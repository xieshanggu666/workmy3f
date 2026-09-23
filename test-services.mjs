/* =========================================================================
 * 三服务架构集成/单元回归（零依赖，node test-services.mjs）
 *
 * 覆盖：
 *  A. 内核单元：EventLog 崩溃恢复（半行截断/序号续接）、多级分叉链、
 *     reducer 守恒与不变量拦截、乱序并发标记、迁移纯函数
 *  B. HTTP 联调：collector→archive→replay 闭环；库存/床位/运输因果重建；
 *     多人会话与断线续演(resumeToken/resync)；历史 seek 与只读锁定；
 *     分支并发写入与末端对照；封存拒写；幂等；
 *     archive 宕机 outbox 补投、archive/replay 重启恢复；
 *     旧快照迁移；真实调度域令牌隔离
 * ========================================================================= */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { listen } from './services/shared/http.js'
import { EventLog } from './services/shared/store.js'
import { EVENT_TYPES, MAIN_BRANCH, makeEvent } from './services/shared/events.js'
import { emptyState, fold, foldInto, projectView } from './services/shared/reducer.js'
import { migrateLegacy } from './services/shared/migrate.js'
import { createArchive } from './services/archive/index.js'
import { createCollector } from './services/collector/index.js'
import { createReplay } from './services/replay/index.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, { timeout = 4000, interval = 25, label = '' } = {}) {
  const t0 = Date.now()
  let lastErr
  while (Date.now() - t0 < timeout) {
    try { const r = await fn(); if (r) return r }
    catch (e) { lastErr = e }
    await sleep(interval)
  }
  throw new Error(`waitFor 超时（${label}）${lastErr ? '：' + lastErr.message : ''}`)
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'es-svc-'))
const open = (router) => new Promise((resolve) => {
  const server = http.createServer(router)
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})
const close = (s) => new Promise((r) => s.server.close(r))

async function api(port, method, urlPath, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, body: json }
}

const T = EVENT_TYPES

/* =========================================================================
 * A. 内核单元
 * ========================================================================= */

console.log('\n== A1. EventLog：崩溃恢复（半行截断、序号续接、幂等重建） ==')
{
  const dir = tmp()
  const log1 = new EventLog(dir)
  log1.append(makeEvent({ realm: 'wg:u', type: T.REALM_OPENED, data: { realm: 'wg:u' } }))
  log1.append(makeEvent({ realm: 'wg:u', type: T.STOCK_GRANTED, data: { baseId: 'b', resource: 'water', qty: 5 } }))
  // 模拟崩溃写到一半的残行
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":3,"eventId":"bro')
  const log2 = new EventLog(dir)
  assert(log2.events.length === 2, '重启后半行被截断，前两条事件完好')
  const r = log2.append(makeEvent({ realm: 'wg:u', type: T.STOCK_GRANTED, data: { baseId: 'b', resource: 'water', qty: 1 } }))
  assert(r.event.seq === 3, '新事件序号从崩溃前水位续接为 3')
  const same = log2.append(makeEvent({ eventId: log2.events[0].eventId, realm: 'wg:u', type: T.REALM_OPENED, data: { realm: 'wg:u' } }))
  assert(same.duplicated === true, '同 eventId 重放判定为重复（幂等）')
}

console.log('\n== A2. 多级分叉链：根→子→孙，父支截断、各支独立 ==')
{
  const dir = tmp()
  const log = new EventLog(dir)
  const open = () => log.append(makeEvent({ realm: 'wg:f', type: T.REALM_OPENED, data: { realm: 'wg:f' } }))
  open()
  const grant = (q, branch = MAIN_BRANCH) => log.append(makeEvent({
    realm: 'wg:f', branchId: branch, type: T.STOCK_GRANTED, data: { baseId: 'b1', resource: 'water', qty: q }
  }))
  grant(100)                                   // main seq2
  log.forkScope({ realm: 'wg:f', branchId: 'c1', parentRealm: 'wg:f', parentBranchId: 'main', forkSeq: 2 })
  grant(10, 'c1')                              // c1 seq1
  grant(50)                                    // main seq3（分叉后父支继续前进）
  log.forkScope({ realm: 'wg:f', branchId: 'c2', parentRealm: 'wg:f', parentBranchId: 'c1', forkSeq: 1 })
  grant(7, 'c2')                               // c2 seq1
  const main = log.causalEvents('wg:f', 'main').map((e) => e.seq)
  const c1 = log.causalEvents('wg:f', 'c1').map((e) => `${e.branchId}:${e.seq}`)
  const c2 = log.causalEvents('wg:f', 'c2').map((e) => `${e.branchId}:${e.seq}`)
  assert(JSON.stringify(main) === '[1,2,3]', `主干事件序正确（${main}）`)
  assert(JSON.stringify(c1) === '["main:1","main:2","c1:1"]', `子支继承父支分叉点之前、不见父支新事件（${c1}）`)
  assert(JSON.stringify(c2) === '["main:1","main:2","c1:1","c2:1"]', `孙支链沿两级分叉展开（${c2}）`)
  const sealed = (() => { log.sealScope('wg:f', 'c1'); let threw = null; try { log.append(makeEvent({ realm: 'wg:f', branchId: 'c1', type: T.STOCK_GRANTED, data: { baseId: 'b1', resource: 'water', qty: 1 } })) } catch (e) { threw = e.code }; return threw })()
  assert(sealed === 'scope_sealed', '封存分支拒绝写入')
}

console.log('\n== A3. reducer：库存/床位守恒与业务不变量拦截 ==')
{
  const events = [
    makeEvent({ realm: 'wg:r', type: T.REALM_OPENED, data: { realm: 'wg:r', bases: [{ id: 'b1', name: '基地', stock: { water: 100 } }], shelters: [{ id: 's1', name: '点', capacity: 10 }] } }),
    makeEvent({ realm: 'wg:r', type: T.STOCK_RESERVED, data: { baseId: 'b1', resource: 'water', qty: 40, refId: 'r1' } }),
    makeEvent({ realm: 'wg:r', type: T.STOCK_ALLOCATED, data: { baseId: 'b1', resource: 'water', qty: 40, refId: 'r1', consumeReserve: true } }),
    makeEvent({ realm: 'wg:r', type: T.STOCK_RETURNED, data: { baseId: 'b1', resource: 'water', qty: 5, refId: 'r1' } }),
    makeEvent({ realm: 'wg:r', type: T.BED_RESERVED, data: { shelterId: 's1', qty: 8, refId: 'bed1' } }),
    makeEvent({ realm: 'wg:r', type: T.BED_OCCUPIED, data: { shelterId: 's1', qty: 8, refId: 'bed1', consumeReserve: true } }),
    makeEvent({ realm: 'wg:r', type: T.BED_FREED, data: { shelterId: 's1', qty: 3, refId: 'bedout1' } })
  ]
  const v = projectView(fold(events))
  const w = v.bases.b1.stock.water
  assert(w.qty === 65, `库存余量守恒：100 − 40 + 5 = 65（实际 ${w.qty}）`)
  assert(w.available === 65 && w.reserved === 0, `预占已转实扣，可用=余量（available=${w.available}）`)
  const s = v.shelters.s1
  assert(s.occupied === 5 && s.free === 5 && s.reserved === 0, `床位守恒：入住8转出3，在住5空余5（occ=${s.occupied},free=${s.free}）`)

  const code = (extra) => { try { fold([...events, extra()]); return null } catch (e) { return e.code } }
  assert(code(() => makeEvent({ realm: 'wg:r', type: T.STOCK_ALLOCATED, data: { baseId: 'b1', resource: 'water', qty: 999, refId: 'x1' } })) === 'invariant_violation', '超扣库存被拦截')
  assert(code(() => makeEvent({ realm: 'wg:r', type: T.BED_RESERVED, data: { shelterId: 's1', qty: 99, refId: 'x2' } })) === 'invariant_violation', '超容量预占床位被拦截')
  assert(code(() => makeEvent({ realm: 'wg:r', type: T.STOCK_RESERVE_RELEASED, data: { refId: 'r1' } })) === 'ref_state', '重复释放已核销预占被拦截')

  // 抢修进度单调递增
  const repEvents = [
    makeEvent({ realm: 'wg:r', type: T.REPAIR_ORDER_CREATED, data: { orderId: 'o1', blockId: 'bk1' } }),
    makeEvent({ realm: 'wg:r', type: T.REPAIR_PROGRESS, data: { orderId: 'o1', progress: 60 } })
  ]
  const regressCode = (() => {
    try { fold([...repEvents, makeEvent({ realm: 'wg:r', type: T.REPAIR_PROGRESS, data: { orderId: 'o1', progress: 40 } })]) ; return null }
    catch (e) { return e.code }
  })()
  assert(regressCode === 'invariant_violation', '抢修进度从 60 倒退到 40 被拦截')
  const doneView = projectView(fold([...repEvents, makeEvent({ realm: 'wg:r', type: T.REPAIR_PROGRESS, data: { orderId: 'o1', progress: 100 } })]))
  assert(doneView.repairs.o1.status === 'done' && doneView.repairs.o1.progress === 100, '进度达 100% 工单进入待验收')
}

console.log('\n== A4. 乱序：增量折叠遇因果断裂自动报 gap（上层全量重建） ==')
{
  const base = emptyState()
  const e1 = makeEvent({ realm: 'wg:o', type: T.REALM_OPENED, data: { realm: 'wg:o', bases: [{ id: 'b', name: '库', stock: { water: 0 } }] } })
  const e2 = makeEvent({ realm: 'wg:o', type: T.STOCK_GRANTED, data: { baseId: 'b', resource: 'water', qty: 1 }, prevId: 'missing-id' })
  let code = null
  try { foldInto(base, [e1, e2]) } catch (e) { code = e.code }
  assert(code === 'causal_gap', '迟到事件指向未知 prevId 时增量链报 causal_gap')
  // 全量重放（按 seq 排好序、因果补正）始终成功 —— replay 降级重建路径
  const ordered = [{ ...e1, seq: 1 }, { ...e2, seq: 2, prevId: null }]
  const rebuilt = fold(ordered, emptyState())
  assert(rebuilt.opened === true && rebuilt.bases.b.stock.water.granted === 1, '全量重建不受增量断裂影响，迟到事件归位入账')
}

console.log('\n== A5. 旧快照迁移（纯函数）：frames diff -> 事件流，账目对齐不挂锚点 ==')
{
  const legacy = {
    name: '旧演练',
    frames: [
      { t: 1000, seq: 0, snapshot: { cmd: { bases: [{ id: 'b1', name: '基地', stock: { water: 100 } }], dispatches: [], events: [] }, tr: { shelters: [{ id: 's1', name: '点', capacity: 100 }], batches: [], settleDay: 1 }, rb: { blocks: [] }, ro: { orders: [] } } },
      { t: 2000, seq: 1, snapshot: { cmd: { bases: [{ id: 'b1', name: '基地', stock: { water: 90 } }], dispatches: [{ id: 'd1', type: 'water', qty: 10, baseId: 'b1', status: 'enroute', signedQty: 0, shortQty: 0, returnedQty: 0 }], events: [] }, tr: { shelters: [{ id: 's1', name: '点', capacity: 100 }], batches: [{ shelterId: 's1', members: Array.from({ length: 5 }, () => ({ checkinAt: 1, checkoutAt: null })) }], settleDay: 1 }, rb: { blocks: [] }, ro: { orders: [] } } },
      { t: 3000, seq: 2, snapshot: { cmd: { bases: [{ id: 'b1', name: '基地', stock: { water: 90 } }], dispatches: [{ id: 'd1', type: 'water', qty: 10, baseId: 'b1', status: 'enroute', signedQty: 10, shortQty: 0, returnedQty: 0 }], events: [] }, tr: { shelters: [{ id: 's1', name: '点', capacity: 100 }], batches: [{ shelterId: 's1', members: Array.from({ length: 5 }, () => ({ checkinAt: 1, checkoutAt: null })) }], settleDay: 2 }, rb: { blocks: [] }, ro: { orders: [] } } }
    ]
  }
  const { events, report } = migrateLegacy({ ...legacy, realm: 'wg:leg-unit' })
  assert(report.anchors === 0, `迁移全程无需快照锚点兜底（anchors=${report.anchors}，warnings=${report.warnings.length}）`)
  const types = events.map((e) => e.type)
  assert(types.includes(T.REALM_OPENED) && types.includes(T.SHIPMENT_CREATED) && types.includes(T.SHIPMENT_DELIVERED), '翻译出 开域/建运单/签收 事件')
  const v = projectView(fold(events.map((e, i) => ({ ...e, seq: i + 1 }))))
  assert(v.bases.b1.stock.water.qty === 90, `迁移后库存对齐旧快照：90（实际 ${v.bases.b1.stock.water.qty}）`)
  assert(v.shelters.s1.occupied === 5, '迁移后床位在住对齐：5')
  assert(v.shipments.d1.signedQty === 10, '迁移后运输单签收量对齐：10')
}

/* =========================================================================
 * B. 三服务 HTTP 联调
 * ========================================================================= */

let arcSrv, colSrv, repSrv
let arcPort, colPort, repPort
const arcDir = tmp()
const colDir = tmp()

console.log('\n== B0. 启动三服务（独立端口/数据目录） ==')
{
  const arc = createArchive(arcDir)
  arcSrv = await open(arc.router)
  arcPort = arcSrv.port
  const col = createCollector({ archiveUrl: `http://127.0.0.1:${arcPort}`, dataDir: colDir, realToken: 'unit-token' })
  colSrv = await open(col.router)
  colPort = colSrv.port
  const rep = createReplay({ archiveUrl: `http://127.0.0.1:${arcPort}` })
  repSrv = await open(rep.router)
  repPort = repSrv.port
  for (const [name, port] of [['collector', colPort], ['archive', arcPort], ['replay', repPort]]) {
    const h = await api(port, 'GET', '/v1/health')
    assert(h.status === 200 && h.body.ok && h.body.service === name, `${name} 健康检查在线 (:${port})`)
  }
}

const emit = (ev, headers = {}) => api(colPort, 'POST', '/v1/events', { events: [ev] }, headers)
const append = (ev) => api(arcPort, 'POST', '/v1/events/append', { events: [ev] })
const state = async (realm, branch = MAIN_BRANCH, kind = '') =>
  api(repPort, 'GET', `/v1/state${kind ? '/' + kind : ''}?realm=${encodeURIComponent(realm)}&branchId=${encodeURIComponent(branch)}`)
const waitState = async (realm, branch, pred, label) => {
  await waitFor(async () => {
    const r = await state(realm, branch)
    return r.status === 200 && pred(r.body.view, r.body)
  }, { label })
}

console.log('\n== B1. 采集→存储→回放闭环：按因果序重建库存/床位/运输 ==')
const DRILL = 'wg:drill1'
{
  const r = await emit({
    realm: DRILL, type: T.REALM_OPENED, clientId: 'c-a',
    data: {
      realm: DRILL,
      bases: [{ id: 'b1', name: '一号库', stock: { water: 100, tent: 50 } }],
      shelters: [{ id: 's1', name: '一号安置点', capacity: 100 }]
    }
  })
  assert(r.status === 200, '开域事件被采集受理')
  await waitState(DRILL, MAIN_BRANCH, (v) => v.opened && v.bases.b1, '开域投影就绪')

  await emit({ realm: DRILL, clientId: 'c-a', type: T.STOCK_RESERVED, data: { baseId: 'b1', resource: 'water', qty: 20, refId: 'plan1' } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.STOCK_ALLOCATED, data: { baseId: 'b1', resource: 'water', qty: 20, refId: 'plan1', consumeReserve: true } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.BED_RESERVED, data: { shelterId: 's1', qty: 30, refId: 'batch1' } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.BED_OCCUPIED, data: { shelterId: 's1', qty: 30, refId: 'batch1', consumeReserve: true } })
  await waitState(DRILL, MAIN_BRANCH, (v) =>
    v.bases.b1.stock.water.qty === 80 && v.shelters.s1.occupied === 30, '库存80/在住30')
  const s1 = (await state(DRILL)).body.view
  assert(s1.bases.b1.stock.water.qty === 80 && s1.bases.b1.stock.water.available === 80, '库存因果重建：出库20，余量=可用=80')
  assert(s1.shelters.s1.occupied === 30 && s1.shelters.s1.free === 70, '床位因果重建：入住30，空余70')

  // 运输全生命周期
  await emit({ realm: DRILL, clientId: 'c-a', type: T.SHIPMENT_CREATED, data: { shipmentId: 'tr1', kind: 'supply', resource: 'water', qty: 20, baseId: 'b1', target: { eventId: 'ev1' } } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.SHIPMENT_ROUTED, data: { shipmentId: 'tr1', route: { distance: 42, minutes: 60, via: [] } } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.SHIPMENT_HELD, data: { shipmentId: 'tr1', reason: '道路阻断' } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.SHIPMENT_RESUMED, data: { shipmentId: 'tr1' } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.SHIPMENT_DELIVERED, data: { shipmentId: 'tr1', qty: 12, partial: true } })
  await emit({ realm: DRILL, clientId: 'c-a', type: T.SHIPMENT_DELIVERED, data: { shipmentId: 'tr1', qty: 8 } })
  await waitState(DRILL, MAIN_BRANCH, (v) => v.shipments.tr1 && v.shipments.tr1.status === 'delivered', '运输单办结')
  const tr1 = (await state(DRILL)).body.view.shipments.tr1
  assert(tr1.signedQty === 20 && tr1.timeline.length >= 6, `运输状态因果重建：分批签收合计20、时间线留痕 ${tr1.timeline.length} 帧`)

  // 子视图端点
  const stk = await state(DRILL, MAIN_BRANCH, 'stock')
  const bed = await state(DRILL, MAIN_BRANCH, 'beds')
  const tpt = await state(DRILL, MAIN_BRANCH, 'transport')
  assert(stk.body.bases && bed.body.shelters && tpt.body.shipments, '库存/床位/运输三个独立子视图可单独重建读取')
}

console.log('\n== B2. 多人并行推演：两个指挥员会话 + 并发写标记 ==')
{
  const CONC = 'wg:conc'
  await append({ realm: CONC, type: T.REALM_OPENED, data: { realm: CONC, bases: [{ id: 'b1', name: '库', stock: { water: 100 } }] } })
  // 两人都基于末端 seq=1 同时提交（弱网下乐观并发）
  const a = await append({ realm: CONC, type: T.STOCK_ALLOCATED, data: { baseId: 'b1', resource: 'water', qty: 30, refId: 'pa' }, expectedSeq: 1, clientId: 'cmd-A' })
  const b = await append({ realm: CONC, type: T.STOCK_ALLOCATED, data: { baseId: 'b1', resource: 'water', qty: 40, refId: 'pb' }, expectedSeq: 1, clientId: 'cmd-B' })
  assert(a.body.results[0].concurrent === false, '先到的提交因果连续')
  assert(b.body.results[0].concurrent === true, '后到的提交基于旧末端，标记 concurrent（不静默丢弃）')
  await waitState(CONC, MAIN_BRANCH, (v) => v.bases.b1.stock.water.qty === 30, '并发两笔都入账（库存充足），余量30')

  const sA = await api(repPort, 'POST', '/v1/sessions', { realm: CONC, branchId: 'main', clientId: 'cmd-A' })
  const sB = await api(repPort, 'POST', '/v1/sessions', { realm: CONC, branchId: 'main', clientId: 'cmd-B' })
  assert(sA.status === 200 && sB.status === 200 && sA.body.sessionId !== sB.body.sessionId, '两名指挥员各自获得独立会话')
  const list = await api(repPort, 'GET', '/v1/sessions')
  assert(list.body.sessions.filter((s) => s.realm === CONC).length === 2, '多人会话同时在册')
}

console.log('\n== B3. 分支并发写入：分叉后两方案独立演进 + 末端对照 + 封存 ==')
{
  const tip = (await api(arcPort, 'GET', `/v1/events?realm=${encodeURIComponent(DRILL)}`)).body.tipSeq
  const fork = await api(arcPort, 'POST', '/v1/branches/fork', { realm: DRILL, parentBranchId: 'main', forkSeq: tip, branchId: 'planB', name: '方案B' })
  assert(fork.status === 200, `从末端 seq=${tip} 分叉成功`)
  // 主干继续：再出库 5
  await append({ realm: DRILL, branchId: 'main', type: T.STOCK_ALLOCATED, data: { baseId: 'b1', resource: 'water', qty: 5, refId: 'main-after-fork' } })
  // 方案B：出库 50
  await append({ realm: DRILL, branchId: 'planB', type: T.STOCK_ALLOCATED, data: { baseId: 'b1', resource: 'water', qty: 50, refId: 'planb-alloc' } })
  await waitState(DRILL, 'main', (v) => v.bases.b1.stock.water.qty === 75, '主干出库5 -> 75')
  await waitState(DRILL, 'planB', (v) => v.bases.b1.stock.water.qty === 30, '方案B出库50 -> 30')
  const mainV = (await state(DRILL, 'main')).body.view
  const planBV = (await state(DRILL, 'planB')).body.view
  assert(mainV.bases.b1.stock.water.qty === 75 && planBV.bases.b1.stock.water.qty === 30, '两分支库存互不污染（快照隔离的事件版实现）')
  assert(planGV(planBV), '方案B不见分叉后主干事件（运输单 tr1 状态沿用分叉点）')
  function planGV(v) { return v.shipments.tr1 && v.bases.b1.stock.tent.qty === 50 }

  const cmp = await api(repPort, 'POST', '/v1/branches/compare', { realm: DRILL, a: 'main', b: 'planB' })
  assert(cmp.status === 200 && cmp.body.diffCount >= 1, `分支末端对照列出 ${cmp.body.diffCount} 项差异`)
  assert(cmp.body.rows.some((r) => r.dim === '基地库存' && r.a === 75 && r.b === 30), '对照包含库存分歧行 75 vs 30')

  // 封存后拒写
  const seal = await api(arcPort, 'POST', '/v1/branches/seal', { realm: DRILL, branchId: 'planB' })
  assert(seal.status === 200, '分支封存成功')
  const refused = await append({ realm: DRILL, branchId: 'planB', type: T.STOCK_GRANTED, data: { baseId: 'b1', resource: 'water', qty: 1 } })
  assert(refused.status === 409 && refused.body.error === 'scope_sealed', '封存分支写入被拒（409）')
}

console.log('\n== B4. 断线续演：resumeToken 重连 + 按 lastSeq 补推缺失事件 ==')
{
  const create = await api(repPort, 'POST', '/v1/sessions', { realm: DRILL, branchId: 'main', clientId: 'field-01' })
  const sid = create.body.sessionId
  const lastSeq = create.body.tipSeq
  // 断线期间主干又来一事件
  await append({ realm: DRILL, branchId: 'main', type: T.STOCK_GRANTED, data: { baseId: 'b1', resource: 'water', qty: 3, reason: '上级增拨' } })
  // 带旧游标重连补拉
  const resync = await api(repPort, 'POST', `/v1/sessions/${sid}/resync`, { lastSeq })
  assert(resync.body.caughtUp === false && resync.body.missedEvents.length >= 1, '断线期间缺失事件被检出并补推')
  assert(resync.body.missedEvents.some((e) => e.type === T.STOCK_GRANTED), '补推内容包含增拨事件')
  // 再补拉一次：已追平
  const resync2 = await api(repPort, 'POST', `/v1/sessions/${sid}/resync`, { lastSeq: resync.body.tipSeq })
  assert(resync2.body.caughtUp === true, '追平后再次 resync 无缺失')
  // 凭 resumeToken 重建会话
  const rejoin = await api(repPort, 'POST', '/v1/sessions', { realm: DRILL, clientId: 'field-01', resumeToken: sid })
  assert(rejoin.body.resumed === true && rejoin.body.resumeCount === 1 && rejoin.body.sessionId === sid, 'resumeToken 恢复同一会话并累计续演次数')
}

console.log('\n== B5. 历史时间点回放 + 只读锁定（隔离实时调度） ==')
{
  const s = await api(repPort, 'POST', '/v1/sessions', { realm: DRILL, branchId: 'main', clientId: 'viewer-1' })
  const sid = s.body.sessionId
  const seek = await api(repPort, 'POST', '/v1/replay/seek', { realm: DRILL, branchId: 'main', seq: 1, sessionId: sid })
  assert(seek.status === 200 && seek.body.readOnly === true, 'seek 到 seq=1 返回只读历史切片')
  assert(seek.body.view.bases.b1 && seek.body.view.shipments.tr1 === undefined, '历史点状态正确（运输单尚未创建）')
  // 实时末端投影未被 seek 污染
  const live = await state(DRILL, 'main')
  assert(live.body.view.shipments.tr1 !== undefined, '历史回放不污染实时末端投影')
  const blocked = await api(repPort, 'POST', '/v1/guard/writable', { sessionId: sid })
  assert(blocked.status === 409 && blocked.body.error === 'read_only_replay', '回放只读态业务写入被拦截')
  const resume = await api(repPort, 'POST', '/v1/replay/resume-live', { sessionId: sid })
  assert(resume.body.mode === 'live' && resume.body.view.shipments.tr1 !== undefined, '回到分支末端解除只读')
  const allowed = await api(repPort, 'POST', '/v1/guard/writable', { sessionId: sid })
  assert(allowed.status === 200 && allowed.body.writable === true, 'live 态放行写入')
}

console.log('\n== B6. 故障恢复：archive 宕机 outbox 暂存 → 恢复补投 → replay 重启重建 ==')
{
  const OUT = 'wg:outage'
  // 预留一个固定端口：先用哑服务器占住拿到端口号，关闭后该端口即可被 archive 使用
  const reserved = await new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
  const recoverPort = reserved

  const col2Dir = tmp()
  const col2 = createCollector({ archiveUrl: `http://127.0.0.1:${recoverPort}`, dataDir: col2Dir, realToken: 'unit-token' })
  const col2Srv = await open(col2.router)
  const c2port = col2Srv.port

  const r1 = await api(c2port, 'POST', '/v1/events', { events: [{ realm: OUT, type: T.REALM_OPENED, data: { realm: OUT, bases: [{ id: 'b1', name: '库', stock: { water: 10 } }] } }] })
  await waitFor(async () => (await api(c2port, 'GET', '/v1/health')).body.archiveUp === false, { label: 'collector 发现 archive 宕机' })
  const r2 = await api(c2port, 'POST', '/v1/events', { events: [{ realm: OUT, type: T.STOCK_GRANTED, data: { baseId: 'b1', resource: 'water', qty: 5 } }] })
  assert((r1.status === 202 || r2.status === 202) && r2.body.queued >= 1, `archive 宕机时事件入本地 outbox（queued=${r2.body.queued}）`)

  // archive 在原端口冷启动（新进程语义：新数据目录即干净重放；补投事件全部补齐）
  const recoverDir = tmp()
  const arcRecover = createArchive(recoverDir)
  const recovered = await new Promise((resolve) => {
    const server = http.createServer(arcRecover.router)
    server.listen(recoverPort, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
  assert(recovered.port === recoverPort, `archive 在原端口 :${recoverPort} 恢复`)
  await api(c2port, 'POST', '/v1/outbox/flush')
  const arcHealth = await waitFor(async () => {
    const h = await api(c2port, 'GET', '/v1/health')
    return h.body.archiveUp === true && h.body.outbox === 0 ? h : null
  }, { timeout: 8000, label: 'outbox 排空' })
  assert(arcHealth.body.outbox === 0, '宕机期间事件全部补投成功、不重不丢')

  // 用独立 replay 实例对恢复后的 archive 重建
  const rep2 = createReplay({ archiveUrl: `http://127.0.0.1:${recoverPort}` })
  const rep2Srv = await open(rep2.router)
  const rp2port = rep2Srv.port
  const v = await waitFor(async () => {
    const r = await api(rp2port, 'GET', `/v1/state?realm=${encodeURIComponent(OUT)}`)
    return r.status === 200 && r.body.view.opened ? r.body : null
  }, { label: '新 replay 实例重建投影' })
  assert(v.view.bases.b1.stock.water.qty === 15, '回放服务冷启动后从事实源重建：10 + 补投的 5 = 15')

  await close(col2Srv)
  await close(rep2Srv)
  await close(recovered)
}

console.log('\n== B7. 旧快照迁移入库：经 archive 导入后可直接回放 ==')
{
  const frames = [
    { t: 1000, seq: 0, snapshot: { cmd: { bases: [{ id: 'b1', name: '基地', stock: { water: 100 } }], dispatches: [], events: [] }, tr: { shelters: [{ id: 's1', name: '点', capacity: 100 }], batches: [], settleDay: 1 }, rb: { blocks: [] }, ro: { orders: [] } } },
    { t: 2000, seq: 1, snapshot: { cmd: { bases: [{ id: 'b1', name: '基地', stock: { water: 90 } }], dispatches: [{ id: 'd1', type: 'water', qty: 10, baseId: 'b1', status: 'enroute', signedQty: 0, returnedQty: 0 }], events: [] }, tr: { shelters: [{ id: 's1', name: '点', capacity: 100 }], batches: [{ shelterId: 's1', members: Array.from({ length: 5 }, () => ({ checkinAt: 1, checkoutAt: null })) }], settleDay: 1 }, rb: { blocks: [] }, ro: { orders: [] } } },
    { t: 3000, seq: 2, snapshot: { cmd: { bases: [{ id: 'b1', name: '基地', stock: { water: 90 } }], dispatches: [{ id: 'd1', type: 'water', qty: 10, baseId: 'b1', status: 'done', signedQty: 10, returnedQty: 0 }], events: [] }, tr: { shelters: [{ id: 's1', name: '点', capacity: 100 }], batches: [{ shelterId: 's1', members: Array.from({ length: 5 }, () => ({ checkinAt: 1, checkoutAt: null })) }], settleDay: 2 }, rb: { blocks: [] }, ro: { orders: [] } } }
  ]
  const mig = await api(arcPort, 'POST', '/v1/migrate/legacy', { realm: 'wg:legacy', frames })
  assert(mig.status === 200, `旧快照导入成功，事件数 ${mig.body.imported}，锚点 ${mig.body.report.anchors}`)
  const v = await waitFor(async () => {
    const r = await api(repPort, 'GET', '/v1/state?realm=wg:legacy')
    return r.status === 200 && r.body.view.bases.b1 ? r.body : null
  }, { label: '迁移域投影就绪' })
  assert(v.view.bases.b1.stock.water.qty === 90, '迁移域库存 = 90')
  assert(v.view.shelters.s1.occupied === 5, '迁移域床位在住 = 5')
  assert(v.view.shipments.d1.signedQty === 10, '迁移域运输单签收 = 10')
  const again = await api(arcPort, 'POST', '/v1/migrate/legacy', { realm: 'wg:legacy', frames })
  assert(again.status === 409 && again.body.error === 'already_migrated', '重复迁移被拒绝（防双写污染）')
}

console.log('\n== B8. 真实调度隔离：real 域令牌守门 + 演练域前缀 + 禁止在 real 分叉 ==')
{
  const noToken = await emit({ realm: 'real', type: T.REALM_OPENED, data: { realm: 'real' } })
  assert(noToken.status === 403 && noToken.body.error === 'realm_forbidden', '无令牌写真实调度域被拒（403）')
  const badPrefix = await emit({ realm: 'sandbox-x', type: T.REALM_OPENED, data: { realm: 'sandbox-x' } })
  assert(badPrefix.status === 400 && badPrefix.body.error === 'bad_realm', '演练域缺少 wg: 前缀被拒')
  const withToken = await emit({ realm: 'real', type: T.REALM_OPENED, data: { realm: 'real', bases: [{ id: 'rb-real', name: '真实库', stock: { water: 1 } }] } }, { 'x-realm-token': 'unit-token' })
  assert(withToken.status === 200, '持正确令牌可写真实调度域')
  await waitFor(async () => {
    const r = await api(repPort, 'GET', '/v1/state?realm=real')
    return r.status === 200 && r.body.view.opened ? r : null
  }, { label: '真实域投影' })
  const forkReal = await api(arcPort, 'POST', '/v1/branches/fork', { realm: 'real', parentBranchId: 'main', forkSeq: 1 })
  assert(forkReal.status === 403, '真实调度域默认禁止分叉演练')
  const drill = await emit({ realm: 'wg:iso', type: T.REALM_OPENED, data: { realm: 'wg:iso' } })
  assert(drill.status === 200, '演练域免令牌、与真实域物理分作用域')
}

console.log('\n== B9. 幂等：采集侧重发 / 存储侧同 eventId / 业务幂等键 ==')
{
  const IDEM = 'wg:idem'
  const fixed = { eventId: 'fixed-evt-1', realm: IDEM, type: T.REALM_OPENED, data: { realm: IDEM } }
  const r1 = await append(fixed)
  const r2 = await append(fixed)
  assert(r1.body.results[0].duplicated === false && r2.body.results[0].duplicated === true, '同 eventId 二次追加返回 duplicated')
  const x = await append({ realm: IDEM, type: T.REPAIR_ORDER_CREATED, data: { orderId: 'o1', blockId: 'bk1' }, idempotencyKey: 'bk1:active-order' })
  const y = await append({ realm: IDEM, type: T.REPAIR_ORDER_CREATED, data: { orderId: 'o2', blockId: 'bk1' }, idempotencyKey: 'bk1:active-order' })
  assert(x.status === 200 && y.status === 409 && y.body.error === 'idempotent_conflict', '业务幂等键拦截重复派单（同一阻断只允许一张在途工单）')
}

/* ---------- 收尾 ---------- */
await close(colSrv)
await close(repSrv)
await close(arcSrv)

console.log(`\n${failed ? '❌ ' : '✅ '}服务化回归完成：${failed ? failed + ' 项失败' : '全部通过'}`)
process.exit(failed ? 1 : 0)
