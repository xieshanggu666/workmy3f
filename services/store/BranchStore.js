import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic, JsonlLog, mutex } from '../lib/storage.js'
import { hlcEncode, hlcNow, hlcReceive, hlcDecode, causalTopoSort } from '../lib/causal.js'
import { fold, foldAll, createState } from '../domain/reducer.js'
import { LIVE_SIM_ID } from '../lib/config.js'

/* =========================================================================
 * BranchStore —— 历史存储服务的存储引擎
 *
 * 每个推演（simId）一个目录：
 *   sim.json                 推演元数据 + 分支索引
 *   events-<branchId>.jsonl  分支事件追加日志（权威事实流，崩溃后重放恢复）
 *   cp-<branchId>.json       最近检查点（投影状态 + applied 偏移）
 *
 * 分支：fork = 复制父分支 [0..forkSeq] 的事件到新日志（copy-on-write），
 *       之后两分支独立追加，天然隔离互不污染。
 * 故障恢复：启动时扫描全部 jsonl，截断半行、从检查点续算，重建内存索引。
 * ========================================================================= */

let envSeq = 0
export function newEventId(prefix = 'ev') {
  return `${prefix}-${Date.now().toString(36)}-${(process.pid % 1e4).toString(36)}-${(++envSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export class BranchStore {
  constructor(rootDir) {
    this.root = ensureDir(rootDir)
    this.lock = mutex()
    this.sims = new Map()      // simId -> meta
    this.logs = new Map()      // `${simId}|${branchId}` -> JsonlLog
    this.cache = new Map()     // 同上 -> { state, events, dirty }
    this._loadAll()
  }

  _simFile(simId) { return path.join(this.root, simId, 'sim.json') }
  _logFile(simId, branchId) { return path.join(this.root, simId, `events-${branchId}.jsonl`) }
  _cpFile(simId, branchId) { return path.join(this.root, simId, `cp-${branchId}.json`) }
  _key(simId, branchId) { return `${simId}|${branchId}` }

  _loadAll() {
    ensureDir(this.root)
    for (const dir of this._subdirs()) {
      const meta = readJson(this._simFile(dir), null)
      if (!meta) continue
      this.sims.set(meta.id, meta)
      for (const br of meta.branches) {
        const log = new JsonlLog(this._logFile(meta.id, br.id))
        this.logs.set(this._key(meta.id, br.id), log)
      }
    }
  }

  _subdirs() {
    try {
      return fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch { return [] }
  }

  _saveMeta(meta) { writeJsonAtomic(this._simFile(meta.id), meta) }

  /* ---------- 推演生命周期 ---------- */

  createSim({ id, name = '推演', scenarioId = 's1', initPayload }) {
    return this.lock(() => {
      if (this.sims.has(id)) throw httpError(409, 'sim-exists', `推演 ${id} 已存在`)
      if (id === LIVE_SIM_ID) { /* live 流允许创建，但只能由带外令牌写入 */ }
      const mainId = 'main'
      const meta = {
        id, name, scenarioId,
        createdAt: Date.now(), lastActiveAt: Date.now(),
        branches: [{
          id: mainId, name: '主干', parentId: null, forkSeq: -1,
          createdAt: Date.now(), lastEventSeq: -1
        }]
      }
      ensureDir(path.join(this.root, id))
      const log = new JsonlLog(this._logFile(id, mainId))
      this.logs.set(this._key(id, mainId), log)
      // sim.init 作为第 0 个事件
      const initEvent = this._makeEnvelope({
        simId: id, branchId: mainId, type: 'sim.init',
        payload: initPayload || { scenarioId }, at: '00:00', id: newEventId('init')
      })
      initEvent.seq = 0
      log.append(initEvent)
      meta.branches[0].lastEventSeq = 0
      this.sims.set(id, meta)
      this._saveMeta(meta)
      this.cache.delete(this._key(id, mainId))
      return { meta, initEvent }
    })
  }

  getSim(simId) { return this.sims.get(simId) || null }
  listSims() { return [...this.sims.values()].filter((m) => m.id !== LIVE_SIM_ID) }

  // 真实调度流（生产）：惰性创建，只能通过带外令牌访问
  async ensureLiveSim(initPayload) {
    const existing = this.sims.get(LIVE_SIM_ID)
    if (existing) return existing
    const { meta } = await this.createSim({
      id: LIVE_SIM_ID, name: '真实调度（生产）', scenarioId: initPayload?.scenarioId || 's1', initPayload
    })
    return meta
  }

  _branchMeta(meta, branchId) { return meta.branches.find((b) => b.id === branchId) }

  /* ---------- 事件追加（含乱序重排 / 幂等 / 因果约束） ---------- */

  _log(simId, branchId) {
    const l = this.logs.get(this._key(simId, branchId))
    if (!l) throw httpError(404, 'branch-not-found', `分支 ${branchId} 不存在`)
    return l
  }

  // 读取分支事件（崩溃恢复后以日志为准）
  eventsOf(simId, branchId) {
    const cached = this.cache.get(this._key(simId, branchId))
    if (cached) return cached.events
    const evs = this._log(simId, branchId).recover()
    this.cache.set(this._key(simId, branchId), { events: evs, state: null, dirty: false })
    return evs
  }

  // 投影状态：优先检查点续算
  stateOf(simId, branchId) {
    const key = this._key(simId, branchId)
    let entry = this.cache.get(key)
    const events = this.eventsOf(simId, branchId)
    if (entry?.state && entry.events.length === events.length) return entry.state
    const cpFile = this._cpFile(simId, branchId)
    const cp = readJson(cpFile, null)
    let state
    if (cp && cp.untilSeq != null) {
      state = cp.state
      state.appliedIds = new Set(state.__appliedArr || [])
      delete state.__appliedArr
      const rest = events.filter((e) => e.seq > cp.untilSeq)
      state = foldAll(state, rest)
    } else {
      state = foldAll(createState(), events)
    }
    normalizeStateForCache(state)
    this.cache.set(key, { events, state, dirty: false })
    return state
  }

  // 追加一批事件；输入可为乱序、并发、重复（幂等）、带 after 因果依赖
  appendEvents(simId, branchId, incoming, { clientId } = {}) {
    return this.lock(() => {
      const meta = this.sims.get(simId)
      if (!meta) throw httpError(404, 'sim-not-found', `推演 ${simId} 不存在`)
      const br = this._branchMeta(meta, branchId)
      if (!br) throw httpError(404, 'branch-not-found', `分支 ${branchId} 不存在`)

      const existing = this.eventsOf(simId, branchId)
      const knownIds = new Set(existing.map((e) => e.id))
      const accepted = []
      const dedup = []
      const rejected = []

      for (const raw of incoming) {
        if (!raw || !raw.type) { rejected.push({ event: raw, reason: 'missing-type' }); continue }
        if (raw.id && knownIds.has(raw.id)) { dedup.push(raw.id); continue }
        accepted.push(this._makeEnvelope({
          simId, branchId, type: raw.type, payload: raw.payload || {},
          at: raw.at, hlc: raw.hlc, after: raw.after, id: raw.id, clientId, day: raw.day
        }))
        if (raw.id) knownIds.add(raw.id)
      }

      if (!accepted.length) {
        return { appended: [], dedup, rejected, seq: br.lastEventSeq, conflicts: [] }
      }

      // 因果重排：after 拓扑 + HLC（乱序/并发写入在同一把锁下得到确定全序）
      const merged = causalMerge(existing, accepted)
      // 重新编号 seq（分支内全序），保持 sim.init 在 seq=0
      merged.forEach((e, i) => { e.seq = i })

      // 全量重写日志 + 折叠，得到冲突账
      const log = this._log(simId, branchId)
      const state = foldAll(createState(), merged)
      const conflicts = state.conflicts || []
      rewriteLog(log, merged)

      br.lastEventSeq = merged.length - 1
      meta.lastActiveAt = Date.now()
      this.cache.set(this._key(simId, branchId), { events: merged, state, dirty: true })
      this._saveMeta(meta)

      const appendedIds = accepted.map((a) => a.id)
      return { appended: merged.filter((e) => appendedIds.includes(e.id)), dedup, rejected, seq: br.lastEventSeq, conflicts }
    })
  }

  // 追加单事件（便捷封装）
  appendOne(simId, branchId, raw, opts) {
    return this.appendEvents(simId, branchId, [raw], opts)
  }

  /* ---------- 事件信封 ---------- */

  _makeEnvelope({ simId, branchId, type, payload, at, hlc, after, id, clientId, day }) {
    const prev = this._lastHlc(simId, branchId)
    let clock = hlc ? parseHlcLoose(hlc) : null
    if (!clock) clock = hlcNow(prev)
    else if (prev) clock = hlcReceive(prev, clock)
    const env = {
      id: id || newEventId(),
      simId, branchId,
      type,
      payload: payload || {},
      at: at || nowHHMM(),
      day: day ?? null,
      hlc: hlcEncode(clock),
      after: Array.isArray(after) ? after.filter(Boolean) : [],
      clientId: clientId || null,
      ts: Date.now()
    }
    return env
  }

  _lastHlc(simId, branchId) {
    const evs = this.eventsOf(simId, branchId)
    const last = evs[evs.length - 1]
    return last ? parseHlcLoose(last.hlc) : { ts: 0, l: 0 }
  }

  /* ---------- 分支 fork（多人并行 / 断线续演） ---------- */

  fork(simId, parentBranchId, { name, atSeq } = {}) {
    return this.lock(() => {
      const meta = this.sims.get(simId)
      if (!meta) throw httpError(404, 'sim-not-found', '推演不存在')
      const parent = this._branchMeta(meta, parentBranchId)
      if (!parent) throw httpError(404, 'branch-not-found', '父分支不存在')
      const parentEvents = this.eventsOf(simId, parentBranchId)
      const forkSeq = atSeq == null ? parentEvents.length - 1 : Math.max(0, Math.min(atSeq, parentEvents.length - 1))
      const childId = newEventId('br')
      const seq = meta.branches.filter((b) => b.parentId === parent.id).length + 1
      const child = {
        id: childId,
        name: (name || '').trim() || `${parent.name} · 方案${seq}`,
        parentId: parent.id, forkSeq,
        createdAt: Date.now(), lastEventSeq: forkSeq
      }
      // copy-on-write：复制父分支 [0..forkSeq]，重新打 branchId（事件 id/hlc 保留以维持因果）
      const copied = parentEvents.slice(0, forkSeq + 1).map((e) => ({ ...e, branchId: childId }))
      const log = new JsonlLog(this._logFile(simId, childId))
      rewriteLog(log, copied)
      this.logs.set(this._key(simId, childId), log)
      meta.branches.push(child)
      this.cache.set(this._key(simId, childId), { events: copied, state: null, dirty: true })
      this._saveMeta(meta)
      // 预投影一次（含检查点落盘）
      this.checkpoint(simId, childId)
      return child
    })
  }

  listBranches(simId) {
    const meta = this.sims.get(simId)
    return meta ? meta.branches.map((b) => ({ ...b, eventCount: b.lastEventSeq + 1 })) : []
  }

  /* ---------- 检查点：投影状态落盘，崩溃恢复从偏移续算 ---------- */

  checkpoint(simId, branchId) {
    const state = this.stateOf(simId, branchId)
    const events = this.eventsOf(simId, branchId)
    const untilSeq = events.length - 1
    const serial = serializeState(state, untilSeq)
    writeJsonAtomic(this._cpFile(simId, branchId), serial)
    const entry = this.cache.get(this._key(simId, branchId))
    if (entry) entry.dirty = false
    return { untilSeq }
  }

  checkpointAll() {
    const out = []
    for (const meta of this.sims.values()) {
      for (const b of meta.branches) {
        try { out.push({ simId: meta.id, branchId: b.id, ...this.checkpoint(meta.id, b.id) }) }
        catch (e) { console.error('checkpoint fail', meta.id, b.id, e.message) }
      }
    }
    return out
  }

  // 断线续演：返回客户端续接所需的最小信息
  resume(simId, clientId) {
    const meta = this.sims.get(simId)
    if (!meta) return null
    return {
      sim: { id: meta.id, name: meta.name, scenarioId: meta.scenarioId },
      branches: meta.branches.map((b) => ({ ...b, eventCount: b.lastEventSeq + 1 })),
      clientId
    }
  }
}

/* ---------------- 辅助 ---------------- */

function causalMerge(existing, accepted) {
  return causalTopoSort([...existing, ...accepted])
}

function rewriteLog(log, events) {
  // 原子替换：写临时文件后 rename，再重建追加句柄
  const tmp = log.file + '.rewrite-' + process.pid
  fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''))
  fs.renameSync(tmp, log.file)
  try { log.close() } catch { /* noop */ }
  log.fd = new JsonlLog(log.file).fd
}

function serializeState(state, untilSeq) {
  const appliedArr = state.appliedIds instanceof Set ? [...state.appliedIds] : state.appliedIds
  const copy = JSON.parse(JSON.stringify(state))
  delete copy.appliedIds
  copy.__appliedArr = appliedArr
  return { untilSeq, state: copy }
}

function normalizeStateForCache(state) {
  if (!(state.appliedIds instanceof Set)) state.appliedIds = new Set(state.appliedIds || [])
}

function parseHlcLoose(s) {
  return s ? hlcDecode(s) : null
}

function nowHHMM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function httpError(status, code, msg) {
  const e = new Error(msg || code)
  e.status = status; e.code = code
  return e
}
