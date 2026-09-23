import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { pointInPolygon, pointOnPolygon, pathBlocked, detourPath } from '@/utils/geo'

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

console.log('— 几何工具：点在区内 / 路线穿越 / 绕行生成 —')
const square = [[0, 0], [1, 0], [1, 1], [0, 1]]
assert(pointInPolygon([0.5, 0.5], square), '点在多边形内')
assert(!pointInPolygon([1.5, 0.5], square), '点在多边形外')
assert(pathBlocked([[-1, 0.5], [2, 0.5]], square), '线段穿越被检出')
assert(!pathBlocked([[-1, 2], [2, 2]], square), '不相交路线放行')
const det = detourPath([-1, 0.5], [2, 0.5], square)
assert(det && !pathBlocked([[-1, 0.5], ...det.via, [2, 0.5]], square), '绕行路径避开封闭区')

console.log('— 贴边路线不得漏检（封闭区边界共线 / 折点压边） —')
const offSquare = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
assert(pathBlocked([[0.3, 0.8], [0.7, 0.8]], offSquare), '路线贴顶边共线重叠被拦截')
assert(pathBlocked([[0.3, 0.2], [0.7, 0.2]], offSquare), '路线贴底边共线重叠被拦截')
assert(pathBlocked([[0.2, 0.3], [0.2, 0.7]], offSquare), '路线贴左边共线重叠被拦截')
assert(pathBlocked([[0.8, 0.3], [0.8, 0.7]], offSquare), '路线贴右边共线重叠被拦截')
assert(pathBlocked([[0, 0.8], [1, 0.8]], offSquare), '整段跨越边界共线被拦截')
assert(pathBlocked([[0.5, 1], [0.5, 0.8], [0, 1]], offSquare), '折点压在边中段（两段均在区外）被拦截')
assert(pathBlocked([[0, -1], [0.2, 0.2], [1, 1]], offSquare), '折点与多边形顶点重合外切被拦截')
assert(!pathBlocked([[0.85, 0.8], [1.2, 0.8]], offSquare), '共线但区间错开的路线放行')
assert(!pathBlocked([[0.3, 0.199], [0.7, 0.199]], offSquare), '贴近但不重合的平行路线放行')
assert(pointOnPolygon([0.5, 0.8], offSquare) && pointOnPolygon([0.2, 0.5], offSquare), '边界点识别（顶边/左边）')
assert(!pointOnPolygon([0.5, 0.5], offSquare), '内部点不在边界上')

// 江油事件 ev-001(104.7456,31.7777) 与绵阳库 rb-2(104.742,31.4641) 之间的阻断区
const ev = cmd.events.find((e) => e.id === 'ev-001')
const midPoly = [
  [104.6438, 31.5209], [104.8438, 31.5209],
  [104.8438, 31.7209], [104.6438, 31.7209]
]

console.log('— 贴边漏检回归：封闭区边界压在运输走廊上，在途派发必须被拦截 —')
// 沿绵阳→江油走廊参数线取 A/B 作为封闭区一条边，向垂直方向偏移出 C/D，走廊不进入区内
const corridorA = [104.742, 31.4641], corridorZ = [104.7456, 31.7777]
const cPt = (t) => [corridorA[0] + (corridorZ[0] - corridorA[0]) * t, corridorA[1] + (corridorZ[1] - corridorA[1]) * t]
const eA = cPt(0.43), eB = cPt(0.63)
const cdx = corridorZ[0] - corridorA[0], cdy = corridorZ[1] - corridorA[1]
const cLen = Math.hypot(cdx, cdy), nnx = cdy / cLen, nny = -cdx / cLen
const edgePoly = [
  [+eA[0].toFixed(6), +eA[1].toFixed(6)],
  [+eB[0].toFixed(6), +eB[1].toFixed(6)],
  [+(eB[0] + nnx * 0.06).toFixed(6), +(eB[1] + nny * 0.06).toFixed(6)],
  [+(eA[0] + nnx * 0.06).toFixed(6), +(eA[1] + nny * 0.06).toFixed(6)]
]
assert(pathBlocked([corridorA, corridorZ], edgePoly), '走廊直线贴着封闭区边界：几何判定命中')
const edgeRec = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'medical', qty: 30 })
const edgeRep = rb.reportBlock({ name: '边界贴走廊阻断', polygon: edgePoly })
const edgeImp = edgeRep.block.impacts.find((i) => i.kind === 'dispatch' && i.id === edgeRec.id)
assert(!!edgeImp, '贴边运输路线的在途派发进入影响评估（不再漏检）')
rb.confirmImpacts(edgeRep.block.id)
const edgeOpt = edgeImp.options.find((o) => o.action === 'detour')
assert(!!edgeOpt, '贴边路线生成绕行候选（起终点不在区内，不必挂起）')
edgeImp.plan = edgeOpt
assert(rb.applyImpact(edgeRep.block.id, edgeImp.key).ok, '贴边绕行方案可执行')
assert(!pathBlocked([corridorA, ...(edgeRec.via || []), corridorZ], edgePoly), '执行后路线避开封闭区')
rb.clearBlock(edgeRep.block.id)
assert(edgeRec.via.length === 0, '恢复通行后贴边绕行路线回直')

console.log('— 上报 → 影响评估 → 绕行改道 → 恢复通行 —')
const rec = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
assert(!!rec, '前置派发建立（绵阳 → 江油）')
assert(!rb.reportBlock({ name: 'x', polygon: [[1, 1], [2, 2]] }).ok, '不足 3 顶点的上报被拒绝')
const repA = rb.reportBlock({ name: '绵江公路积水断道', reason: '积水内涝', reporter: '巡查员甲', polygon: midPoly })
assert(repA.ok, '现场上报道路封闭范围')
const blkA = repA.block
const impA = blkA.impacts.find((i) => i.kind === 'dispatch' && i.id === rec.id)
assert(!!impA, '影响评估检出受影响派发')
rb.confirmImpacts(blkA.id)
assert(blkA.confirmed && impA.options.some((o) => o.action === 'detour'), '指挥员确认后生成绕行方案')
assert(ev.timeline.some((t) => t.text.includes('道路阻断')), '事件时间线已回写阻断生效')
impA.plan = impA.options.find((o) => o.action === 'detour')
const d0 = rec.distance
assert(rb.applyImpact(blkA.id, impA.key).ok, '执行绕行方案')
assert(rec.via.length > 0 && rec.distance > d0, `绕行后里程增加 ${d0}→${rec.distance}km`)
assert(cmd.sentMap[ev.id].food === 100, '绕行不影响已满足量')
rb.clearBlock(blkA.id)
assert(blkA.status === 'cleared' && rec.via.length === 0 && rec.distance === d0, '恢复通行后绕行路线回直')

console.log('— 挂起：物资退回 / 不计入已满足 / 恢复后续派 —')
const blkB = rb.reportBlock({ name: '阻断B', polygon: midPoly }).block
rb.confirmImpacts(blkB.id)
const impB = blkB.impacts.find((i) => i.id === rec.id)
impB.plan = impB.options.find((o) => o.action === 'suspend')
const foodStock0 = cmd.bases.find((b) => b.id === 'rb-2').stock.food
rb.applyImpact(blkB.id, impB.key)
assert(rec.status === 'held', '派发已挂起')
assert(cmd.bases.find((b) => b.id === 'rb-2').stock.food === foodStock0 + 100, '挂起物资退回基地')
assert(!cmd.sentMap[ev.id]?.food, '挂起不计入已满足量（缺口重新释放）')
rb.clearBlock(blkB.id)
const rs = rb.resumeHeld()
assert(rs.resumed === 1 && rec.status === 'enroute', '恢复通行后一键续派')
assert(cmd.bases.find((b) => b.id === 'rb-2').stock.food === foodStock0, '续派重新扣减库存')
assert(cmd.sentMap[ev.id].food === 100, '续派后重新计入已满足量')

console.log('— 转移批次：挂起拦截登记 / 续派恢复 —')
const bt1 = tr.createBatch({ eventId: ev.id, name: '', headcount: 40, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-2' }).batch
assert(bt1.eta && bt1.eta.distance > 0, `批次建派即带 ETA（${bt1.eta.distance}km·${bt1.eta.minutes}min）`)
const blkC = rb.reportBlock({ name: '阻断C', polygon: midPoly }).block
assert(blkC.impacts.some((i) => i.kind === 'batch' && i.id === bt1.id), '影响评估检出受影响批次')
rb.confirmImpacts(blkC.id)
const impC = blkC.impacts.find((i) => i.id === bt1.id)
impC.plan = impC.options.find((o) => o.action === 'suspend')
rb.applyImpact(blkC.id, impC.key)
assert(bt1.held, '批次已挂起（车辆/床位预占保留）')
assert(!tr.register(bt1.id, 'pickup', { name: '王五', idNo: '1' }).ok, '挂起批次接运登记被拦截')
rb.clearBlock(blkC.id)
rb.resumeHeld()
assert(!bt1.held, '续派解除批次挂起')
assert(tr.register(bt1.id, 'pickup', { name: '王五', idNo: '1' }).ok, '续派后可正常登记')

console.log('— 目的地/出发地落入封闭区 → 仅可挂起 —')
const onEvPoly = [[104.70, 31.73], [104.79, 31.73], [104.79, 31.82], [104.70, 31.82]]
const blkD = rb.reportBlock({ name: '阻断D', polygon: onEvPoly }).block
rb.confirmImpacts(blkD.id)
const impD1 = blkD.impacts.find((i) => i.id === rec.id)
assert(impD1?.destInside && impD1.options.length === 1 && impD1.options[0].action === 'suspend', '目的地在封闭区内：派发仅可挂起')
const impD2 = blkD.impacts.find((i) => i.id === bt1.id)
assert(impD2?.originInside && impD2.options.length === 1 && impD2.options[0].action === 'suspend', '出发地在封闭区内：批次仅可挂起')
rb.clearBlock(blkD.id)

console.log('— 派发改派基地：库存联动 —')
const rec2 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 50 })
const blkE = rb.reportBlock({ name: '阻断E', polygon: midPoly }).block
rb.confirmImpacts(blkE.id)
const impE = blkE.impacts.find((i) => i.id === rec2.id)
const ropt = impE.options.find((o) => o.action === 'reassign')
assert(!!ropt, '生成改派基地方案（绕开全部生效阻断）')
impE.plan = ropt
const rb2 = cmd.bases.find((b) => b.id === 'rb-2')
const alt = cmd.bases.find((b) => b.id === ropt.baseId)
const wOld = rb2.stock.water
const wAlt = alt.stock.water
assert(rb.applyImpact(blkE.id, impE.key).ok, '执行改派方案')
assert(rec2.baseId === alt.id && rec2.source === '改派', `派发改由「${alt.name}」出库`)
assert(rb2.stock.water === wOld + 50 && alt.stock.water === wAlt - 50, '旧基地退回 / 新基地扣减')
rb.clearBlock(blkE.id)

console.log('— 批次改派安置点：床位占用同步 —')
const bt2 = tr.createBatch({ eventId: ev.id, name: '', headcount: 30, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-1' }).batch
const tinyPoly = [[104.750, 31.770], [104.766, 31.770], [104.766, 31.786], [104.750, 31.786]]
const blkF = rb.reportBlock({ name: '阻断F', polygon: tinyPoly }).block
rb.confirmImpacts(blkF.id)
const impF = blkF.impacts.find((i) => i.kind === 'batch' && i.id === bt2.id)
const sopt = impF.options.find((o) => o.action === 'reassign')
assert(!!sopt, '生成改派安置点方案')
impF.plan = sopt
const r1 = tr.bedMap['sh-1'].reserved
const r2 = tr.bedMap[sopt.shelterId].reserved
assert(rb.applyImpact(blkF.id, impF.key).ok, '执行批次改派')
assert(bt2.shelterId === sopt.shelterId, '批次安置点已改派')
assert(tr.bedMap['sh-1'].reserved === r1 - 30 && tr.bedMap[sopt.shelterId].reserved === r2 + 30, '床位预占同步迁移')
rb.clearBlock(blkF.id)

console.log('— 批次绕行：路线与 ETA 同步 —')
const eta0 = bt1.eta.distance
const blkG = rb.reportBlock({ name: '阻断G', polygon: midPoly }).block
rb.confirmImpacts(blkG.id)
const impG = blkG.impacts.find((i) => i.id === bt1.id)
const gdet = impG.options.find((o) => o.action === 'detour')
assert(!!gdet, '批次绕行方案已生成')
impG.plan = gdet
rb.applyImpact(blkG.id, impG.key)
assert(bt1.via.length > 0 && bt1.eta.distance > eta0, `批次绕行 ETA 增加 ${eta0}→${bt1.eta.distance}km`)
rb.clearBlock(blkG.id)
assert(bt1.via.length === 0 && bt1.eta.distance === eta0, '恢复通行后批次路线回直')

console.log('— 快捷上报：运输走廊封闭区 —')
const qp = rb.quickPolygon(ev.id)
assert(Array.isArray(qp) && qp.length === 6, '快捷上报生成六边形封闭区')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
