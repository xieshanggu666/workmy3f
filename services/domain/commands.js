import { dispatchParts, bedMap } from './reducer.js'
import { pointInPolygon, pathBlocked, firstBlocker, detourPathMulti } from '../lib/geo.js'
import { pathMetrics, roughPath } from './reducer.js'
import { RESOURCE_TYPES, REPAIR_MATERIAL_TYPES } from './constants.js'

/* =========================================================================
 * 命令工厂：把指挥员业务意图（"派发/签收/建批/阻断处置/抢修..."）翻译为
 * 一个或多个领域事件，并在当前投影上做前置校验。
 *
 * 输入：state（回放服务给出的当前分支末端态势）、command 名称、参数
 * 输出：{ ok, events: [...], msg, meta }  events 中可带 after 表达同批因果
 *
 * 这里的校验是"快速失败"（返回 4xx，不产生事件）；
 * reducer 折叠时仍有最终守恒校验（应对并发写入导致的竞态）。
 * ========================================================================= */

export function buildCommand(state, command, args = {}) {
  const fn = COMMANDS[command]
  if (!fn) return { ok: false, status: 404, msg: `未知命令 ${command}` }
  return fn(state, args)
}

const ok = (events, meta = {}) => ({ ok: true, events: Array.isArray(events) ? events : [events], ...meta })
const bad = (msg, status = 409) => ({ ok: false, status, msg })

function ev(type, payload, extra = {}) {
  return { type, payload, at: extra.at, day: extra.day, after: extra.after, hlc: extra.hlc }
}

const COMMANDS = {
  advanceStatus(state, { eventId, status, at }) {
    const e = state.events.find((x) => x.id === eventId)
    if (!e) return bad('事件不存在', 404)
    return ok(ev('event.statusChanged', { eventId, status }, { at }))
  },

  /* ---------------- 物资派发 ---------------- */

  dispatchResource(state, { baseId, eventId, type, qty, at }) {
    const base = state.bases.find((b) => b.id === baseId)
    const e = state.events.find((x) => x.id === eventId)
    if (!base || !e) return bad('基地或事件不存在', 404)
    qty = Math.max(0, Math.round(qty || 0))
    if (qty <= 0) return bad('派发数量必须大于 0', 400)
    if ((base.stock[type] || 0) < qty) return bad(`${base.name} ${RESOURCE_TYPES[type]?.label || type} 库存不足（余 ${base.stock[type] || 0}）`)
    return ok(ev('resource.dispatched', { baseId, eventId, type, qty, source: '手动', color: '#2f9cf5' }, { at }))
  },

  dispatchToShelter(state, { baseId, shelterId, type, qty, at }) {
    const base = state.bases.find((b) => b.id === baseId)
    const sh = state.shelters.find((s) => s.id === shelterId)
    if (!base || !sh) return bad('基地或安置点不存在', 404)
    qty = Math.max(0, Math.round(qty || 0))
    if (qty <= 0) return bad('补给数量必须大于 0', 400)
    if ((base.stock[type] || 0) < qty) return bad(`${base.name} 库存不足`)
    return ok(ev('resource.dispatched', {
      baseId, shelterId, shelterName: sh.name, lng: sh.lng, lat: sh.lat,
      type, qty, source: '安置补给', color: '#26a69a'
    }, { at }))
  },

  signDispatch(state, { dispatchId, qty, shortQty = 0, receiver, at }) {
    const d = state.dispatches.find((x) => x.id === dispatchId)
    if (!d) return bad('派发记录不存在', 404)
    if (d.status === 'held') return bad('派发挂起中，待续派后再签收')
    if (d.status === 'withdrawn') return bad('该派发已撤回，不能签收')
    if (d.status === 'done') return bad('该派发已办结，不能重复签收')
    qty = Math.max(0, Math.round(qty || 0)); shortQty = Math.max(0, Math.round(shortQty || 0))
    if (qty === 0 && shortQty === 0) return bad('请填写签收或短缺数量', 400)
    if (qty + shortQty > dispatchParts(d).outstanding) return bad(`签认数量超出在途余量 ${dispatchParts(d).outstanding}${d.unit}`)
    return ok(ev('dispatch.signed', { dispatchId, qty, shortQty, receiver }, { at }))
  },

  replenishShortage(state, { dispatchId, qty, at }) {
    const d = state.dispatches.find((x) => x.id === dispatchId)
    if (!d) return bad('派发记录不存在', 404)
    if (d.status === 'withdrawn') return bad('该派发已撤回，不能补派')
    const parts = dispatchParts(d)
    const need = qty == null ? parts.shortPending : Math.min(qty, parts.shortPending)
    if (need <= 0) return bad('无待补派短缺量')
    // 校验各基地库存总量够补（拆单由 reducer 完成）
    const total = state.bases.reduce((n, b) => n + (b.stock[d.type] || 0), 0)
    if (total <= 0) return bad('各基地该类物资库存不足，无法补派')
    return ok(ev('dispatch.shortageReplenished', { dispatchId, qty: need }, { at }))
  },

  returnDispatch(state, { dispatchId, qty, reason, at }) {
    const d = state.dispatches.find((x) => x.id === dispatchId)
    if (!d) return bad('派发记录不存在', 404)
    if (['held', 'withdrawn', 'done'].includes(d.status)) return bad('当前状态不能退回')
    qty = Math.max(0, Math.round(qty || 0))
    if (qty <= 0) return bad('请填写退回数量', 400)
    if (qty > dispatchParts(d).outstanding) return bad('退回数量超出在途余量')
    return ok(ev('dispatch.returned', { dispatchId, qty, reason }, { at }))
  },

  withdrawDispatch(state, { dispatchId, reason, at }) {
    const d = state.dispatches.find((x) => x.id === dispatchId)
    if (!d) return bad('派发记录不存在', 404)
    if (['withdrawn', 'done'].includes(d.status)) return bad('该派发已结束')
    return ok(ev('dispatch.withdrawn', { dispatchId, reason }, { at }))
  },

  /* ---------------- 转移批次 ---------------- */

  createBatch(state, { eventId, name, headcount, vehicleBaseId, vehicleCount, shelterId, at }) {
    const e = state.events.find((x) => x.id === eventId)
    const base = state.bases.find((b) => b.id === vehicleBaseId)
    const sh = state.shelters.find((s) => s.id === shelterId)
    if (!e || !base || !sh) return bad('参数不完整：事件/车辆来源/安置点', 404)
    headcount = Math.max(1, Math.round(headcount || 0))
    vehicleCount = Math.max(1, Math.round(vehicleCount || 0))
    if ((base.stock.vehicle || 0) < vehicleCount) return bad(`${base.name} 车辆不足（余 ${base.stock.vehicle || 0} 辆）`)
    if (bedMap(state)[shelterId].left < headcount) return bad(`${sh.name} 剩余床位不足`)
    return ok(ev('batch.created', {
      eventId, name: name?.trim() || undefined, headcount, vehicleBaseId, vehicleCount, shelterId
    }, { at }))
  },

  register(state, { batchId, stage, name, idNo, count, day, at }) {
    const b = state.batches.find((x) => x.id === batchId)
    if (!b) return bad('批次不存在', 404)
    if (b.status === 'closed') return bad('批次已办结')
    if (b.held && stage !== 'checkout') return bad('批次挂起中，待续派后登记')
    if (count == null && !name && !idNo) return bad('请填写姓名或证件号', 400)
    return ok(ev('batch.registered', { batchId, stage, name, idNo, count, day }, { at, day }))
  },

  movePerson(state, { personId, toBatchId, at }) {
    let person = null, from = null
    for (const b of state.batches) {
      const m = b.members.find((x) => x.id === personId)
      if (m) { person = m; from = b; break }
    }
    const to = state.batches.find((b) => b.id === toBatchId)
    if (!person || !from) return bad('未找到人员登记', 404)
    if (!to || to.status === 'closed') return bad('目标批次不可用')
    if (from.id === to.id) return bad('人员已在本批次')
    if (to.members.length >= to.headcount) return bad('目标批次已达计划人数')
    return ok(ev('batch.personMoved', { personId, toBatchId }, { at }))
  },

  splitBatch(state, args) {
    const src = state.batches.find((b) => b.id === args.batchId)
    if (!src) return bad('批次不存在', 404)
    if (src.status === 'closed') return bad('批次已办结')
    const ids = [...new Set(args.personIds || [])]
    if (!ids.length) return bad('请勾选至少一名成员', 400)
    const base = state.bases.find((b) => b.id === args.vehicleBaseId)
    const sh = state.shelters.find((s) => s.id === args.shelterId)
    if (!base || !sh) return bad('请选择车辆来源与安置点', 404)
    return ok(ev('batch.split', {
      batchId: src.id, name: args.name, personIds: ids,
      headcount: args.headcount || ids.length,
      vehicleBaseId: base.id, vehicleCount: args.vehicleCount || 1, shelterId: sh.id
    }, { at: args.at }))
  },

  reassignBatch(state, args) {
    const b = state.batches.find((x) => x.id === args.batchId)
    if (!b) return bad('批次不存在', 404)
    return ok(ev('batch.reassigned', {
      batchId: b.id, shelterId: args.shelterId,
      vehicleBaseId: args.vehicleBaseId, vehicleCount: args.vehicleCount
    }, { at: args.at }))
  },
  closeBatch(state, { batchId, at }) {
    const b = state.batches.find((x) => x.id === batchId)
    if (!b) return bad('批次不存在', 404)
    if (b.members.some((m) => m.checkinAt && !m.checkoutAt)) return bad('仍有在住人员，请先转出')
    return ok(ev('batch.closed', { batchId }, { at }))
  },
  cancelBatch(state, { batchId, at }) {
    const b = state.batches.find((x) => x.id === batchId)
    if (!b) return bad('批次不存在', 404)
    if (b.members.length > 0) return bad('已有登记记录，不能取消')
    return ok(ev('batch.cancelled', { batchId }, { at }))
  },
  holdBatch(state, { batchId, blockId, at }) {
    const b = state.batches.find((x) => x.id === batchId)
    if (!b || b.status === 'closed' || b.held) return bad('批次不可挂起')
    return ok(ev('batch.held', { batchId, blockId }, { at }))
  },
  resumeBatch(state, { batchId, at }) {
    const b = state.batches.find((x) => x.id === batchId)
    if (!b || !b.held) return bad('批次未挂起')
    return ok(ev('batch.resumed', { batchId }, { at }))
  },
  rerouteBatch(state, { batchId, via, blockId, at }) {
    const b = state.batches.find((x) => x.id === batchId)
    if (!b || b.status === 'closed') return bad('批次不可改道')
    return ok(ev('batch.rerouted', { batchId, via: via || [], blockId }, { at }))
  },

  settleShelters(state, { day, at }) {
    return ok(ev('shelter.settled', { day: day ?? state.settleDay }, { at, day: day ?? state.settleDay }))
  },

  /* ---------------- 道路阻断 ---------------- */

  reportBlock(state, { name, reason, reporter, polygon, at }) {
    if (!Array.isArray(polygon) || polygon.length < 3) return bad('封闭范围至少 3 个顶点', 400)
    return ok(ev('block.reported', { name, reason, reporter, polygon }, { at }))
  },
  clearBlock(state, { blockId, at }) {
    const blk = state.blocks.find((b) => b.id === blockId)
    if (!blk || blk.status !== 'active') return bad('阻断不存在或已恢复', 404)
    // 联合重算由编排层生成路线事件 + 工单联动；这里先发清除事件
    return ok(ev('block.cleared', { blockId }, { at }))
  },
  removeBlock(state, { blockId }) {
    const blk = state.blocks.find((b) => b.id === blockId)
    if (!blk || blk.status !== 'cleared') return bad('仅已恢复阻断可删除')
    return ok(ev('block.removed', { blockId }))
  },

  /* ---------------- 抢修工单 ---------------- */

  createOrder(state, args) {
    const blk = state.blocks.find((b) => b.id === args.blockId)
    if (!blk) return bad('阻断不存在', 404)
    if (blk.status !== 'active') return bad('阻断已恢复，无需抢修')
    if (state.orders.some((o) => o.blockId === blk.id && ['dispatched', 'accepted', 'done'].includes(o.status))) {
      return bad('该阻断已有进行中工单')
    }
    const base = state.bases.find((b) => b.id === args.baseId)
    if (!base) return bad('请选择出库基地', 404)
    const personnel = Math.max(0, Math.round(args.personnel || 0))
    const vehicles = Math.max(0, Math.round(args.vehicles || 0))
    const mats = (args.materials || []).filter((m) => m.qty > 0 && REPAIR_MATERIAL_TYPES.includes(m.type))
    if (personnel <= 0 && vehicles <= 0 && !mats.length) return bad('请至少分配人员/车辆/物资', 400)
    if ((base.stock.personnel || 0) < personnel) return bad('救援人员不足')
    if ((base.stock.vehicle || 0) < vehicles) return bad('救援车辆不足')
    for (const m of mats) if ((base.stock[m.type] || 0) < m.qty) return bad(`${RESOURCE_TYPES[m.type]?.label || m.type} 不足`)
    return ok(ev('repair.created', {
      blockId: blk.id, baseId: base.id, personnel, vehicles, materials: mats,
      deadline: args.deadline, remark: args.remark
    }, { at: args.at }))
  },
  acceptOrder(state, { orderId, at }) {
    const o = state.orders.find((x) => x.id === orderId)
    if (!o || o.status !== 'dispatched') return bad('仅待接单工单可接单')
    return ok(ev('repair.accepted', { orderId }, { at }))
  },
  reportProgress(state, { orderId, progress, note, at }) {
    const o = state.orders.find((x) => x.id === orderId)
    if (!o || o.status !== 'accepted') return bad('仅抢修中工单可报进度')
    progress = Math.round(progress || 0)
    if (progress < o.progress) return bad(`进度不能回退（当前 ${o.progress}%）`)
    return ok(ev('repair.progress', { orderId, progress, note }, { at }))
  },
  finishOrder(state, { orderId, used, at }) {
    const o = state.orders.find((x) => x.id === orderId)
    if (!o || o.status !== 'accepted') return bad('仅抢修中工单可完工')
    return ok(ev('repair.finished', { orderId, used: used || {} }, { at }))
  },
  delayOrder(state, { orderId, reason, deadline, at }) {
    const o = state.orders.find((x) => x.id === orderId)
    if (!o || o.status !== 'accepted') return bad('仅抢修中工单可延期')
    return ok(ev('repair.delayed', { orderId, reason, deadline }, { at }))
  },
  failOrder(state, { orderId, reason, used, at }) {
    const o = state.orders.find((x) => x.id === orderId)
    if (!o || !['accepted', 'done'].includes(o.status)) return bad('工单状态不允许失败处理')
    return ok(ev('repair.failed', { orderId, reason, used: used || null }, { at }))
  },
  cancelOrder(state, { orderId, reason, used, at }) {
    const o = state.orders.find((x) => x.id === orderId)
    if (!o || !['dispatched', 'accepted'].includes(o.status)) return bad('工单状态不允许撤单')
    return ok(ev('repair.cancelled', { orderId, reason, used: used || null }, { at }))
  },
  acceptWork(state, { orderId, at }) {
    const o = state.orders.find((x) => x.id === orderId)
    if (!o || o.status !== 'done') return bad('仅待验收工单可验收')
    // 验收通过：工单办结 + 阻断清除（reducer 内联动解除封闭）
    return ok(ev('repair.acceptedWork', { orderId }, { at }))
  }
}

/* ---------------- 阻断影响评估与处置编排（几何重活） ---------------- */

function taskPoints(state, kind, ref) {
  if (kind === 'dispatch') {
    const base = state.bases.find((b) => b.id === ref.baseId)
    if (!base) return null
    return { a: [base.lng, base.lat], z: [ref.lng, ref.lat], pts: [[base.lng, base.lat], ...(ref.via || []), [ref.lng, ref.lat]] }
  }
  const e = state.events.find((x) => x.id === ref.eventId)
  const sh = state.shelters.find((s) => s.id === ref.shelterId)
  if (!e || !sh) return null
  return { a: [e.location.lng, e.location.lat], z: [sh.lng, sh.lat], pts: [[e.location.lng, e.location.lat], ...(ref.via || []), [sh.lng, sh.lat]] }
}

// 扫描单个阻断对当前全部在途任务的影响
export function scanImpacts(state, blockId) {
  const blk = state.blocks.find((b) => b.id === blockId)
  if (!blk) return []
  const impacts = []
  state.dispatches.forEach((d) => {
    if (['held', 'done', 'withdrawn'].includes(d.status)) return
    if (dispatchParts(d).outstanding <= 0) return
    const t = taskPoints(state, 'dispatch', d)
    if (!t) return
    if (pointInPolygon(t.z, blk.polygon) || pointInPolygon(t.a, blk.polygon) || pathBlocked(t.pts, blk.polygon)) {
      impacts.push({ kind: 'dispatch', id: d.id, destInside: pointInPolygon(t.z, blk.polygon), originInside: pointInPolygon(t.a, blk.polygon) })
    }
  })
  state.batches.forEach((b) => {
    if (b.status === 'closed' || b.held) return
    const t = taskPoints(state, 'batch', b)
    if (!t) return
    if (pointInPolygon(t.z, blk.polygon) || pointInPolygon(t.a, blk.polygon) || pathBlocked(t.pts, blk.polygon)) {
      impacts.push({ kind: 'batch', id: b.id, destInside: pointInPolygon(t.z, blk.polygon), originInside: pointInPolygon(t.a, blk.polygon) })
    }
  })
  return impacts
}

// 生成单个任务的处置方案（联合避障绕行 → 改派 → 挂起）
export function optionsFor(state, blockId, kind, id) {
  const polys = state.blocks.filter((b) => b.status === 'active').map((b) => b.polygon)
  const ref = kind === 'dispatch'
    ? state.dispatches.find((d) => d.id === id)
    : state.batches.find((b) => b.id === id)
  if (!ref) return []
  const t = taskPoints(state, kind, ref)
  if (!t) return []
  const destInsideAny = polys.some((p) => pointInPolygon(t.z, p))
  const originInsideAny = polys.some((p) => pointInPolygon(t.a, p))
  const opts = []

  if (!destInsideAny && !originInsideAny) {
    const det = detourPathMulti(t.a, t.z, polys)
    if (det) {
      const m = pathMetrics([t.a, ...det.via, t.z])
      opts.push({ action: 'detour', via: det.via, distance: m.distance, minutes: m.minutes })
    }
  }

  if (kind === 'dispatch') {
    const moveQty = dispatchParts(ref).outstanding
    if (!destInsideAny) {
      const alt = state.bases
        .filter((b) => b.id !== ref.baseId && (b.stock[ref.type] || 0) >= moveQty)
        .filter((b) => firstBlocker([[b.lng, b.lat], t.z], polys) < 0)
        .map((b) => ({ b, m: roughPath(b.lng, b.lat, ref.lng, ref.lat) }))
        .sort((x, y) => x.m.minutes - y.m.minutes)[0]
      if (alt) opts.push({ action: 'reassign', baseId: alt.b.id, baseName: alt.b.name, distance: alt.m.distance, minutes: alt.m.minutes })
    }
  } else if (!originInsideAny && !ref.members.some((m) => m.checkinAt)) {
    const alt = state.shelters
      .filter((s) => s.id !== ref.shelterId && bedMap(state)[s.id].left >= ref.headcount)
      .filter((s) => firstBlocker([t.a, [s.lng, s.lat]], polys) < 0)
      .map((s) => ({ s, m: pathMetrics([t.a, [s.lng, s.lat]]) }))
      .sort((x, y) => x.m.minutes - y.m.minutes)[0]
    if (alt) opts.push({ action: 'reassign', shelterId: alt.s.id, shelterName: alt.s.name, distance: alt.m.distance, minutes: alt.m.minutes })
  }
  opts.push({ action: 'suspend' })
  return opts
}

// 执行处置方案：翻译成具体业务事件（执行前复核由调用方拿最新 state 再算一次）
export function applyImpactEvents(state, blockId, kind, id, chosen) {
  // 执行前复核：以最新态势重新生成候选，原方案失效时自动降级 detour→reassign→suspend
  const fresh = optionsFor(state, blockId, kind, id)
  let plan = fresh.find((o) => o.action === chosen.action &&
    (o.baseId === undefined || o.baseId === chosen.baseId) &&
    (o.shelterId === undefined || o.shelterId === chosen.shelterId))
  let adjusted = false
  if (!plan) {
    plan = fresh.find((o) => o.action === 'detour') || fresh.find((o) => o.action === 'reassign') || fresh.find((o) => o.action === 'suspend')
    adjusted = true
  }
  if (!plan) return bad('当前无可行方案')
  const events = []
  if (kind === 'dispatch') {
    if (plan.action === 'detour') events.push(ev('dispatch.rerouted', { dispatchId: id, via: plan.via, blockId }))
    else if (plan.action === 'reassign') events.push(ev('dispatch.reassigned', { dispatchId: id, newBaseId: plan.baseId }))
    else events.push(ev('dispatch.held', { dispatchId: id, blockId }))
  } else {
    if (plan.action === 'detour') events.push(ev('batch.rerouted', { batchId: id, via: plan.via, blockId }))
    else if (plan.action === 'reassign') events.push(ev('batch.reassigned', { batchId: id, shelterId: plan.shelterId }))
    else events.push(ev('batch.held', { batchId: id, blockId }))
  }
  events.push(ev('block.impactApplied', { blockId, key: `${kind}:${id}`, action: plan.action, msg: plan.baseName || plan.shelterName || '' }))
  return { ok: true, events, plan, adjusted }
}

// 阻断清除后的联合重算：绕行路线能回直则回直，仍受阻则重排；挂起任务保持
export function clearBlockRerouteEvents(state, blockId) {
  const events = [ev('block.cleared', { blockId })]
  const polys = state.blocks.filter((b) => b.status === 'active' && b.id !== blockId).map((b) => b.polygon)
  state.dispatches.forEach((d) => {
    if (d.status !== 'enroute' || dispatchParts(d).outstanding <= 0 || !(d.via || []).length) return
    const base = state.bases.find((b) => b.id === d.baseId)
    if (!base) return
    const a = [base.lng, base.lat], z = [d.lng, d.lat]
    if (firstBlocker([a, z], polys) < 0) events.push(ev('dispatch.rerouted', { dispatchId: d.id, via: [], blockId: null }))
    else {
      const det = detourPathMulti(a, z, polys)
      if (det && det.via.length) events.push(ev('dispatch.rerouted', { dispatchId: d.id, via: det.via, blockId }))
    }
  })
  state.batches.forEach((b) => {
    if (b.status === 'closed' || b.held || !(b.via || []).length) return
    const e = state.events.find((x) => x.id === b.eventId)
    const sh = state.shelters.find((s) => s.id === b.shelterId)
    if (!e || !sh) return
    const a = [e.location.lng, e.location.lat], z = [sh.lng, sh.lat]
    if (firstBlocker([a, z], polys) < 0) events.push(ev('batch.rerouted', { batchId: b.id, via: [], blockId: null }))
    else {
      const det = detourPathMulti(a, z, polys)
      if (det && det.via.length) events.push(ev('batch.rerouted', { batchId: b.id, via: det.via, blockId }))
    }
  })
  // 在该阻断上仍进行的抢修工单：强制恢复 → 撤单/视同验收（reducer settleByBlock 语义）
  state.orders.filter((o) => o.blockId === blockId && ['dispatched', 'accepted', 'done'].includes(o.status)).forEach((o) => {
    events.push(o.status === 'done'
      ? ev('repair.acceptedWork', { orderId: o.id })
      : ev('repair.cancelled', { orderId: o.id, reason: '道路恢复通行，工单自动撤单', used: null }))
  })
  return { ok: true, events }
}

// 一键续派：挂起任务路线复核，能通的生成 resume 事件
export function resumeHeldEvents(state) {
  const polys = state.blocks.filter((b) => b.status === 'active').map((b) => b.polygon)
  const blocked = (a, z) => polys.some((p) => pointInPolygon(z, p)) || polys.some((p) => pathBlocked([a, z], p))
  const events = []
  const kept = []
  state.dispatches.filter((d) => d.status === 'held' && dispatchParts(d).outstanding > 0).forEach((d) => {
    const base = state.bases.find((b) => b.id === d.baseId)
    if (!base) { kept.push(d.id); return }
    const a = [base.lng, base.lat], z = [d.lng, d.lat]
    if (blocked(a, z)) { kept.push(d.id); return }
    events.push(ev('dispatch.resumed', { dispatchId: d.id }))
  })
  state.batches.filter((b) => b.held).forEach((b) => {
    const e = state.events.find((x) => x.id === b.eventId)
    const sh = state.shelters.find((s) => s.id === b.shelterId)
    if (!e || !sh || blocked([e.location.lng, e.location.lat], [sh.lng, sh.lat])) { kept.push(b.id); return }
    events.push(ev('batch.resumed', { batchId: b.id }))
  })
  return { ok: true, events, kept }
}
