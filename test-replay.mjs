import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { useReplayStore, installReplayRecorder } from '@/store/replay'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const ro = useRepairStore()
const rp = useReplayStore()
// 四 store 创建后安装复盘录制器（与 main.js 一致）
installReplayRecorder()
cmd.loadScenario('s1')
tr.load()
rb.load()
ro.load()
rp.setTestClock(9 * 3600 * 1000) // 固定帧时间戳（09:00 起逐帧 +1s）
rp.begin()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events.find((e) => e.id === 'ev-001')
// 注意：回放恢复快照会整体替换 cmd.bases 数组，库存断言必须经实时查找（不能缓存对象引用）
const base2 = () => cmd.bases.find((b) => b.id === 'rb-2')

console.log('— 基线帧：场景载入即第 0 帧 —')
assert(rp.active && rp.mode === 'live', '录制器已开始、处于 live 模式')
assert(rp.frameCount === 1 && rp.frames[0].seq === 0, '时间轴仅基线帧')
assert(rp.frames[0].category === 'system' && rp.frames[0].title.includes('演练开始'), '基线帧标题正确')
assert(rp.frames[0].snapshot.cmd.events.length === cmd.events.length, '基线快照含全部事件')
assert(rp.frames[0].snapshot.tr.shelters.length === tr.shelters.length, '基线快照含全部安置点')

console.log('— 业务动作逐帧录制（含嵌套联动只记最外层） —')
const food0 = base2().stock.food
const rec = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
const fDispatch = rp.frames[rp.frameCount - 1]
assert(rp.frameCount === 2, '派发产生 1 个新帧: ' + rp.frameCount)
assert(fDispatch.category === 'dispatch' && fDispatch.title.includes('应急食品'), '派发帧分类/标题正确: ' + fDispatch.title)
assert(base2().stock.food === food0 - 100, '库存扣减 100（真实状态）')
assert(fDispatch.snapshot.cmd.bases.find((b) => b.id === 'rb-2').stock.food === food0 - 100, '帧快照记录扣减后库存')
assert(fDispatch.logs.some((l) => l.text.includes('派发')), '帧内收集到事件时间线处置日志')

const sign = cmd.signDispatch(rec.id, { qty: 80, shortQty: 20, receiver: '李队长' })
assert(sign.ok, '签收 80 + 认定短缺 20')
const fSign = rp.frames[rp.frameCount - 1]
assert(fSign.category === 'dispatch', '签收帧归入物资派发分类')
assert(fSign.logs.some((l) => l.text.includes('物资签收')), '签收日志入帧')

cmd.replenishShortage(rec.id)
assert(rp.frames[rp.frameCount - 1].title.includes('短缺补派'), '补派帧标题正确')

console.log('— 校验拦截的无效动作不入时间轴 —')
const n0 = rp.frameCount
cmd.signDispatch(rec.id, { qty: 9999 }) // 已办结 + 超量，必被拦截
cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 0 })
assert(rp.frameCount === n0, `状态无变化的动作不产生帧（仍为 ${n0}）`)

console.log('— 转移 / 阻断 / 抢修全链路录制 —')
tr.setClock('10:00')
const cb = tr.createBatch({ eventId: ev.id, name: '首批', headcount: 40, vehicleBaseId: 'rb-2', vehicleCount: 2, shelterId: 'sh-2' }).batch
assert(rp.frames[rp.frameCount - 1].category === 'transfer', '建批帧归入群众转移分类')
tr.register(cb.id, 'pickup', { count: 40 })
tr.register(cb.id, 'checkin', { count: 40 })
const fCheckin = rp.frames[rp.frameCount - 1]
assert(fCheckin.logs.some((l) => l.text.includes('入住登记')), '入住登记日志入帧')
assert(fCheckin.snapshot.tr.batches.find((b) => b.id === cb.id).members.length === 40, '帧快照记录登记人数')
tr.settleShelters()
assert(rp.frames[rp.frameCount - 1].category === 'supply', '日结帧归入安置补给分类')

const midPoly = [
  [104.6438, 31.5209], [104.8438, 31.5209],
  [104.8438, 31.7209], [104.6438, 31.7209]
]
const d2 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 60 })
// 派发挥：库存扣减 + 新增派发状态条目
assert(rp.currentDiff.stocks.some((x) => x.type === '饮用水' && x.delta === -60), '派发挥差异含资源占用（库存 -60）')
assert(rp.currentDiff.statusChanges.some((x) => x.text.includes('饮用水')), '派发挥差异含状态变化条目')
assert(rp.currentDiff.routes.some((r) => r.name.includes('饮用水') && r.from === null), '派发挥新增路线（无前序）')
const blk = rb.reportBlock({ name: '绵江公路积水断道', polygon: midPoly }).block
const fBlock = rp.frames[rp.frameCount - 1]
assert(fBlock.category === 'block' && fBlock.logs.some((l) => l.text.includes('上报道路封闭')), '阻断上报帧 + 阻断日志')
assert(rp.currentDiff.counters.blocks === 1, '态势计数：1 处生效阻断')
rb.confirmImpacts(blk.id)
const imp = blk.impacts.find((i) => i.kind === 'dispatch' && i.id === d2.id)
assert(!!imp, '影响评估检出水派发')
imp.plan = imp.options.find((o) => o.action === 'detour')
const distBefore = d2.distance
rb.applyImpact(blk.id, imp.key)
assert(d2.via.length > 0, '绕行已执行')
assert(rp.currentDiff.routes.some((r) => r.name.includes('饮用水') && r.to.via > 0), '执行帧差异含路线调整维度（绕行途经点）')

// 抢修派单：绵阳库无救援人员，从川西基地（rb-1）派队伍
const order = ro.createOrder({ blockId: blk.id, baseId: 'rb-1', personnel: 8, vehicles: 2, materials: [{ type: 'water', qty: 30 }] }).order
assert(rp.frames[rp.frameCount - 1].category === 'repair', '抢修派单帧归入道路抢修分类')
assert(rp.frames[rp.frameCount - 1].logs.some((l) => l.source === 'repair' && l.text.includes('派单')), '工单日志入帧')
ro.acceptOrder(order.id)
ro.reportProgress(order.id, { progress: 60 })
const fProg = rp.frames[rp.frameCount - 1]
assert(fProg.title.includes('60%'), '进度帧标题含百分比: ' + fProg.title)

const totalFrames = rp.frameCount
console.log('  录制完成，共 ' + totalFrames + ' 帧')

console.log('— 进入复盘：态势只读，业务动作全部拦截 —')
rp.enterReview(0)
assert(rp.mode === 'review' && rp.cursor === 0, '回到基线帧')
assert(cmd.dispatches.length === 0, '基线帧态势：无派发记录（地图同步撤线）')
assert(tr.batches.length === 0 && rb.blocks.length === 0 && ro.orders.length === 0, '基线帧态势：无批次/阻断/工单')
assert(cmd.events.length === 3, '基线帧事件仍在')
const stockInBase = base2().stock.food
const blocked = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 50 })
assert(blocked === null && base2().stock.food === stockInBase && rp.frameCount === totalFrames, '回放中派发动动作被拦截、状态与时间轴不变')
const blockedTr = tr.register(cb.id, 'pickup', { count: 1 })
assert(blockedTr === null, '回放中转移登记被拦截')
const blockedRb = rb.clearBlock(blk.id)
assert(blockedRb === null && rb.blocks.length === 0, '回放中阻断操作被拦截（基线态阻断列表为空）')

console.log('— 逐帧 seek：任意节点态势精确还原（库存/路线/登记/状态） —')
const idxDispatch = rp.frames.findIndex((f) => f.action === 'dispatchResource' && f.args?.[0]?.type === 'food')
rp.seek(idxDispatch)
// 派发帧库存 = 前一帧（基线）库存 − 100
const stockBeforeDispatch = rp.frames[idxDispatch - 1].snapshot.cmd.bases.find((b) => b.id === 'rb-2').stock.food
assert(base2().stock.food === stockBeforeDispatch - 100, `seek 到派发帧：库存还原（${base2().stock.food} = 前帧 ${stockBeforeDispatch} − 100）`)
assert(cmd.dispatches.find((d) => d.id === rec.id)?.qty === 100, 'seek 后该派发记录存在')
assert(!cmd.dispatches.find((d) => d.replenishOf === rec.id), '该帧尚无补派子单（未来记录不存在）')

const idxSign = idxDispatch + 1
rp.seek(idxSign)
const recAtSign = cmd.dispatches.find((d) => d.id === rec.id)
assert(recAtSign.signedQty === 80 && recAtSign.shortQty === 20, 'seek 到签收帧：实收/短缺账目还原')
assert(recAtSign.status === 'done', '该帧派发已办结')

const idxCheckin = rp.frames.findIndex((f) => f.title.includes('入住登记'))
rp.seek(idxCheckin)
const batchAtCi = tr.batches.find((b) => b.id === cb.id)
assert(batchAtCi.members.filter((m) => m.checkinAt).length === 40, 'seek 到入住帧：40 人入住状态还原')
const sh2 = tr.shelters.find((s) => s.id === 'sh-2')
assert(tr.bedMap['sh-2'].inHouse === 40, '回放态床位在住 getter 随快照重算 = 40')
assert(rb.blocks.length === 0, '该帧阻断尚未上报（未来阻断不存在）')
assert(ro.orders.length === 0, '该帧无抢修工单')
assert(rp.currentDiff.occupancy.some((x) => x.shelter === sh2.name && x.to === 40), '差异含安置点占用 +40')

const idxBlock = rp.frames.findIndex((f) => f.action === 'reportBlock')
rp.seek(idxBlock)
assert(rb.blocks.find((b) => b.id === blk.id)?.status === 'active', 'seek 到阻断帧：阻断恢复为生效中')
assert(cmd.dispatches.find((d) => d.id === d2.id)?.via.length === 0, '该帧水派发尚未绕行（直线）')
const idxApply = rp.frames.findIndex((f) => f.action === 'applyImpact')
rp.seek(idxApply)
const d2AtApply = cmd.dispatches.find((d) => d.id === d2.id)
assert(d2AtApply.via.length > 0, 'seek 到执行帧：绕行途经点还原（地图路线同步）')
assert(d2AtApply.distance > distBefore, '绕行里程增量还原')
const routeEntry = rp.currentDiff.routes.find((r) => r.name.includes('饮用水'))
assert(routeEntry && routeEntry.to.minutes > routeEntry.from.minutes, '路线调整差异：里程/时长增量可见')

const idxProg = rp.frames.findIndex((f) => f.action === 'reportProgress')
rp.seek(idxProg)
assert(ro.orders.find((o) => o.id === order.id)?.progress === 60, 'seek 到进度帧：抢修进度 60% 还原')

console.log('— 步进与播放游标 —')
rp.first()
assert(rp.cursor === 0, '回到首帧')
rp.next()
assert(rp.cursor === 1, '下一节点')
rp.prev()
assert(rp.cursor === 0, '上一节点')
rp.last()
assert(rp.cursor === totalFrames - 1 && rp.atLastFrame, '跳到最新节点')
assert(rb.blocks.find((b) => b.id === blk.id)?.status === 'active', '最新节点阻断仍生效')
assert(ro.orders.find((o) => o.id === order.id)?.status === 'accepted', '最新节点工单抢修中')

console.log('— 从中间节点分叉恢复演练：原演练分支保留、新分支独立续写 —')
const forkIdx = idxSign // 从「签收 80/短缺 20」帧分叉（补派/批次/阻断都是旧未来）
assert(forkIdx >= 1, '签收帧序号有效')
rp.seek(forkIdx)
const forkId = rp.resumeHere()
assert(typeof forkId === 'string' && forkId !== 'main', '分叉返回新分支 id')
assert(rp.branchCount === 2, '分支树现有 2 条分支（主干保留）')
assert(rp.mode === 'live' && rp.currentBranchId === forkId, '分叉后位于新分支、live 可操作模式')
const mainBranch = rp.branchById('main')
const forkBranch = rp.branchById(forkId)
assert(mainBranch.frames.length === totalFrames, `原演练分支历史完整保留（${mainBranch.frames.length} === ${totalFrames}，不截断）`)
assert(forkBranch.frames.length === forkIdx + 1, `新分支仅含共同祖先帧（${forkBranch.frames.length} === ${forkIdx + 1}）`)
assert(forkBranch.parentId === 'main' && forkBranch.forkFrameIndex === forkIdx, '子分支记录父分支与分叉帧下标（溯源信息）')
const forkFrame = forkBranch.frames[forkIdx]
assert(forkFrame.fork === true && mainBranch.frames[forkIdx].fork === true, '父子两侧分叉节点均标记 🌿')
// 分叉点库存/资源占用严格以分叉帧快照为准（新分支任何动作发生之前）
assert(base2().stock.vehicle === forkFrame.snapshot.cmd.bases.find((b) => b.id === 'rb-2').stock.vehicle, '分叉点车辆库存与分叉帧快照一致（旧未来的建批占用已回滚）')
const recAtFork = cmd.dispatches.find((d) => d.id === rec.id)
assert(recAtFork.signedQty === 80 && dispatchParts(recAtFork).shortPending === 20, '分叉点态势保留（短缺缺口重新释放）')
assert(!cmd.dispatches.find((d) => d.replenishOf === rec.id), '分叉点尚无补派单（旧未来在新分支不存在）')
assert(rb.blocks.length === 0 && tr.batches.find((b) => b.id === cb.id) == null, '分叉点无阻断/批次（它们是原分支的旧未来）')

// 沿新分支演练：换一种处置——不补派食品，改派饮用水
const waterAtFork = base2().stock.water
const alt = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 50 })
assert(!!alt, '新分支上执行替代派发成功')
const fNew = forkBranch.frames[forkBranch.frames.length - 1]
assert(forkBranch.frames.length === forkIdx + 2 && fNew.title.includes('饮用水'), '新分支动作在分叉点后追加 1 帧: ' + fNew.title)
assert(fNew.seq > forkBranch.frames[forkIdx].seq, '新分支帧序号在分叉点之后递增')
assert(base2().stock.water === waterAtFork - 50, '新分支独立扣减自己的库存账')

// 新分支上再建批次（旧未来的批次 ID 不应冲突）
const cb2 = tr.createBatch({ eventId: ev.id, name: '复盘新批次', headcount: 10, vehicleBaseId: 'rb-2', vehicleCount: 1, shelterId: 'sh-1' })
assert(cb2.ok && cb2.batch.id !== cb.id, '新分支批次 ID 与原分支旧未来不冲突')
assert(forkBranch.frames[forkBranch.frames.length - 1].title.includes('复盘新批次'), '新分支建批帧标题正确')

console.log('— 切回原演练分支：库存/床位/派发/抢修状态独立、可继续推演 —')
rp.switchBranch('main')
assert(rp.mode === 'live' && rp.currentBranchId === 'main', '切换回主干、进入 live')
assert(rp.frameCount === totalFrames, `主干帧序列仍为 ${totalFrames}（分叉与新分支动作未污染）`)
assert(!!cmd.dispatches.find((d) => d.replenishOf === rec.id), '主干上旧未来的补派单随切换还原')
assert(tr.batches.find((b) => b.id === cb.id) && rb.blocks.find((x) => x.id === blk.id), '主干上原批次/阻断还原')
assert(ro.orders.find((o) => o.id === order.id)?.progress === 60, '主干末端抢修工单进度 60% 还原（独立抢修状态）')
assert(base2().stock.water === mainBranch.frames[totalFrames - 1].snapshot.cmd.bases.find((b) => b.id === 'rb-2').stock.water, '主干库存按主干末端快照还原（新分支的 50 水派发不影响主干）')
assert(base2().stock.water !== waterAtFork - 50, '两分支库存相互隔离')
assert(tr.bedMap['sh-2'].inHouse === 40, '主干床位占用还原：原批次 40 人在住')
assert(!tr.batches.find((b) => b.id === cb2.batch.id), '主干上看不到新分支独有的批次')

// 主干继续推演（与子分支并行）
const mainExtra = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 10 })
assert(!!mainExtra && mainBranch.frames.length === totalFrames + 1, '主干追加动作只进主干时间轴')
assert(forkBranch.frames.length === forkIdx + 3, '子分支帧序列不受主干续写影响')

console.log('— 再切回分叉分支：状态与录制目标随之切换 —')
rp.switchBranch(forkId)
assert(cmd.dispatches.find((d) => d.id === alt.id)?.qty === 50, '分叉分支末端：替代水派发在')
assert(!!tr.batches.find((b) => b.id === cb2.batch.id), '分叉分支末端：新批次在')
assert(!cmd.dispatches.find((d) => d.id === mainExtra.id), '分叉分支看不到主干续写帧的派发')
const foodNow = base2().stock.food
const fOnFork = forkBranch.frames.length
cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 5 })
assert(forkBranch.frames.length === fOnFork + 1 && mainBranch.frames.length === totalFrames + 1, '在分叉分支上的动作只入分叉分支')
assert(base2().stock.food === foodNow - 5, '分叉分支独立食品库存账')

console.log('— 分叉分支上再次分叉（多层分支树、兄弟分支互不影响） —')
rp.enterReview(forkIdx, forkId)
const fork2Id = rp.resumeHere({ name: '补派方案' })
assert(rp.branchCount === 3, '分支树现有 3 条分支')
const fork2 = rp.branchById(fork2Id)
assert(fork2.parentId === forkId && fork2.forkFrameIndex === forkIdx, '二级分叉的父分支为一级分叉分支')
assert(forkBranch.frames.length === fOnFork + 1, '再次分叉不截断父分叉分支（兄弟分支并存）')
assert(rp.currentBranchId === fork2Id && fork2.frames.length === forkIdx + 1, '新分支从共同分叉点出发')
// 该方案走原设想：补派短缺食品
cmd.replenishShortage(rec.id)
assert(fork2.frames.length === forkIdx + 2, '二级分支动作独立成帧')
assert(dispatchParts(cmd.dispatches.find((d) => d.id === rec.id)).shortPending === 0, '补派方案：短缺缺口已补')

console.log('— 分支对照：处置结果差异按维度列出（库存/床位/派发/抢修） —')
rp.openCompare(forkId, fork2Id)
assert(!!rp.compareResult, '生成对照结果')
const cmp1 = rp.compareResult
assert(cmp1.a.branch.id === forkId && cmp1.b.branch.id === fork2Id, '对照两侧为两条分叉分支')
assert(cmp1.rows.length > 0, '两方案末端态势存在差异')
assert(cmp1.groups.some((g) => g.dim === '物资派发'), '对照含「物资派发」维度（水派发 vs 食品补派）')
assert(cmp1.groups.some((g) => g.dim === '基地库存'), '对照含「基地库存」维度')
assert(cmp1.groups.some((g) => g.dim === '转移批次'), '对照含「转移批次」维度（新分支批次仅一侧有）')
assert(cmp1.rows.every((r) => r.a !== r.b), '对照仅列出有差异的条目')
// 交换 / 防同分支
rp.swapCompare()
assert(rp.compareResult.a.branch.id === fork2Id && rp.compareResult.b.branch.id === forkId, '交换对照两侧')
rp.setCompareSide('a', fork2Id) // 与 b 相同 → 忽略
assert(rp.compare.a === fork2Id && rp.compare.b === forkId, '同一分支不能同时作为对照两侧')
rp.closeCompare()
assert(rp.compareResult === null, '关闭对照')

console.log('— 回放中切换查看其它分支（只读，不改写任何分支历史） —')
rp.enterReview(0, 'main')
assert(rp.mode === 'review' && rp.currentBranchId === 'main' && rp.cursor === 0, '进入主干首帧回放')
assert(cmd.dispatches.length === 0, '主干首帧：无派发')
const mainLenBefore = mainBranch.frames.length
cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 9 })
assert(cmd.dispatches.length === 0 && mainBranch.frames.length === mainLenBefore, '回放中业务动作仍被拦截')
rp.switchBranch(fork2Id)
assert(rp.mode === 'live' && !!cmd.dispatches.find((d) => d.replenishOf === rec.id), '从回放直接切到二级分支末端继续推演')

console.log('— 退出回放回到当前分支末端（保留完整历史）—')
rp.enterReview(0)
rp.exitToLive()
assert(rp.mode === 'live' && rp.cursor === rp.frameCount - 1, '回到当前分支 live 且定位末端帧')
assert(!!cmd.dispatches.find((d) => d.replenishOf === rec.id), '当前分支（二级分叉）末端态势正确')

console.log('— 向后兼容：旧版单线 frames 历史可直接载入为单主干分支 —')
const legacyFrames = mainBranch.frames
const legacyCount = rp.branchCount
rp.begin() // 重置后为空主干
assert(rp.branchCount === 1 && rp.frameCount === 1, '重置后为单基线主干')
const ok = rp.loadLegacyFrames(legacyFrames.map((f) => ({ ...f })))
assert(ok === true, '旧单线结构载入成功')
assert(rp.branchCount === 1 && rp.currentBranchId === 'main', '归一化为单主干分支')
assert(rp.frameCount === legacyFrames.length, `旧帧全部保留（${rp.frameCount} === ${legacyFrames.length}）`)
assert(rp.frames[0].branchId === 'main' && rp.frames[0].snapshot.cmd.events.length >= 1, '旧帧补齐 branchId、快照可读')
rp.last()
assert(rb.blocks.find((b) => b.id === blk.id)?.status === 'active', '旧单线历史 seek 到末端：阻断态势精确还原')
assert(ro.orders.find((o) => o.id === order.id)?.progress === 60, '旧单线历史 seek 到末端：抢修进度还原')
// 兼容旧 API 语义：在载入的旧单线上可直接回放/分叉（分叉自动升级为多分支树）
rp.first()
assert(rp.cursor === 0 && cmd.dispatches.length === 0, '旧历史基线帧 seek 正常')
const compatFork = rp.resumeHere()
assert(!!compatFork && rp.branchCount === 2, '旧单线历史分叉后自动形成分支树')
assert(rp.branchById('main').frames.length === legacyFrames.length, '兼容模式下分叉同样保留原线')
assert(legacyCount >= 2, '（前置）多分支场景曾真实建立')


if (failed) {
  console.error(`\n❌ 历史复盘模块测试 ${failed} 项失败`)
  process.exit(1)
} else {
  console.log('\n✅ 历史复盘模块全部通过：基线录制/逐帧快照/四维度差异/回放只读锁定/任意节点 seek/多分支分叉保留原线/分支切换续写/库存床位派发抢修分支独立/多层分支树/分支处置结果对照/旧单线历史兼容')
}
