// 安置点按日补给回归：按实际入住时段折算人日、耐用品/消耗品分账、跨日结转库存与在途、
// 人员转出/分批签收/短缺补派/退回联动重算缺口、兼容历史派发记录、避免重复补给
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useTransferStore, memberDayFrac } from '@/store/transfer'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
cmd.loadScenario('s1')
tr.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events.find((e) => e.id === 'ev-001')
const rb2 = cmd.bases.find((b) => b.id === 'rb-2') // 绵阳库（距 sh-1 最近）
const sh1 = tr.shelters.find((s) => s.id === 'sh-1')
const need1 = () => tr.shelterNeeds.find((x) => x.shelter.id === 'sh-1')
const need3 = () => tr.shelterNeeds.find((x) => x.shelter.id === 'sh-3')

console.log('— 按实际入住时段折算本日人日（08:00 入住 → 当日 2/3 人日） —')
tr.setClock('08:00')
const b1 = tr.createBatch({ eventId: ev.id, name: '日供一批', headcount: 60, vehicleBaseId: 'rb-1', vehicleCount: 2, shelterId: 'sh-1' })
assert(b1.ok, '建立批次 60 人 → sh-1')
tr.register(b1.batch.id, 'pickup', { count: 60 })
tr.register(b1.batch.id, 'checkin', { count: 60 })
let n1 = need1()
assert(n1.todayPd === 40, `本日人日 = 60×(24-8)/24 = 40，实际 ${n1.todayPd}`)
assert(n1.consumables.food.today === 24 && n1.gap.food === 24, `食品本日需 24（40人日×0.6），缺口 24，实际 ${n1.consumables.food.today}/${n1.gap.food}`)
assert(n1.consumables.water.today === 8 && n1.consumables.medical.today === 2, '水 8 / 医疗 2 同步折算')
assert(n1.durables.tent.need === 15 && n1.durables.tent.gap === 15, '耐用品帐篷按在住峰值配备 15（60×0.25），不按日耗')
assert(n1.need.food === 24, '累计需求视图 = 24')

console.log('— 一键补给按当日缺口调拨，缺口平后不再重复补给 —')
const sup1 = tr.autoSupply('sh-1')
assert(sup1.ok && sup1.sent.length === 4, `一键补给 4 类物资（食24/水8/医2/帐15），实际 ${sup1.sent.length} 单`)
const qtyOf = (t) => sup1.sent.find((x) => x.type === t)?.qty
assert(qtyOf('food') === 24 && qtyOf('water') === 8 && qtyOf('medical') === 2 && qtyOf('tent') === 15, '补给量与按日核算缺口一致')
assert(rb2.stock.food === 12000 - 24 && rb2.stock.tent === 3000 - 15, '就近从绵阳库出库')
assert(!need1().gap.food && !need1().gap.tent, '在途计入后缺口清零')
const supDup = tr.autoSupply('sh-1')
assert(!supDup.ok, '缺口已平，重复一键补给被拦截: ' + supDup.msg)

console.log('— 分批签收：实收入账形成结余库存，在途逐批递减 —')
const dFood = sup1.sent.find((x) => x.type === 'food')
cmd.signDispatch(dFood.id, { qty: 10, receiver: '仓管甲' })
n1 = need1()
assert(n1.consumables.food.onHand === 10 && n1.consumables.food.inTransit === 14, '签收 10：结余 10 / 在途 14')
assert(!n1.gap.food, '实收+在途仍覆盖本日需求，无缺口')
cmd.signDispatch(dFood.id, { qty: 14, receiver: '仓管乙' })
n1 = need1()
assert(n1.consumables.food.received === 24 && n1.consumables.food.inTransit === 0 && n1.consumables.food.onHand === 24, '两批签收完：实收 24 / 在途 0 / 结余 24')
// 超量补给（手动多拨 10）：形成跨日结余
const dExtra = cmd.dispatchToShelter({ baseId: 'rb-2', shelterId: 'sh-1', shelterName: sh1.name, lng: sh1.lng, lat: sh1.lat, type: 'food', qty: 10 })
cmd.signDispatch(dExtra.id, { qty: 10 })
assert(need1().consumables.food.onHand === 34, '多拨 10 签收后结余 34')
const dWater = sup1.sent.find((x) => x.type === 'water')
cmd.signDispatch(dWater.id, { qty: 5 }) // 水签收 5，余 3 在途（留待日结结转）

console.log('— 日结：按入住时段入账消耗，结余库存与在途物资跨日结转 —')
const st1 = tr.settleShelters()
assert(tr.settleDay === 2, '日结后进入第 2 日')
const r1 = st1.find((x) => x.shelter.id === 'sh-1')
assert(r1.personDays === 40 && r1.inHouse === 60, `第 1 日人日 40、日终在住 60，实际 ${r1.personDays}/${r1.inHouse}`)
assert(r1.consumed.food === 24 && r1.consumed.water === 8 && r1.consumed.medical === 2, '消耗品按人日×系数入账（耐用品不耗）')
assert(!('tent' in r1.consumed), '耐用品不参与日消耗')
assert(r1.carry.food === 10, `结余库存结转次日：食品 34-24=10，实际 ${r1.carry.food}`)
assert(r1.inTransit.water === 3 && r1.inTransit.tent === 15, '在途物资（水 3、帐篷 15）结转至次日')
n1 = need1()
assert(n1.consumables.food.consumed === 24 && n1.consumables.food.onHand === 10, '账面：累计已耗 24 / 结余 10')
assert(sh1.settlements.length === 1 && sh1.settlements[0].day === 1, '日结记录留痕')
assert(ev.timeline.some((t) => t.text.includes('日结')), '日结回写事件时间线')

console.log('— 次日需求滚动：历史已耗 + 本日预计；人员转出同步重算缺口 —')
tr.setClock('12:00')
n1 = need1()
assert(n1.todayPd === 60 && n1.gap.food === 26, `转出前：人日 60、累计需 60、缺口 = 60-34 = 26，实际 ${n1.todayPd}/${n1.gap.food}`)
tr.register(b1.batch.id, 'checkout', { count: 24 }) // 24 人 12:00 转出 → 当日各计 0.5 人日
n1 = need1()
assert(n1.todayPd === 48, `转出 24 人后本日人日 = 36×1 + 24×0.5 = 48，实际 ${n1.todayPd}`)
assert(n1.consumables.food.today === 28.8 && n1.gap.food === 19, `食品本日需 28.8、累计需 52.8、缺口 19，实际 ${n1.consumables.food.today}/${n1.gap.food}`)
assert(n1.gap.water === 10, `水累计需 17.6、实收 5+在途 3、缺口 10，实际 ${n1.gap.water}`)
assert(n1.peak === 60 && n1.durables.tent.need === 15 && !n1.gap.tent, '转出不减耐用品峰值需求（帐篷 15 已在途）')

console.log('— 短缺认定重开缺口 → 补派联动 → 退回再重算 —')
const dW2 = cmd.dispatchToShelter({ baseId: 'rb-2', shelterId: 'sh-1', shelterName: sh1.name, lng: sh1.lng, lat: sh1.lat, type: 'water', qty: 20 })
const sw = cmd.signDispatch(dW2.id, { qty: 8, shortQty: 12 })
assert(sw.ok && dW2.status === 'done', '水 20：签收 8 + 认定短缺 12 后办结')
n1 = need1()
assert(n1.consumables.water.received === 13 && n1.consumables.water.inTransit === 3, '水实收 13 / 在途 3（短缺不计保障）')
assert(n1.gap.water === 2, `短缺重开缺口：17.6 - 16 = 1.6 → 2，实际 ${n1.gap.water}`)
const rp = cmd.replenishShortage(dW2.id)
assert(rp.ok && rp.sent.length === 1 && rp.sent[0].qty === 12, '短缺 12 一键补派')
assert(!need1().gap.water, '补派在途计入后缺口闭合')
const rt = cmd.returnDispatch(rp.sent[0].id, { qty: 12, reason: '重复出库' })
assert(rt.ok && need1().gap.water === 2, '补派单全量退回后缺口重新释放为 2')

console.log('— 兼容历史派发记录：无闭环字段按全量在途计入，避免重复补给 —')
const legacy = {
  id: 'dp-legacy-sh1', baseId: 'rb-2', baseName: rb2.name, shelterId: 'sh-1', shelterName: sh1.name,
  lng: sh1.lng, lat: sh1.lat, type: 'food', typeLabel: '应急食品', qty: 26, unit: '份',
  distance: 10, minutes: 20, at: '昨天', color: '#26a69a', source: '旧系统',
  status: 'enroute', via: [], detourBy: null, holdBy: null // 故意不携带闭环字段
}
cmd.dispatches.unshift(legacy)
n1 = need1()
assert(dispatchParts(legacy).inTransit === 26, '旧记录按全量在途兼容')
assert(n1.consumables.food.inTransit === 26 && !n1.gap.food, `旧补给在途 26 计入后食品缺口闭合（52.8-34-26<0），实际 ${n1.gap.food}`)
const sup2 = tr.autoSupply('sh-1')
assert(sup2.ok && sup2.sent.length === 2, `一键补给仅补真实缺口（水 2 + 医 3），实际 ${sup2.sent.length} 单`)
assert(sup2.sent.find((x) => x.type === 'water')?.qty === 2 && sup2.sent.find((x) => x.type === 'medical')?.qty === 3, '补派量 = 各类缺口，不重复补给')
assert(!tr.autoSupply('sh-1').ok, '缺口平后再次补给被拦截')

console.log('— 同日入退按时段折算 + 第二次日结 —')
tr.setClock('10:00')
const b3 = tr.createBatch({ eventId: ev.id, name: '当日往返批', headcount: 8, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-3' })
tr.register(b3.batch.id, 'pickup', { count: 8 })
tr.register(b3.batch.id, 'checkin', { count: 8 })
tr.setClock('18:00')
tr.register(b3.batch.id, 'checkout', { count: 8 }) // 当日 10:00→18:00，各 1/3 人日
const st2 = tr.settleShelters()
const r3 = st2.find((x) => x.shelter.id === 'sh-3')
assert(r3.personDays === 2.67, `sh-3 第 2 日人日 = 8×(18-10)/24 ≈ 2.67，实际 ${r3.personDays}`)
assert(r3.consumed.food === 1.6 && r3.inHouse === 0, 'sh-3 当日消耗食品 1.6、日终在住 0')
const r2 = st2.find((x) => x.shelter.id === 'sh-1')
assert(r2.personDays === 48 && r2.inHouse === 36, 'sh-1 第 2 日人日 48、日终在住 36')
assert(need1().consumables.food.consumed === 52.8, `sh-1 累计已耗 24+28.8=52.8，实际 ${need1().consumables.food.consumed}`)
assert(sh1.settlements.length === 2, 'sh-1 已有 2 条日结记录')

console.log('— 第 3 日：结转后缺口按 累计需求-实收-在途 重算 —')
tr.setClock('00:00')
n1 = need1()
assert(n1.todayPd === 36 && n1.consumables.food.today === 21.6, '第 3 日在住 36 人全日计：本日需 21.6')
assert(n1.gap.food === 15, `食品累计需 74.4 - 实收 34 - 在途 26 = 14.4 → 15，实际 ${n1.gap.food}`)
assert(n1.gap.water === 7, `水累计需 24.8 - 实收 13 - 在途 5 = 6.8 → 7，实际 ${n1.gap.water}`)
const n3 = need3()
assert(n3.gap.food === 2, `sh-3 历史已耗 1.6 未补给 → 缺口 2（跨日欠账滚存），实际 ${n3.gap.food}`)
assert(n3.durables.tent.need === 2 && n3.durables.tent.gap === 2, 'sh-3 峰值 8 人 → 帐篷需 2')

console.log('— 时段折算工具：成员日占比边界 —')
assert(memberDayFrac({ checkinAt: '12:00', checkinDay: 2 }, 1) === 0, '第 2 日入住者在第 1 日不计')
assert(memberDayFrac({ checkinAt: '12:00', checkinDay: 2 }, 2) === 0.5, '当日 12:00 入住计 0.5 人日')
assert(memberDayFrac({ checkinAt: '12:00', checkinDay: 1, checkoutAt: '18:00', checkoutDay: 2 }, 2) === 0.75, '次日 18:00 转出计 0.75 人日')
assert(memberDayFrac({ checkinAt: '12:00', checkinDay: 1, checkoutAt: '18:00', checkoutDay: 2 }, 3) === 0, '转出后第 3 日不计')
assert(memberDayFrac({ checkinAt: '09:00' }, 1) === 0.625, '无日戳历史记录按第 1 日兼容（(24-9)/24=0.625）')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
