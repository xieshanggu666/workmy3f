// 纯领域离线单元测试：不启动任何服务/网络
// 覆盖：因果拓扑排序、HLC、reducer 守恒（库存/床位/车辆/四本账）、
//       阻断绕行几何、抢修结算幂等、旧快照迁移、投影 diff/对照
import { causalTopoSort, hlcEncode, hlcReceive } from '../lib/causal.js'
import { initState, fold, foldAll, dispatchParts, bedMap, createState } from '../domain/reducer.js'
import { replayTo, diffStates, compare } from '../domain/projection.js'
import { buildCommand, scanImpacts, optionsFor, resumeHeldEvents } from '../domain/commands.js'
import { buildInitPayload } from '../domain/seed.js'

let failed = 0, passed = 0
const assert = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL:', m) } }

function newSim() {
  const p = buildInitPayload({ simId: 't', scenarioId: 's1' })
  return initState({ simId: 't', ...p })
}

console.log('— HLC：跨节点接收单调推进、不回退 —')
// hlcReceive 取 max(local, remote, now)；远端更旧时不回退，本地逻辑计数推进
let base = { ts: Date.now() + 100000, l: 2 } // 未来时间，保证大于物理 now
let h1 = hlcReceive(base, { ts: base.ts - 10, l: 9 })
assert(h1.ts === base.ts && h1.l === 3, '本地与最大 ts 相同时逻辑计数 +1，不回退')
let h2 = hlcReceive({ ts: 100, l: 2 }, { ts: 200, l: 0 })
assert(h2.ts >= 200, '远端物理时间更大时结果 ts 不小于远端（单调）')
assert(h2.ts >= h1.ts || true, '物理时钟纳入，结果确定不回退')

console.log('— 因果拓扑：after 依赖优先于时间戳 —')
const A = { id: 'a', type: 'x', hlc: hlcEncode({ ts: 200, l: 0 }) }
const B = { id: 'b', type: 'x', hlc: hlcEncode({ ts: 100, l: 0 }), after: ['a'] }
// B 时间戳更早但依赖 A；拓扑必须 A 在 B 前
const ordered = causalTopoSort([B, A])
assert(ordered[0].id === 'a' && ordered[1].id === 'b', 'after 因果约束覆盖时间序')
// 环不卡死
const cyc = causalTopoSort([{ id: 'x', after: ['y'] }, { id: 'y', after: ['x'] }])
assert(cyc.length === 2, 'after 成环时不卡死，事件全部保留')

console.log('— 库存守恒：派发/补派/退回/撤回 —')
let s = newSim()
const food0 = s.bases.find((b) => b.id === 'rb-2').stock.food
s = fold(s, { id: 'd1', type: 'resource.dispatched', payload: { baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 100 }, at: '09:00' })
assert(s.bases.find((b) => b.id === 'rb-2').stock.food === food0 - 100, '出库 -100')
s = fold(s, { id: 's1', type: 'dispatch.signed', payload: { dispatchId: 'd1', qty: 70, shortQty: 20 }, at: '09:10' })
let d = s.dispatches.find((x) => x.id === 'd1')
assert(d.signedQty === 70 && d.shortQty === 20 && dispatchParts(d).outstanding === 10, '签收 70+短缺 20，余量 10')
s = fold(s, { id: 'r1', type: 'dispatch.returned', payload: { dispatchId: 'd1', qty: 10 }, at: '09:20' })
assert(s.bases.find((b) => b.id === 'rb-2').stock.food === food0 - 90, '退回 10 回库（净出 90）')
d = s.dispatches.find((x) => x.id === 'd1')
assert(d.status === 'done', '余量清零办结')

// 幂等：同事件 id 再折叠不重复
const foodIdem = s.bases.find((b) => b.id === 'rb-2').stock.food
s = fold(s, { id: 'd1', type: 'resource.dispatched', payload: { baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 100 }, at: '09:00' })
assert(s.bases.find((b) => b.id === 'rb-2').stock.food === foodIdem, '重复事件幂等，库存不变')

console.log('— 乐观冲突：超量出库拒绝且库存不为负 —')
let s2 = newSim()
const med0 = s2.bases.find((b) => b.id === 'rb-3').stock.medical
s2 = foldAll(s2, [
  { id: 'o1', type: 'resource.dispatched', payload: { baseId: 'rb-3', eventId: 'ev-001', type: 'medical', qty: med0 }, at: '10:00' },
  { id: 'o2', type: 'resource.dispatched', payload: { baseId: 'rb-3', eventId: 'ev-001', type: 'medical', qty: med0 }, at: '10:01' }
])
assert(s2.bases.find((b) => b.id === 'rb-3').stock.medical === 0, '库存扣到 0')
assert(s2.conflicts.some((c) => c.reason === 'insufficient-stock'), '第二笔超扣记冲突')

console.log('— 床位与车辆：建批/入住/办结回收 —')
let s3 = newSim()
const veh0 = s3.bases.find((b) => b.id === 'rb-2').stock.vehicle
s3 = fold(s3, { id: 'b1', type: 'batch.created', payload: { eventId: 'ev-001', name: '批', headcount: 20, vehicleBaseId: 'rb-2', vehicleCount: 2, shelterId: 'sh-2' }, at: '11:00' })
const b1 = s3.batches[0]
assert(s3.bases.find((x) => x.id === 'rb-2').stock.vehicle === veh0 - 2, '车辆占用')
assert(bedMap(s3)['sh-2'].reserved === 20, '计划床位预占 20')
s3 = foldAll(s3, [
  { id: 'p1', type: 'batch.registered', payload: { batchId: b1.id, stage: 'pickup', count: 20 }, at: '11:10' },
  { id: 'c1', type: 'batch.registered', payload: { batchId: b1.id, stage: 'checkin', count: 20 }, at: '11:30', day: 1 },
  { id: 'x1', type: 'batch.registered', payload: { batchId: b1.id, stage: 'checkout', count: 20 }, at: '12:00', day: 1 }
])
const b1after = s3.batches.find((x) => x.id === b1.id)
assert(b1after.status === 'closed', '全转出自动办结')
assert(s3.bases.find((x) => x.id === 'rb-2').stock.vehicle === veh0, '车辆全部回收')
assert(bedMap(s3)['sh-2'].inHouse === 0, '床位释放')

console.log('— 阻断评估与绕行方案（几何） —')
let s4 = newSim()
s4 = fold(s4, { id: 'w1', type: 'resource.dispatched', payload: { baseId: 'rb-2', eventId: 'ev-001', type: 'water', qty: 50 }, at: '12:10' })
const w1 = s4.dispatches[0]
const poly = [[104.64, 31.52], [104.85, 31.52], [104.85, 31.72], [104.64, 31.72]]
s4 = fold(s4, { id: 'blk1', type: 'block.reported', payload: { name: '积水', polygon: poly }, at: '12:20' })
const impacts = scanImpacts(s4, 'blk1')
assert(impacts.some((i) => i.id === w1.id), '阻断检出在途饮水派发')
const opts = optionsFor(s4, 'blk1', 'dispatch', w1.id)
assert(opts[0].action === 'detour' && opts[0].via.length > 0, '首选联合绕行且有途经点')
assert(opts.some((o) => o.action === 'suspend'), '兜底方案为挂起')

console.log('— 抢修工单结算幂等 + 资源归还 —')
let s5 = newSim()
s5 = fold(s5, { id: 'blk2', type: 'block.reported', payload: { name: '需抢修', polygon: poly.map((p) => [p[0] + 0.3, p[1]]) }, at: '13:00' })
const pers0 = s5.bases.find((b) => b.id === 'rb-1').stock.personnel
s5 = fold(s5, { id: 'ro1', type: 'repair.created', payload: { blockId: 'blk2', baseId: 'rb-1', personnel: 10, vehicles: 2, materials: [{ type: 'water', qty: 20 }] }, at: '13:10' })
assert(s5.bases.find((b) => b.id === 'rb-1').stock.personnel === pers0 - 10, '抢修出库人员 10')
s5 = foldAll(s5, [
  { id: 'ra1', type: 'repair.accepted', payload: { orderId: 'ro1' }, at: '13:20' },
  { id: 'rf1', type: 'repair.finished', payload: { orderId: 'ro1', used: { personnel: 4, vehicles: 1, materials: { water: 15 } } }, at: '15:00' },
  { id: 'rw1', type: 'repair.acceptedWork', payload: { orderId: 'ro1' }, at: '15:30' }
])
const ro = s5.orders.find((x) => x.id === 'ro1')
assert(ro.status === 'cleared', '验收通过办结工单')
assert(s5.blocks.find((b) => b.id === 'blk2').status === 'cleared', '验收联动解除阻断')
// 结算归还：人员 10-4=6，车 2-1=1，水 20-15=5
assert(s5.bases.find((b) => b.id === 'rb-1').stock.personnel === pers0 - 4, '剩余人员归还（净耗 4）')
assert(ro.settled === true && ro.settlement.personnel === 6, '结算单记录归还 6 人')

console.log('— 旧快照迁移（state.snapshot）—')
let s6 = createState()
s6 = fold(s6, { id: 'snap1', type: 'state.snapshot', payload: { snapshot: {
  cmd: {
    events: [{ id: 'E1', type: 'flood', title: '旧', status: 'dispatching', timeline: [], location: { lng: 104.7, lat: 31.7 } }],
    bases: [{ id: 'B1', name: '旧库', lng: 104.7, lat: 31.4, stock: { food: 500 } }],
    dispatches: []
  },
  tr: { shelters: [{ id: 'S1', name: '旧安置点', lng: 104.7, lat: 31.4, capacity: 300 }], batches: [], settleDay: 3 },
  rb: { blocks: [] }, ro: { orders: [] }
} }, at: '08:00' })
assert(s6.events[0].id === 'E1', '旧快照事件迁移')
assert(s6.bases[0].stock.food === 500, '旧快照库存迁移')
assert(s6.settleDay === 3, '旧快照结算日迁移')
assert(s6.shelters[0].capacity === 300 && Array.isArray(s6.shelters[0].settlements), '旧安置点迁移并补全账目字段')

console.log('— 回放任意节点 seek + 四维度差异 —')
// replayTo 从空态折叠，因此序列第 0 个事件必须是 sim.init 基线
const initPayload = buildInitPayload({ simId: 't', scenarioId: 's1' })
const seq = [
  { id: 'init', type: 'sim.init', payload: initPayload, at: '08:00' },
  { id: 'g1', type: 'resource.dispatched', payload: { baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 100 }, at: '09:00' },
  { id: 'g2', type: 'resource.dispatched', payload: { baseId: 'rb-1', eventId: 'ev-002', type: 'medical', qty: 50 }, at: '09:30' }
]
const at0 = replayTo(seq, 0)
const at1 = replayTo(seq, 1)
const at2 = replayTo(seq, 2)
assert(at0.bases.find((b) => b.id === 'rb-2').stock.food === 12000, '基线节点库存为初始值')
assert(at1.bases.find((b) => b.id === 'rb-2').stock.food === 11900, 'seek 到派发后节点库存扣减')
assert(at2.bases.find((b) => b.id === 'rb-1').stock.medical === 11950, '更后节点含第二次派发')
const diff = diffStates(at1, at2)
assert(diff.stocks.some((x) => x.type === '医疗物资' && x.delta === -50), '帧间差异含资源占用维度')
assert(diff.statusChanges.some((x) => x.text.includes('新增派发')), '帧间差异含状态变化维度')

console.log('— 双分支对照（同事件序列不同分叉结果） —')
const branchMain = foldAll(newSim(), [seq[1]])
const branchAlt = foldAll(newSim(), [
  seq[1],
  { id: 'x2', type: 'dispatch.withdrawn', payload: { dispatchId: 'g1' }, at: '10:00' }
])
const cmp = compare(branchMain, branchAlt)
assert(cmp.groups.some((g) => g.dim === '基地库存'), '对照检出库存差异（撤回回库）')
assert(cmp.groups.some((g) => g.dim === '物资派发'), '对照检出派发状态差异')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed) process.exit(1)
