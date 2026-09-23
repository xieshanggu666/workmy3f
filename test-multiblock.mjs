// 多处道路阻断同时生效：联合避障 / 方案执行前复核 / 绕行·改派·挂起·恢复联动回归
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { pathBlocked, detourPath, detourPathMulti, firstBlocker } from '@/utils/geo'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
cmd.loadScenario('s1')
tr.load()
rb.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events.find((e) => e.id === 'ev-001') // 江油 (104.7456,31.7777)
// 走廊上两个相互独立的封闭区（各封死南/北半幅通道，单个绕行会撞上另一个）
const p1 = [[104.55, 31.50], [104.95, 31.50], [104.95, 31.56], [104.55, 31.56]]
const p2 = [[104.55, 31.58], [104.95, 31.58], [104.95, 31.64], [104.55, 31.64]]
const midPoly = [[104.6438, 31.5209], [104.8438, 31.5209], [104.8438, 31.7209], [104.6438, 31.7209]]
const pathOf = (d) => {
  const base = cmd.bases.find((b) => b.id === d.baseId)
  return [[base.lng, base.lat], ...(d.via || []), [d.lng, d.lat]]
}
const clearActive = () => [...rb.activeBlocks].forEach((b) => rb.clearBlock(b.id))

console.log('— 几何：单区绕行遇邻区必穿越，联合绕行才能避开全部 —')
const unit1 = [[0, 0], [2, 0], [2, 1], [0, 1]]
// 竖条收口：单绕 unit1 北侧/南侧走廊都会撞上它，联合绕行必须连续绕两侧
const unit2 = [[2.45, -0.15], [2.62, -0.15], [2.62, 1.15], [2.45, 1.15]]
const single = detourPath([-1, 0.5], [3, 0.5], unit1)
assert(single && pathBlocked([[-1, 0.5], ...single.via, [3, 0.5]], unit2), '只绕单个封闭区的路线会穿越相邻封闭区')
const joint = detourPathMulti([-1, 0.5], [3, 0.5], [unit1, unit2])
assert(joint && firstBlocker([[-1, 0.5], ...joint.via, [3, 0.5]], [unit1, unit2]) < 0, '联合绕行同时避开多个封闭区')
assert(detourPathMulti([-1, 5], [3, 5], [unit1, unit2])?.via.length === 0, '本就畅通的路线联合绕行结果为直线')
assert(detourPathMulti([1, 0.5], [3, 0.5], [unit1]) === null, '起点落入封闭区时无绕行解')

console.log('— 两处阻断同时生效：只执行一处联合绕行，路线同时避开两处 —')
const rec = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
const b1 = rb.reportBlock({ name: '阻断1', polygon: p1 }).block
const b2 = rb.reportBlock({ name: '阻断2', polygon: p2 }).block
rb.confirmImpacts(b1.id)
rb.confirmImpacts(b2.id)
const i1 = b1.impacts.find((i) => i.id === rec.id)
const i2 = b2.impacts.find((i) => i.id === rec.id)
i1.plan = i1.options.find((o) => o.action === 'detour')
assert(!!i1.plan && !!i2.options.find((o) => o.action === 'detour'), '两处阻断均生成绕行候选')
rb.applyImpact(b1.id, i1.key)
assert(firstBlocker(pathOf(rec), [p1, p2]) < 0, '联合避障：执行后路线不穿越任何生效阻断')

console.log('— 跨阻断联动：一处联合绕行后，另一阻断上的同任务影响自动销项 —')
assert(i1.done, '执行方影响已销项')
assert(i2.done && i2.result.action === 'linked', '阻断2 的影响项联动标记为「路线已绕开本阻断」')
// 再对阻断2 点执行应被幂等拦截
assert(!rb.applyImpact(b2.id, i2.key).ok, '已联动销项的影响不可重复执行')

console.log('— 恢复联动：解除单块后旧绕行在剩余阻断下自动重排，全清后回直 —')
rb.clearBlock(b2.id)
assert(firstBlocker(pathOf(rec), [p1]) < 0, '解除一处后路线在剩余阻断下重排有效')
rb.clearBlock(b1.id)
assert(rec.via.length === 0, '全部恢复通行后路线回直')

console.log('— 方案执行前复核：确认后新阻断封堵原绕行走廊，执行时自动改算 —')
const recB = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'medical', qty: 20 })
const bX = rb.reportBlock({ name: '阻断X', polygon: p1 }).block
rb.confirmImpacts(bX.id)
const iX = bX.impacts.find((i) => i.id === recB.id)
iX.plan = iX.options.find((o) => o.action === 'detour')
// 确认方案之后、执行之前，走廊另一侧新增阻断；原绕行路线会穿越它
rb.reportBlock({ name: '阻断Y', polygon: p2 })
rb.applyImpact(bX.id, iX.key)
assert(firstBlocker(pathOf(recB), [p1, p2]) < 0, '复核后执行的绕行同时避开新老阻断')
clearActive()

console.log('— 方案执行前复核：改派目标库存被前序方案占用时自动降级绕行 —')
const d1 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 1000 })
const d2 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 1000 })
const bR = rb.reportBlock({ name: '改派复核', polygon: midPoly }).block
rb.confirmImpacts(bR.id)
const r1 = bR.impacts.find((i) => i.id === d1.id)
const r2 = bR.impacts.find((i) => i.id === d2.id)
const ropt1 = r1.options.find((o) => o.action === 'reassign')
assert(!!ropt1, '生成改派基地方案')
r1.plan = ropt1
r2.plan = r2.options.find((o) => o.action === 'reassign')
rb.applyImpact(bR.id, r1.key)
const altBase = cmd.bases.find((b) => b.id === ropt1.baseId)
altBase.stock.water = Math.min(altBase.stock.water, 500) // 模拟改派库存被其它任务占用，余量不足 1000
const review = rb.applyImpact(bR.id, r2.key)
assert(review.ok, '第二条方案执行不中断')
assert(r2.result.action === 'detour' && d2.via.length > 0, '复核发现改派库存不足，自动降级为绕行')
assert(bR.log.some((l) => l.text.includes('方案执行前复核')), '复核调整已写入处置日志')
clearActive()

console.log('— 挂起联动：一处挂起，其它生效阻断上同任务同步挂起销项 —')
const recH = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'tent', qty: 30 })
const bH1 = rb.reportBlock({ name: '挂起阻断1', polygon: p1 }).block
const bH2 = rb.reportBlock({ name: '挂起阻断2', polygon: p2 }).block
rb.confirmImpacts(bH1.id)
rb.confirmImpacts(bH2.id)
const h1 = bH1.impacts.find((i) => i.id === recH.id)
h1.plan = h1.options.find((o) => o.action === 'suspend')
rb.applyImpact(bH1.id, h1.key)
assert(recH.status === 'held', '派发已挂起')
const h2 = bH2.impacts.find((i) => i.id === recH.id)
assert(h2.done && h2.result.action === 'suspend', '阻断2 上同任务联动挂起销项')

console.log('— 恢复联动：仅解除一处时挂起任务保持挂起，全部解除后续派 —')
rb.clearBlock(bH1.id)
const rs1 = rb.resumeHeld()
assert(recH.status === 'held' && rs1.kept >= 1, '剩余阻断未清，挂起任务保持挂起')
rb.clearBlock(bH2.id)
const rs2 = rb.resumeHeld()
assert(rs2.resumed >= 1 && recH.status === 'enroute', '全部阻断解除后一键续派成功')

console.log('— 任务新建联动：阻断生效期间新建派发/批次自动进入影响评估 —')
const bA = rb.reportBlock({ name: '走廊阻断', polygon: midPoly }).block
const dNew = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 60 })
assert(bA.impacts.some((i) => i.kind === 'dispatch' && i.id === dNew.id), '新建派发自动纳入已生效阻断评估')
rb.confirmImpacts(bA.id)
const btNew = tr.createBatch({ eventId: ev.id, name: '', headcount: 20, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-2' }).batch
const impNew = bA.impacts.find((i) => i.kind === 'batch' && i.id === btNew.id)
assert(!!impNew && impNew.options.some((o) => o.action === 'detour'), '新建批次自动纳入评估并可直接生成联合方案')
impNew.plan = impNew.options.find((o) => o.action === 'detour')
rb.applyImpact(bA.id, impNew.key)
const sh = tr.shelters.find((s) => s.id === btNew.shelterId)
const btPath = [[ev.location.lng, ev.location.lat], ...(btNew.via || []), [sh.lng, sh.lat]]
assert(firstBlocker(btPath, [midPoly]) < 0, '批次联合绕行路线避开封闭区')
rb.clearBlock(bA.id)
assert(btNew.via.length === 0, '阻断解除后批次路线回直、ETA 恢复')

console.log('— 改派即联合避障：改派候选的直连路线逐一避开全部生效阻断 —')
const recR = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 80 })
const bZ = rb.reportBlock({ name: '改派联合', polygon: midPoly }).block
rb.confirmImpacts(bZ.id)
const iz = bZ.impacts.find((i) => i.id === recR.id)
iz.options.filter((o) => o.action === 'reassign').forEach((o) => {
  const nb = cmd.bases.find((b) => b.id === o.baseId)
  assert(firstBlocker([[nb.lng, nb.lat], [recR.lng, recR.lat]], [midPoly]) < 0, `改派候选「${nb.name}」路线不穿越封闭区`)
})
iz.plan = iz.options.find((o) => o.action === 'reassign')
if (iz.plan) rb.applyImpact(bZ.id, iz.key)
clearActive()

console.log('— 不变量：三阻断交错上报/处置/乱序恢复，已处置路线始终有效 —')
const c3 = [[104.60, 31.66], [104.90, 31.66], [104.90, 31.70], [104.60, 31.70]]
const g1 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 10 })
const g2 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 20 })
tr.createBatch({ eventId: ev.id, name: '甲批', headcount: 20, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-2' })
const batchPathClear = (b) => {
  if (b.held || b.status === 'closed') return true
  const e = cmd.events.find((x) => x.id === b.eventId)
  const s = tr.shelters.find((x) => x.id === b.shelterId)
  return firstBlocker([[e.location.lng, e.location.lat], ...(b.via || []), [s.lng, s.lat]], rb.activePolygons) < 0
}
// 已处置任务集合：在某生效阻断影响清单中已 done（或挂起）；待处置任务留给指挥员决策，不计入不变量
const processedKeys = () => {
  const set = new Set()
  rb.activeBlocks.forEach((blk) => blk.impacts.forEach((i) => { if (i.done) set.add(i.kind + ':' + i.id) }))
  rb.blocks.forEach((blk) => blk.impacts.forEach((i) => { if (i.done) set.add(i.kind + ':' + i.id) }))
  return set
}
const invariant = (tag) => {
  const done = processedKeys()
  const dpOk = cmd.dispatches
    .filter((d) => d.status === 'held' || done.has('dispatch:' + d.id))
    .every((d) => d.status === 'held' || firstBlocker(pathOf(d), rb.activePolygons) < 0)
  const tbOk = tr.batches
    .filter((b) => b.held || done.has('batch:' + b.id))
    .every((b) => b.held || batchPathClear(b))
  assert(dpOk && tbOk, `[${tag}] 已处置路线全部避开生效阻断`)
}
const x1 = rb.reportBlock({ name: 'c1', polygon: p1 }).block
rb.confirmImpacts(x1.id); rb.applyAll(x1.id); invariant('c1处置后')
const x2 = rb.reportBlock({ name: 'c2', polygon: p2 }).block
rb.confirmImpacts(x2.id); rb.applyAll(x2.id); invariant('c2处置后')
const x3 = rb.reportBlock({ name: 'c3', polygon: c3 }).block
rb.confirmImpacts(x3.id); rb.applyAll(x3.id); invariant('c3处置后')
// 新任务进入评估但待指挥员处置：已处置路线不受影响
const g3 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'tent', qty: 5 })
tr.createBatch({ eventId: ev.id, name: '乙批', headcount: 15, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-2' })
invariant('新任务待处置不影响存量路线')
assert(x3.impacts.some((i) => i.kind === 'dispatch' && i.id === g3.id), '新建任务已进入待处置评估')
rb.activeBlocks.forEach((x) => { rb.confirmImpacts(x.id); rb.applyAll(x.id) })
invariant('新任务处置完成')
rb.clearBlock(x2.id); invariant('乱序解除 c2')
rb.clearBlock(x1.id); invariant('乱序解除 c1')
rb.clearBlock(x3.id); invariant('全部解除')
assert(g1.via.length === 0 && g2.via.length === 0 && g3.via.length === 0, '全部物资路线回直')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
