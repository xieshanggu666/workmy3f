import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'

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

const ev = cmd.events[0]
const base = cmd.bases.find((b) => b.id === 'rb-2')   // 绵阳物资储备库（40 辆）
const v0 = base.stock.vehicle
const baseOther = cmd.bases.find((b) => b.id === 'rb-3')
const vo0 = baseOther.stock.vehicle

console.log('— 准备：建批 100 人并完成部分登记 —')
const r0 = tr.createBatch({ eventId: ev.id, name: '拆分测试批', headcount: 100, vehicleBaseId: base.id, vehicleCount: 3, shelterId: 'sh-2' })
assert(r0.ok, '创建原批次成功')
const b = r0.batch
tr.register(b.id, 'pickup', { name: '张三', idNo: '510781199001011234' })
tr.register(b.id, 'pickup', { count: 59 })           // 共 60 人接运
tr.register(b.id, 'checkin', { count: 20 })          // 其中 20 人入住
assert(b.status === 'transporting', '原批次接运中')
assert(tr.bedMap['sh-2'].reserved === 80, `预占=计划100-已入住20=80，实际 ${tr.bedMap['sh-2'].reserved}`)
assert(base.stock.vehicle === v0 - 3, `原批次占用 3 辆车，实际余 ${base.stock.vehicle}`)

const pickedMembers = b.members.filter((m) => m.pickupAt && !m.checkinAt)   // 40 名仅接运
const housedMembers = b.members.filter((m) => m.checkinAt && !m.checkoutAt) // 20 名已入住
// 拆出 30 人（25 在途 + 5 在住），张三已入住且保留在原批次
const pickedToMove = pickedMembers.slice(0, 25).map((m) => m.id)
const housedToMove = housedMembers.filter((m) => m.name !== '张三').slice(0, 5).map((m) => m.id)
assert(pickedToMove.length === 25 && housedToMove.length === 5, '可拆成员 25 在途 + 5 在住')
const moveIds = [...pickedToMove, ...housedToMove]
const moveInHouse = 5

console.log('— 拆分校验：非法入参拦截 —')
assert(!tr.splitBatch('nope', { personIds: moveIds }).ok, '批次不存在被拒绝')
assert(!tr.splitBatch(b.id, { personIds: [] }).ok, '未勾选成员被拒绝')
assert(!tr.splitBatch(b.id, { personIds: ['p-x'], headcount: 1, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-1' }).ok, '非本批次成员被拒绝')
assert(!tr.splitBatch(b.id, { personIds: moveIds, headcount: 10, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-2' }).ok, '计划人数少于勾选人数被拒绝')
assert(!tr.splitBatch(b.id, { personIds: moveIds, headcount: 100, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-2' }).ok, '原批次剩余计划容不下保留成员被拒绝')
assert(!tr.splitBatch(b.id, { personIds: moveIds, headcount: 30, vehicleBaseId: base.id, vehicleCount: 999, shelterId: 'sh-2' }).ok, '车辆不足被拒绝')
// 勾选中有已入住成员却改投其它安置点
assert(!tr.splitBatch(b.id, { personIds: moveIds, headcount: 30, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-1' }).ok, '已入住成员跨安置点拆分被拒绝')

console.log('— 执行拆分：30 人（含 5 人在住）→ 其它基地车辆 + 原安置点 —')
const r1 = tr.splitBatch(b.id, {
  name: '拆分新分组',
  personIds: moveIds,
  headcount: 40,
  vehicleBaseId: baseOther.id,
  vehicleCount: 1,
  shelterId: 'sh-2'
})
assert(r1.ok, '拆分成功: ' + (r1.msg || ''))
const nb = r1.batch
assert(nb, '新批次已生成')
assert(nb.shelterId === 'sh-2', '新批次安置点正确')
assert(nb.vehicleBaseId === baseOther.id && nb.vehicleCount === 1, '新批次使用其它基地 1 辆车')
assert(base.stock.vehicle === v0 - 3, `原批次 3 辆车保留（余 ${base.stock.vehicle}）`)
assert(baseOther.stock.vehicle === vo0 - 1, `新分组基地占用 1 辆（余 ${baseOther.stock.vehicle}）`)

console.log('— 保留登记历史 —')
assert(nb.members.length === 30, `新分组 30 名成员，实际 ${nb.members.length}`)
assert(nb.members.filter((m) => m.checkinAt && !m.checkoutAt).length === moveInHouse, '5 名在住成员的入住记录随人保留')
assert(nb.members.filter((m) => m.pickupAt && !m.checkinAt).length === 25, '25 名在途成员的接运记录随人保留')
const zs = nb.members.find((m) => m.name === '张三')
assert(!zs, '未勾选的张三仍在原批次')
assert(b.members.length === 30, `原批次保留 30 名成员，实际 ${b.members.length}`)
assert(b.members.some((m) => m.name === '张三'), '张三登记历史保留在原批次')

console.log('— 床位预占联动重分配 —')
assert(b.headcount === 60, `原批次计划 60，实际 ${b.headcount}`)
// 预占 = 各批计划中尚未入住/转出的名额：源批 60-15 在住=45，新批 40-5 在住=35
assert(tr.bedMap['sh-2'].reserved === 80, `床位预占按未入住名额重分配 45+35=80，实际 ${tr.bedMap['sh-2'].reserved}`)
assert(tr.bedMap['sh-2'].inHouse === 20, '在住仍为 20 人（5+15）')

console.log('— 状态与办结条件同步 —')
assert(b.status === 'transporting', '原批次仍有未入住人员 → 接运中')
assert(nb.status === 'transporting', '新分组有在途人员 → 接运中')

console.log('— 事件转移进度同步 —')
const prog = tr.progressByEvent[ev.id]
assert(prog.batches === 2, `事件下 2 个批次，实际 ${prog.batches}`)
assert(prog.planned === 100, `计划总数守恒 100，实际 ${prog.planned}`)
assert(prog.picked === 60, `接运 60 人，实际 ${prog.picked}`)
assert(prog.checkedIn === 20, `入住 20 人，实际 ${prog.checkedIn}`)
assert(tr.stats.inTransit === 40, `大屏在途 40，实际 ${tr.stats.inTransit}`)
assert(tr.stats.housed === 20, `大屏在住 20，实际 ${tr.stats.housed}`)

console.log('— 新批次路线独立（ETA 已算、未继承挂起/绕行） —')
assert(nb.eta && nb.eta.minutes > 0, '新分组运输路线 ETA 已联动计算')
assert(!nb.held && !nb.via.length, '新分组未继承挂起/绕行状态')

console.log('— 时间线留痕 —')
assert(ev.timeline.some((t) => t.text.includes('拆分') && t.text.includes('拆分新分组')), '拆分操作已写入事件时间线')

console.log('— 拆分后继续登记：两批独立推进 —')
// 新分组剩余 10 个计划空位可继续登记
assert(tr.register(nb.id, 'pickup', { count: 10 }).ok, '新分组继续接运登记 10 人')
const ciRest = tr.register(nb.id, 'checkin', { count: 35 }) // 35 待入住（25在途+10新）
assert(ciRest.ok, '新分组批量入住 35 人: ' + (ciRest.msg || ''))
assert(nb.members.filter((m) => m.checkinAt).length === 40, '新分组 40 人全部入住（含原 5 人）')
assert(nb.status === 'settled', '新分组满员全入住 → 已安置')
// 原批次也继续推进至满员入住
assert(tr.register(b.id, 'pickup', { count: 30 }).ok, '原批次补登记接运 30 人（计划 60）')
assert(b.members.length === 60, '原批次满员 60')
assert(tr.register(b.id, 'checkin', { count: 45 }).ok, '原批次 45 人入住（含原 15 人在住）')
assert(b.status === 'settled', '原批次 → 已安置')

console.log('— 全部转出：两批各自办结并回收车辆 —')
assert(tr.register(b.id, 'checkout', { count: 60 }).ok, '原批次全部转出')
assert(tr.register(nb.id, 'checkout', { count: 40 }).ok, '新分组全部转出')
assert(b.status === 'closed' && nb.status === 'closed', '两批均自动办结')
assert(base.stock.vehicle === v0, `原基地车辆全部回收（余 ${base.stock.vehicle}）`)
assert(baseOther.stock.vehicle === vo0, `新分组基地车辆回收（余 ${baseOther.stock.vehicle}）`)
assert(tr.progressByEvent[ev.id].out === 100, `事件累计转出 100，实际 ${tr.progressByEvent[ev.id].out}`)

console.log('— 纯计划拆分：未登记批次按人头拆分为两个待接运批次 —')
const r2 = tr.createBatch({ eventId: ev.id, name: '空批次', headcount: 100, vehicleBaseId: base.id, vehicleCount: 2, shelterId: 'sh-1' })
assert(r2.ok, '第三个批次创建')
const b2 = r2.batch
// 无成员可勾选 → 无法拆分（拆分是按人员分组）
assert(!tr.splitBatch(b2.id, { personIds: [], headcount: 50, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-1' }).ok, '无登记成员的批次不能按人员拆分')

console.log('— 已转出成员不可参与拆分 —')
tr.register(b2.id, 'pickup', { count: 3 })
tr.register(b2.id, 'checkin', { count: 3 })
tr.register(b2.id, 'checkout', { count: 3 })
const outId = b2.members[0].id
assert(!tr.splitBatch(b2.id, { personIds: [outId], headcount: 1, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-1' }).ok, '已转出成员拆分被拒绝')

console.log('— 已办结批次不可再拆 —')
// b2 有 3 人已转出且无在住，但未满员：需手动办结
const rc = tr.closeBatch(b2.id)
assert(rc.ok, '无在住人员，手动办结成功')
assert(!tr.splitBatch(b2.id, { personIds: b2.members.map((m) => m.id), headcount: 3, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-1' }).ok, '办结后拆分被拒绝')

console.log('— 跨安置点拆分：新分组改投 sh-1，床位余量联动校验 —')
const r3 = tr.createBatch({ eventId: ev.id, name: '跨点拆分批', headcount: 100, vehicleBaseId: base.id, vehicleCount: 2, shelterId: 'sh-2' })
assert(r3.ok, '第四个批次创建（sh-2）')
const b3 = r3.batch
tr.register(b3.id, 'pickup', { count: 10 })
// 10 人均仅接运未入住，可改投 sh-1（b2 此前在 sh-1 预占 100 后办结已释放）
const sh1LeftBefore = tr.bedMap['sh-1'].left
const sh2ResBefore = tr.bedMap['sh-2'].reserved
const r4 = tr.splitBatch(b3.id, {
  name: '跨点新分组',
  personIds: b3.members.map((m) => m.id),
  headcount: 10,
  vehicleBaseId: baseOther.id,
  vehicleCount: 1,
  shelterId: 'sh-1'
})
assert(r4.ok, '跨安置点拆分成功: ' + (r4.msg || ''))
const nb4 = r4.batch
assert(tr.bedMap['sh-1'].left === sh1LeftBefore - 10, `sh-1 新增预占 10 床（余 ${tr.bedMap['sh-1'].left}）`)
// sh-2：b3 计划从 100 降为 90（10 个名额拆往 sh-1），预占净减 10
assert(tr.bedMap['sh-2'].reserved === sh2ResBefore - 10, `sh-2 释放拆出的 10 个名额预占（${sh2ResBefore}→${tr.bedMap['sh-2'].reserved}）`)
assert(nb4.shelterId === 'sh-1' && nb4.eta && nb4.eta.minutes > 0, '新分组路线按 sh-1 重新联动计算')
// 超床位仍被拦截
assert(!tr.splitBatch(b3.id, {
  personIds: [],
  headcount: 1, vehicleBaseId: base.id, vehicleCount: 1, shelterId: 'sh-1'
}).ok, '无成员拆分仍被拒绝')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
