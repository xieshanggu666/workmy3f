/* =========================================================================
 * archive —— 历史存储服务（唯一事实源，独立进程）
 *
 * 职责：
 *   1. 追加写事件日志（EventLog），分配 (realm, branchId) 内单调 seq；
 *   2. 幂等（eventId / 业务幂等键）、乐观并发标记（concurrent）、封存分支拒写；
 *   3. 分叉管理：fork 登记父子指针，不复制事件；
 *   4. 读取：按作用域/分叉链的因果事件流，供 replay 折叠；
 *   5. 推送：SSE 实时订阅（回放服务断线续演靠 Last-Event-ID 补拉）。
 * ========================================================================= */

import path from 'node:path'
import { createRouter, listen, readJson, send, sseHeartbeat, sseInit, sseSend } from '../shared/http.js'
import { ensure, genId, nowMs } from '../shared/util.js'
import { EVENT_TYPES, MAIN_BRANCH, REALM_REAL, makeEvent } from '../shared/events.js'
import { EventLog } from '../shared/store.js'
import { migrateLegacy } from '../shared/migrate.js'

const PORT = Number(process.env.ARCHIVE_PORT || 7102)
const DATA_DIR = process.env.ARCHIVE_DATA || path.join(process.cwd(), 'data', 'archive')

export function createArchive(dataDir = DATA_DIR) {
  const log = new EventLog(dataDir)

  const router = createRouter([
    {
      method: 'GET', pattern: '/v1/health',
      handler: async (_req, res) => send(res, 200, {
        ok: true, service: 'archive',
        scopes: log.listScopes().length,
        events: log.events.length,
        ts: nowMs()
      })
    },

    /* ---------- 追加 ---------- */
    {
      method: 'POST', pattern: '/v1/events/append',
      handler: async (req, res) => {
        const body = await readJson(req)
        const list = Array.isArray(body.events) ? body.events : [body.event || body]
        ensure(list.length && list.length <= 1000, 'bad_batch', '批量大小需在 1..1000', 400)
        const results = []
        for (const raw of list) {
          const event = makeEvent(raw) // 服务端侧再校验一次（不信任上游）
          const r = log.append(event)
          results.push({
            eventId: r.event.eventId, seq: r.event.seq,
            realm: r.event.realm, branchId: r.event.branchId,
            duplicated: r.duplicated, concurrent: r.concurrent
          })
        }
        send(res, 200, { results })
      }
    },

    /* ---------- 分叉 ---------- */
    {
      method: 'POST', pattern: '/v1/branches/fork',
      handler: async (req, res) => {
        const body = await readJson(req)
        const { realm, parentBranchId = MAIN_BRANCH, forkSeq, name } = body
        ensure(realm, 'bad_realm', '缺少 realm', 400)
        ensure(realm !== REALM_REAL || body.allowReal === true, 'realm_forbidden',
          '真实调度域默认禁止分叉演练（显式 allowReal 才放行，用于审计副本）', 403)
        ensure(Number.isInteger(forkSeq) && forkSeq >= 0, 'bad_fork_seq', 'forkSeq 必须是非负整数', 400)
        const branchId = body.branchId || genId('br')
        const meta = log.forkScope({
          realm, branchId,
          parentRealm: body.parentRealm || realm,
          parentBranchId, forkSeq
        })
        // 分叉动作本身作为事件落在子支（审计留痕）
        const forkEvent = makeEvent({
          realm, branchId,
          type: EVENT_TYPES.BRANCH_FORKED,
          data: { fromBranchId: parentBranchId, fromSeq: forkSeq, name: name || branchId },
          clientId: body.clientId || 'server'
        })
        log.append(forkEvent)
        send(res, 200, { branch: meta, forkEventId: forkEvent.eventId })
      }
    },
    {
      method: 'POST', pattern: '/v1/branches/seal',
      handler: async (req, res) => {
        const body = await readJson(req)
        ensure(body.realm && body.branchId, 'bad_scope', '缺少 realm/branchId', 400)
        const seal = makeEvent({
          realm: body.realm, branchId: body.branchId,
          type: EVENT_TYPES.BRANCH_SEALED, data: {}, clientId: 'server'
        })
        log.append(seal, { sealEvent: true })
        log.sealScope(body.realm, body.branchId)
        send(res, 200, { sealed: true })
      }
    },
    {
      method: 'GET', pattern: '/v1/scopes',
      handler: async (req, res) => {
        send(res, 200, { scopes: log.listScopes(req.query.realm || null) })
      }
    },

    /* ---------- 读取 ---------- */
    {
      // 某作用域完整因果事件流（含父支继承段），replay 全量重建用
      method: 'GET', pattern: '/v1/events',
      handler: async (req, res) => {
        const { realm, branchId = MAIN_BRANCH } = req.query
        ensure(realm, 'bad_realm', '缺少 realm', 400)
        const events = log.causalEvents(realm, branchId)
        send(res, 200, { realm, branchId, tipSeq: log.tipSeq(realm, branchId), events })
      }
    },
    {
      // 增量拉取：断线续演补数据（fromSeq 之后的本支自有事件）
      method: 'GET', pattern: '/v1/events/since',
      handler: async (req, res) => {
        const { realm, branchId = MAIN_BRANCH } = req.query
        const fromSeq = Number(req.query.fromSeq || 0)
        ensure(realm, 'bad_realm', '缺少 realm', 400)
        const events = log.ownEvents(realm, branchId).filter((e) => e.seq > fromSeq)
        send(res, 200, { realm, branchId, fromSeq, tipSeq: log.tipSeq(realm, branchId), events })
      }
    },
    {
      // SSE 实时订阅：?realm=&branchId=（可选）；断线后由 replay 侧用 /events/since 补齐缺口
      method: 'GET', pattern: '/v1/stream',
      handler: async (req, res) => {
        const { realm, branchId } = req.query
        sseInit(res)
        const filter = (e) => (!realm || e.realm === realm) && (!branchId || e.branchId === branchId)
        const unsubscribe = log.subscribe((e) => {
          if (!filter(e)) return
          try { sseSend(res, { event: 'event', id: `${e.realm}/${e.branchId}/${e.seq}`, data: e }) }
          catch { unsubscribe() }
        })
        const hb = setInterval(() => { try { sseHeartbeat(res) } catch { /* closed */ } }, 15000)
        req.on('close', () => { clearInterval(hb); unsubscribe() })
      }
    },

    /* ---------- 旧快照迁移 ---------- */
    {
      // 导入旧版 { frames:[...] } 全量快照历史 -> 事件流，写入指定 realm 的 main 分支
      method: 'POST', pattern: '/v1/migrate/legacy',
      handler: async (req, res) => {
        const body = await readJson(req, { limit: 64 * 1024 * 1024 })
        const realm = body.realm || REALM_REAL
        const existing = log.ownEvents(realm, MAIN_BRANCH)
        ensure(!existing.length, 'already_migrated',
          `作用域 ${realm}/main 已有 ${existing.length} 条事件，拒绝重复迁移（防双写）`, 409)
        const { events, report } = migrateLegacy({ ...body, realm })
        const results = events.map((e) => log.append(e))
        send(res, 200, {
          realm, branchId: MAIN_BRANCH,
          imported: results.length,
          report
        })
      }
    }
  ])

  return { router, log }
}

if (process.argv[1] && process.argv[1].endsWith('index.js') && process.env.ARCHIVE_EMBED !== '1') {
  const { router } = createArchive()
  const server = await listen(router, PORT)
  console.log(`[archive] listening on :${PORT}, data=${DATA_DIR}`)
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
