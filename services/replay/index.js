/* =========================================================================
 * replay —— 回放计算服务（独立进程，无状态事实源，只持有派生缓存）
 *
 * 职责：
 *   1. 从 archive 拉取因果事件流，按因果序折叠重建 库存 / 床位 / 运输 三类投影；
 *   2. 实时订阅 + 增量折叠；乱序/迟到事件导致因果断裂时自动降级为全量重建
 *      （重建结果确定性，与从头折叠逐字节一致）；
 *   3. 多人并行推演：会话记录参与者与分支选择；断线带 resumeToken 重连续演；
 *   4. 时间点回放：任意 seq 的状态切片（历史 seek），不污染实时缓存；
 *   5. 分支对照：两分支末端投影逐维度 diff（事件/库存/床位/运输/阻断/抢修）；
 *   6. 只读守门：回放态（seek 历史点）严禁写入 —— 写请求必须先 resume 到分支末端。
 *
 * 缓存失效：archive 事件的 (scope, tipSeq) 变化即缓存版本；版本不符丢弃缓存重建，
 *           因此 replay 任意时刻崩溃都安全（重建自唯一事实源）。
 * ========================================================================= */

import { createRouter, listen, readJson, send } from '../shared/http.js'
import { DomainError, ensure, genId, nowMs, stableStringify } from '../shared/util.js'
import { MAIN_BRANCH } from '../shared/events.js'
import { emptyState, fold, foldInto, projectView } from '../shared/reducer.js'

const DEFAULT_PORT = Number(process.env.REPLAY_PORT || 7103)
const DEFAULT_ARCHIVE_URL = process.env.ARCHIVE_URL || 'http://127.0.0.1:7102'

async function fetchJson(url, init, timeoutMs = 4000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, init ? {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal
    } : { signal: ctrl.signal })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new DomainError(body.error || 'archive_error', body.message || `archive ${res.status}`, res.status)
    return body
  } finally { clearTimeout(t) }
}

/* ---------------- 投影引擎（每作用域一份可重建缓存） ---------------- */

class ProjectionEngine {
  constructor(archiveUrl = DEFAULT_ARCHIVE_URL) {
    this.archiveUrl = archiveUrl
    this.cache = new Map() // scope -> { tipSeq, state }
  }
  key(realm, branchId) { return `${realm}|${branchId}` }

  // 全量重建：拉分叉链完整因果流，从头折叠
  async rebuild(realm, branchId) {
    const { events, tipSeq } = await fetchJson(
      `${this.archiveUrl}/v1/events?realm=${encodeURIComponent(realm)}&branchId=${encodeURIComponent(branchId)}`)
    const state = fold(events, emptyState())
    const entry = { tipSeq, state, fingerprint: stableStringify(projectView(state)) }
    this.cache.set(this.key(realm, branchId), entry)
    return entry
  }

  async get(realm, branchId) {
    const cached = this.cache.get(this.key(realm, branchId))
    if (!cached) return this.rebuild(realm, branchId)
    // 与 archive 对账末端 seq，一致直接复用
    const { tipSeq } = await fetchJson(
      `${this.archiveUrl}/v1/events/since?realm=${encodeURIComponent(realm)}&branchId=${encodeURIComponent(branchId)}&fromSeq=${cached.tipSeq}`)
    if (tipSeq === cached.tipSeq) return cached
    // 末端前进：先尝试增量（断线/正常订阅路径），断裂则全量重建（乱序补齐/分叉段切换）
    const since = await fetchJson(
      `${this.archiveUrl}/v1/events/since?realm=${encodeURIComponent(realm)}&branchId=${encodeURIComponent(branchId)}&fromSeq=${cached.tipSeq}`)
    if (!since.events.length) {
      cached.tipSeq = tipSeq
      return cached
    }
    try {
      foldInto(cached.state, since.events, { expectContinuous: true })
      cached.tipSeq = tipSeq
      cached.fingerprint = stableStringify(projectView(cached.state))
    } catch (err) {
      if (err.code === 'causal_gap') return this.rebuild(realm, branchId)
      throw err
    }
    return cached
  }

  // 历史时间点切片：折叠到 seq<=targetSeq（不写入缓存；大回放可让 archive 支持 atSeq 拉取）
  async at(realm, branchId, targetSeq) {
    const { events } = await fetchJson(
      `${this.archiveUrl}/v1/events?realm=${encodeURIComponent(realm)}&branchId=${encodeURIComponent(branchId)}`)
    const cut = events.filter((e) => e.seq <= targetSeq)
    const state = fold(cut, emptyState())
    return { tipSeq: targetSeq, state, fingerprint: stableStringify(projectView(state)) }
  }
}

const engine = null // 实际实例在 createReplay 中创建（支持注入 archiveUrl）

/* ---------------- 多人会话（断线续演） ---------------- */

function createSessionStore() {
  const sessions = new Map() // sessionId -> session
  const sessionByClient = new Map() // `${realm}|${clientId}` -> sessionId

  function createSession({ realm, branchId, clientId, role, resumeToken }) {
    // 断线续演：同 realm+clientId 的旧会话仍存活时，按 token 恢复其分支/游标
    const ck = `${realm}|${clientId}`
    const oldId = resumeToken || sessionByClient.get(ck)
    const old = oldId ? sessions.get(oldId) : null
    if (old) {
      old.disconnectedAt = null
      old.resumedAt = nowMs()
      old.resumeCount++
      sessionByClient.set(ck, old.id)
      return { session: old, resumed: true }
    }
    const id = genId('sess')
    const session = {
      id, realm, branchId, clientId, role: role || 'commander',
      mode: 'live', cursorSeq: null,
      joinedAt: nowMs(), resumedAt: nowMs(), resumeCount: 0,
      disconnectedAt: null, version: 0
    }
    sessions.set(id, session)
    sessionByClient.set(ck, id)
    return { session, resumed: false }
  }

  return { sessions, createSession }
}

/* ---------------- 分支末端对照（复用现有 reducer 投影） ---------------- */

function diff(a, b) {
  const rows = []
  const add = (dim, label, va, vb, same = va === vb) => { if (!same) rows.push({ dim, label, a: va, b: vb }) }

  // 库存（基地 × 资源）
  const stockKeys = new Set()
  ;[a, b].forEach((st) => Object.keys(st.bases).forEach((bid) => {
    Object.keys(st.bases[bid].stock).forEach((r) => stockKeys.add(`${bid}|${r}`))
  }))
  stockKeys.forEach((k) => {
    const [bid, r] = k.split('|')
    const qa = a.bases[bid]?.stock[r]?.qty
    const qb = b.bases[bid]?.stock[r]?.qty
    if (qa !== qb) {
      rows.push({ dim: '基地库存', label: `${a.bases[bid]?.name || b.bases[bid]?.name || bid} · ${r}`, a: qa ?? '—', b: qb ?? '—' })
    }
  })

  // 床位
  ;[...new Set([...Object.keys(a.shelters), ...Object.keys(b.shelters)])].forEach((id) => {
    const x = a.shelters[id], y = b.shelters[id]
    const ox = x ? `${x.occupied}/${x.capacity}` : '—'
    const oy = y ? `${y.occupied}/${y.capacity}` : '—'
    if (ox !== oy) rows.push({ dim: '安置床位', label: y?.name || x?.name || id, a: ox, b: oy })
  })

  // 运输
  ;[...new Set([...Object.keys(a.shipments), ...Object.keys(b.shipments)])].forEach((id) => {
    const x = a.shipments[id], y = b.shipments[id]
    const sx = x ? `${x.status}｜签${x.signedQty || 0}/退${x.returnedQty || 0}` : '—'
    const sy = y ? `${y.status}｜签${y.signedQty || 0}/退${y.returnedQty || 0}` : '—'
    if (sx !== sy) rows.push({ dim: '运输状态', label: id, a: sx, b: sy })
  })

  // 阻断
  ;[...new Set([...Object.keys(a.blocks), ...Object.keys(b.blocks)])].forEach((id) => {
    const x = a.blocks[id], y = b.blocks[id]
    add('道路阻断', y?.name || x?.name || id, x ? x.status : '—', y ? y.status : '—')
  })

  // 抢修
  ;[...new Set([...Object.keys(a.repairs), ...Object.keys(b.repairs)])].forEach((id) => {
    const x = a.repairs[id], y = b.repairs[id]
    add('抢修工单', id, x ? `${x.status} ${x.progress}%` : '—', y ? `${y.status} ${y.progress}%` : '—')
  })

  return rows
}

/* ---------------- 路由 ---------------- */

export function createReplay(opts = {}) {
  const archiveUrl = opts.archiveUrl || DEFAULT_ARCHIVE_URL
  const engine = new ProjectionEngine(archiveUrl)
  const { sessions, createSession } = createSessionStore()
  const router = createRouter([
    {
      method: 'GET', pattern: '/v1/health',
      handler: async (_req, res) => send(res, 200, { ok: true, service: 'replay', sessions: sessions.size, ts: nowMs() })
    },

    /* ---------- 多人推演会话 ---------- */
    {
      // 开会话 / 断线重连（带 resumeToken 即续演：恢复分支与游标）
      method: 'POST', pattern: '/v1/sessions',
      handler: async (req, res) => {
        const body = await readJson(req)
        ensure(body.realm && body.clientId, 'bad_session', '缺少 realm/clientId', 400)
        const { session, resumed } = createSession({
          realm: body.realm,
          branchId: body.branchId || MAIN_BRANCH,
          clientId: body.clientId,
          role: body.role,
          resumeToken: body.resumeToken
        })
        const entry = await engine.get(session.realm, session.branchId)
        session.tipSeq = entry.tipSeq
        send(res, 200, {
          sessionId: session.id,
          resumeToken: session.id,
          resumed,
          realm: session.realm, branchId: session.branchId,
          mode: session.mode, cursorSeq: session.cursorSeq,
          tipSeq: entry.tipSeq,
          resumeCount: session.resumeCount
        })
      }
    },
    {
      // 心跳 / 断线标记（SSE/WS 由网关维护时，心跳保活会话）
      method: 'POST', pattern: '/v1/sessions/:id/heartbeat',
      handler: async (req, res) => {
        const s = sessions.get(req.params.id)
        ensure(s, 'no_session', '会话不存在或已过期', 404)
        s.tipSeq = (await engine.get(s.realm, s.branchId)).tipSeq
        send(res, 200, { ok: true, tipSeq: s.tipSeq })
      }
    },
    {
      // 断线续演：返回「客户端最后已知 seq」之后的增量事件 + 当前投影，供客户端追平
      method: 'POST', pattern: '/v1/sessions/:id/resync',
      handler: async (req, res) => {
        const s = sessions.get(req.params.id)
        ensure(s, 'no_session', '会话不存在或已过期', 404)
        const body = await readJson(req).catch(() => ({}))
        const clientSeq = Number(body.lastSeq || 0)
        const since = await fetchJson(
          `${archiveUrl}/v1/events/since?realm=${encodeURIComponent(s.realm)}&branchId=${encodeURIComponent(s.branchId)}&fromSeq=${clientSeq}`)
        const entry = await engine.get(s.realm, s.branchId)
        s.disconnectedAt = null
        send(res, 200, {
          caughtUp: since.tipSeq === entry.tipSeq && since.events.length === 0,
          missedEvents: since.events,
          tipSeq: entry.tipSeq,
          view: projectView(entry.state),
          fingerprint: entry.fingerprint
        })
      }
    },

    /* ---------- 投影读取 ---------- */
    {
      // 实时末端态势：库存/床位/运输/阻断/抢修
      method: 'GET', pattern: '/v1/state',
      handler: async (req, res) => {
        const realm = req.query.realm
        ensure(realm, 'bad_realm', '缺少 realm', 400)
        const branchId = req.query.branchId || MAIN_BRANCH
        const entry = await engine.get(realm, branchId)
        send(res, 200, {
          realm, branchId, tipSeq: entry.tipSeq,
          fingerprint: entry.fingerprint,
          view: projectView(entry.state)
        })
      }
    },
    {
      // 库存 / 床位 / 运输 三个正交子视图（题目三类状态的独立重建入口）
      method: 'GET', pattern: '/v1/state/:kind',
      handler: async (req, res) => {
        const { realm } = req.query
        ensure(realm, 'bad_realm', '缺少 realm', 400)
        const branchId = req.query.branchId || MAIN_BRANCH
        const entry = await engine.get(realm, branchId)
        const view = projectView(entry.state)
        const map = {
          stock: { bases: view.bases },
          beds: { shelters: view.shelters },
          transport: { shipments: view.shipments, blocks: view.blocks }
        }
        ensure(map[req.params.kind], 'bad_kind', 'kind 仅支持 stock|beds|transport', 404)
        send(res, 200, { realm, branchId, tipSeq: entry.tipSeq, ...map[req.params.kind] })
      }
    },

    /* ---------- 历史时间点回放（只读） ---------- */
    {
      method: 'POST', pattern: '/v1/replay/seek',
      handler: async (req, res) => {
        const body = await readJson(req)
        ensure(body.realm && Number.isInteger(body.seq), 'bad_seek', '需要 realm 与整数 seq', 400)
        const branchId = body.branchId || MAIN_BRANCH
        const entry = await engine.at(body.realm, branchId, body.seq)
        if (body.sessionId) {
          const s = sessions.get(body.sessionId)
          ensure(s, 'no_session', '会话不存在或已过期', 404)
          // 进入历史回放：会话锁定只读，写操作被 /guard/writable 拦截
          s.mode = 'review'
          s.cursorSeq = body.seq
        }
        send(res, 200, {
          realm: body.realm,
          branchId,
          seq: body.seq,
          readOnly: true,
          view: projectView(entry.state)
        })
      }
    },
    {
      // 退出历史回放、回到分支末端「继续推演」（live），解除只读锁定
      method: 'POST', pattern: '/v1/replay/resume-live',
      handler: async (req, res) => {
        const body = await readJson(req)
        const s = sessions.get(body.sessionId)
        ensure(s, 'no_session', '会话不存在或已过期', 404)
        s.mode = 'live'
        s.cursorSeq = null
        if (body.branchId) s.branchId = body.branchId
        const entry = await engine.get(s.realm, s.branchId)
        s.tipSeq = entry.tipSeq
        send(res, 200, {
          mode: 'live', realm: s.realm, branchId: s.branchId,
          tipSeq: entry.tipSeq, view: projectView(entry.state)
        })
      }
    },

    /* ---------- 分支对照 ---------- */
    {
      method: 'POST', pattern: '/v1/branches/compare',
      handler: async (req, res) => {
        const body = await readJson(req)
        ensure(body.realm && body.a && body.b, 'bad_compare', '需要 realm 与两个分支 id a/b', 400)
        const [ea, eb] = await Promise.all([
          engine.get(body.realm, body.a), engine.get(body.realm, body.b)
        ])
        const rows = diff(projectView(ea.state), projectView(eb.state))
        send(res, 200, {
          realm: body.realm, a: body.a, b: body.b,
          tipA: ea.tipSeq, tipB: eb.tipSeq,
          diffCount: rows.length, rows
        })
      }
    },

    /* ---------- 只读守门：历史回放态不允许业务写 ---------- */
    {
      // 业务网关在回放（seek）模式下调用，校验该会话是否允许继续写；必须先回到 live
      method: 'POST', pattern: '/v1/guard/writable',
      handler: async (req, res) => {
        const body = await readJson(req)
        if (body.sessionId) {
          const s = sessions.get(body.sessionId)
          if (s && s.mode === 'review') {
            throw new DomainError('read_only_replay',
              '当前处于历史回放只读态：请先「返回末端继续推演」(resume live) 再提交调度', 409)
          }
        }
        send(res, 200, { writable: true })
      }
    },

    {
      method: 'GET', pattern: '/v1/sessions',
      handler: async (_req, res) => send(res, 200, {
        sessions: [...sessions.values()].map((s) => ({
          id: s.id, realm: s.realm, branchId: s.branchId, clientId: s.clientId,
          role: s.role, mode: s.mode, tipSeq: s.tipSeq, resumeCount: s.resumeCount,
          disconnectedAt: s.disconnectedAt
        }))
      })
    }
  ])
  return { router, engine, sessions }
}

/* ---------------- CLI 启动 ---------------- */

const isMain = process.argv[1] && process.argv[1].endsWith('replay/index.js')
if (isMain && process.env.REPLAY_EMBED !== '1') {
  const port = Number(process.env.REPLAY_PORT || 7103)
  const archiveUrl = process.env.ARCHIVE_URL || 'http://127.0.0.1:7102'
  const { router } = createReplay({ archiveUrl })
  const server = await listen(router, port)
  console.log(`[replay] listening on :${port} -> archive ${archiveUrl}`)
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
