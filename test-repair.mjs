// 道路抢修工单闭环：阻断发起 → 派单扣资源 → 现场接单/进度 → 完工实际消耗
// → 验收通过解除封闭并重算运输；延期/失败保留阻断；撤单与完工按实际消耗归还
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const rp = useRepairStore()
cmd.loadScenario('s1')
tr.load()
rb.load()
rp.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events.find((e) => e.id === 'ev-001') // 江油 (104.7456,31.7777)
// 绵阳库(104.742,31.4641) → 江油走廊上的阻断区
const midPoly = [
  [104.6438, 31.5209], [104.8438, 31.5209],
  [104.8438, 31.7209], [104.6438, 31.7209]
]
const base = () => cmd.bases.find((b) => b.id === 'rb-2')
const base1 = () => cmd.bases.find((b) => b.id === 'rb-1')

console.log('— 前置：在途派发穿越阻断 → 绕行（验收通过后应回直） —')
const rec = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
const rep0 = rb.reportBlock({ name: '绵江公路塌方断道', polygon: midPoly })
const blk = rep0.block
rb.confirmImpacts(blk.id)
const imp = blk.impacts.find((i) => i.id === rec.id)
imp.plan = imp.options.find((o) => o.action === 'detour')
rb.applyImpact(blk.id, imp.key)
assert(rec.via.length > 0, '前置派发已绕行')
const detourDist = rec.distance

console.log('— 阻断记录发起抢修：派单校验与库存扣减 —')
assert(!rp.createOrder({ blockId: 'not-exist', baseId: 'rb-2', personnel: 5 }).ok, '阻断不存在派单被拒')
assert(!rp.createOrder({ blockId: blk.id, baseId: 'rb-2', personnel: 0, vehicles: 0 }).ok, '未分配任何资源派单被拒')
const stockBefore = {
  personnel: base1().stock.personnel,
  vehicle: base1().stock.vehicle,
  medical: base1().stock.medical
}
const over = rp.createOrder({ blockId: blk.id, baseId: 'rb-1', personnel: 99999, vehicles: 1 })
assert(!over.ok && over.msg.includes('人员不足'), '人员超库存被拦截')
const r1 = rp.createOrder({
  blockId: blk.id, baseId: 'rb-1', personnel: 20, vehicles: 4,
  materials: [{ type: 'medical', qty: 50 }], deadline: '今日 18:00'
})
assert(r1.ok, '指挥员分配队伍/车辆/物资派单成功')
const order = r1.order
assert(order.status === 'dispatched', '新工单为「待接单」')
assert(base1().stock.personnel === stockBefore.personnel - 20, '人员库存即时扣减 20')
assert(base1().stock.vehicle === stockBefore.vehicle - 4, '车辆库存即时扣减 4')
assert(base1().stock.medical === stockBefore.medical - 50, '医疗物资即时扣减 50')
assert(blk.log.some((l) => l.text.includes('发起道路抢修工单')), '阻断日志记录工单发起')
assert(!!rp.orderOfBlock(blk.id), '可按阻断查到进行中工单')

console.log('— 重复派单 / 重复接单拦截 —')
assert(!rp.createOrder({ blockId: blk.id, baseId: 'rb-1', personnel: 5 }).ok, '同一阻断不能重复发起在途工单')
assert(!rp.reportProgress(order.id, { progress: 10 }).ok, '未接单不能上报进度')
assert(rp.acceptOrder(order.id).ok, '现场接单成功')
assert(!rp.acceptOrder(order.id).ok, '重复接单被拦截')
assert(order.acceptedAt, '接单时间已记录')

console.log('— 现场上报进度：单调递增 —')
assert(rp.reportProgress(order.id, { progress: 30, note: '路面清障过半' }).ok, '上报 30%')
assert(!rp.reportProgress(order.id, { progress: 20 }).ok, '进度回退被拦截')
assert(rp.reportProgress(order.id, { progress: 60 }).ok, '上报 60%')
assert(order.progress === 60, '工单进度为 60%')

console.log('— 延期：保留阻断 —')
assert(rp.delayOrder(order.id, { reason: '夜间暴雨', deadline: '明日 12:00' }).ok, '申请延期')
assert(order.delayed && order.delayCount === 1, '工单标记延期 1 次')
assert(blk.status === 'active', '延期后阻断仍然生效')
assert(!!rb.activeBlocks.find((b) => b.id === blk.id), '延期阻断仍在生效清单')

console.log('— 完工上报实际消耗：阻断保留待验收 —')
const fin = rp.finishOrder(order.id, {
  personnel: 18, vehicles: 1,
  materials: { medical: 40 }
})
assert(fin.ok, '现场完工上报（实际消耗）')
assert(order.status === 'done' && order.progress === 100, '工单进入待验收')
assert(order.personnelUsed === 18 && order.vehiclesUsed === 1, '人员/车辆实际消耗已登记')
assert(order.materials[0].used === 40, '物资实际消耗已登记')
assert(blk.status === 'active', '完工未验收前阻断仍保留')
assert(!rp.delayOrder(order.id).ok, '待验收工单不能延期')
assert(!rp.reportProgress(order.id, { progress: 90 }).ok, '待验收工单不能再报进度')

console.log('— 验收通过：解除封闭 + 重算运输 + 按实际消耗归还 —')
const vehNow = base1().stock.vehicle
const pass = rp.acceptWork(order.id)
assert(pass.ok, '指挥员验收通过')
assert(order.status === 'cleared' && order.settled, '工单办结且已结算')
assert(blk.status === 'cleared', '验收通过后阻断解除')
assert(base1().stock.personnel === stockBefore.personnel - 18, '归还未消耗人员 2（20-18）')
assert(base1().stock.vehicle === stockBefore.vehicle - 1, '归还未损毁车辆 3（4-1）')
assert(base1().stock.medical === stockBefore.medical - 40, '归还未消耗医疗 10（50-40）')
assert(rec.via.length === 0 && rec.distance < detourDist, '受影响运输已重算：绕行路线回直')
assert(blk.log.some((l) => l.text.includes('验收通过')), '阻断日志记录验收通过')
assert(!rp.acceptWork(order.id).ok, '重复验收被拦截')

console.log('— 撤单：阻断保留，按实际消耗归还资源 —')
const blk2 = rb.reportBlock({ name: '阻断2-撤单场景', polygon: midPoly }).block
const stockB2 = { personnel: base1().stock.personnel, vehicle: base1().stock.vehicle, water: base1().stock.water }
const r2 = rp.createOrder({
  blockId: blk2.id, baseId: 'rb-1', personnel: 10, vehicles: 2,
  materials: [{ type: 'water', qty: 30 }]
})
const o2 = r2.order
assert(rp.cancelOrder(o2.id).ok, '待接单工单撤单成功')
assert(o2.status === 'cancelled' && blk2.status === 'active', '撤单后工单关闭、阻断保留')
assert(base1().stock.personnel === stockB2.personnel, '待接单撤单：人员全量归还 10')
assert(base1().stock.vehicle === stockB2.vehicle, '待接单撤单：车辆全量归还 2')
assert(base1().stock.water === stockB2.water, '待接单撤单：物资全量归还 30')
assert(!rp.orderOfBlock(blk2.id), '撤单工单不再计入在途工单')
// 阻断保留期间允许重新派单
const r2b = rp.createOrder({ blockId: blk2.id, baseId: 'rb-1', personnel: 6, vehicles: 1 }).order
rp.acceptOrder(r2b.id)
assert(rp.cancelOrder(r2b.id, { used: { personnel: 2 } }).ok, '接单后撤单可登记实际消耗')
assert(base1().stock.personnel === stockB2.personnel - 2, '抢修中撤单：仅扣实际消耗 2，余量 4 归还')
assert(!rp.cancelOrder(r2b.id).ok, '已撤单不能重复操作')

console.log('— 抢修失败（验收不通过）：阻断保留，按实际消耗归还 —')
const blk3 = rb.reportBlock({ name: '阻断3-失败场景', polygon: midPoly }).block
const stockB1 = { personnel: base1().stock.personnel, vehicle: base1().stock.vehicle, food: base1().stock.food }
const r3 = rp.createOrder({
  blockId: blk3.id, baseId: 'rb-1', personnel: 12, vehicles: 3,
  materials: [{ type: 'food', qty: 40 }]
})
const o3 = r3.order
rp.acceptOrder(o3.id)
rp.reportProgress(o3.id, { progress: 80 })
assert(rp.finishOrder(o3.id, { personnel: 12, vehicles: 2, materials: { food: 35 } }).ok, '完工待验收')
assert(rp.failOrder(o3.id, { reason: '夜间二次塌方，抢通段复损' }).ok, '验收不通过转失败')
assert(o3.status === 'failed' && blk3.status === 'active', '失败工单关闭、阻断保留')
assert(base1().stock.personnel === stockB1.personnel - 12, '人员全部实际消耗（12 不归还）')
assert(base1().stock.vehicle === stockB1.vehicle - 2, '损毁 2 辆，归还 1 辆')
assert(base1().stock.food === stockB1.food - 35, '食品消耗 35，归还 5')
assert(blk3.log.some((l) => l.text.includes('验收不通过') && l.text.includes('阻断保留')), '阻断日志记录验收不通过、阻断保留')
// 失败后可重新派单
const r3b = rp.createOrder({ blockId: blk3.id, baseId: 'rb-1', personnel: 4, vehicles: 1 })
assert(r3b.ok, '失败后阻断仍生效，允许重新派单')

console.log('— 结算幂等：重复归还不会多加库存 —')
// 注：失败后重新派单 r3b 仍占用 4 人（工单在途），故库存较初始少 12+4
assert(base1().stock.personnel === stockB1.personnel - 12 - 4, '失败工单结算后库存稳定（含重新派单占用 4）')
assert(o3.settled === true && o3.settlement.vehicle === 1, '结算快照记录归还车辆 1')

console.log('— 指挥员直接恢复通行：在途工单自动撤单、待验收自动办结 —')
const blk4 = rb.reportBlock({ name: '阻断4-强制恢复A', polygon: midPoly }).block
const stockB2b = { personnel: base1().stock.personnel }
const o4 = rp.createOrder({ blockId: blk4.id, baseId: 'rb-1', personnel: 8 }).order
rb.clearBlock(blk4.id)
assert(o4.status === 'cancelled', '抢修中的工单随阻断恢复自动撤单')
assert(base1().stock.personnel === stockB2b.personnel, '自动撤单按零消耗全量归还 8')

const blk5 = rb.reportBlock({ name: '阻断5-强制恢复B', polygon: midPoly }).block
const before5 = { personnel: base1().stock.personnel, medical: base1().stock.medical }
const o5 = rp.createOrder({ blockId: blk5.id, baseId: 'rb-1', personnel: 6, materials: [{ type: 'medical', qty: 20 }] }).order
rp.acceptOrder(o5.id)
rp.finishOrder(o5.id, { personnel: 2, materials: { medical: 5 } })
rb.clearBlock(blk5.id)
assert(o5.status === 'cleared', '待验收工单随阻断恢复视同验收通过自动办结')
assert(base1().stock.personnel === before5.personnel - 2, '自动办结归还未消耗人员 4')
assert(base1().stock.medical === before5.medical - 5, '自动办结归还未消耗医疗 15')
assert(blk5.status === 'cleared', '阻断已解除')

console.log('— 统计口径 —')
rp.load()
rb.load()
const a1 = rp.createOrder({ blockId: rb.reportBlock({ name: 's1', polygon: midPoly }).block.id, baseId: 'rb-1', personnel: 5 }).order
const a2 = rp.createOrder({ blockId: rb.reportBlock({ name: 's2', polygon: midPoly }).block.id, baseId: 'rb-1', personnel: 5 }).order
assert(rp.workingCount === 2, '两个待接单工单计入抢修中')
assert(rp.verifyCount === 0, '暂无待验收')
rp.acceptOrder(a1.id)
rp.finishOrder(a1.id, { personnel: 0 })
assert(rp.workingCount === 1 && rp.verifyCount === 1, '完工后抢修中-1、待验收+1')
rp.acceptWork(a1.id)
assert(rp.workingCount === 1 && rp.verifyCount === 0, '办结后退出待验收')
assert(rp.activeOrders.length === 1, '已办结工单不在活跃清单')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
