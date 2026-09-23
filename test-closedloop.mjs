// 物资派发闭环回归：分批签收 / 短缺认定补派 / 退回入库 / 在途与实收分账
// 联动：灾点需求缺口、安置点补给、道路阻断处置；兼容旧派发记录；防重复签收/回库
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
cmd.loadScenario('s1')
tr.load()
rb.load()
tr.setClock('00:00') // 固定业务时钟：本日入住按全日折算（原快照口径）

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events.find((e) => e.id === 'ev-001') // 江油
const rb2 = cmd.bases.find((b) => b.id === 'rb-2')   // 绵阳库
const stockFood = () => cmd.bases.reduce((s, b) => s + (b.stock.food || 0), 0)

console.log('— 分批签收：在途逐批递减，实收累计，缺口按 实收+在途 核算 —')
const d = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
assert(!!d, '派发建立：food 100')
assert(dispatchParts(d).inTransit === 100 && dispatchParts(d).received === 0, '初始在途 100 / 实收 0')
assert(cmd.sentMap[ev.id].food === 100, '保障量按在途计入 100')
assert(cmd.receivedMap[ev.id] === undefined, '尚无实收')
assert(!rb2.stock.food || rb2.stock.food === 12000 - 100, '出库扣减库存 100')

const s1 = cmd.signDispatch(d.id, { qty: 40, receiver: '李队长' })
assert(s1.ok, '第一批签收 40: ' + s1.msg)
assert(d.status === 'enroute', '部分签收后仍在途')
assert(dispatchParts(d).received === 40 && dispatchParts(d).inTransit === 60, '分账：实收 40 / 在途 60')
assert(cmd.sentMap[ev.id].food === 100, '保障量 = 实收 40 + 在途 60 = 100')
assert(cmd.receivedMap[ev.id].food === 40, '实收量 40')
const s2 = cmd.signDispatch(d.id, { qty: 60, receiver: '王干事' })
assert(s2.ok && d.status === 'done' && d.doneReason === 'signed', '第二批签收 60 后办结')
assert(dispatchParts(d).received === 100 && dispatchParts(d).inTransit === 0, '累计实收 100 / 在途 0')
assert(d.signLogs.length === 2 && d.signLogs[1].receiver === '王干事', '两批签收回执留痕')

console.log('— 防重复签收：办结记录拒绝再签；超量签认拦截 —')
const dup = cmd.signDispatch(d.id, { qty: 1 })
assert(!dup.ok, '已办结记录重复签收被拦截: ' + dup.msg)
assert(!cmd.returnDispatch(d.id, { qty: 1 }).ok, '已办结记录重复退回被拦截')

const d2 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 50 })
const over = cmd.signDispatch(d2.id, { qty: 30, shortQty: 30 })
assert(!over.ok, '签收+短缺超出在途余量被拦截（30+30>50）: ' + over.msg)
const neg = cmd.signDispatch(d2.id, { qty: 0, shortQty: 0 })
assert(!neg.ok, '空签收被拦截')

console.log('— 短缺认定：在途余量留账，缺口重新释放 —')
const w1 = cmd.signDispatch(d2.id, { qty: 40, shortQty: 10, receiver: '赵仓管' })
assert(w1.ok && d2.status === 'done' && d2.doneReason === 'short', '签收 40 + 认定短缺 10 后办结')
assert(dispatchParts(d2).received === 40 && dispatchParts(d2).shortage === 10, '实收 40 / 短缺 10')
assert(cmd.sentMap[ev.id].water === 40, '保障量仅计实收 40（短缺不计）')
assert(cmd.shortageMap[ev.id].water === 10, '短缺待补 10 计入缺口视图')
assert(cmd.gaps.find((g) => g.eventId === ev.id).gap.water === 3000 - 40, '需求缺口重算（短缺 10 退出保障，缺口重新释放为 2960）')

console.log('— 短缺补派：就近出库生成新在途记录，防重复补派 —')
const foodBefore = stockFood()
const rp = cmd.replenishShortage(d2.id)
assert(rp.ok && rp.sent.length === 1 && rp.sent[0].qty === 10, '短缺 10 补派一单: ' + rp.msg)
const child = rp.sent[0]
assert(child.replenishOf === d2.id && (child.source || '').includes('补派'), '补派记录回链原单并标记来源')
assert(d2.shortReplenished === 10 && dispatchParts(d2).shortPending === 0, '原单短缺已补齐，待补清零')
assert(cmd.shortageMap[ev.id]?.water === undefined, '短缺待补视图清零')
assert(stockFood() === foodBefore, '补派按短缺量重新扣库（water 10）')
assert(!cmd.replenishShortage(d2.id).ok, '无待补短缺时重复补派被拦截')
// 补派单本身是新的在途任务，保障量回到 50（实收40 + 补派在途10）
assert(cmd.sentMap[ev.id].water === 50, '补派在途计入保障量')
assert(rb.blocks.length >= 0, '（无阻断场景）补派不触发异常')

console.log('— 分批补派：跨基地库存不足时拆单 —')
const d3 = cmd.dispatchResource({ baseId: 'rb-3', eventId: ev.id, type: 'medical', qty: 200 })
cmd.signDispatch(d3.id, { qty: 0, shortQty: 200 })
// rb-3 medical 8000 充足，先造紧：将其库存压到 30，补派应拆给其他基地
cmd.bases.find((b) => b.id === 'rb-3').stock.medical = 30
const rp2 = cmd.replenishShortage(d3.id)
const made = rp2.sent.reduce((s, x) => s + x.qty, 0)
assert(rp2.ok && made === 200, `跨基地拆单补派 200（${rp2.sent.length} 单）`)
assert(new Set(rp2.sent.map((x) => x.baseId)).size >= 1, '补派单来自库存可用基地')
assert(rp2.sent.every((x) => x.replenishOf === d3.id), '拆单均回链原短缺单')

console.log('— 退回入库：部分退回库存回补、在途量下降；全部退回办结 —')
const d4 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'tent', qty: 80 })
const tentBefore = rb2.stock.tent
const r1 = cmd.returnDispatch(d4.id, { qty: 30, reason: '包装破损' })
assert(r1.ok && dispatchParts(d4).returned === 30 && dispatchParts(d4).inTransit === 50, '部分退回 30，在途余量 50')
assert(rb2.stock.tent === tentBefore + 30, '退回 30 库存回补')
assert(cmd.sentMap[ev.id].tent === 50, '保障量只计剩余在途 50')
assert(d4.returnLogs.length === 1 && d4.returnLogs[0].reason === '包装破损', '退回原因留痕')
assert(!cmd.returnDispatch(d4.id, { qty: 60 }).ok, '超余量退回被拦截（60>50）')
const r2 = cmd.returnDispatch(d4.id, { qty: 50 })
assert(r2.ok && d4.status === 'done' && d4.doneReason === 'returned', '余量 50 全部退回后办结')
assert(rb2.stock.tent === tentBefore + 80 && dispatchParts(d4).inTransit === 0, '累计回库 80 / 在途 0')
assert(cmd.sentMap[ev.id]?.tent === undefined, '该单不再提供任何保障量')

console.log('— 撤回留账：在途余量回库，实收/短缺/退回记录保留，缺口重算 —')
const d5 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 60 })
const fb0 = rb2.stock.food // d5 出库后的库存基线（含退回 10 尚未发生）
cmd.signDispatch(d5.id, { qty: 20 })           // 实收 20
cmd.returnDispatch(d5.id, { qty: 10 })          // 退回 10（已回库）
const fb1 = rb2.stock.food                      // = fb0 + 10
const foodCoverBefore = cmd.sentMap[ev.id].food
cmd.withdrawDispatch(d5.id)                     // 撤回：仅剩在途 30 应回库
assert(rb2.stock.food === fb1 + 30 && rb2.stock.food === fb0 + 40, '撤回仅返还在途 30（签收 20 不回、退回 10 不重复回）')
assert(cmd.dispatches.some((x) => x.id === d5.id), '撤回后记录保留（不再删除）')
assert(d5.status === 'withdrawn' && d5.doneReason === 'withdrawn', '记录标记为已撤回留档')
const p5 = dispatchParts(d5)
assert(p5.received === 20 && p5.returned === 10 && p5.withdrawn === 30 && p5.outstanding === 0 && p5.inTransit === 0,
  '分账保留：实收 20 / 退回 10 / 撤回 30，在途清零')
assert(d5.signLogs.length === 1 && d5.returnLogs.length === 1 && d5.withdrawLogs.length === 1 && d5.withdrawLogs[0].qty === 30,
  '签收/退回/撤回三类回执均留痕')
assert(cmd.sentMap[ev.id].food === foodCoverBefore - 30, '灾点保障量重算：撤回的在途 30 退出')
assert(cmd.receivedMap[ev.id].food >= 20, '实收账目未随撤回丢失')
assert(!cmd.signDispatch(d5.id, { qty: 1 }).ok, '撤回后签收被拦截')
assert(!cmd.returnDispatch(d5.id, { qty: 1 }).ok, '撤回后退回被拦截')
cmd.withdrawDispatch(d5.id)
assert(rb2.stock.food === fb1 + 30, '重复撤回幂等：不重复回库')

console.log('— 撤回短缺补派单：在途补派回库，原单短缺缺口重新释放 —')
const childBase = cmd.bases.find((b) => b.id === child.baseId)
const cw0 = childBase.stock.water
cmd.withdrawDispatch(child.id)
assert(child.status === 'withdrawn' && dispatchParts(child).withdrawn === 10, '补派单撤回留档，在途 10 计入撤回账')
assert(childBase.stock.water === cw0 + 10, '补派在途 10 退回基地库存')
assert(d2.shortReplenished === 0 && dispatchParts(d2).shortPending === 10, '原单已补派量冲回，短缺 10 重新待补')
assert(cmd.shortageMap[ev.id].water === 10, '短缺待补视图重新出现')
assert(cmd.sentMap[ev.id].water === 40, `撤回补派后保障量回落为 d2 实收 40（d7 尚未建立），实际 ${cmd.sentMap[ev.id].water}`)
const rp3 = cmd.replenishShortage(d2.id)
assert(rp3.ok && dispatchParts(d2).shortPending === 0, '缺口重开后可再次补派补齐')
assert(cmd.sentMap[ev.id].water === 50, '再次补派在途 10 回到保障量 50')

console.log('— 撤回挂起单：物资已随挂起在库，撤回不重复回库但留账 —')
const d9 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'tent', qty: 40 })
cmd.holdDispatch(d9.id, null)
const tentHeld = rb2.stock.tent
cmd.withdrawDispatch(d9.id)
assert(rb2.stock.tent === tentHeld, '挂起余量已在库，撤回不重复回库')
assert(d9.status === 'withdrawn' && dispatchParts(d9).withdrawn === 40 && dispatchParts(d9).outstanding === 0,
  '挂起余量 40 计入撤回账、记录留档')

console.log('— 挂起/续派与闭环联动：仅在途余量退库/重扣，可继续分批签收 —')
const d6 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
cmd.signDispatch(d6.id, { qty: 40 })                       // 已签 40
const g0 = rb2.stock.food
const corridor = [[104.6438, 31.5209], [104.8438, 31.5209], [104.8438, 31.7209], [104.6438, 31.7209]]
const blk = rb.reportBlock({ name: '闭环走廊阻断', polygon: corridor }).block
assert(blk.impacts.some((i) => i.kind === 'dispatch' && i.id === d6.id), '在途余量任务进入阻断影响评估')
rb.confirmImpacts(blk.id)
const imp = blk.impacts.find((i) => i.id === d6.id)
imp.plan = imp.options.find((o) => o.action === 'suspend')
rb.applyImpact(blk.id, imp.key)
assert(d6.status === 'held' && dispatchParts(d6).heldQty === 60, '挂起只冻结在途余量 60（实收 40 不受影响）')
assert(rb2.stock.food === g0 + 60, '挂起仅退回 60（非全量 100）')
// 保障量（food）：d 已办结实收 100 + d5 撤回留档实收 20 + d6 已签 40（挂起的在途 60 退出）
assert(cmd.sentMap[ev.id].food === 160, `挂起后保障量 = 既有实收 100 + 撤回单保留实收 20 + 本单实收 40 = 160，实际 ${cmd.sentMap[ev.id].food}`)
assert(!cmd.signDispatch(d6.id, { qty: 1 }).ok, '挂起中签收被拦截')
rb.clearBlock(blk.id)
const rs = rb.resumeHeld()
assert(rs.resumed >= 1 && d6.status === 'enroute', '恢复后续派成功')
assert(rb2.stock.food === g0, '续派重新扣减 60')
const s3 = cmd.signDispatch(d6.id, { qty: 30 })
assert(s3.ok && dispatchParts(d6).received === 70 && dispatchParts(d6).inTransit === 30, '续派后继续分批签收：实收 70 / 在途 30')
const s4 = cmd.signDispatch(d6.id, { qty: 30 })
assert(s4.ok && d6.status === 'done', '剩余 30 签收后办结')

console.log('— 阻断扫描排除已办结派发，绕行只改在途任务 —')
const d7 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 20 })
cmd.signDispatch(d7.id, { qty: 20 })
const blk2 = rb.reportBlock({ name: '办结单阻断', polygon: corridor }).block
assert(!blk2.impacts.some((i) => i.kind === 'dispatch' && i.id === d7.id), '已办结派发不再纳入阻断影响评估')
rb.clearBlock(blk2.id)

console.log('— 部分签收后改派：仅在途余量跨基地迁移 —')
const d8 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'medical', qty: 100 })
cmd.signDispatch(d8.id, { qty: 60 })
const oldStock = rb2.stock.medical
const blk3 = rb.reportBlock({ name: '改派阻断', polygon: corridor }).block
rb.confirmImpacts(blk3.id)
const imp8 = blk3.impacts.find((i) => i.id === d8.id)
const ropt = imp8?.options.find((o) => o.action === 'reassign')
if (ropt) {
  imp8.plan = ropt
  assert(rb.applyImpact(blk3.id, imp8.key).ok, '执行改派')
  const nb = cmd.bases.find((b) => b.id === ropt.baseId)
  assert(dispatchParts(d8).inTransit === 40, '改派后在途余量仍为 40')
  assert(rb2.stock.medical === oldStock + 40, `旧基地仅退回在途 40（实收 60 不动）`)
  assert(d8.baseId === nb.id, `改派至「${nb.name}」`)
} else {
  assert(false, '应生成改派候选（在途 40 的替代基地）')
}
rb.clearBlock(blk3.id)

console.log('— 安置点补给闭环：在途/实收分账驱动缺口，签收后才计入实收 —')
const bt = tr.createBatch({ eventId: ev.id, name: '补给测试批', headcount: 50, vehicleBaseId: 'rb-1', vehicleCount: 2, shelterId: 'sh-2' })
assert(bt.ok, '建立批次')
tr.register(bt.batch.id, 'pickup', { count: 50 })
tr.register(bt.batch.id, 'checkin', { count: 50 }) // 在住 50 → food 需求 30
const before = tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2')
assert(before.gap.food === 30, '安置点食品缺口 30')
const sup = tr.autoSupply('sh-2')
assert(sup.ok && sup.sent.length > 0, `一键补给 ${sup.sent.length} 单`)
const supRec = sup.sent.find((x) => x.type === 'food')
const after0 = tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2')
assert(!after0.gap.food && after0.sent.food === 30 && (after0.received.food || 0) === 0, '在途补给计入保障量、实收仍为 0')
cmd.signDispatch(supRec.id, { qty: 30 })
const after1 = tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2')
assert(after1.received.food === 30 && after1.sent.food === 30, '签收后实收 30、保障量不变')
// 补给退回：缺口重新出现
const supRec2 = tr.autoSupply('sh-2') // 无缺口应无动作
assert(!supRec2.ok, '缺口已平时一键补给无动作: ' + supRec2.msg)

console.log('— 撤回安置点补给：在途量回库缺口重开，已签收补给保留 —')
const sh2 = tr.shelters.find((s) => s.id === 'sh-2')
// 一键补给中 water 10 仍在途：撤回后缺口应重新释放
const supWater = sup.sent.find((x) => x.type === 'water')
assert(supWater && dispatchParts(supWater).inTransit === 10, '存在在途 water 补给 10')
const sw0 = cmd.bases.find((b) => b.id === supWater.baseId).stock.water
cmd.withdrawDispatch(supWater.id)
assert(cmd.bases.find((b) => b.id === supWater.baseId).stock.water === sw0 + 10, '撤回补给在途 10 回库')
const sh1 = tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2')
assert(sh1.gap.water === 10 && (sh1.sent.water || 0) === 0 && (sh1.received.water || 0) === 0,
  '撤回后安置点 water 缺口重新释放为 10，保障/实收清零')
// 增加在住人数至 100 → food 需求 60；新发在途 30 部分签撤回：签收 10 保留、在途 20 退出
const bt2 = tr.createBatch({ eventId: ev.id, name: '补给扩员批', headcount: 50, vehicleBaseId: 'rb-1', vehicleCount: 2, shelterId: 'sh-2' })
assert(bt2.ok, '建立扩员批次')
tr.register(bt2.batch.id, 'pickup', { count: 50 })
tr.register(bt2.batch.id, 'checkin', { count: 50 })
const sd2 = cmd.dispatchToShelter({
  baseId: 'rb-2', shelterId: 'sh-2', shelterName: sh2.name, lng: sh2.lng, lat: sh2.lat, type: 'food', qty: 30
})
cmd.signDispatch(sd2.id, { qty: 10 })
cmd.withdrawDispatch(sd2.id)
const sh2need = tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2')
assert(sh2need.need.food === 60 && sh2need.received.food === 40 && sh2need.sent.food === 40 && sh2need.gap.food === 20,
  '撤回后已签收补给 10 保留（累计实收 40），在途 20 退出保障，缺口 20')
assert(sd2.status === 'withdrawn' && dispatchParts(sd2).received === 10 && dispatchParts(sd2).withdrawn === 20,
  '补给单分账：实收 10 不丢、撤回 20 回库')

console.log('— 兼容旧派发记录：无闭环字段时默认全量在途，原行为不变 —')
const legacy = {
  id: 'dp-legacy-1', baseId: 'rb-2', baseName: rb2.name, eventId: ev.id, eventTitle: ev.title,
  lng: ev.location.lng, lat: ev.location.lat,
  type: 'tent', typeLabel: '帐篷', qty: 70, unit: '顶',
  distance: 10, minutes: 20, at: '00:01', color: '#fff', source: '旧系统',
  status: 'enroute', via: [], detourBy: null, holdBy: null
  // 故意不携带任何闭环字段
}
cmd.dispatches.unshift(legacy)
const lp = dispatchParts(legacy)
assert(lp.inTransit === 70 && lp.received === 0 && lp.outstanding === 70, '旧记录按全量在途兼容')
assert(cmd.sentMap[ev.id].tent === 70, '旧记录照常计入保障量')
// 旧记录可直接走新闭环流程完成签收
const ls = cmd.signDispatch(legacy.id, { qty: 70 })
assert(ls.ok && legacy.status === 'done' && legacy.signLogs.length === 1, '旧记录支持新流程签收并办结')
// 旧形态挂起记录（status=held 无闭环字段）：兼容视为全量挂起
const legacyHeld = {
  id: 'dp-legacy-2', baseId: 'rb-2', baseName: rb2.name, eventId: ev.id, eventTitle: ev.title,
  lng: ev.location.lng, lat: ev.location.lat,
  type: 'water', typeLabel: '饮用水', qty: 30, unit: '箱',
  distance: 10, minutes: 20, at: '00:02', color: '#fff', source: '旧系统',
  status: 'held', via: [], detourBy: null, holdBy: 'blk-x'
}
cmd.dispatches.unshift(legacyHeld)
assert(dispatchParts(legacyHeld).heldQty === 30, '旧挂起记录兼容为全量挂起 30')
// 既有 water 保障量 = d2 实收 40 + 补派在途 10 + d7 实收 20 = 70；旧挂起 30 不计入
assert(cmd.sentMap[ev.id].water === 70, `旧挂起记录不计保障量（实际 ${cmd.sentMap[ev.id].water}）`)

console.log('— 大屏统计：签收记录数 / 短缺待补记录数 —')
assert(cmd.stats.signedToday >= 5, `今日签收记录数 ${cmd.stats.signedToday} >= 5`)
assert(cmd.stats.shortagePending === 0, '短缺均已补派，待补记录数为 0')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
