#!/usr/bin/env node
// 历史存储服务：事件追加日志（权威事实流）+ 分支树 + 快照检查点 + 故障恢复
import { createApp, send, ok, fail, listen } from '../lib/http.js'
import { PORTS, DATA_DIR, LIVE_SIM_ID, LIVE_WRITE_TOKEN } from '../lib/config.js'
import { BranchStore, httpError } from '../store/BranchStore.js'
import { buildInitPayload } from '../domain/seed.js'

const store = new BranchStore(`${DATA_DIR}/history`)

// 周期检查点落盘（崩溃恢复时从检查点偏移续算，而非全量重放）
const CP_INTERVAL = Number(process.env.CHECKPOINT_INTERVAL_MS || 15000)
setInterval(() => { store.checkpointAll() }, CP_INTERVAL).unref()

function requireLiveToken(req) {
  const token = req.headers['x-live-token']
  return !!LIVE_WRITE_TOKEN && token === LIVE_WRITE_TOKEN
}

const app = createApp([
  ['GET', '/healthz', async (req, res) => ok(res, { service: 'history', sims: store.listSims().length })],

  /* ---------- 推演会话 ---------- */

  ['POST', '/sims', async (req, res, params, query, body) => {
    const id = body.id || `sim-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    if (id === LIVE_SIM_ID) return fail(res, 403, 'reserved', 'live 为真实调度保留 ID，请换名')
    const initPayload = buildInitPayload({ simId: id, scenarioId: body.scenarioId, name: body.name })
    const { meta } = await store.createSim({ id, name: body.name || initPayload.name, scenarioId: initPayload.scenarioId, initPayload })
    ok(res, { sim: publicSim(meta), initSeq: 0 })
  }],

  ['GET', '/sims', async (req, res) => ok(res, { sims: store.listSims().map(publicSim) })],
  ['GET', '/sims/:simId', async (req, res, { simId }) => {
    const meta = store.getSim(simId)
    if (!meta) return fail(res, 404, 'sim-not-found', '推演不存在')
    ok(res, { sim: publicSim(meta), branches: store.listBranches(simId) })
  }],

  // 真实调度（生产流）：仅带外令牌可初始化
  ['POST', '/live/init', async (req, res, params, query, body) => {
    if (!LIVE_WRITE_TOKEN) return fail(res, 403, 'token-disabled', '未配置 LIVE_WRITE_TOKEN，真实流为只读隔离状态')
    if (!requireLiveToken(req)) return fail(res, 401, 'bad-token', '真实流写入令牌无效')
    const initPayload = buildInitPayload({ simId: LIVE_SIM_ID, scenarioId: body.scenarioId, name: '真实调度（生产）' })
    const meta = await store.ensureLiveSim(initPayload)
    ok(res, { sim: publicSim(meta) })
  }],
  ['GET', '/live', async (req, res) => {
    const meta = store.getSim(LIVE_SIM_ID)
    if (!meta) return fail(res, 404, 'no-live', '真实流尚未建立')
    ok(res, { sim: publicSim(meta), branches: store.listBranches(LIVE_SIM_ID) })
  }],

  /* ---------- 分支 ---------- */

  ['GET', '/sims/:simId/branches', async (req, res, { simId }) => {
    if (!store.getSim(simId)) return fail(res, 404, 'sim-not-found', '推演不存在')
    ok(res, { branches: store.listBranches(simId) })
  }],

  // 分叉：复制父分支 [0..atSeq] 事件到新日志，之后独立追加
  ['POST', '/sims/:simId/branches', async (req, res, { simId }, query, body) => {
    if (simId === LIVE_SIM_ID) return fail(res, 403, 'live-protected', '真实调度流不允许分叉演练')
    const child = await store.fork(simId, body.parentBranchId || 'main', { name: body.name, atSeq: body.atSeq })
    ok(res, { branch: child })
  }],

  /* ---------- 事件追加（乱序 / 并发 / 幂等 / 因果） ---------- */

  ['POST', '/sims/:simId/branches/:branchId/events', async (req, res, { simId, branchId }, query, body) => {
    if (simId === LIVE_SIM_ID) return fail(res, 403, 'live-protected', '推演事件不得写入真实调度流')
    const list = Array.isArray(body.events) ? body.events : [body.event || body]
    if (!Array.isArray(list) || !list.length) return fail(res, 400, 'empty', 'events 不能为空')
    const result = await store.appendEvents(simId, branchId, list, { clientId: body.clientId })
    ok(res, {
      appended: result.appended.length,
      dedup: result.dedup,
      rejected: result.rejected,
      seq: result.seq,
      conflicts: result.conflicts,
      events: result.appended.map((e) => ({ id: e.id, seq: e.seq, type: e.type, hlc: e.hlc }))
    })
  }],

  // 真实流追加：只接受带外令牌
  ['POST', '/live/events', async (req, res, params, query, body) => {
    if (!LIVE_WRITE_TOKEN) return fail(res, 403, 'token-disabled', '真实流只读')
    if (!requireLiveToken(req)) return fail(res, 401, 'bad-token', '真实流写入令牌无效')
    const list = Array.isArray(body.events) ? body.events : [body.event || body]
    const result = await store.appendEvents(LIVE_SIM_ID, body.branchId || 'main', list, { clientId: 'live' })
    ok(res, { appended: result.appended.length, seq: result.seq, conflicts: result.conflicts })
  }],

  // 读取分支事件（断线续演增量拉取：?afterSeq=）
  ['GET', '/sims/:simId/branches/:branchId/events', async (req, res, { simId, branchId }, { afterSeq }) => {
    if (!store.getSim(simId)) return fail(res, 404, 'sim-not-found', '推演不存在')
    const all = store.eventsOf(simId, branchId)
    const from = afterSeq == null ? 0 : Math.max(0, parseInt(afterSeq, 10) + 1)
    const events = all.slice(from)
    ok(res, { branchId, from, seq: all.length - 1, events, hasMore: false })
  }],

  /* ---------- 投影 / 检查点 ---------- */

  // 折叠后的完整状态（库存/床位/运输），历史服务内建只读投影便于对账
  ['GET', '/sims/:simId/branches/:branchId/state', async (req, res, { simId, branchId }, { atSeq }) => {
    if (!store.getSim(simId)) return fail(res, 404, 'sim-not-found', '推演不存在')
    const state = store.stateOf(simId, branchId)
    ok(res, { state: stripInternal(state) })
  }],

  ['POST', '/sims/:simId/branches/:branchId/checkpoint', async (req, res, { simId, branchId }) => {
    const r = await store.checkpoint(simId, branchId)
    ok(res, r)
  }],
  ['POST', '/checkpoints', async (req, res) => ok(res, { checkpoints: await store.checkpointAll() })],

  // 断线续演：会话恢复信息
  ['POST', '/sims/:simId/resume', async (req, res, { simId }, query, body) => {
    const info = store.resume(simId, body.clientId || null)
    if (!info) return fail(res, 404, 'sim-not-found', '推演不存在')
    ok(res, info)
  }]
])

function publicSim(meta) {
  return { id: meta.id, name: meta.name, scenarioId: meta.scenarioId, createdAt: meta.createdAt, lastActiveAt: meta.lastActiveAt }
}
function stripInternal(state) {
  const { appliedIds, conflicts, seq, ...pub } = state
  return { ...pub, appliedCount: appliedIds instanceof Set ? appliedIds.size : (appliedIds?.length || 0), conflictCount: (conflicts || []).length, conflicts: conflicts || [] }
}

app.on('error', (e) => { if (e?.code !== 'EADDRINUSE') console.error(e) })

listen(app, PORTS.history, 'history').catch((e) => { console.error(e); process.exit(1) })

// 全局把 BranchStore 的业务错误转 HTTP
process.on('uncaughtException', (e) => console.error('[history] uncaught', e))
