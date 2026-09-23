import { createState, fold, dispatchParts, bedMap } from './reducer.js'
import { RESOURCE_TYPES } from './constants.js'

/* =========================================================================
 * 回放投影：从（已按因果序排好的）事件序列折叠任意节点的态势，
 * 并计算 帧边界 / 四维度差异 / 分支末端对照。
 * 纯计算、无 IO，供回放服务在每个 seek 请求上复用。
 * ========================================================================= */

// 折叠到指定 seq（含），返回当时状态
export function replayTo(events, atSeq) {
  let s = createState()
  const upto = atSeq == null ? events.length - 1 : Math.min(atSeq, events.length - 1)
  for (let i = 0; i <= upto; i++) s = fold(s, events[i])
  return s
}

// 逐帧索引：每个产生实质状态变化的事件记一帧（与前端"空动作不入轴"等价：
// reducer 冲突不改状态，这里通过 applied 序号判定）
export function buildFrames(events) {
  let s = createState()
  const frames = []
  events.forEach((e, i) => {
    const before = appliedCount(s)
    s = fold(s, e)
    const after = appliedCount(s)
    if (after > before || i === 0) {
      frames.push({ seq: i, eventSeq: e.seq ?? i, type: e.type, at: e.at, hlc: e.hlc, title: frameTitle(e, s) })
    }
  })
  return frames
}

function appliedCount(s) { return s.appliedIds instanceof Set ? s.appliedIds.size : (s.appliedIds?.length || 0) }

function frameTitle(e, s) {
  const p = e.payload || {}
  switch (e.type) {
    case 'sim.init': return '演练开始 · 场景载入'
    case 'state.snapshot': return '旧快照迁移 · 基线导入'
    case 'event.statusChanged': return `事件状态流转 → ${p.status}`
    case 'resource.dispatched': return `派发 ${RESOURCE_TYPES[p.type]?.label || p.type} ${p.qty}`
    case 'dispatch.signed': return `物资签收 ${p.qty || 0}${p.shortQty ? `，短缺 ${p.shortQty}` : ''}`
    case 'dispatch.shortageReplenished': return '短缺补派出库'
    case 'dispatch.returned': return '物资退回入库'
    case 'dispatch.rerouted': return '派发绕行改道'
    case 'dispatch.reassigned': return '派发改派基地'
    case 'dispatch.held': return '派发挂起待通'
    case 'dispatch.resumed': return '派发恢复续派'
    case 'dispatch.withdrawn': return '派发撤回留账'
    case 'batch.created': return `创建转移批次「${p.name || ''}」`
    case 'batch.registered': return `登记（${({ pickup: '接运', checkin: '入住', checkout: '转出' })[p.stage] || p.stage}）`
    case 'batch.split': return '批次按人员分组拆分'
    case 'batch.personMoved': return '人员跨批改派'
    case 'batch.held': return '批次挂起'
    case 'batch.resumed': return '批次恢复续派'
    case 'batch.rerouted': return '批次绕行改道'
    case 'batch.closed': return '批次办结、车辆回收'
    case 'batch.cancelled': return '批次取消'
    case 'batch.reassigned': return '批次改派'
    case 'shelter.settled': return `安置点第 ${p.day || 1} 日日结`
    case 'block.reported': return `现场上报道路阻断：${p.name || ''}`
    case 'block.impactConfirmed': return '确认阻断影响、生成方案'
    case 'block.impactApplied': return `执行阻断处置：${p.action}`
    case 'block.cleared': return '道路恢复通行'
    case 'block.removed': return '删除阻断记录'
    case 'repair.created': return '派出道路抢修工单'
    case 'repair.accepted': return '抢修队伍接单'
    case 'repair.progress': return `抢修进度 ${p.progress}%`
    case 'repair.finished': return '抢修完工待验收'
    case 'repair.delayed': return '抢修延期'
    case 'repair.failed': return '抢修失败、阻断保留'
    case 'repair.cancelled': return '撤销抢修工单'
    case 'repair.acceptedWork': return '验收通过、解除封闭'
    default: return e.type
  }
}

/* ---------------- 四维度差异（状态/路线/资源占用/床位） ---------------- */

export function diffStates(prev, next) {
  const statusChanges = []
  const routes = []
  const stocks = []
  const occupancy = []

  next.events.forEach((ev) => {
    const old = prev ? prev.events.find((x) => x.id === ev.id) : null
    if (!old) statusChanges.push({ icon: '🚨', text: `新增事件：${ev.title}` })
    else if (old.status !== ev.status) statusChanges.push({ icon: '🔁', text: `事件「${ev.title}」：${old.status} → ${ev.status}` })
  })

  next.dispatches.forEach((d) => {
    const old = prev ? prev.dispatches.find((x) => x.id === d.id) : null
    const name = dispatchName(d)
    if (!old) statusChanges.push({ icon: '📦', text: `新增派发：${name}` })
    else if (old.status !== d.status) statusChanges.push({ icon: '🔁', text: `派发「${name}」：${old.status} → ${d.status}` })
    const or = old ? { base: old.baseName, distance: old.distance, minutes: old.minutes, via: (old.via || []).length } : null
    const nr = { base: d.baseName, distance: d.distance, minutes: d.minutes, via: (d.via || []).length }
    if (!or || or.base !== nr.base || or.distance !== nr.distance || or.minutes !== nr.minutes || or.via !== nr.via) {
      routes.push({ name, from: or, to: nr, kind: old?.baseId !== d.baseId ? '改派基地' : (nr.via > 0 ? '绕行路线' : '直达路线') })
    }
  })

  next.batches.forEach((b) => {
    const old = prev ? prev.batches.find((x) => x.id === b.id) : null
    if (!old) statusChanges.push({ icon: '🚌', text: `新增批次「${b.name}」（${b.headcount} 人）` })
    else if (old.status !== b.status) statusChanges.push({ icon: '🔁', text: `批次「${b.name}」：${old.status} → ${b.status}` })
  })

  next.blocks.forEach((blk) => {
    const old = prev ? prev.blocks.find((x) => x.id === blk.id) : null
    if (!old) statusChanges.push({ icon: '🚧', text: `新增阻断：${blk.name}` })
    else if (old.status !== blk.status) statusChanges.push({ icon: '✅', text: `阻断「${blk.name}」已恢复通行` })
  })

  next.orders.forEach((o) => {
    const old = prev ? prev.orders.find((x) => x.id === o.id) : null
    if (!old) statusChanges.push({ icon: '🔧', text: `新增抢修工单：${o.blockName}` })
    else if (old.status !== o.status) statusChanges.push({ icon: '🔁', text: `工单「${o.blockName}」：${old.status} → ${o.status}` })
    else if (old.progress !== o.progress) statusChanges.push({ icon: '📍', text: `工单进度：${old.progress}% → ${o.progress}%` })
  })

  // 资源占用：基地×物资
  next.bases.forEach((b) => {
    const old = prev ? prev.bases.find((x) => x.id === b.id) : null
    Object.keys(b.stock).forEach((t) => {
      const nv = b.stock[t] || 0
      const ov = old ? old.stock[t] || 0 : nv
      if (ov !== nv) stocks.push({ base: b.name, type: RESOURCE_TYPES[t]?.label || t, unit: RESOURCE_TYPES[t]?.unit || '', from: ov, to: nv, delta: nv - ov })
    })
  })

  // 床位在住
  const nextBeds = bedMap(next)
  const prevBeds = prev ? bedMap(prev) : {}
  next.shelters.forEach((sh) => {
    const nv = nextBeds[sh.id]?.inHouse || 0
    const ov = prevBeds[sh.id]?.inHouse ?? nv
    if (ov !== nv) occupancy.push({ shelter: sh.name, capacity: sh.capacity, from: ov, to: nv, delta: nv - ov })
  })

  return {
    statusChanges, routes, stocks, occupancy,
    counters: {
      events: next.events.length,
      dispatches: next.dispatches.length,
      batches: next.batches.length,
      activeBlocks: next.blocks.filter((b) => b.status === 'active').length,
      orders: next.orders.length,
      settleDay: next.settleDay
    }
  }
}

function dispatchName(d) {
  return `${d.typeLabel} ${d.qty}${d.unit}｜${d.baseName} → ${d.eventTitle || d.shelterName}`
}

/* ---------------- 末端态势摘要（两分支对照） ---------------- */

export function summarize(state) {
  const stock = {}
  state.bases.forEach((b) => {
    Object.entries(b.stock).forEach(([t, q]) => {
      stock[`${b.id}|${t}`] = { base: b.name, type: RESOURCE_TYPES[t]?.label || t, unit: RESOURCE_TYPES[t]?.unit || '', qty: q || 0 }
    })
  })
  const beds = {}
  const bm = bedMap(state)
  state.shelters.forEach((sh) => { beds[sh.id] = { name: sh.name, capacity: sh.capacity, inHouse: bm[sh.id]?.inHouse || 0 } })

  const events = {}
  state.events.forEach((e) => { events[e.id] = { title: e.title, status: e.status } })
  const dispatches = {}
  state.dispatches.forEach((d) => {
    const p = dispatchParts(d)
    dispatches[d.id] = { name: dispatchName(d), status: d.status, signed: p.received, short: p.shortage, returned: p.returned }
  })
  const batches = {}
  state.batches.forEach((b) => {
    batches[b.id] = {
      name: b.name, status: b.status, headcount: b.headcount,
      members: b.members.length,
      inHouse: b.members.filter((m) => m.checkinAt && !m.checkoutAt).length,
      held: !!b.held
    }
  })
  const blocks = {}
  state.blocks.forEach((b) => { blocks[b.id] = { name: b.name, active: b.status === 'active' } })
  const orders = {}
  state.orders.forEach((o) => { orders[o.id] = { name: `${o.blockName}（${o.baseName}）`, status: o.status, progress: o.progress } })

  return { events, stock, beds, dispatches, batches, blocks, orders, settleDay: state.settleDay }
}

// 两分支末端态势对照，返回逐维度差异行
export function compare(aState, bState) {
  const a = summarize(aState)
  const b = summarize(bState)
  const rows = []
  const push = (dim, label, va, vb, same, fmt = (x) => String(x)) => { if (!same) rows.push({ dim, label, a: fmt(va), b: fmt(vb) }) }

  Object.keys({ ...a.events, ...b.events }).forEach((id) => {
    const x = a.events[id], y = b.events[id]
    push('事件状态', y?.title || x.title, x?.status, y?.status, x?.status === y?.status)
  })
  Object.keys({ ...a.stock, ...b.stock }).forEach((k) => {
    const x = a.stock[k], y = b.stock[k]; const meta = y || x
    push('基地库存', `${meta.base}·${meta.type}`, x?.qty, y?.qty, (x?.qty ?? 0) === (y?.qty ?? 0), (v) => v + meta.unit)
  })
  Object.keys({ ...a.beds, ...b.beds }).forEach((id) => {
    const x = a.beds[id], y = b.beds[id]; const meta = y || x
    push('安置床位', meta.name, x ? `${x.inHouse}/${x.capacity}` : '—', y ? `${y.inHouse}/${y.capacity}` : '—',
      (x?.inHouse ?? 0) === (y?.inHouse ?? 0))
  })
  Object.keys({ ...a.dispatches, ...b.dispatches }).forEach((id) => {
    const x = a.dispatches[id], y = b.dispatches[id]; const meta = y || x
    const fmt = (d) => d ? `${d.status}｜签${d.signed}/短${d.short}/退${d.returned}` : '—'
    const same = !!x && !!y && x.status === y.status && x.signed === y.signed && x.short === y.short && x.returned === y.returned
    push('物资派发', meta.name, x, y, same, fmt)
  })
  Object.keys({ ...a.batches, ...b.batches }).forEach((id) => {
    const x = a.batches[id], y = b.batches[id]; const meta = y || x
    const fmt = (d) => d ? `${d.status}｜登记${d.members}/${d.headcount}·在住${d.inHouse}${d.held ? '·挂起' : ''}` : '—'
    const same = !!x && !!y && x.status === y.status && x.members === y.members && x.headcount === y.headcount && x.inHouse === y.inHouse && x.held === y.held
    push('转移批次', meta.name, x, y, same, fmt)
  })
  Object.keys({ ...a.blocks, ...b.blocks }).forEach((id) => {
    const x = a.blocks[id], y = a.blocks[id], yy = b.blocks[id]
    const xx = a.blocks[id]
    const meta = yy || xx
    push('道路阻断', meta.name, xx ? (xx.active ? '封闭中' : '已恢复') : '—', yy ? (yy.active ? '封闭中' : '已恢复') : '—',
      !!xx === !!yy && xx?.active === yy?.active)
  })
  Object.keys({ ...a.orders, ...b.orders }).forEach((id) => {
    const x = a.orders[id], y = b.orders[id]; const meta = y || x
    push('抢修工单', meta.name, x, y, !!x && !!y && x.status === y.status && x.progress === y.progress, (o) => `${o.status} ${o.progress}%`)
  })
  push('补给结算', '当前结算日', '第' + a.settleDay + '日', '第' + b.settleDay + '日', a.settleDay === b.settleDay)

  const dims = ['事件状态', '基地库存', '安置床位', '物资派发', '转移批次', '道路阻断', '抢修工单', '补给结算']
  return {
    rows,
    groups: dims.map((dim) => ({ dim, rows: rows.filter((r) => r.dim === dim) })).filter((g) => g.rows.length),
    totals: {
      events: Object.keys(b.events).length,
      dispatches: Object.keys(b.dispatches).length,
      batches: Object.keys(b.batches).length,
      activeBlocks: Object.values(b.blocks).filter((x) => x.active).length,
      orders: Object.values(b.orders).filter((x) => ['dispatched', 'accepted', 'done'].includes(x.status)).length,
      settleDay: b.settleDay
    }
  }
}
