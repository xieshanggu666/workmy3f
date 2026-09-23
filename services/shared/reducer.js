/* =========================================================================
 * reducer —— 纯函数折叠：因果事件流 => 某一时刻的投影视图
 *
 * 三类核心投影（题目要求「按因果顺序重建库存、床位和运输状态」）：
 *   stock     bases[baseId].stock[resource] = { granted, allocated, returned,
 *                                               reserved, qty(实物余量), available }
 *   beds      shelters[shelterId]          = { capacity, reserved, occupied, free }
 *   transport shipments[shipmentId]        = { kind, status, qty, route, events... }
 *
 * 另含 blocks / repairs / participants / meta（结算日等）用于完整态势。
 *
 * 关键性质：
 *   1. 纯函数 + 严格因果序 => 确定性，同一事件集无论「实时到 / 乱序补到 / 重启重放」
 *      折叠结果逐字节相同（快照指纹可验证）。
 *   2. 所有数字账守恒：库存 余量 = granted − allocated + returned；
 *      available = qty − reserved；床位 capacity = reserved + occupied + free。
 *   3. 业务不变量在此断言（超扣/超占直接抛 invariant_violation），
 *      把「脏事件」挡在投影之外，而不是让视图静默算错。
 * ========================================================================= */

import { clone, DomainError, ensure } from './util.js'
import { EVENT_TYPES } from './events.js'

export function emptyState() {
  return {
    version: 1,
    opened: false,
    sealed: false,
    bases: {},          // baseId -> { id, name, stock: { resource: ledger } }
    shelters: {},       // shelterId -> { id, name, capacity, reserved, occupied, free }
    shipments: {},      // shipmentId -> 运输聚合
    blocks: {},         // blockId -> { id, status, polygon, ... }
    repairs: {},        // orderId -> 工单聚合
    participants: {},   // clientId -> { joinedAt, lastSeenAt }
    settleDay: 1,
    appliedSeq: 0,
    lastEventId: null,
    // 资源账本引用计数：reserve/alloc 按 refId 登记，释放/回库时核销（防同一预占重复释放）
    refs: {}            // refId -> { kind:'reserve'|'alloc', baseId?, resource?, shelterId?, qty, released }
  }
}

function baseLedger(state, baseId, resource) {
  const b = state.bases[baseId]
  ensure(b, 'unknown_base', `库存事件引用了不存在的基地: ${baseId}`, 422)
  if (!b.stock[resource]) {
    b.stock[resource] = { granted: 0, allocated: 0, returned: 0, reserved: 0 }
  }
  return b.stock[resource]
}

function stockQty(l) { return l.granted - l.allocated + l.returned }
function stockAvailable(l) { return stockQty(l) - l.reserved }

function shelter(state, shelterId) {
  const s = state.shelters[shelterId]
  ensure(s, 'unknown_shelter', `床位事件引用了不存在的安置点: ${shelterId}`, 422)
  return s
}

function qtyOf(d, key = 'qty') {
  const q = Number(d[key])
  ensure(Number.isFinite(q) && q !== 0, 'bad_qty', `数量非法: ${d[key]}`, 422)
  return q
}

function ref(state, refId) {
  ensure(refId, 'missing_ref', '库存/床位事件缺少 refId（业务关联键）', 422)
  return state.refs[refId] || null
}

/* ---------------- 旧快照锚点水合（迁移兜底） ---------------- */

// 旧全量快照 -> 当前投影形状：库存只对齐实物余量（granted=余量，过程账目归零），
// 床位按成员在住重算 occupied，运输单按旧字段映射状态。
function hydrateFromLegacy(state, snap) {
  if (!snap) return
  if (snap.cmd?.bases) {
    state.bases = {}
    snap.cmd.bases.forEach((b) => {
      const stock = {}
      Object.entries(b.stock || {}).forEach(([r, q]) => {
        stock[r] = { granted: q, allocated: 0, returned: 0, reserved: 0 }
      })
      state.bases[b.id] = { id: b.id, name: b.name, stock }
    })
  }
  if (snap.tr?.shelters) {
    state.shelters = {}
    snap.tr.shelters.forEach((s) => {
      const occupied = (snap.tr.batches || [])
        .filter((bt) => bt.shelterId === s.id)
        .reduce((n, bt) => n + (bt.members || []).filter((m) => m.checkinAt && !m.checkoutAt).length, 0)
      state.shelters[s.id] = {
        id: s.id, name: s.name, capacity: s.capacity,
        reserved: 0, occupied, free: s.capacity - occupied
      }
    })
  }
  if (snap.cmd?.dispatches) {
    state.shipments = {}
    snap.cmd.dispatches.forEach((d) => {
      const statusMap = { enroute: 'enroute', held: 'held', done: 'closed', withdrawn: 'withdrawn' }
      state.shipments[d.id] = {
        id: d.id, kind: 'supply', resource: d.type, qty: d.qty,
        baseId: d.baseId, target: d.eventId ? { eventId: d.eventId } : { shelterId: d.shelterId },
        route: d.distance != null ? { distance: d.distance, minutes: d.minutes, via: d.via || [] } : null,
        status: statusMap[d.status] || 'created',
        signedQty: d.signedQty || 0, shortQty: d.shortQty || 0, returnedQty: d.returnedQty || 0,
        timeline: [], anchored: true
      }
    })
  }
  if (snap.rb?.blocks) {
    state.blocks = {}
    snap.rb.blocks.forEach((b) => {
      state.blocks[b.id] = { id: b.id, name: b.name, status: b.status, polygon: b.polygon || [] }
    })
  }
  if (snap.ro?.orders) {
    state.repairs = {}
    snap.ro.orders.forEach((o) => {
      state.repairs[o.id] = { id: o.id, blockId: o.blockId, baseId: o.baseId, status: o.status, progress: o.progress || 0 }
    })
  }
  if (snap.tr?.settleDay) state.settleDay = snap.tr.settleDay
  // 锚点之后的 refs 全部失效（旧过程账目不回溯），避免后续释放误核销
  state.refs = {}
}

/* ---------------- 单个事件折叠 ---------------- */

function applyOne(state, e) {
  const d = e.data || {}
  switch (e.type) {
    case EVENT_TYPES.REALM_OPENED: {
      state.opened = true
      if (d.bases) {
        d.bases.forEach((b) => {
          state.bases[b.id] = { id: b.id, name: b.name || b.id, stock: {} }
          Object.entries(b.stock || {}).forEach(([r, q]) => {
            state.bases[b.id].stock[r] = { granted: q, allocated: 0, returned: 0, reserved: 0 }
          })
        })
      }
      if (d.shelters) {
        d.shelters.forEach((s) => {
          state.shelters[s.id] = {
            id: s.id, name: s.name || s.id,
            capacity: s.capacity || 0, reserved: 0, occupied: 0, free: s.capacity || 0
          }
        })
      }
      if (d.settleDay) state.settleDay = d.settleDay
      break
    }
    case EVENT_TYPES.BRANCH_SEALED:
      state.sealed = true
      break

    case EVENT_TYPES.PARTICIPANT_JOINED:
      state.participants[e.clientId] = { clientId: e.clientId, actor: e.actor, joinedAt: e.happenedAt }
      break
    case EVENT_TYPES.PARTICIPANT_LEFT:
      delete state.participants[e.clientId]
      break

    /* ---------- 库存 ---------- */
    case EVENT_TYPES.STOCK_GRANTED: {
      const q = qtyOf(d)
      const l = baseLedger(state, d.baseId, d.resource)
      ensure(stockQty(l) + q >= 0, 'invariant_violation',
        `库存核销后为负：${d.baseId}/${d.resource}`, 422)
      l.granted += q
      break
    }
    case EVENT_TYPES.STOCK_RESERVED: {
      const q = qtyOf(d)
      const l = baseLedger(state, d.baseId, d.resource)
      ensure(!ref(state, d.refId), 'ref_exists', `预占引用已存在: ${d.refId}`, 409)
      ensure(stockAvailable(l) >= q, 'invariant_violation',
        `可用库存不足，无法预占：${d.baseId}/${d.resource} 需要 ${q}，可用 ${stockAvailable(l)}`, 422)
      l.reserved += q
      state.refs[d.refId] = { kind: 'reserve', baseId: d.baseId, resource: d.resource, qty: q, released: false }
      break
    }
    case EVENT_TYPES.STOCK_RESERVE_RELEASED: {
      const r = ref(state, d.refId)
      ensure(r && r.kind === 'reserve' && !r.released, 'ref_state',
        `预占引用不可释放（不存在/已释放/非预占）: ${d.refId}`, 409)
      const l = baseLedger(state, r.baseId, r.resource)
      l.reserved -= r.qty
      r.released = true
      break
    }
    case EVENT_TYPES.STOCK_ALLOCATED: {
      const q = qtyOf(d)
      const l = baseLedger(state, d.baseId, d.resource)
      // 出库允许带 consumeReserve:true 核销同 refId 预占（统筹提交：预占转实扣）
      const r = ref(state, d.refId)
      if (d.consumeReserve) {
        ensure(r && r.kind === 'reserve' && !r.released, 'ref_state',
          `出库需核销的预占不存在或已释放: ${d.refId}`, 409)
        l.reserved -= r.qty
        r.released = true
      }
      ensure(stockQty(l) >= q, 'invariant_violation',
        `库存不足，无法出库：${d.baseId}/${d.resource} 需要 ${q}，余量 ${stockQty(l)}`, 422)
      l.allocated += q
      state.refs[`alloc:${d.refId}`] = {
        kind: 'alloc', baseId: d.baseId, resource: d.resource, qty: q, released: false
      }
      break
    }
    case EVENT_TYPES.STOCK_RETURNED: {
      const q = qtyOf(d)
      const l = baseLedger(state, d.baseId, d.resource)
      const ar = ref(state, `alloc:${d.refId}`)
      ensure(ar && !ar.released, 'ref_state',
        `出库引用不存在或已结算，无法回库: ${d.refId}`, 409)
      ensure(q <= ar.qty - (ar.returnedQty || 0), 'invariant_violation',
        `回库数量超过可归还量: ${d.refId}`, 422)
      l.returned += q
      ar.returnedQty = (ar.returnedQty || 0) + q
      if (ar.returnedQty >= ar.qty) ar.released = true
      break
    }

    /* ---------- 床位 ---------- */
    case EVENT_TYPES.BED_RESERVED: {
      const q = qtyOf(d)
      const s = shelter(state, d.shelterId)
      ensure(!ref(state, d.refId), 'ref_exists', `床位预占引用已存在: ${d.refId}`, 409)
      ensure(s.free >= q, 'invariant_violation',
        `床位不足，无法预占：${s.name} 需要 ${q}，空余 ${s.free}`, 422)
      s.reserved += q; s.free -= q
      state.refs[d.refId] = { kind: 'bed-reserve', shelterId: d.shelterId, qty: q, released: false }
      break
    }
    case EVENT_TYPES.BED_RESERVE_RELEASED: {
      const r = ref(state, d.refId)
      ensure(r && r.kind === 'bed-reserve' && !r.released, 'ref_state',
        `床位预占不可释放: ${d.refId}`, 409)
      const s = shelter(state, r.shelterId)
      s.reserved -= r.qty; s.free += r.qty
      r.released = true
      break
    }
    case EVENT_TYPES.BED_OCCUPIED: {
      const q = qtyOf(d)
      const s = shelter(state, d.shelterId)
      // 入住优先核销本批预占（consumeReserve + refId），也允许无预占直接入住（历史兼容）
      if (d.consumeReserve) {
        const r = ref(state, d.refId)
        ensure(r && r.kind === 'bed-reserve' && !r.released && r.qty >= q, 'ref_state',
          `入住需核销的床位预占不足: ${d.refId}`, 409)
        s.reserved -= q
        r.qty -= q
        if (r.qty === 0) r.released = true
      } else {
        ensure(s.free >= q, 'invariant_violation',
          `床位不足，无法入住：${s.name} 需要 ${q}，空余 ${s.free}`, 422)
        s.free -= q
      }
      s.occupied += q
      break
    }
    case EVENT_TYPES.BED_FREED: {
      const q = qtyOf(d)
      const s = shelter(state, d.shelterId)
      ensure(s.occupied >= q, 'invariant_violation',
        `转出人数超过在住：${s.name}`, 422)
      s.occupied -= q; s.free += q
      break
    }

    /* ---------- 运输 ---------- */
    case EVENT_TYPES.SHIPMENT_CREATED: {
      const id = d.shipmentId
      ensure(!state.shipments[id], 'shipment_exists', `运输单已存在: ${id}`, 409)
      state.shipments[id] = {
        id,
        kind: d.kind || 'supply',            // supply 物资 / transfer 人员 / repair 抢修投送
        status: 'created',
        resource: d.resource || null,
        qty: Number(d.qty) || 0,
        people: Number(d.people) || 0,
        baseId: d.baseId || null,
        target: d.target || null,            // { eventId / shelterId }
        route: d.route || null,              // { distance, minutes, via:[] }
        timeline: [{ seq: e.seq, at: e.happenedAt, type: e.type }]
      }
      break
    }
    case EVENT_TYPES.SHIPMENT_ROUTED: {
      const s = state.shipments[d.shipmentId]
      ensure(s, 'unknown_shipment', `运输单不存在: ${d.shipmentId}`, 422)
      s.route = { ...(s.route || {}), ...(d.route || {}) }
      if (d.baseId) s.baseId = d.baseId
      if (d.target) s.target = { ...(s.target || {}), ...d.target }
      s.timeline.push({ seq: e.seq, at: e.happenedAt, type: e.type, note: d.note || null })
      break
    }
    case EVENT_TYPES.SHIPMENT_HELD: {
      const s = state.shipments[d.shipmentId]; ensure(s, 'unknown_shipment', '运输单不存在', 422)
      s.status = 'held'; s.holdReason = d.reason || null
      s.timeline.push({ seq: e.seq, at: e.happenedAt, type: e.type, reason: d.reason || null })
      break
    }
    case EVENT_TYPES.SHIPMENT_RESUMED: {
      const s = state.shipments[d.shipmentId]; ensure(s, 'unknown_shipment', '运输单不存在', 422)
      s.status = 'enroute'; s.holdReason = null
      s.timeline.push({ seq: e.seq, at: e.happenedAt, type: e.type })
      break
    }
    case EVENT_TYPES.SHIPMENT_DELIVERED: {
      const s = state.shipments[d.shipmentId]; ensure(s, 'unknown_shipment', '运输单不存在', 422)
      if (s.kind === 'supply') {
        s.signedQty = (s.signedQty || 0) + qtyOf(d)
        s.shortQty = (s.shortQty || 0) + (Number(d.shortQty) || 0)
      } else if (s.kind === 'transfer') {
        s.deliveredPeople = (s.deliveredPeople || 0) + qtyOf(d)
      }
      s.status = d.partial ? 'enroute' : 'delivered'
      s.timeline.push({ seq: e.seq, at: e.happenedAt, type: e.type, qty: d.qty, partial: !!d.partial })
      break
    }
    case EVENT_TYPES.SHIPMENT_RETURNED: {
      const s = state.shipments[d.shipmentId]; ensure(s, 'unknown_shipment', '运输单不存在', 422)
      s.returnedQty = (s.returnedQty || 0) + qtyOf(d)
      s.timeline.push({ seq: e.seq, at: e.happenedAt, type: e.type, qty: d.qty })
      break
    }
    case EVENT_TYPES.SHIPMENT_CLOSED: {
      const s = state.shipments[d.shipmentId]; ensure(s, 'unknown_shipment', '运输单不存在', 422)
      s.status = d.status || (d.withdrawn ? 'withdrawn' : 'closed')
      s.closedAt = e.happenedAt
      s.timeline.push({ seq: e.seq, at: e.happenedAt, type: e.type, withdrawn: !!d.withdrawn })
      break
    }

    /* ---------- 道路阻断 / 抢修 ---------- */
    case EVENT_TYPES.BLOCK_REPORTED: {
      ensure(!state.blocks[d.blockId], 'block_exists', `阻断已存在: ${d.blockId}`, 409)
      state.blocks[d.blockId] = {
        id: d.blockId, name: d.name || d.blockId, status: 'active',
        polygon: d.polygon || [], reportedAt: e.happenedAt
      }
      break
    }
    case EVENT_TYPES.BLOCK_CLEARED: {
      const b = state.blocks[d.blockId]; ensure(b, 'unknown_block', '阻断不存在', 422)
      b.status = 'cleared'; b.clearedAt = e.happenedAt
      break
    }
    case EVENT_TYPES.REPAIR_ORDER_CREATED: {
      ensure(!state.repairs[d.orderId], 'repair_exists', `工单已存在: ${d.orderId}`, 409)
      state.repairs[d.orderId] = {
        id: d.orderId, blockId: d.blockId, status: 'dispatched',
        baseId: d.baseId || null, progress: 0, createdAt: e.happenedAt
      }
      break
    }
    case EVENT_TYPES.REPAIR_PROGRESS: {
      const r = state.repairs[d.orderId]; ensure(r, 'unknown_repair', '工单不存在', 422)
      const p = Number(d.progress)
      ensure(p >= (r.progress || 0), 'invariant_violation',
        `抢修进度必须单调递增：${r.progress} -> ${p}`, 422)
      r.progress = Math.min(100, p)
      r.status = p >= 100 ? 'done' : 'accepted'
      break
    }
    case EVENT_TYPES.REPAIR_SETTLED: {
      const r = state.repairs[d.orderId]; ensure(r, 'unknown_repair', '工单不存在', 422)
      r.status = d.outcome // cleared(验收通过) / failed / cancelled
      r.consumed = d.consumed || null
      r.settledAt = e.happenedAt
      break
    }

    // 分叉事件本身不改投影（分叉是存储层拓扑），仅记账
    case EVENT_TYPES.BRANCH_FORKED:
      break
    // 旧快照锚点：无法用增量事件完整还原时，以旧全量快照整体校准投影（只进不出的迁移兜底）
    case EVENT_TYPES.SNAPSHOT_ANCHOR:
      hydrateFromLegacy(state, d.snapshot)
      break
    default:
      // 未识别事件：向前兼容（新版事件类型不炸掉旧折叠器），但计入 appliedSeq
      state.unknownTypes = state.unknownTypes || []
      if (!state.unknownTypes.includes(e.type)) state.unknownTypes.push(e.type)
  }
}

/* ---------------- 对外 API ---------------- */

// 折叠完整因果流（重启重建 / 全量回放）
export function fold(events, base = emptyState()) {
  const state = base
  for (const e of events) {
    applyOne(state, e)
    state.appliedSeq = e.seq
    state.lastEventId = e.eventId
  }
  return state
}

// 严格因果序的增量折叠：要求 events 已按拓扑序；支持从中间断点续播。
// fromLastEventId 之后的事件必须与已折叠状态因果连续，否则报 causal_gap 让上层全量重建。
export function foldInto(state, events, { expectContinuous = true } = {}) {
  for (const e of events) {
    if (expectContinuous && state.lastEventId && e.prevId && e.prevId !== state.lastEventId) {
      // 增量链断裂（乱序补齐、分叉段切换）— 交给上层用 fold 全量重建，避免错位更新
      throw new DomainError('causal_gap',
        `增量折叠因果断裂：期望 prev=${state.lastEventId}，实际 prev=${e.prevId}`, 409)
    }
    applyOne(state, e)
    state.appliedSeq = e.seq
    state.lastEventId = e.eventId
  }
  return state
}

// 对外投影视图：把账本换算成可读余量（不暴露内部 refs）
export function projectView(state) {
  const s = clone(state)
  Object.values(s.bases).forEach((b) => {
    Object.entries(b.stock).forEach(([r, l]) => {
      l.qty = l.granted - l.allocated + l.returned
      l.available = l.qty - l.reserved
    })
  })
  Object.values(s.shelters).forEach((sh) => {
    sh.free = sh.capacity - sh.reserved - sh.occupied
  })
  delete s.refs
  return s
}

export { DomainError }
