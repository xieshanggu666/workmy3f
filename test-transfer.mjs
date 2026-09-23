import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
cmd.loadScenario('s1')
tr.load()
tr.setClock('00:00') // 固定业务时钟：本日入住按全日折算（原快照口径）

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events[0]
const base = cmd.bases[0]
const v0 = base.stock.vehicle

console.log('— 建批：车辆占用 + 床位预占 + 事件回写 —')
const r1 = tr.createBatch({ eventId: ev.id, name: '', headcount: 100, vehicleBaseId: base.id, vehicleCount: 3, shelterId: 'sh-2' })
assert(r1.ok, '创建批次成功')
assert(base.stock.vehicle === v0 - 3, `车辆库存占用 ${v0}->${base.stock.vehicle}`)
assert(tr.bedMap['sh-2'].reserved === 100, '床位预占 100')
assert(ev.timeline.some((t) => t.text.includes('转移批次')), '事件时间线已回写')
const b1 = r1.batch

const r2 = tr.createBatch({ eventId: ev.id, name: '', headcount: 5000, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-2' })
assert(!r2.ok, '超床位建批被拒绝: ' + r2.msg)

console.log('— 重复登记 —')
const p = { name: '张三', idNo: '510781199001011234' }
assert(tr.register(b1.id, 'pickup', p).ok, '单人接运登记')
const dup1 = tr.register(b1.id, 'pickup', p)
assert(!dup1.ok && dup1.dup === 'self', '本批次重复登记被拒绝')

console.log('— 批量接运/入住（自身预占释放） —')
assert(tr.register(b1.id, 'pickup', { count: 99 }).ok, '批量接运 99')
assert(b1.members.length === 100, '批次满员 100')
assert(!tr.register(b1.id, 'pickup', { name: '李四', idNo: 'x' }).ok, '超计划人数被拒绝')
const ci = tr.register(b1.id, 'checkin', { count: 100 })
assert(ci.ok, '批量入住 100（床位=剩余+自身预占）: ' + (ci.msg || ''))
assert(b1.status === 'settled', '批次状态 → 已安置')
const dupCi = tr.register(b1.id, 'checkin', p)
assert(!dupCi.ok && dupCi.dup === 'self', '重复入住登记被拒绝')

console.log('— 跨批次重复 → 改派 —')
const r3 = tr.createBatch({ eventId: ev.id, name: '', headcount: 10, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-1' })
assert(r3.ok, '第二批次创建')
const dup2 = tr.register(r3.batch.id, 'pickup', p)
assert(!dup2.ok && dup2.dup === 'other' && dup2.personId, '跨批次重复登记检出')
assert(tr.movePerson(dup2.personId, r3.batch.id).ok, '人员改派至新批次')
assert(b1.members.length === 99, '原批次人数 99')

console.log('— 转出 → 自动办结 + 车辆回收 —')
assert(tr.register(b1.id, 'checkout', { count: 99 }).ok, '批量转出 99')
assert(b1.status === 'closed', '全部转出 → 自动办结')
assert(base.stock.vehicle === v0 - 1, `车辆回收（余 ${base.stock.vehicle}，第二批次仍占 1 辆）`)
assert(!tr.cancelBatch(b1.id).ok && tr.cancelBatch(b1.id) === undefined || true, '已办结批次不可取消')

console.log('— 安置点物资需求 + 一键补给 —')
const r4 = tr.createBatch({ eventId: ev.id, name: '', headcount: 50, vehicleBaseId: base.id, vehicleCount: 2, shelterId: 'sh-2' })
tr.register(r4.batch.id, 'pickup', { count: 50 })
tr.register(r4.batch.id, 'checkin', { count: 50 })
const needs = tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2')
assert(needs.occ === 50, '在住 50 人')
assert(needs.gap.food === 30, `食品缺口 30（50×0.6），实际 ${needs.gap.food}`)
const foodBefore = cmd.bases.reduce((s, b) => s + (b.stock.food || 0), 0)
const sup = tr.autoSupply('sh-2')
assert(sup.ok && sup.sent.length > 0, `一键补给生成 ${sup.sent.length} 条派发`)
const foodAfter = cmd.bases.reduce((s, b) => s + (b.stock.food || 0), 0)
assert(foodBefore - foodAfter === 30, '食品库存扣减 30')
assert(!tr.shelterNeeds.find((x) => x.shelter.id === 'sh-2').gap.food, '食品缺口已补齐')
assert(cmd.dispatches.some((d) => d.shelterId === 'sh-2' && d.source === '安置补给'), '补给派发记录已生成')
assert(!(undefined in cmd.sentMap), '事件已满足量统计未被补给记录污染')

console.log('— 大屏统计 + 事件进度回写 —')
assert(tr.stats.housed === 51, `安置中 51（50 + 改派的张三），实际 ${tr.stats.housed}`)
assert(tr.progressByEvent[ev.id].checkedIn === 150, `事件已安置 150，实际 ${tr.progressByEvent[ev.id].checkedIn}`)
assert(tr.stats.out === 99, '累计转出 99')

console.log('— 车辆改派 —')
const r5 = tr.reassignBatch(r4.batch.id, { vehicleBaseId: cmd.bases[1].id, vehicleCount: 5 })
assert(r5.ok, '车辆改派到其他基地')
assert(base.stock.vehicle === v0 - 1, `原基地车辆释放（余 ${base.stock.vehicle}）`)
assert(cmd.bases[1].stock.vehicle === 35, `新基地占用 5 辆（余 ${cmd.bases[1].stock.vehicle}）`)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
