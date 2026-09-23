/* =========================================================================
 * EventLog —— archive 服务的落盘事件日志（唯一事实源）
 *
 * 存储形态（零依赖、可直接审计）：
 *   <dir>/events.jsonl   只追加日志，每行一个事件信封（信封不可变）
 *   <dir>/scopes.json    作用域元数据：分叉指针 {parentRealm,parentBranchId,forkSeq,sealed}
 *
 * 故障恢复：
 *   - 追加用 O_APPEND 单条 write（小于 PIPE_BUF 的行在内核层面不交错），fsync 后才应答；
 *   - 启动时扫描重放：重建每作用域 seq 游标与幂等表，截断末尾半行（崩溃写到一半的事件）；
 *   - seq 在单进程事件循环内原子分配（archive 是该作用域的唯一写入口，可水平分片按 realm 拆实例）。
 *
 * 分叉：子作用域不物理复制父分支事件，只记录 fork 指针；replay 折叠时
 *       沿 parentRealm/parentBranchId 链取父分支 [0..forkSeq] 段，再接本支事件。
 * ========================================================================= */

import fs from 'node:fs'
import path from 'node:path'
import { ensure } from './util.js'

const SCOPE_META_FILE = 'scopes.json'
const LOG_FILE = 'events.jsonl'

export class EventLog {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
    this.logPath = path.join(dir, LOG_FILE)
    this.metaPath = path.join(dir, SCOPE_META_FILE)
    this.events = []                                  // 全量事件（启动扫描重建）
    this.byId = new Map()                             // eventId -> event
    this.idem = new Map()                             // `${scope}|${idemKey}` -> eventId
    this.maxSeq = new Map()                           // scope -> 已分配最大 seq
    this.scopes = new Map()                           // `${realm}|${branchId}` -> meta
    this.listeners = new Set()                        // 持久订阅者（归档推送）
    this._recover()
  }

  scopeKey(realm, branchId) { return `${realm}|${branchId}` }

  _recover() {
    // 1) 作用域元数据
    if (fs.existsSync(this.metaPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'))
        Object.entries(raw).forEach(([k, v]) => this.scopes.set(k, v))
      } catch { /* 元数据损坏不应阻断事件日志恢复；按无分叉信息降级（告警由上层打） */ }
    }
    // 2) 只追加日志：逐行解析，末行残缺则截断（崩溃在一次 write 中途）
    if (!fs.existsSync(this.logPath)) return
    const buf = fs.readFileSync(this.logPath, 'utf8')
    const lines = buf.split('\n')
    const kept = []
    let dirty = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      try {
        const e = JSON.parse(line)
        if (!e || !e.eventId || !e.type) throw new Error('bad envelope')
        kept.push(e)
      } catch {
        // 末行写坏：丢弃本行及其后全部内容（只追加日志里只可能是末尾）
        dirty = true
        break
      }
    }
    kept.sort((a, b) => a.seq - b.seq || a.eventId.localeCompare(b.eventId))
    kept.forEach((e) => this._index(e))
    if (dirty) this._rewrite(kept)
  }

  _index(e) {
    const sk = this.scopeKey(e.realm, e.branchId)
    // 恢复重放时若同 eventId 已在（理论不会，日志不重写已有行）则以先入为准
    if (!this.byId.has(e.eventId)) this.events.push(e)
    this.byId.set(e.eventId, e)
    if (e.idempotencyKey) this.idem.set(`${sk}|${e.idempotencyKey}`, e.eventId)
    const cur = this.maxSeq.get(sk) || 0
    if (e.seq > cur) this.maxSeq.set(sk, e.seq)
  }

  // 崩溃恢复后若裁掉了半行，用干净内容重写日志（仅这一处非追加写）
  _rewrite(kept) {
    const tmp = this.logPath + '.tmp'
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''))
    fs.renameSync(tmp, this.logPath)
  }

  _persistMeta() {
    const obj = {}
    this.scopes.forEach((v, k) => { obj[k] = v })
    const tmp = this.metaPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, this.metaPath)
  }

  _appendLine(e) {
    const fd = fs.openSync(this.logPath, 'a')
    try {
      fs.writeSync(fd, JSON.stringify(e) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  /* ---------- 作用域 / 分叉 ---------- */

  ensureScope(realm, branchId, meta = null) {
    const sk = this.scopeKey(realm, branchId)
    if (!this.scopes.has(sk)) {
      this.scopes.set(sk, {
        realm, branchId,
        parentRealm: meta?.parentRealm || null,
        parentBranchId: meta?.parentBranchId || null,
        forkSeq: Number.isInteger(meta?.forkSeq) ? meta.forkSeq : null,
        sealed: false,
        createdAt: Date.now()
      })
      this._persistMeta()
    }
    return this.scopes.get(sk)
  }

  getScopeMeta(realm, branchId) {
    return this.scopes.get(this.scopeKey(realm, branchId)) || null
  }

  // 分叉：校验父支存在、forkSeq 不越界；登记子作用域（不复制事件）
  forkScope({ realm, branchId, parentRealm, parentBranchId, forkSeq }) {
    const parentSk = this.scopeKey(parentRealm, parentBranchId)
    ensure(this.scopes.has(parentSk), 'parent_scope_missing', '父分支不存在，无法分叉', 409)
    const parentTip = this.maxSeq.get(parentSk) || 0
    ensure(forkSeq >= 0 && forkSeq <= parentTip, 'fork_seq_out_of_range',
      `分叉点越界（父支末端 seq=${parentTip}）`, 409, { forkSeq, parentTip })
    const sk = this.scopeKey(realm, branchId)
    ensure(!this.scopes.has(sk), 'scope_exists', '目标分支已存在', 409)
    this.scopes.set(sk, {
      realm, branchId, parentRealm, parentBranchId, forkSeq,
      sealed: false, createdAt: Date.now()
    })
    this.maxSeq.set(sk, 0) // 子支自有事件从 1 起（0 留给链路上的分叉基线）
    this._persistMeta()
    return this.scopes.get(sk)
  }

  sealScope(realm, branchId) {
    const meta = this.ensureScope(realm, branchId)
    meta.sealed = true
    this._persistMeta()
  }

  listScopes(realm = null) {
    return [...this.scopes.values()].filter((m) => !realm || m.realm === realm)
  }

  /* ---------- 追加 ---------- */

  /**
   * 追加事件。
   * @returns {{event:object, duplicated:boolean, concurrent:boolean}}
   *  - 幂等：同 eventId 重放直接返回旧事件（duplicated=true）
   *  - 业务幂等键：同作用域内同 idempotencyKey 拒绝（idempotent_conflict）
   *  - 乐观并发：expectedSeq 落后于末端且 prevId 非末端事件 => concurrent=true（不拒绝）
   *  - 封存：sealed 作用域只接受只读元数据事件（由上层再挡）
   */
  append(incoming, { sealEvent = false } = {}) {
    const e = incoming
    const sk = this.scopeKey(e.realm, e.branchId)
    // 自动补建主作用域（realm.opened 之外的首个事件也能落）
    this.ensureScope(e.realm, e.branchId)
    const meta = this.scopes.get(sk)
    ensure(!meta.sealed || sealEvent, 'scope_sealed', '分支已封存，拒绝写入', 409)

    const existing = this.byId.get(e.eventId)
    if (existing) return { event: existing, duplicated: true, concurrent: existing.concurrent }

    if (e.idempotencyKey) {
      const prevEventId = this.idem.get(`${sk}|${e.idempotencyKey}`)
      ensure(!prevEventId, 'idempotent_conflict',
        '业务幂等键冲突（该操作已受理过，请勿重复提交）', 409, { eventId: prevEventId })
    }

    const tipSeq = this.maxSeq.get(sk) || 0
    const nextSeq = tipSeq + 1
    // 因果检测：客户端预期序号 < 末端 => 它基于旧态势提交，与末端事件并发
    let concurrent = false
    if (e.expectedSeq != null && e.expectedSeq < tipSeq) concurrent = true
    if (e.prevId) {
      const prev = this.byId.get(e.prevId)
      if (!prev || prev.realm !== e.realm || prev.branchId !== e.branchId) {
        // prevId 指向别处（跨分支）：按并发处理而不是拒绝，便于现场弱网容错
        concurrent = true
      }
    }

    const stored = {
      ...e,
      seq: nextSeq,
      concurrent,
      branchSeq: nextSeq,
      ingestedAt: Date.now()
    }
    this._appendLine(stored)
    this._index(stored)

    for (const fn of this.listeners) {
      try { fn(stored) } catch { /* 订阅者异常不影响落盘 */ }
    }
    return { event: stored, duplicated: false, concurrent }
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /* ---------- 读取 ---------- */

  // 取某作用域自有事件（不含父支继承段），按因果序
  ownEvents(realm, branchId) {
    return this.events
      .filter((e) => e.realm === realm && e.branchId === branchId)
      .sort((a, b) => a.seq - b.seq || a.eventId.localeCompare(b.eventId))
  }

  // 取「沿分叉链」的完整因果事件流（根→末端）：
  // 自末端分支沿 fork 指针回溯到根，父支段按 forkSeq 截断后与各子支段顺序拼接。
  // 各段来自不同作用域（或父支的截断子段），事件不重复。
  causalEvents(realm, branchId) {
    const chain = []
    let node = { realm, branchId, maxSeq: null }
    const guard = new Set()
    while (node) {
      const key = this.scopeKey(node.realm, node.branchId)
      if (guard.has(key)) throw new Error('fork_cycle: 分叉链存在环，作用域元数据可能损坏')
      guard.add(key)
      chain.push(node)
      const meta = this.scopes.get(key)
      if (!meta || meta.parentBranchId == null) break
      node = { realm: meta.parentRealm, branchId: meta.parentBranchId, maxSeq: meta.forkSeq }
    }
    const out = []
    chain.reverse().forEach((seg) => {
      let own = this.ownEvents(seg.realm, seg.branchId)
      if (seg.maxSeq != null) own = own.filter((e) => e.seq <= seg.maxSeq)
      own.forEach((e) => out.push(e))
    })
    return out
  }

  tipSeq(realm, branchId) { return this.maxSeq.get(this.scopeKey(realm, branchId)) || 0 }

  get(eventId) { return this.byId.get(eventId) || null }
}
