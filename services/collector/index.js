/* =========================================================================
 * collector —— 事件采集服务（独立进程，可水平扩容）
 *
 * 职责：
 *   1. 接收现场端/演练端事件（单条或批量），做信封校验与幂等去重；
 *   2. 域隔离守门：realm=real（真实调度）必须携带服务间令牌，演练域（wg:*）放开；
 *   3. 可靠投递：先进本地 outbox（JSONL 落盘）再转发 archive；
 *      archive 宕机/网络抖动时事件不丢，恢复后自动重投（断线续演的采集侧保障）；
 *   4. 不保存业务状态 —— 唯一事实源在 archive，collector 崩溃重启只重放 outbox。
 * ========================================================================= */

import fs from 'node:fs'
import path from 'node:path'
import { createRouter, listen, readJson, send } from '../shared/http.js'
import { ensure, nowMs } from '../shared/util.js'
import { REALM_REAL, makeEvent, validateEventType, validatePayload } from '../shared/events.js'

/* ---------------- 本地 outbox（崩溃可恢复的转发队列） ---------------- */

class Outbox {
  constructor(file) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.pending = []          // 未确认事件（按入队序）
    this.seen = new Set()      // 已入队 eventId（进程内幂等）
    this._recover()
  }
  _recover() {
    if (!fs.existsSync(this.file)) return
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
    const alive = []
    for (const line of lines) {
      try {
        const rec = JSON.parse(line)
        if (rec.kind === 'ack') {
          const i = alive.findIndex((r) => r.event.eventId === rec.eventId)
          if (i >= 0) alive.splice(i, 1)
          continue
        }
        if (rec.kind === 'event' && rec.event?.eventId && !this.seen.has(rec.event.eventId)) {
          this.seen.add(rec.event.eventId)
          alive.push(rec)
        }
      } catch { /* 半行忽略：重投由 archive 幂等去重兜底 */ }
    }
    this.pending = alive.map((r) => r.event)
  }
  _append(rec) {
    const fd = fs.openSync(this.file, 'a')
    try { fs.writeSync(fd, JSON.stringify(rec) + '\n'); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
  }
  enqueue(event) {
    if (this.seen.has(event.eventId)) return false
    this.seen.add(event.eventId)
    this.pending.push(event)
    this._append({ kind: 'event', event })
    return true
  }
  ack(eventId) {
    const i = this.pending.findIndex((e) => e.eventId === eventId)
    if (i >= 0) this.pending.splice(i, 1)
    this._append({ kind: 'ack', eventId, at: nowMs() })
  }
  size() { return this.pending.length }
}

export function createCollector(opts = {}) {
  const archiveUrl = opts.archiveUrl || process.env.ARCHIVE_URL || 'http://127.0.0.1:7102'
  const realToken = opts.realToken || process.env.REAL_REALM_TOKEN || 'dev-real-token'
  const dataDir = opts.dataDir || process.env.COLLECTOR_DATA || path.join(process.cwd(), 'data', 'collector')
  const forwardTimeoutMs = Number(process.env.FORWARD_TIMEOUT_MS || 3000)
  const outbox = new Outbox(path.join(dataDir, 'outbox.jsonl'))

  let forwarding = false
  let retryDelay = 500
  // 启动时 archive 可达性未知：在首次成功投递前按离线处理（事件落 outbox，不向客户端谎报在线）
  const archiveState = { up: false, checked: false }

  function deadLetter(event, reason) {
    const fd = fs.openSync(path.join(dataDir, 'deadletter.jsonl'), 'a')
    try { fs.writeSync(fd, JSON.stringify({ event, reason, at: nowMs() }) + '\n'); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
  }

  async function postToArchive(events) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), forwardTimeoutMs)
    try {
      const res = await fetch(`${archiveUrl}/v1/events/append`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
        signal: ctrl.signal
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) return { ok: false, fatal: true, body }
        throw new Error(`archive ${res.status}`)
      }
      return { ok: true, body }
    } finally {
      clearTimeout(timer)
    }
  }

  async function drainOutbox() {
    if (forwarding || !outbox.size()) return
    forwarding = true
    try {
      while (outbox.size()) {
        const batch = outbox.pending.slice(0, 100)
        let result
        try {
          result = await postToArchive(batch)
        } catch {
          archiveState.checked = true
          archiveState.up = false
          setTimeout(drainOutbox, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 15000)
          return
        }
        if (result.ok) {
          archiveState.checked = true
          archiveState.up = true
          retryDelay = 500
          const results = result.body.results || []
          if (results.length) results.forEach((r) => outbox.ack(r.eventId))
          else batch.forEach((e) => outbox.ack(e.eventId))
          continue
        }
        if (result.fatal) {
          // 坏消息隔离进死信，其余重投
          for (const e of batch) {
            try {
              const one = await postToArchive([e])
              if (one.ok) outbox.ack(e.eventId)
              else if (one.fatal) { outbox.ack(e.eventId); deadLetter(e, one.body) }
              else throw new Error('retryable')
            } catch {
              archiveState.checked = true
              archiveState.up = false
              setTimeout(drainOutbox, retryDelay)
              retryDelay = Math.min(retryDelay * 2, 15000)
              return
            }
          }
          continue
        }
      }
    } finally {
      forwarding = false
    }
  }

  function guardRealm(event, req) {
    if (event.realm === REALM_REAL) {
      ensure(req.headers['x-realm-token'] === realToken, 'realm_forbidden',
        '真实调度域（real）仅允许调度系统写入：缺少/错误的服务令牌', 403)
    } else {
      ensure(event.realm.startsWith('wg:'), 'bad_realm',
        '演练域必须以 wg: 前缀命名（与真实调度域隔离）', 400)
    }
  }

  function normalizeIncoming(raw, req) {
    ensure(raw && typeof raw === 'object', 'bad_event', '事件必须是对象', 400)
    validateEventType(raw.type)
    validatePayload(raw.type, raw.data)
    const event = makeEvent({
      ...raw,
      clientId: raw.clientId || req.headers['x-client-id'] || 'anonymous',
      actor: raw.actor || req.headers['x-actor'] || null
    })
    guardRealm(event, req)
    return event
  }

  const router = createRouter([
    {
      method: 'GET', pattern: '/v1/health',
      handler: async (_req, res) => send(res, 200, {
        ok: true, service: 'collector', archiveUp: archiveState.up, outbox: outbox.size(), ts: nowMs()
      })
    },
    {
      method: 'GET', pattern: '/v1/outbox',
      handler: async (_req, res) => send(res, 200, {
        pending: outbox.pending.map((e) => e.eventId), size: outbox.size()
      })
    },
    {
      // 单条/批量采集。archive 在线时同步确认；离线时 202 入队（恢复后自动补投）
      method: 'POST', pattern: '/v1/events',
      handler: async (req, res) => {
        const body = await readJson(req)
        const list = Array.isArray(body.events) ? body.events : [body.event || body]
        ensure(list.length && list.length <= 500, 'bad_batch', '批量大小需在 1..500', 400)
        const accepted = []
        const duplicates = []
        for (const raw of list) {
          const event = normalizeIncoming(raw, req)
          if (outbox.enqueue(event)) accepted.push(event.eventId)
          else duplicates.push(event.eventId)
        }
        drainOutbox()
        // 仅当已确认 archive 离线时返回 202；可达性未知（启动首发）按受理 200，失败会落 outbox 自动补投
        const knownDown = archiveState.checked && !archiveState.up
        const status = knownDown ? 202 : 200
        send(res, status, {
          accepted, duplicates,
          queued: outbox.size(),
          archiveUp: archiveState.up,
          note: knownDown ? 'archive 暂不可达，事件已落本地 outbox，恢复后自动补投（断线续演）' : '已受理并转发'
        })
      }
    },
    {
      method: 'POST', pattern: '/v1/outbox/flush',
      handler: async (_req, res) => { drainOutbox(); send(res, 200, { queued: outbox.size() }) }
    }
  ])

  return { router, outbox, drain: drainOutbox, archiveState }
}

/* ---------------- CLI 启动 ---------------- */

const isMain = process.argv[1] && process.argv[1].endsWith('collector/index.js')
if (isMain && process.env.COLLECTOR_EMBED !== '1') {
  const port = Number(process.env.COLLECTOR_PORT || 7101)
  const { router, drain } = createCollector()
  const server = await listen(router, port)
  console.log(`[collector] listening on :${port} -> archive ${process.env.ARCHIVE_URL || 'http://127.0.0.1:7102'}`)
  drain() // 排空上次崩溃遗留的 outbox
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
