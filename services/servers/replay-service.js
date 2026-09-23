#!/usr/bin/env node
// 回放计算服务：从历史服务拉取分支事件，按因果序重建
// 库存 / 床位 / 运输状态，支持任意节点 seek、四维度差异、双分支对照、旧快照迁移
import { createApp, ok, fail, listen, call } from '../lib/http.js'
import { PORTS, LONG_POLL_MS } from '../lib/config.js'
import { replayTo, buildFrames, diffStates, compare } from '../domain/projection.js'

/* 内存投影缓存：key -> { events, lastSeq }
 * 投影前先向历史做一次轻量 seq 探测，发现新事件即失效重建——
 * 外部（采集/直连/其它采集节点）写入后，回放始终给出最新因果投影。 */
const cache = new Map()

async function fetchHead(simId, branchId) {
  const r = await call('GET', PORTS.history, `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branchId)}/events?afterSeq=1000000000`)
  if (r.status !== 200) throw new Error(`history head ${r.status}`)
  return r.body.seq
}

async function fetchEvents(simId, branchId) {
  const r = await call('GET', PORTS.history, `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branchId)}/events`)
  if (r.status !== 200) throw new Error(`history ${r.status}: ${r.body?.msg || ''}`)
  return r.body.events
}

async function getEvents(simId, branchId, forceRefresh = false) {
  const key = `${simId}|${branchId}`
  const cached = cache.get(key)
  if (!forceRefresh && cached) {
    try {
      if ((await fetchHead(simId, branchId)) === cached.lastSeq) return cached.events
    } catch { /* 历史探测失败则保守重拉 */ }
  }
  const evs = await fetchEvents(simId, branchId)
  cache.set(key, { events: evs, lastSeq: evs.length ? evs[evs.length - 1].seq : -1, at: Date.now() })
  return evs
}

// 长轮询：等待分支出现 seq 之后的新事件（断线续演 / 自动播放游标推进）
async function waitForNew(simId, branchId, seq, deadline = Date.now() + LONG_POLL_MS) {
  for (;;) {
    const evs = await fetchEvents(simId, branchId)
    const last = evs.length ? evs[evs.length - 1].seq : -1
    if (last > seq) return { events: evs, last }
    if (Date.now() >= deadline) return { events: evs, last, timeout: true }
    await new Promise((r) => setTimeout(r, 300))
  }
}

const app = createApp([
  ['GET', '/healthz', async (req, res) => ok(res, { service: 'replay' })],

  // 任意节点回放：atSeq 省略 = 末端；返回完整态势（库存/床位/派发/批次/阻断/工单）
  ['GET', '/sims/:simId/branches/:branchId/replay', async (req, res, { simId, branchId }, { atSeq, refresh }) => {
    let events
    try { events = await getEvents(simId, branchId, refresh === '1') } catch (e) { return fail(res, 502, 'history-unavailable', e.message) }
    if (!events.length) return fail(res, 404, 'empty-branch', '分支无事件')
    const seq = atSeq == null ? events.length - 1 : Math.max(0, Math.min(parseInt(atSeq, 10), events.length - 1))
    const state = replayTo(events, seq)
    ok(res, { atSeq: seq, lastSeq: events.length - 1, state: publicState(state) })
  }],

  // 时间轴：逐帧索引
  ['GET', '/sims/:simId/branches/:branchId/timeline', async (req, res, { simId, branchId }) => {
    let events
    try { events = await getEvents(simId, branchId) } catch (e) { return fail(res, 502, 'history-unavailable', e.message) }
    ok(res, { frames: buildFrames(events), lastSeq: events.length - 1 })
  }],

  // 帧间四维度差异：状态变化 / 路线 / 资源占用 / 床位
  ['GET', '/sims/:simId/branches/:branchId/diff', async (req, res, { simId, branchId }, { atSeq }) => {
    let events
    try { events = await getEvents(simId, branchId) } catch (e) { return fail(res, 502, 'history-unavailable', e.message) }
    const seq = atSeq == null ? events.length - 1 : parseInt(atSeq, 10)
    const prev = seq > 0 ? replayTo(events, seq - 1) : null
    const cur = replayTo(events, seq)
    ok(res, { atSeq: seq, diff: diffStates(prev, cur) })
  }],

  // 双分支末端处置结果对照（自动对齐各自末端）
  ['GET', '/sims/:simId/compare', async (req, res, { simId }, { a, b }) => {
    if (!a || !b || a === b) return fail(res, 400, 'bad-params', '需要两个不同分支 a / b')
    let ea, eb
    try {
      ;[ea, eb] = await Promise.all([getEvents(simId, a), getEvents(simId, b)])
    } catch (e) { return fail(res, 502, 'history-unavailable', e.message) }
    ok(res, { compare: compare(replayTo(ea, ea.length - 1), replayTo(eb, eb.length - 1)) })
  }],

  // 长轮询订阅：?afterSeq=N 有新事件时返回（供断线续演/实时播放）
  ['GET', '/sims/:simId/branches/:branchId/poll', async (req, res, { simId, branchId }, { afterSeq }) => {
    const seq = parseInt(afterSeq ?? '-1', 10)
    try {
      const r = await waitForNew(simId, branchId, seq)
      ok(res, { lastSeq: r.last, timeout: !!r.timeout })
    } catch (e) { fail(res, 502, 'history-unavailable', e.message) }
  }],

  // 旧快照迁移：把前端历史版本（v1 单线 frames，含 {cmd,tr,rb,ro} 全量快照）
  // 转为一串有序 state.snapshot 事件落到新推演主干，之后即可正常分叉/回放/续写。
  // 用 after 串链保证即便快照事件时间戳乱序，迁移后的顺序仍与旧时间轴一致。
  ['POST', '/sims/migrate-snapshot', async (req, res, params, query, body) => {
    const frames = body.frames
    if (!Array.isArray(frames) || !frames.length) return fail(res, 400, 'bad-frames', 'frames 必须是非空数组')
    const simId = body.simId || `mig-${Date.now().toString(36)}`
    const name = body.name || '旧快照迁移推演'
    const created = await call('POST', PORTS.history, '/sims', { id: simId, name, scenarioId: body.scenarioId || 's1' })
    if (created.status !== 200) return fail(res, 502, 'create-failed', created.body?.msg || '创建推演失败')

    const events = frames.map((f, i) => ({
      type: 'state.snapshot',
      at: typeof f.at === 'string' ? f.at : (f.t ? new Date(f.t).toLocaleTimeString('zh-CN', { hour12: false }) : '00:00'),
      payload: {
        snapshot: f.snapshot || f,
        migratedFrom: 'legacy-frames',
        legacySeq: f.seq ?? i,
        // 首帧为基线导入，其余标记为旧帧回放
        baseline: i === 0
      }
    }))
    // 一次批量提交：历史服务按 after 拓扑得到与旧时间轴一致的确定顺序
    const pushed = await call('POST', PORTS.history, `/sims/${encodeURIComponent(simId)}/branches/main/events`, { events })
    if (pushed.status !== 200) return fail(res, 502, 'migrate-failed', pushed.body?.msg || '迁移事件写入失败')
    ok(res, { simId, branchId: 'main', frames: frames.length, migrated: true, seq: pushed.body?.seq })
  }]
])

function publicState(s) {
  return {
    version: s.version, simId: s.simId, scenarioId: s.scenarioId, name: s.name, settleDay: s.settleDay,
    events: s.events, bases: s.bases, shelters: s.shelters,
    dispatches: s.dispatches, batches: s.batches, blocks: s.blocks, orders: s.orders,
    appliedCount: s.appliedIds instanceof Set ? s.appliedIds.size : (s.appliedIds?.length || 0),
    conflicts: s.conflicts
  }
}

listen(app, PORTS.replay, 'replay').catch((e) => { console.error(e); process.exit(1) })
