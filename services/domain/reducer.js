import { pathKm } from '../lib/geo.js'
import {
  RESOURCE_TYPES, DEFAULT_BASES, DEFAULT_SHELTERS,
  SUPPLY_PER_CAPITA, SUPPLY_DURABLES
} from './constants.js'

/* =========================================================================
 * 纯函数事件溯源 Reducer
 *
 * state = fold(events)：库存、床位、运输（派发/批次/阻断/抢修）状态全部由
 * 事件序列按因果顺序折叠重建，任意节点 seek = 折叠到该序号。
 *
 * 不做 IO、不读时钟；事件上带发生时间 at（字符串）与 day（结算日）。
 * 折叠幂等：同 eventId 重复出现（客户端重试/故障重发）只生效一次。
 * 乐观因果冲突：违反业务前置（库存/床位不足、状态机非法跳转）不抛异常，
 * 追加到 state.conflicts 且不改状态——乱序/并发写入后最终状态仍守恒。
 * ========================================================================= */

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100

export function pathMetrics(points) {
  const distance = Math.round(pathKm(points) * 1.25 * 10) / 10
  const minutes = Math.round((distance / 55) * 60 + 8)
  return { distance, minutes }
}

export function roughPath(lng1, lat1, lng2, lat2) {
  return pathMetrics([[lng1, lat1], [lng2, lat2]])
}

// 派发四本账（与前端 dispatchParts 等价；无闭环字段的旧记录按全量在途）
export function dispatchParts(d) {
  const received = d.signedQty || 0
  const shortage = d.shortQty || 0
  const returned = d.returnedQty || 0
  const withdrawn = d.withdrawnQty || 0
  const outstanding = Math.max(0, (d.qty || 0) - received - shortage - returned - withdrawn)
  return {
    received, shortage, returned, withdrawn, outstanding,
    inTransit: d.status === 'enroute' ? outstanding : 0,
    heldQty: d.status === 'held' ? outstanding : 0,
    resupplied: d.shortReplenished || 0,
    shortPending: Math.max(0, shortage - (d.shortReplenished || 0))
  }
}

export function createState() {
  return {
    version: 2,
    simId: null,
    scenarioId: null,
    name: '',
    settleDay: 1,
    events: [],
    bases: [],
    shelters: [],
    dispatches: [],
    batches: [],
    blocks: [],
    orders: [],
    // 折叠簿记
    appliedIds: [],          // 幂等（检查点会保留为 Set，序列化时转数组）
    conflicts: [],
    seq: 0
  }
}

export function initState({ simId, scenarioId = 's1', name = '推演', events = null, bases = null, shelters = null } = {}) {
  const s = createState()
  s.simId = simId
  s.scenarioId = scenarioId
  s.name = name
  s.events = events || []
  s.bases = (bases || DEFAULT_BASES).map((b) => ({ ...b, stock: { ...b.stock } }))
  s.shelters = (shelters || DEFAULT_SHELTERS).map((x) => ({ ...x, consumed: {}, settlements: [], peakInHouse: 0 }))
  return s
}

function asSet(x) {
  if (!x) return new Set()
  return x instanceof Set ? x : new Set(x)
}

// 应用单个事件；返回新的 state（原地修改浅克隆后的聚合根集合，事件本身不被修改）
export function fold(state, ev, ctx = {}) {
  const applied = asSet(state.appliedIds)
  if (ev.id && applied.has(ev.id)) return state // 幂等：重试/重复投递
  const s = state
  s.seq += 1
  const reject = (reason) => {
    s.conflicts.push({ eventId: ev.id || null, kind: ev.type, at: ev.at || null, reason })
    if (ev.id) applied.add(ev.id)
    s.appliedIds = [...applied]
    return s
  }
  const commit = () => { if (ev.id) applied.add(ev.id); s.appliedIds = [...applied]; return s }
  const p = ev.payload || {}
  const at = ev.at || ''

  const findBase = (id) => s.bases.find((b) => b.id === id)
  const findEvent = (id) => s.events.find((e) => e.id === id)
  const findDispatch = (id) => s.dispatches.find((d) => d.id === id)
  const findBatch = (id) => s.batches.find((b) => b.id === id)
  const findShelter = (id) => s.shelters.find((x) => x.id === id)
  const findBlock = (id) => s.blocks.find((b) => b.id === id)
  const findOrder = (id) => s.orders.find((o) => o.id === id)

  const logEvent = (eventId, text) => {
    const e = findEvent(eventId)
    if (e) e.timeline.push({ at, text })
  }

  switch (ev.type) {
    case 'sim.init': {
      if (s.events.length || s.dispatches.length) return reject('already-initialized')
      const st = initState({
        simId: p.simId || s.simId, scenarioId: p.scenarioId, name: p.name,
        events: p.events, bases: p.bases, shelters: p.shelters
      })
      if (ev.id) applied.add(ev.id)
      st.appliedIds = [...applied]; st.seq = s.seq; st.conflicts = s.conflicts
      return st
    }

    case 'state.snapshot': {
      // 旧快照迁移：整体替换聚合状态（保留因果簿记与冲突账）
      const snap = p.snapshot || p.state
      if (!snap) return reject('missing-snapshot')
      s.simId = p.simId || s.simId
      s.scenarioId = snap.scenarioId || s.scenarioId
      s.name = snap.name || s.name
      s.settleDay = snap.tr?.settleDay ?? snap.settleDay ?? s.settleDay
      s.events = (snap.cmd?.events || snap.events || []).map((e) => ({ ...e, timeline: [...(e.timeline || [])] }))
      s.bases = (snap.cmd?.bases || snap.bases || []).map((b) => ({ ...b, stock: { ...b.stock } }))
      s.dispatches = (snap.cmd?.dispatches || snap.dispatches || []).map(normalizeDispatch)
      const batches = snap.tr?.batches || snap.batches || []
      s.batches = batches.map((b) => ({ ...b, members: (b.members || []).map((m) => ({ ...m })) }))
      s.shelters = migrateShelters(snap.tr?.shelters || snap.shelters || [], s.settleDay)
      s.blocks = (snap.rb?.blocks || snap.blocks || []).map((b) => ({ ...b, impacts: b.impacts || [], log: b.log || [] }))
      s.orders = (snap.ro?.orders || snap.orders || []).map((o) => ({ ...o, logs: o.logs || [], materials: o.materials || [] }))
      return commit()
    }

    case 'event.statusChanged': {
      const e = findEvent(p.eventId)
      if (!e) return reject('event-not-found')
      e.status = p.status
      e.timeline.push({ at, text: `状态变更：→ ${p.status}` })
      return commit()
    }

    /* ---------------- 物资派发闭环 ---------------- */

    case 'resource.dispatched': {
      const base = findBase(p.baseId)
      const ev2 = findEvent(p.eventId)
      if (!base) return reject('base-not-found')
      const qty = Math.max(0, Math.round(p.qty || 0))
      if (qty <= 0) return reject('qty-invalid')
      if ((base.stock[p.type] || 0) < qty) return reject('insufficient-stock')
      if (p.eventId && !ev2) return reject('event-not-found')
      base.stock[p.type] -= qty
      let lng = p.lng, lat = p.lat, title = p.destName
      if (ev2) { lng = ev2.location.lng; lat = ev2.location.lat; title = ev2.title }
      else if (p.shelterId) { const sh = findShelter(p.shelterId); lng ??= sh?.lng; lat ??= sh?.lat; title ??= p.shelterName || sh?.name }
      const m = roughPath(base.lng, base.lat, lng, lat)
      const d = {
        id: p.dispatchId || ev.id,
        baseId: base.id, baseName: base.name,
        eventId: p.eventId || null, eventTitle: p.eventId ? title : null,
        shelterId: p.shelterId || null, shelterName: p.shelterId ? (p.shelterName || title) : null,
        lng, lat,
        type: p.type, typeLabel: RESOURCE_TYPES[p.type]?.label || p.type,
        qty, unit: RESOURCE_TYPES[p.type]?.unit || '',
        distance: m.distance, minutes: m.minutes, at,
        color: p.color || '#2f9cf5', source: p.source || '手动',
        status: 'enroute', via: [], detourBy: null, holdBy: null,
        signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
        signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: p.replenishOf || null
      }
      s.dispatches.unshift(d)
      if (ev2) {
        ev2.timeline.push({ at, text: `${d.source}派发 ${d.typeLabel} ${qty}${d.unit}👈${base.name}` })
        if (ev2.status === 'assessing' || ev2.status === 'reported') ev2.status = 'dispatching'
      }
      return commit()
    }

    case 'dispatch.signed': {
      const d = findDispatch(p.dispatchId)
      if (!d) return reject('dispatch-not-found')
      if (d.status === 'held' || d.status === 'withdrawn' || d.status === 'done') return reject('illegal-status:' + d.status)
      const qty = Math.max(0, Math.round(p.qty || 0))
      const shortQty = Math.max(0, Math.round(p.shortQty || 0))
      if (qty === 0 && shortQty === 0) return reject('empty-sign')
      const parts = dispatchParts(d)
      if (qty + shortQty > parts.outstanding) return reject('exceeds-outstanding')
      if (qty > 0) {
        d.signedQty = parts.received + qty
        d.signLogs.push({ at, qty, receiver: p.receiver || '现场签收员' })
      }
      if (shortQty > 0) d.shortQty = parts.shortage + shortQty
      if (dispatchParts(d).outstanding === 0) { d.status = 'done'; d.doneReason = d.shortQty > 0 ? 'short' : 'signed' }
      logEvent(d.eventId, `📥 物资签收：${d.typeLabel} ${qty}${d.unit}（累计实收 ${d.signedQty}/${d.qty}${d.unit}）`
        + (shortQty ? `，现场认定短缺 ${shortQty}${d.unit}` : ''))
      return commit()
    }

    case 'dispatch.shortageReplenished': {
      const parent = findDispatch(p.dispatchId)
      if (!parent) return reject('dispatch-not-found')
      if (parent.status === 'withdrawn') return reject('illegal-status:withdrawn')
      const parts0 = dispatchParts(parent)
      let need = Math.min(p.qty ?? parts0.shortPending, parts0.shortPending)
      if (need <= 0) return reject('no-shortage-pending')
      const children = []
      const cands = s.bases
        .filter((b) => (b.stock[parent.type] || 0) > 0)
        .map((b) => ({ b, m: roughPath(b.lng, b.lat, parent.lng, parent.lat) }))
        .sort((a, b) => a.m.minutes - b.m.minutes)
      let idx = 0
      for (const c of cands) {
        if (need <= 0) break
        const take = Math.min(need, c.b.stock[parent.type])
        c.b.stock[parent.type] -= take
        need -= take
        const child = {
          id: p.childIds?.[idx] || `${ev.id}:c${idx}`,
          baseId: c.b.id, baseName: c.b.name,
          eventId: parent.eventId, eventTitle: parent.eventTitle,
          shelterId: parent.shelterId, shelterName: parent.shelterName,
          lng: parent.lng, lat: parent.lat,
          type: parent.type, typeLabel: parent.typeLabel, qty: take, unit: parent.unit,
          distance: c.m.distance, minutes: c.m.minutes, at,
          color: parent.color, source: parent.shelterId ? '补给补派' : '短缺补派',
          status: 'enroute', via: [], detourBy: null, holdBy: null,
          signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
          signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: parent.id
        }
        s.dispatches.unshift(child)
        children.push(child)
        idx++
      }
      const made = children.reduce((n, x) => n + x.qty, 0)
      if (made === 0) return reject('insufficient-stock')
      parent.shortReplenished = parts0.resupplied + made
      logEvent(parent.eventId, `🔁 短缺补派：${parent.typeLabel} ${made}${parent.unit} 已重新出库`)
      return commit()
    }

    case 'dispatch.returned': {
      const d = findDispatch(p.dispatchId)
      if (!d) return reject('dispatch-not-found')
      if (d.status === 'held' || d.status === 'withdrawn' || d.status === 'done') return reject('illegal-status:' + d.status)
      const qty = Math.max(0, Math.round(p.qty || 0))
      const parts = dispatchParts(d)
      if (qty <= 0) return reject('qty-invalid')
      if (qty > parts.outstanding) return reject('exceeds-outstanding')
      const base = findBase(d.baseId)
      if (base) base.stock[d.type] = (base.stock[d.type] || 0) + qty
      d.returnedQty = parts.returned + qty
      d.returnLogs.push({ at, qty, reason: p.reason || '现场退回' })
      if (dispatchParts(d).outstanding === 0) { d.status = 'done'; d.doneReason = 'returned' }
      logEvent(d.eventId, `↩️ 物资退回：${d.typeLabel} ${qty}${d.unit} 退回 ${d.baseName}`)
      return commit()
    }

    case 'dispatch.rerouted': {
      const d = findDispatch(p.dispatchId)
      if (!d || d.status !== 'enroute' || dispatchParts(d).outstanding <= 0) return reject('not-enroute')
      const base = findBase(d.baseId)
      if (!base) return reject('base-not-found')
      const m = pathMetrics([[base.lng, base.lat], ...(p.via || []), [d.lng, d.lat]])
      d.via = p.via || []
      d.distance = m.distance; d.minutes = m.minutes; d.detourBy = p.blockId || null
      return commit()
    }

    case 'dispatch.reassigned': {
      const d = findDispatch(p.dispatchId)
      const nb = findBase(p.newBaseId)
      if (!d || !nb || d.status !== 'enroute' || d.baseId === p.newBaseId) return reject('reassign-invalid')
      const moveQty = dispatchParts(d).outstanding
      if (moveQty <= 0) return reject('no-outstanding')
      if ((nb.stock[d.type] || 0) < moveQty) return reject('insufficient-stock')
      const ob = findBase(d.baseId)
      if (ob) ob.stock[d.type] = (ob.stock[d.type] || 0) + moveQty
      nb.stock[d.type] -= moveQty
      d.baseId = nb.id; d.baseName = nb.name; d.via = []; d.detourBy = null
      const m = roughPath(nb.lng, nb.lat, d.lng, d.lat)
      d.distance = m.distance; d.minutes = m.minutes; d.source = '改派'
      logEvent(d.eventId, `🔀 派发改派：${d.typeLabel} 在途 ${moveQty}${d.unit} 改由 ${nb.name} 出库`)
      return commit()
    }

    case 'dispatch.held': {
      const d = findDispatch(p.dispatchId)
      if (!d || d.status === 'held') return reject('illegal-status')
      const qty = dispatchParts(d).outstanding
      if (qty <= 0) return reject('no-outstanding')
      const base = findBase(d.baseId)
      if (base) base.stock[d.type] = (base.stock[d.type] || 0) + qty
      d.status = 'held'; d.holdBy = p.blockId || null; d.via = []; d.detourBy = null
      logEvent(d.eventId, `⏸ 派发挂起：在途 ${qty}${d.unit} 退回 ${d.baseName}`)
      return commit()
    }

    case 'dispatch.resumed': {
      const d = findDispatch(p.dispatchId)
      if (!d || d.status !== 'held') return reject('not-held')
      const qty = dispatchParts(d).outstanding
      const base = findBase(d.baseId)
      if (qty <= 0) return reject('no-outstanding')
      if (!base || (base.stock[d.type] || 0) < qty) return reject('insufficient-stock')
      base.stock[d.type] -= qty
      d.status = 'enroute'; d.holdBy = null; d.via = []; d.detourBy = null
      const m = roughPath(base.lng, base.lat, d.lng, d.lat)
      d.distance = m.distance; d.minutes = m.minutes
      logEvent(d.eventId, `▶️ 恢复续派：${d.typeLabel} ${qty}${d.unit} 重新出库`)
      return commit()
    }

    case 'dispatch.withdrawn': {
      const d = findDispatch(p.dispatchId)
      if (!d || d.status === 'withdrawn' || d.status === 'done') return reject('illegal-status')
      const parts = dispatchParts(d)
      const left = parts.outstanding
      if (left > 0 && d.status === 'enroute') {
        const base = findBase(d.baseId)
        if (base) base.stock[d.type] = (base.stock[d.type] || 0) + left
      }
      if (left > 0) {
        d.withdrawnQty = parts.withdrawn + left
        d.withdrawLogs.push({ at, qty: left, reason: p.reason || '撤回派发' })
        if (d.replenishOf) {
          const parent = findDispatch(d.replenishOf)
          if (parent) parent.shortReplenished = Math.max(0, (parent.shortReplenished || 0) - left)
        }
      }
      d.status = 'withdrawn'; d.doneReason = 'withdrawn'; d.holdBy = null; d.via = []; d.detourBy = null
      logEvent(d.eventId, `🚫 派发撤回：在途余量 ${left}${d.unit} 退回 ${d.baseName}`)
      return commit()
    }

    /* ---------------- 转移批次与床位 ---------------- */

    case 'batch.created': {
      const ev2 = findEvent(p.eventId); const base = findBase(p.vehicleBaseId); const sh = findShelter(p.shelterId)
      if (!ev2 || !base || !sh) return reject('params-incomplete')
      const headcount = Math.max(1, Math.round(p.headcount || 0))
      const vehicleCount = Math.max(1, Math.round(p.vehicleCount || 0))
      if ((base.stock.vehicle || 0) < vehicleCount) return reject('insufficient-vehicles')
      if (bedLeft(s, p.shelterId) < headcount) return reject('insufficient-beds')
      base.stock.vehicle -= vehicleCount
      const b = {
        id: p.batchId || ev.id, eventId: p.eventId,
        name: p.name || `批次`, headcount,
        vehicleBaseId: base.id, vehicleCount, shelterId: sh.id,
        vehicleReleased: false, status: 'pending', members: [], createdAt: at,
        held: false, holdBy: null, via: [], detourBy: null, eta: syncEta(ev2, sh, [])
      }
      s.batches.unshift(b)
      ev2.timeline.push({ at, text: `🚌 创建转移批次「${b.name}」：计划 ${headcount} 人，${base.name} 出车 ${vehicleCount} 辆 → ${sh.name}` })
      if (ev2.status === 'reported' || ev2.status === 'assessing') ev2.status = 'dispatching'
      return commit()
    }

    case 'batch.registered': {
      const b = findBatch(p.batchId)
      if (!b) return reject('batch-not-found')
      if (b.status === 'closed') return reject('batch-closed')
      if (b.held && p.stage !== 'checkout') return reject('batch-held')
      if (p.count != null) return commitBulkRegister(s, b, p, at, ev.id, applied, reject, commit)
      const person = { name: (p.name || '').trim() || '（未留姓名）', idNo: (p.idNo || '').trim() }
      if (!p.name && !p.idNo) return reject('person-empty')
      const key = (m) => (m.idNo && m.idNo.trim()) ? 'id:' + m.idNo.trim() : 'nm:' + (m.name || '').trim()
      if (p.stage === 'pickup') {
        if (b.members.some((m) => key(m) === key(person))) return reject('duplicate-self')
        const other = s.batches.find((x) => x.id !== b.id && x.status !== 'closed' && x.members.some((m) => key(m) === key(person)))
        if (other) return reject('duplicate-other:' + other.id)
        if (b.members.length >= b.headcount) return reject('headcount-full')
        b.members.push({ id: p.personId || `${ev.id}.m1`, ...person, pickupAt: at, pickupDay: p.day || s.settleDay, checkinAt: null, checkoutAt: null })
        afterRegister(s, b, at)
        return commit()
      }
      const m = b.members.find((x) => key(x) === key(person))
      if (!m) return reject('person-not-in-batch')
      if (p.stage === 'checkin') {
        if (m.checkinAt) return reject('duplicate-self')
        const r = checkin(s, b, [m], at, p.day || s.settleDay)
        if (r !== true) return reject(r)
        return commit()
      }
      if (p.stage !== 'checkout') return reject('stage-invalid')
      if (m.checkoutAt) return reject('duplicate-self')
      if (!m.checkinAt) return reject('not-checked-in')
      m.checkoutAt = at; m.checkoutDay = p.day || s.settleDay
      afterRegister(s, b, at)
      return commit()
    }

    case 'batch.personMoved': {
      let person = null, from = null
      for (const b of s.batches) {
        const m = b.members.find((x) => x.id === p.personId)
        if (m) { person = m; from = b; break }
      }
      const to = findBatch(p.toBatchId)
      if (!person || !from) return reject('person-not-found')
      if (!to || to.status === 'closed') return reject('target-invalid')
      if (from.id === to.id) return reject('same-batch')
      if (to.members.length >= to.headcount) return reject('target-full')
      if (person.checkinAt && !person.checkoutAt && from.shelterId !== to.shelterId && bedLeft(s, to.shelterId) < 1) {
        return reject('insufficient-beds')
      }
      from.members = from.members.filter((x) => x.id !== person.id)
      to.members.push(person)
      touchPeak(s, to.shelterId)
      logEvent(from.eventId, `🔀「${person.name}」由批次「${from.name}」改派至「${to.name}」`)
      return commit()
    }

    case 'batch.split': {
      const src = findBatch(p.batchId)
      if (!src) return reject('batch-not-found')
      if (src.status === 'closed') return reject('batch-closed')
      const ids = [...new Set(p.personIds || [])]
      if (!ids.length) return reject('no-members')
      const move = []
      for (const pid of ids) {
        const m = src.members.find((x) => x.id === pid)
        if (!m) return reject('member-not-in-batch')
        if (m.checkoutAt) return reject('member-checked-out')
        move.push(m)
      }
      const headcount = Math.max(1, Math.round(p.headcount || move.length))
      const vehicleCount = Math.max(1, Math.round(p.vehicleCount || 1))
      if (headcount < move.length) return reject('headcount-too-small')
      const stay = src.members.filter((x) => !ids.includes(x.id))
      if (src.headcount - headcount < stay.length) return reject('source-headcount-overflow')
      const base = findBase(p.vehicleBaseId); const sh = findShelter(p.shelterId)
      if (!base) return reject('base-not-found')
      if ((base.stock.vehicle || 0) < vehicleCount) return reject('insufficient-vehicles')
      if (!sh) return reject('shelter-not-found')
      const inHouse = move.filter((x) => x.checkinAt && !x.checkoutAt)
      if (inHouse.length && p.shelterId !== src.shelterId) return reject('inhouse-must-stay')
      if (p.shelterId !== src.shelterId && bedLeft(s, p.shelterId) < headcount) return reject('insufficient-beds')
      base.stock.vehicle -= vehicleCount
      const moveSet = new Set(ids)
      src.members = src.members.filter((x) => !moveSet.has(x.id))
      src.headcount -= headcount
      const ev2 = findEvent(src.eventId)
      const nb = {
        id: p.newBatchId || ev.id, eventId: src.eventId,
        name: p.name || `${src.name}-拆`, headcount,
        vehicleBaseId: base.id, vehicleCount, shelterId: sh.id,
        vehicleReleased: false, status: 'pending', members: move, createdAt: at, splitFrom: src.id,
        held: false, holdBy: null, via: [], detourBy: null, eta: ev2 ? syncEta(ev2, sh, []) : null
      }
      s.batches.unshift(nb)
      recomputeStatus(s, src, at)
      recomputeStatus(s, nb, at)
      logEvent(src.eventId, `✂️ 批次「${src.name}」拆分出「${nb.name}」：${move.length} 人`)
      return commit()
    }

    case 'batch.held': {
      const b = findBatch(p.batchId)
      if (!b || b.status === 'closed' || b.held) return reject('illegal-status')
      b.held = true; b.holdBy = p.blockId || null; b.via = []; b.detourBy = null
      logEvent(b.eventId, `⏸ 批次「${b.name}」挂起（车辆/床位预占保留）`)
      return commit()
    }
    case 'batch.resumed': {
      const b = findBatch(p.batchId)
      if (!b || !b.held) return reject('not-held')
      b.held = false; b.holdBy = null; b.via = []; b.detourBy = null
      const ev2 = findEvent(b.eventId); const sh = findShelter(b.shelterId)
      if (ev2 && sh) b.eta = syncEta(ev2, sh, [])
      return commit()
    }
    case 'batch.rerouted': {
      const b = findBatch(p.batchId)
      if (!b || b.status === 'closed') return reject('batch-closed')
      b.via = p.via || []; b.detourBy = p.blockId || null
      const ev2 = findEvent(b.eventId); const sh = findShelter(b.shelterId)
      if (ev2 && sh) b.eta = syncEta(ev2, sh, b.via)
      return commit()
    }
    case 'batch.closed': {
      const b = findBatch(p.batchId)
      if (!b || b.status === 'closed') return reject('illegal-status')
      const inHouse = b.members.filter((m) => m.checkinAt && !m.checkoutAt).length
      if (inHouse > 0) return reject('still-inhouse')
      closeBatch(s, b, at)
      return commit()
    }
    case 'batch.cancelled': {
      const b = findBatch(p.batchId)
      if (!b) return reject('batch-not-found')
      if (b.members.length > 0) return reject('has-registrations')
      releaseVehicles(s, b)
      s.batches = s.batches.filter((x) => x.id !== b.id)
      logEvent(b.eventId, `🗑 批次「${b.name}」已取消，车辆已释放`)
      return commit()
    }
    case 'batch.reassigned': {
      const b = findBatch(p.batchId)
      if (!b || b.status === 'closed') return reject('illegal-status')
      if (p.shelterId && p.shelterId !== b.shelterId) {
        if (b.members.some((m) => m.checkinAt)) return reject('has-checkin')
        if (bedLeft(s, p.shelterId) < b.headcount) return reject('insufficient-beds')
        b.shelterId = p.shelterId; b.via = []; b.detourBy = null
        const ev2 = findEvent(b.eventId); const sh = findShelter(b.shelterId)
        if (ev2 && sh) b.eta = syncEta(ev2, sh, [])
      }
      if (p.vehicleBaseId && p.vehicleCount != null) {
        const n = Math.max(1, Math.round(p.vehicleCount))
        const nb2 = findBase(p.vehicleBaseId)
        if (!nb2) return reject('base-not-found')
        const avail = (nb2.stock.vehicle || 0) + (nb2.id === b.vehicleBaseId && !b.vehicleReleased ? b.vehicleCount : 0)
        if (avail < n) return reject('insufficient-vehicles')
        const ob = findBase(b.vehicleBaseId)
        if (ob && !b.vehicleReleased) ob.stock.vehicle += b.vehicleCount
        nb2.stock.vehicle -= n
        b.vehicleBaseId = nb2.id; b.vehicleCount = n; b.vehicleReleased = false
      }
      return commit()
    }

    /* ---------------- 安置点日结补给 ---------------- */

    case 'shelter.settled': {
      const day = p.day || s.settleDay
      s.shelters.forEach((sh) => {
        const members = s.batches.filter((b) => b.shelterId === sh.id).flatMap((b) => b.members)
        let personDays = 0
        members.forEach((m) => { personDays += memberDayFrac(m, day) })
        personDays = round2(personDays)
        const consumed = {}
        Object.entries(SUPPLY_PER_CAPITA).forEach(([t, coef]) => {
          if (SUPPLY_DURABLES.includes(t)) return
          const c = round2(personDays * coef)
          if (c > 0) { consumed[t] = c; sh.consumed[t] = round2((sh.consumed[t] || 0) + c) }
        })
        const inHouse = members.filter((m) => memberInHouseEndOf(m, day)).length
        sh.peakInHouse = Math.max(sh.peakInHouse || 0, inHouse)
        sh.settlements.push({ day, personDays, inHouse, consumed })
      })
      s.settleDay = day + 1
      return commit()
    }

    /* ---------------- 道路阻断 ---------------- */

    case 'block.reported': {
      if (!p.polygon || p.polygon.length < 3) return reject('polygon-invalid')
      const blk = {
        id: p.blockId || ev.id,
        name: p.name || `道路阻断-${s.blocks.length + 1}`,
        reason: p.reason || '道路中断', reporter: p.reporter || '现场巡查员',
        polygon: p.polygon, status: 'active', reportedAt: at, clearedAt: null,
        impacts: p.impacts || [], confirmed: false, log: [{ at, text: `🚳 上报道路封闭范围（${p.polygon.length} 个顶点）` }]
      }
      s.blocks.unshift(blk)
      return commit()
    }
    case 'block.impactConfirmed': {
      const blk = findBlock(p.blockId)
      if (!blk) return reject('block-not-found')
      blk.confirmed = true
      if (Array.isArray(p.impacts)) blk.impacts = p.impacts
      blk.log.push({ at, text: `✔️ 指挥员确认影响并生成方案` })
      return commit()
    }
    case 'block.impactApplied': {
      const blk = findBlock(p.blockId)
      if (!blk) return reject('block-not-found')
      const imp = blk.impacts.find((x) => x.key === p.key)
      if (imp) { imp.done = true; imp.result = { action: p.action, msg: p.msg || '' } }
      blk.log.push({ at, text: `✅ 执行处置：${p.action} ${p.key || ''}` })
      return commit()
    }
    case 'block.cleared': {
      const blk = findBlock(p.blockId)
      if (!blk || blk.status !== 'active') return reject('block-not-active')
      blk.status = 'cleared'; blk.clearedAt = at
      blk.log.push({ at, text: '✅ 道路恢复通行' })
      return commit()
    }
    case 'block.removed': {
      const blk = findBlock(p.blockId)
      if (!blk || blk.status !== 'cleared') return reject('block-not-cleared')
      s.blocks = s.blocks.filter((x) => x.id !== blk.id)
      return commit()
    }

    /* ---------------- 抢修工单 ---------------- */

    case 'repair.created': {
      const blk = findBlock(p.blockId); const base = findBase(p.baseId)
      if (!blk) return reject('block-not-found')
      if (blk.status !== 'active') return reject('block-not-active')
      if (s.orders.some((o) => o.blockId === blk.id && ['dispatched', 'accepted', 'done'].includes(o.status))) {
        return reject('order-exists')
      }
      if (!base) return reject('base-not-found')
      const personnel = Math.max(0, Math.round(p.personnel || 0))
      const vehicles = Math.max(0, Math.round(p.vehicles || 0))
      const mats = (p.materials || []).filter((m) => m.qty > 0)
      if (personnel <= 0 && vehicles <= 0 && !mats.length) return reject('empty-order')
      if ((base.stock.personnel || 0) < personnel) return reject('insufficient-stock')
      if ((base.stock.vehicle || 0) < vehicles) return reject('insufficient-stock')
      for (const m of mats) if ((base.stock[m.type] || 0) < m.qty) return reject('insufficient-stock')
      base.stock.personnel -= personnel
      base.stock.vehicle -= vehicles
      mats.forEach((m) => { base.stock[m.type] -= m.qty })
      const order = {
        id: p.orderId || ev.id, blockId: blk.id, blockName: blk.name,
        baseId: base.id, baseName: base.name, personnel, vehicles,
        materials: mats.map((m) => ({ type: m.type, typeLabel: RESOURCE_TYPES[m.type]?.label || m.type, unit: RESOURCE_TYPES[m.type]?.unit || '', qty: m.qty, used: 0 })),
        personnelUsed: 0, vehiclesUsed: 0,
        status: 'dispatched', progress: 0, delayed: false, delayCount: 0,
        deadline: p.deadline || '', createdAt: at,
        acceptedAt: null, doneAt: null, closedAt: null,
        logs: [{ at, text: '📋 指挥员派单' }], settled: false, settlement: null
      }
      s.orders.unshift(order)
      blk.log.push({ at, text: `🔧 发起抢修工单，现场待接单` })
      return commit()
    }
    case 'repair.accepted': {
      const o = findOrder(p.orderId)
      if (!o || o.status !== 'dispatched') return reject('illegal-status')
      o.status = 'accepted'; o.acceptedAt = at
      o.logs.push({ at, text: '🙋 现场队伍已接单' })
      return commit()
    }
    case 'repair.progress': {
      const o = findOrder(p.orderId)
      if (!o || o.status !== 'accepted') return reject('illegal-status')
      const prog = Math.max(0, Math.min(100, Math.round(p.progress || 0)))
      if (prog < o.progress) return reject('progress-regression')
      o.progress = prog
      o.logs.push({ at, text: `📍 进度 ${prog}%` })
      return commit()
    }
    case 'repair.finished': {
      const o = findOrder(p.orderId)
      if (!o || o.status !== 'accepted') return reject('illegal-status')
      applyUsed(o, p.used || {})
      o.progress = 100; o.status = 'done'; o.doneAt = at
      o.logs.push({ at, text: '🏁 完工上报，待验收' })
      return commit()
    }
    case 'repair.delayed': {
      const o = findOrder(p.orderId)
      if (!o || o.status !== 'accepted') return reject('illegal-status')
      o.delayed = true; o.delayCount += 1
      if (p.deadline) o.deadline = p.deadline
      o.logs.push({ at, text: `⏰ 延期（第 ${o.delayCount} 次）` })
      return commit()
    }
    case 'repair.failed': {
      const o = findOrder(p.orderId)
      if (!o || !['dispatched', 'accepted', 'done'].includes(o.status)) return reject('illegal-status')
      if (o.status === 'dispatched') return reject('not-accepted')
      if (p.used) applyUsed(o, p.used)
      settleOrder(s, o)
      o.status = 'failed'; o.closedAt = at
      o.logs.push({ at, text: '❌ 失败/验收不通过，阻断保留，剩余资源归还' })
      return commit()
    }
    case 'repair.cancelled': {
      const o = findOrder(p.orderId)
      if (!o || !['dispatched', 'accepted'].includes(o.status)) return reject('illegal-status')
      if (p.used) applyUsed(o, p.used)
      settleOrder(s, o)
      o.status = 'cancelled'; o.closedAt = at
      o.logs.push({ at, text: '🚫 撤单，阻断保留，剩余资源归还' })
      return commit()
    }
    case 'repair.acceptedWork': {
      const o = findOrder(p.orderId)
      if (!o || o.status !== 'done') return reject('illegal-status')
      settleOrder(s, o)
      o.status = 'cleared'; o.closedAt = at
      o.logs.push({ at, text: '✅ 验收通过，解除封闭' })
      const blk = findBlock(o.blockId)
      if (blk?.status === 'active') {
        blk.status = 'cleared'; blk.clearedAt = at
        blk.log.push({ at, text: '✅ 抢修验收通过，道路恢复通行' })
      }
      return commit()
    }

    default:
      return reject('unknown-event-type:' + ev.type)
  }
}

/* ---------------- 派生：床位 / 批次状态 / 路线 ---------------- */

export function bedMap(s) {
  const m = {}
  s.shelters.forEach((x) => { m[x.id] = { inHouse: 0, reserved: 0, left: x.capacity } })
  s.batches.forEach((b) => {
    if (!b.shelterId || !m[b.shelterId]) return
    const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
    const out = b.members.filter((x) => x.checkoutAt).length
    m[b.shelterId].inHouse += inHouse
    if (b.status !== 'closed') m[b.shelterId].reserved += Math.max(0, b.headcount - inHouse - out)
  })
  Object.values(m).forEach((v) => { v.left = Math.max(0, v.capacity - v.inHouse - v.reserved) })
  return m
}
export function bedLeft(s, shelterId) { return bedMap(s)[shelterId]?.left ?? 0 }

function touchPeak(s, shelterId) {
  const sh = s.shelters.find((x) => x.id === shelterId)
  if (!sh) return
  const inHouse = s.batches
    .filter((b) => b.shelterId === shelterId)
    .reduce((n, b) => n + b.members.filter((m) => m.checkinAt && !m.checkoutAt).length, 0)
  sh.peakInHouse = Math.max(sh.peakInHouse || 0, inHouse)
}

function syncEta(ev, sh, via) {
  return pathMetrics([[ev.location.lng, ev.location.lat], ...via, [sh.lng, sh.lat]])
}

function releaseVehicles(s, b) {
  if (b.vehicleReleased) return
  const base = s.bases.find((x) => x.id === b.vehicleBaseId)
  if (base) base.stock.vehicle += b.vehicleCount
  b.vehicleReleased = true
}

function closeBatch(s, b, at) {
  b.status = 'closed'
  releaseVehicles(s, b)
  const e = s.events.find((x) => x.id === b.eventId)
  if (e) e.timeline.push({ at, text: `✅ 批次「${b.name}」办结：累计转移 ${b.members.length} 人，车辆已回收` })
}

function recomputeStatus(s, b, at) {
  const picked = b.members.filter((x) => x.pickupAt).length
  const checkedIn = b.members.filter((x) => x.checkinAt).length
  if (picked === 0) b.status = 'pending'
  else if (checkedIn < picked || picked < b.headcount) b.status = 'transporting'
  else b.status = 'settled'
  if (b.status === 'settled' && b.members.length > 0 && b.members.every((x) => x.checkoutAt)) closeBatch(s, b, at)
}

function afterRegister(s, b, at) {
  recomputeStatus(s, b, at)
  const e = s.events.find((x) => x.id === b.eventId)
  const picked = b.members.filter((x) => x.pickupAt).length
  if (e) e.timeline.push({ at, text: `登记更新（批次「${b.name}」${picked}/${b.headcount}）` })
}

function checkin(s, b, members, at, day) {
  const bed = bedMap(s)[b.shelterId]
  const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
  const out = b.members.filter((x) => x.checkoutAt).length
  const ownReserved = b.status === 'closed' ? 0 : Math.max(0, b.headcount - inHouse - out)
  if (bed.left + ownReserved < members.length) return 'insufficient-beds'
  members.forEach((m) => { m.checkinAt = at; m.checkinDay = day })
  touchPeak(s, b.shelterId)
  afterRegister(s, b, at)
  return true
}

function commitBulkRegister(s, b, p, at, eventId, applied, reject, commit) {
  const count = Math.max(1, Math.round(p.count || 0))
  if (p.stage === 'pickup') {
    const room = b.headcount - b.members.length
    const n = Math.min(count, room)
    if (n <= 0) return reject('headcount-full')
    for (let i = 0; i < n; i++) {
      b.members.push({
        id: `${eventId}.bulk${b.members.length + i}`,
        name: `群众${b.members.length + i + 1}号`, idNo: '', anon: true,
        pickupAt: at, pickupDay: p.day || s.settleDay, checkinAt: null, checkoutAt: null
      })
    }
    afterRegister(s, b, at)
    return commit()
  }
  const pool = p.stage === 'checkin'
    ? b.members.filter((x) => x.pickupAt && !x.checkinAt)
    : b.members.filter((x) => x.checkinAt && !x.checkoutAt)
  const targets = pool.slice(0, count)
  if (!targets.length) return reject('no-targets')
  if (p.stage === 'checkin') {
    const r = checkin(s, b, targets, at, p.day || s.settleDay)
    if (r !== true) return reject(r)
  } else {
    targets.forEach((m) => { m.checkoutAt = at; m.checkoutDay = p.day || s.settleDay })
    afterRegister(s, b, at)
  }
  return commit()
}

/* ---------------- 人日 / 补给（与前端同口径） ---------------- */

export function timeToHours(str) {
  if (!str) return 0
  const m = String(str).match(/(上午|下午|中午|晚上)?\s*(\d{1,2}):(\d{2})/)
  if (!m) return 0
  let h = +m[2]
  if ((m[1] === '下午' || m[1] === '晚上' || m[1] === '中午') && h < 12) h += 12
  if (m[1] === '上午' && h === 12) h = 0
  return Math.min(24, h + (+m[3]) / 60)
}

export function memberDayFrac(m, day) {
  if (!m.checkinAt) return 0
  const ciDay = m.checkinDay ?? 1
  if (ciDay > day) return 0
  const coDay = m.checkoutAt ? (m.checkoutDay ?? ciDay) : null
  if (coDay != null && coDay < day) return 0
  const start = ciDay === day ? timeToHours(m.checkinAt) : 0
  const end = coDay === day ? timeToHours(m.checkoutAt) : 24
  return Math.min(24, Math.max(0, end - start)) / 24
}

function memberInHouseEndOf(m, day) {
  if (!m.checkinAt) return false
  const ciDay = m.checkinDay ?? 1
  if (ciDay > day) return false
  const coDay = m.checkoutAt ? (m.checkoutDay ?? ciDay) : null
  return coDay == null || coDay > day
}

/* ---------------- 抢修消耗与结算 ---------------- */

function applyUsed(o, used) {
  if (used.personnel != null) o.personnelUsed = Math.max(0, Math.min(o.personnel, Math.round(used.personnel)))
  if (used.vehicles != null) o.vehiclesUsed = Math.max(0, Math.min(o.vehicles, Math.round(used.vehicles)))
  const mu = used.materials || {}
  o.materials.forEach((m) => {
    if (mu[m.type] != null) m.used = Math.max(0, Math.min(m.qty, Math.round(mu[m.type])))
  })
}

function settleOrder(s, o) {
  if (o.settled) return o.settlement
  const base = s.bases.find((b) => b.id === o.baseId)
  const returned = { personnel: 0, vehicle: 0, materials: {} }
  const add = (type, n) => {
    if (n <= 0) return
    if (base) base.stock[type === 'vehicle' ? 'vehicle' : type] = (base.stock[type === 'vehicle' ? 'vehicle' : type] || 0) + n
  }
  if (o.personnel - o.personnelUsed > 0) { returned.personnel = o.personnel - o.personnelUsed; add('personnel', returned.personnel) }
  if (o.vehicles - o.vehiclesUsed > 0) { returned.vehicle = o.vehicles - o.vehiclesUsed; add('vehicle', returned.vehicle) }
  o.materials.forEach((m) => {
    const n = m.qty - m.used
    if (n > 0) { returned.materials[m.type] = n; add(m.type, n) }
  })
  o.settled = true
  o.settlement = returned
  return returned
}

/* ---------------- 旧快照迁移辅助 ---------------- */

function normalizeDispatch(d) {
  return {
    via: [], detourBy: null, holdBy: null,
    signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
    signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: null,
    ...d
  }
}

function migrateShelters(list, settleDay) {
  return (list || []).map((x) => ({
    consumed: {}, settlements: [], peakInHouse: 0,
    ...x,
    // 旧快照可能缺少补给账目字段
    consumed: x.consumed || {},
    settlements: x.settlements || [],
    peakInHouse: x.peakInHouse || 0
  }))
}

// 折叠整段事件序列（回放/检查点恢复）；fromState 可从检查点续算
export function foldAll(state, events) {
  let s = state
  for (const ev of events) s = fold(s, ev)
  return s
}
