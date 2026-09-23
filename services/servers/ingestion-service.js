#!/usr/bin/env node
// 事件采集服务：多端事件统一入口
//  - 接收指挥员/现场上报事件，分配 client 会话与 HLC
//  - 乱序窗口（DISORDER_SLACK_MS）内按 HLC 稳定重排后再下发
//  - 同分支串行（每分支一把锁），并发写入由历史服务因果归并
//  - 本地 WAL 记录「待确认/已确认」，历史服务短暂不可达时缓存重试，崩溃后恢复不丢事件
//  - 断线续演：clientId 会话状态（最后确认 seq）
import { createApp, ok, fail, listen, call, waitFor } from '../lib/http.js'
import { PORTS, DATA_DIR, DISORDER_SLACK_MS } from '../lib/config.js'
import { ensureDir, readJson, writeJsonAtomic, JsonlLog, mutex } from '../lib/storage.js'
import path from 'node:path'
import { hlcDecode, hlcEncode, hlcReceive } from '../lib/causal.js'

const dir = ensureDir(`${DATA_DIR}/ingestion`)
const wal = new JsonlLog(path.join(dir, 'wal.jsonl'))
const sessionsFile = path.join(dir, 'sessions.json')

// 会话：clientId -> { simId, branchId, lastSeq, disconnectedAt }
let sessions = readJson(sessionsFile, {}) || {}
const saveSessions = () => writeJsonAtomic(sessionsFile, sessions)

// 待确认事件：eventId -> envelope（崩溃恢复时从 WAL 重建）
const pending = new Map()
// 每个分支的乱序缓冲与串行锁
const buffers = new Map()      // key -> [{ env, arriveAt }]
const branchLock = new Map()   // key -> mutex
const flushTimers = new Map()  // key -> timer

function lockFor(key) {
  if (!branchLock.has(key)) branchLock.set(key, mutex())
  return branchLock.get(key)
}

/* ---------------- WAL（崩溃恢复不丢事件） ---------------- */
// WAL 行：{ op:'send', env, status:'pending' } / { op:'ack', id }
function recover() {
  const rows = wal.recover()
  for (const r of rows) {
    if (r.op === 'send' && r.status === 'pending') pending.set(r.env.id, r.env)
    if (r.op === 'ack') pending.delete(r.id)
  }
  // 启动后异步重试历史服务（若尚未就绪则等待）
  if (pending.size) setTimeout(redeliverAll, 300)
}
function walSend(env) { wal.append({ op: 'send', status: 'pending', env }) }
function walAck(id) { wal.append({ op: 'ack', id }) }

async function redeliverAll() {
  try {
    await waitFor(PORTS.history, '/healthz', 100, 200)
  } catch { return setTimeout(redeliverAll, 1000) }
  for (const env of pending.values()) {
    // eslint-disable-next-line no-await-in-loop
    await deliverToHistory(env)
  }
}

async function deliverToHistory(env) {
  const key = `${env.simId}|${env.branchId}`
  return lockFor(key)(async () => {
    try {
      const r = await call('POST', PORTS.history,
        `/sims/${encodeURIComponent(env.simId)}/branches/${encodeURIComponent(env.branchId)}/events`,
        { events: [stripForHistory(env)], clientId: env.clientId })
      if (r.status === 200) {
        pending.delete(env.id)
        walAck(env.id)
        const cs = sessions[env.clientId]
        if (cs) { cs.lastSeq = r.body.seq; cs.lastActiveAt = Date.now(); saveSessions() }
        return { ok: true, body: r.body }
      }
      // 业务拒绝（如写入真实流）：不算故障，直接返回
      if (r.status >= 400 && r.status < 500) { pending.delete(env.id); walAck(env.id); return { ok: false, status: r.status, body: r.body } }
      throw new Error('history ' + r.status)
    } catch (e) {
      // 历史服务不可达：留在 pending，稍后重试
      scheduleRetry(env)
      return { ok: true, deferred: true, reason: e.message }
    }
  })
}

const retryTimers = new Map()
function scheduleRetry(env) {
  if (retryTimers.has(env.id)) return
  const t = setTimeout(async () => {
    retryTimers.delete(env.id)
    if (!pending.has(env.id)) return
    await deliverToHistory(env)
  }, 500 + Math.random() * 500)
  retryTimers.set(env.id, t)
}

function stripForHistory(env) {
  const { simId, branchId, clientId, ...e } = env
  return e
}

/* ---------------- 乱序窗口缓冲 ---------------- */

function bufferKey(env) { return `${env.simId}|${env.branchId}` }

function enqueue(env) {
  const key = bufferKey(env)
  if (!buffers.has(key)) buffers.set(key, [])
  buffers.get(key).push({ env, arriveAt: Date.now() })
  if (!flushTimers.has(key)) {
    flushTimers.set(key, setInterval(() => flushKey(key), 100))
  }
}

// 到期冲刷：把窗口内事件按 HLC 稳定排序，逐个串行投递（保持分支内顺序）
async function flushKey(key) {
  const buf = buffers.get(key)
  if (!buf || !buf.length) return
  const now = Date.now()
  const due = []
  const keep = []
  for (const item of buf) {
    if (now - item.arriveAt >= DISORDER_SLACK_MS) due.push(item)
    else keep.push(item)
  }
  buffers.set(key, keep)
  if (!due.length) return
  // 乱序重排：按 HLC（编码字符串字典序）+ id 稳定排序
  due.sort((a, b) => {
    const ka = (a.env.hlc || '') + '|' + a.env.id
    const kb = (b.env.hlc || '') + '|' + b.env.id
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  for (const item of due) {
    // 同分支锁内顺序投递
    // eslint-disable-next-line no-await-in-loop
    await deliverToHistory(item.env)
  }
}

/* ---------------- 信封构造 ---------------- */

let inSeq = 0
function makeEnvelope({ id, simId, branchId, type, payload, at, hlc, after, clientId, day }) {
  // 显式 id（网关因果串链）优先；否则本地生成全局唯一 id
  const eid = id || `${type}-${Date.now().toString(36)}-${(++inSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return {
    id: eid, simId, branchId, clientId: clientId || null,
    type, payload: payload || {},
    at: at || nowHHMM(), day: day ?? null,
    hlc: hlc || newHlc(), after: Array.isArray(after) ? after.filter(Boolean) : [], ts: Date.now()
  }
}

// 采集节点本地 HLC（纳秒级精度用计数器补足同毫秒）
let lastHlc = { ts: 0, l: 0 }
function newHlc() {
  const now = Date.now()
  lastHlc = now > lastHlc.ts ? { ts: now, l: 0 } : { ts: lastHlc.ts, l: lastHlc.l + 1 }
  return hlcEncode(lastHlc)
}
function nowHHMM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* ---------------- HTTP ---------------- */

const app = createApp([
  ['GET', '/healthz', async (req, res) => ok(res, { service: 'ingestion', pending: pending.size, sessions: Object.keys(sessions).length })],

  // 会话登记/续接：断线后客户端用同一 clientId 拿回最后确认位置
  ['POST', '/sessions', async (req, res, params, query, body) => {
    const clientId = body.clientId || `cli-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const existed = sessions[clientId]
    if (!existed) {
      sessions[clientId] = {
        simId: body.simId || null, branchId: body.branchId || 'main',
        lastSeq: -1, connectedAt: Date.now(), lastActiveAt: Date.now()
      }
      saveSessions()
    } else {
      existed.disconnectedAt = null
      existed.lastActiveAt = Date.now()
      if (body.branchId) existed.branchId = body.branchId
      saveSessions()
    }
    ok(res, { clientId, resumed: !!existed, session: sessions[clientId] })
  }],

  ['POST', '/sessions/:clientId/disconnect', async (req, res, { clientId }) => {
    const cs = sessions[clientId]
    if (cs) { cs.disconnectedAt = Date.now(); saveSessions() }
    ok(res, { disconnected: true })
  }],

  ['GET', '/sessions/:clientId', async (req, res, { clientId }) => {
    const cs = sessions[clientId]
    if (!cs) return fail(res, 404, 'session-not-found', '会话不存在，需重新登记')
    ok(res, { session: cs })
  }],

  // 上报单个/一批事件（核心入口）
  ['POST', '/sims/:simId/branches/:branchId/events', async (req, res, { simId, branchId }, query, body) => {
    const list = Array.isArray(body.events) ? body.events : [body.event || body]
    if (!Array.isArray(list) || !list.length || list.some((e) => !e?.type)) {
      return fail(res, 400, 'bad-events', 'events 需为带 type 的对象或数组')
    }
    const clientId = body.clientId
    if (clientId && sessions[clientId]) {
      sessions[clientId].simId = simId
      sessions[clientId].branchId = branchId
      sessions[clientId].lastActiveAt = Date.now()
      saveSessions()
    }
    const accepted = []
    for (const raw of list) {
      const env = makeEnvelope({
        id: raw.id, simId, branchId, clientId,
        type: raw.type, payload: raw.payload, at: raw.at, day: raw.day,
        hlc: raw.hlc, after: raw.after
      })
      // 客户端显式携带 HLC：保留并据此推进本地时钟（多采集节点因果合并）；
      // 否则由本地生成。不得覆盖客户端时间戳——乱序重排要依据它。
      if (raw.hlc) {
        const r = hlcDecode(raw.hlc)
        if (r) lastHlc = hlcReceive(lastHlc, r)
      }
      pending.set(env.id, env)
      walSend(env)
      enqueue(env)
      accepted.push({ id: env.id, type: env.type, hlc: env.hlc })
    }
    // 立即冲刷一次（低延迟路径），乱序窗口对乱序到达仍生效
    flushKey(`${simId}|${branchId}`)
    ok(res, { accepted: accepted.length, events: accepted, buffered: true, slackMs: DISORDER_SLACK_MS })
  }],

  // 立即冲刷（测试/低延迟用）：等待窗口内事件全部投递并返回确认结果
  ['POST', '/flush', async (req, res, params, query, body) => {
    const simId = body.simId, branchId = body.branchId
    for (const [key, buf] of buffers.entries()) {
      if (simId && key !== `${simId}|${branchId || 'main'}`) continue
      // eslint-disable-next-line no-await-in-loop
      await flushKeyImmediate(key)
    }
    ok(res, { pending: pending.size })
  }],

  // 故障注入/运维：查看未确认事件
  ['GET', '/pending', async (req, res) => {
    ok(res, { pending: [...pending.values()].map((e) => ({ id: e.id, simId: e.simId, branchId: e.branchId, type: e.type })) })
  }]
])

async function flushKeyImmediate(key) {
  const buf = buffers.get(key)
  if (!buf) return
  // 立即到期
  buf.forEach((x) => { x.arriveAt = 0 })
  await flushKey(key)
}

recover()

waitFor(PORTS.history, '/healthz', 5, 500).then(() => {
  console.error('[ingestion] history upstream ready')
}).catch(() => { /* 历史服务可稍后启动，采集仍可先缓冲 */ })

listen(app, PORTS.ingestion, 'ingestion').catch((e) => { console.error(e); process.exit(1) })
