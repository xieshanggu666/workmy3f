import { defineStore } from 'pinia'
import {
  SCENARIOS, RESOURCE_BASES, EVENT_TYPES, RESOURCE_TYPES, SEVERITY, EVENT_STATUS
} from '@/mock/data'
import { pathKm } from '@/utils/geo'
import { useRoadblockStore } from '@/store/roadblock'

// 新建派发后联动：让道路阻断模块即时复核（该 store 尚未注册时静默跳过）
function notifyDispatchChanged() {
  try {
    useRoadblockStore().assessActive()
  } catch { /* 道路阻断模块未初始化 */ }
}

// 灾情等级权重（统筹分配优先级：等级高者优先锁定库存）
const SEV_WEIGHT = { red: 4, orange: 3, yellow: 2, blue: 1 }

// 折线路径估算里程与时长（直线 x 路网系数，演示用）
export function pathMetrics(points) {
  const roadDist = Math.round(pathKm(points) * 1.25 * 10) / 10 // 路网折算
  const minutes = Math.round((roadDist / 55) * 60 + 8) // 55km/h 平均 + 装卸
  return { distance: roadDist, minutes }
}

// 派发记录的数量分账（兼容无闭环字段的旧记录：默认全部为在途）
//   received 实收 / shortage 认定短缺 / returned 退回入库 / withdrawn 撤回回库
//   outstanding 尚未闭环量 = qty - 四者（enroute 时即在途量，held 时为挂起待续派量）
//   撤回只把在途余量并入 withdrawn，已发生的实收/短缺/退回账目原样保留
export function dispatchParts(d) {
  const received = d.signedQty || 0
  const shortage = d.shortQty || 0
  const returned = d.returnedQty || 0
  const withdrawn = d.withdrawnQty || 0
  const outstanding = Math.max(0, (d.qty || 0) - received - shortage - returned - withdrawn)
  const inTransit = d.status === 'enroute' ? outstanding : 0
  const heldQty = d.status === 'held' ? outstanding : 0
  const resupplied = d.shortReplenished || 0
  return {
    received, shortage, returned, withdrawn, outstanding, inTransit, heldQty, resupplied,
    shortPending: Math.max(0, shortage - resupplied)
  }
}

// 两点直达估算（pathMetrics 的便捷封装）
export function roughPath(lng1, lat1, lng2, lat2) {
  return pathMetrics([[lng1, lat1], [lng2, lat2]])
}

let dpSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

export const useCommandStore = defineStore('command', {
  state: () => ({
    scenarioId: SCENARIOS[0].id,
    events: [],
    bases: [],
    // 派发记录与在途状态
    dispatches: [],
    // 多灾点统筹：未提交的跨基地分配方案 / 最近一次批量派发结果
    plan: [],
    planResult: null,
    // 大屏统计
    selectedEventId: null,
    filter: { type: 'all', severity: 'all', status: 'all' },
    search: '',
    autoPlay: false,
    replayTimer: null
  }),

  getters: {
    scenario(state) {
      return SCENARIOS.find((s) => s.id === state.scenarioId)
    },
    filteredEvents(state) {
      let list = [...state.events]
      if (state.filter.type !== 'all') list = list.filter((e) => e.type === state.filter.type)
      if (state.filter.severity !== 'all') list = list.filter((e) => e.severity === state.filter.severity)
      if (state.filter.status !== 'all') list = list.filter((e) => e.status === state.filter.status)
      if (state.search) list = list.filter((e) => e.title.includes(state.search) || (e.location && e.location.name.includes(state.search)))
      return list
    },
    // 各事件在途保障量：eventId -> { type: qty }（实收 + 在途；挂起未出库/短缺/退回均不计）
    sentMap(state) {
      const m = {}
      state.dispatches.forEach((d) => {
        if (!d.eventId) return
        const p = dispatchParts(d)
        const cover = p.received + p.inTransit
        if (cover > 0) {
          m[d.eventId] = m[d.eventId] || {}
          m[d.eventId][d.type] = (m[d.eventId][d.type] || 0) + cover
        }
      })
      return m
    },
    // 各事件实际签收量：eventId -> { type: qty }（闭环核算的实收口径）
    receivedMap(state) {
      const m = {}
      state.dispatches.forEach((d) => {
        if (!d.eventId) return
        const received = d.signedQty || 0
        if (received > 0) {
          m[d.eventId] = m[d.eventId] || {}
          m[d.eventId][d.type] = (m[d.eventId][d.type] || 0) + received
        }
      })
      return m
    },
    // 各事件已认定但尚未补派的短缺量：eventId -> { type: qty }
    shortageMap(state) {
      const m = {}
      state.dispatches.forEach((d) => {
        if (!d.eventId) return
        const p = dispatchParts(d)
        if (p.shortPending > 0) {
          m[d.eventId] = m[d.eventId] || {}
          m[d.eventId][d.type] = (m[d.eventId][d.type] || 0) + p.shortPending
        }
      })
      return m
    },
    // 各事件需求缺口：需求 - 在途 - 方案预占
    gaps(state) {
      const planned = {}
      state.plan.forEach((p) => {
        planned[p.eventId] = planned[p.eventId] || {}
        planned[p.eventId][p.type] = (planned[p.eventId][p.type] || 0) + p.qty
      })
      return state.events.map((ev) => {
        const gap = {}
        Object.entries(ev.demand || {}).forEach(([t, need]) => {
          const g = need - (this.sentMap[ev.id]?.[t] || 0) - (planned[ev.id]?.[t] || 0)
          if (g > 0) gap[t] = g
        })
        return { eventId: ev.id, gap }
      })
    },
    // 方案冲突检测：按 基地+类型 汇总预占，超出当前库存即冲突（提交时将触发重分配）
    planConflicts(state) {
      const use = {}
      state.plan.forEach((p) => {
        const k = p.baseId + '|' + p.type
        use[k] = (use[k] || 0) + p.qty
      })
      const conflicts = {}
      Object.entries(use).forEach(([k, qty]) => {
        const [baseId, type] = k.split('|')
        const base = state.bases.find((b) => b.id === baseId)
        const stock = base ? base.stock[type] || 0 : 0
        if (qty > stock) conflicts[k] = { planned: qty, stock }
      })
      return conflicts
    },
    // 大屏统计卡片
    stats(state) {
      const counts = { listed: state.events.length }
      SEVERITY.forEach((s) => {
        counts[s.value] = state.events.filter((e) => e.severity === s.value).length
      })
      counts.dispatching = state.events.filter((e) => e.status === 'dispatching').length
      counts.closed = state.events.filter((e) => e.status === 'closed').length
      counts.dispatchedToday = state.dispatches.length
      counts.signedToday = state.dispatches.reduce((n, d) => n + ((d.signLogs || []).length > 0 ? 1 : 0), 0)
      counts.shortagePending = state.dispatches.reduce((n, d) => n + (dispatchParts(d).shortPending > 0 ? 1 : 0), 0)
      const totalAffected = state.events.reduce((sum, e) => sum + (e.affected || 0), 0)
      return { ...counts, totalAffected }
    },
    typeLabels() {
      return EVENT_TYPES
    }
  },

  actions: {
    loadScenario(id) {
      this.scenarioId = id
      const s = this.scenario
      this.events = s.events.map((e) => ({
        ...e,
        timeline: [
          { at: e.reportedAt, text: `事件上报：${e.title}` }
        ]
      }))
      this.bases = RESOURCE_BASES.map((b) => ({ ...b, stock: { ...b.stock } }))
      this.dispatches = []
      this.plan = []
      this.planResult = null
      this.selectedEventId = this.events[0] ? this.events[0].id : null
    },
    selectEvent(id) {
      this.selectedEventId = id
    },
    // 状态流转到下一步
    advanceStatus(eventId, toStatus) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      const from = EVENT_STATUS.find((s) => s.value === ev.status)
      const to = EVENT_STATUS.find((s) => s.value === toStatus)
      ev.status = toStatus
      ev.timeline.push({ at: nowStr(), text: `状态变更：${from.label} → ${to.label}` })
    },
    // 内部：扣库存 + 生成派发记录 + 联动事件状态/时间线（库存需已校验）
    _pushDispatch(baseId, eventId, type, qty, source = '手动') {
      const base = this.bases.find((b) => b.id === baseId)
      const ev = this.events.find((e) => e.id === eventId)
      if (!base || !ev || qty <= 0) return null
      base.stock[type] = (base.stock[type] || 0) - qty
      const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
      const record = {
        id: 'dp-' + Date.now() + '-' + ++dpSeq,
        baseId, baseName: base.name, eventId, eventTitle: ev.title,
        lng: ev.location.lng, lat: ev.location.lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowStr(),
        color: EVENT_TYPES[ev.type].color, source,
        // 道路阻断处置：在途/挂起状态、绕行途经点、来源阻断
        status: 'enroute', via: [], detourBy: null, holdBy: null,
        // 派发闭环：分批签收 / 短缺补派 / 退回入库（在途 = qty - 实收 - 短缺 - 退回 - 撤回）
        signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
        signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: null
      }
      this.dispatches.unshift(record)
      ev.timeline.push({ at: record.at, text: `${source}派发 ${record.typeLabel} ${qty}${record.unit}👈${base.name}` })
      if (ev.status === 'assessing' || ev.status === 'reported') ev.status = 'dispatching'
      notifyDispatchChanged()
      return record
    },
    // 从资源库派发资源到受灾点
    dispatchResource({ baseId, eventId, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base) return null
      qty = Math.max(0, Math.min(qty, base.stock[type] || 0))
      if (qty === 0) return null
      return this._pushDispatch(baseId, eventId, type, qty, '手动')
    },
    // 向安置点补给物资（联动转移安置模块，不计入事件需求缺口）
    dispatchToShelter({ baseId, shelterId, shelterName, lng, lat, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base || qty <= 0) return null
      qty = Math.min(qty, base.stock[type] || 0)
      if (qty === 0) return null
      base.stock[type] = (base.stock[type] || 0) - qty
      const path = roughPath(base.lng, base.lat, lng, lat)
      const record = {
        id: 'dp-' + Date.now() + '-' + ++dpSeq,
        baseId, baseName: base.name, shelterId, shelterName,
        lng, lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowStr(),
        color: '#26a69a', source: '安置补给',
        status: 'enroute', via: [], detourBy: null, holdBy: null,
        // 派发闭环字段（同事件派发）
        signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
        signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: null
      }
      this.dispatches.unshift(record)
      notifyDispatchChanged()
      return record
    },

    /* ---------- 派发闭环：分批签收 / 短缺认定补派 / 退回入库 ---------- */

    _destName(d) { return d.eventTitle || d.shelterName || '目的地' },
    _logDest(d, text) {
      const ev = this.events.find((e) => e.id === d.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
    },

    // 现场签收：支持分批；可同批认定短缺（在途剩余按 qty-实收-短缺 留账）
    // 幂等防护：已办结（在途+挂起余量为 0）记录、挂起中记录一律拒绝
    signDispatch(recordId, { qty, shortQty = 0, receiver = '' } = {}) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return { ok: false, msg: '派发记录不存在' }
      if (rec.status === 'held') return { ok: false, msg: '派发挂起中，待恢复通行续派后再签收' }
      if (rec.status === 'withdrawn') return { ok: false, msg: '该派发已撤回，剩余在途已回库，不能再签收' }
      if (rec.status === 'done') return { ok: false, msg: '该派发已办结，不能重复签收' }
      qty = Math.max(0, Math.round(qty || 0))
      shortQty = Math.max(0, Math.round(shortQty || 0))
      if (qty === 0 && shortQty === 0) return { ok: false, msg: '请填写本次签收或短缺数量' }
      const parts = dispatchParts(rec)
      if (qty + shortQty > parts.outstanding) {
        return { ok: false, msg: `本次签认数量超出在途余量 ${parts.outstanding}${rec.unit}，不能重复签收` }
      }
      const at = nowStr()
      if (qty > 0) {
        rec.signedQty = parts.received + qty
        if (!Array.isArray(rec.signLogs)) rec.signLogs = [] // 兼容无闭环字段的旧记录
        rec.signLogs.push({ at, qty, receiver: (receiver || '').trim() || '现场签收员' })
      }
      if (shortQty > 0) rec.shortQty = parts.shortage + shortQty
      const left = dispatchParts(rec).outstanding
      if (left === 0) {
        rec.status = 'done'
        rec.doneReason = rec.shortQty > 0 ? 'short' : 'signed'
      }
      this._logDest(rec, `📥 物资签收：${rec.typeLabel} ${qty}${rec.unit}（累计实收 ${rec.signedQty}/${rec.qty}${rec.unit}）`
        + (shortQty ? `，现场认定短缺 ${shortQty}${rec.unit}` : ''))
      // 道路阻断联动：全部签收后该任务自动退出影响评估，部分签收则刷新在途余量
      notifyDispatchChanged()
      return { ok: true, record: rec, received: rec.signedQty, shortage: rec.shortQty, outstanding: left }
    },

    // 短缺补派：按已认定尚未补派的短缺量就近重新出库（可跨基地拆单）
    // 防重复补派：仅按 短缺量 - 已补派量 补发
    replenishShortage(recordId, opts = {}) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return { ok: false, msg: '派发记录不存在' }
      if (rec.status === 'withdrawn') return { ok: false, msg: '该派发已撤回，剩余在途已回库，不能再补派' }
      const parts = dispatchParts(rec)
      let need = parts.shortPending
      if (opts.qty != null) need = Math.min(need, Math.max(0, Math.round(opts.qty)))
      if (need <= 0) return { ok: false, msg: '该派发无待补派的短缺量（短缺可能已补派）' }
      const source = rec.shelterId ? '补给补派' : '短缺补派'
      const sent = []
      // 候选基地按运输时长升序，库存不足时跨基地拆单
      const cands = this.bases
        .filter((b) => (b.stock[rec.type] || 0) > 0)
        .map((b) => ({ b, path: roughPath(b.lng, b.lat, rec.lng, rec.lat) }))
        .sort((x, y) => x.path.minutes - y.path.minutes)
      for (const c of cands) {
        if (need <= 0) break
        const take = Math.min(need, c.b.stock[rec.type])
        c.b.stock[rec.type] -= take
        need -= take
        const child = {
          id: 'dp-' + Date.now() + '-' + ++dpSeq,
          baseId: c.b.id, baseName: c.b.name,
          eventId: rec.eventId || null, eventTitle: rec.eventTitle || null,
          shelterId: rec.shelterId || null, shelterName: rec.shelterName || null,
          lng: rec.lng, lat: rec.lat,
          type: rec.type, typeLabel: rec.typeLabel, qty: take, unit: rec.unit,
          distance: c.path.distance, minutes: c.path.minutes, at: nowStr(),
          color: rec.color, source,
          status: 'enroute', via: [], detourBy: null, holdBy: null,
          signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
          signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: rec.id
        }
        this.dispatches.unshift(child)
        sent.push(child)
      }
      const made = sent.reduce((s, x) => s + x.qty, 0)
      if (made > 0) {
        rec.shortReplenished = parts.resupplied + made
        this._logDest(rec, `🔁 短缺补派：${rec.typeLabel} ${made}${rec.unit} 已重新出库（${sent.map((x) => x.baseName).join('、')}）`)
        notifyDispatchChanged()
      }
      return {
        ok: made > 0,
        sent,
        unmet: need,
        msg: made > 0
          ? `已补派 ${made}${rec.unit}` + (need > 0 ? `，库存不足仍缺 ${need}${rec.unit}` : '')
          : `各基地 ${rec.typeLabel} 库存不足，暂无法补派`
      }
    },

    // 退回入库：在途余量原路退回出库基地，库存回补、数量不再计入保障量
    // 幂等防护：已办结 / 挂起中 / 无在途余量的记录拒绝重复退回
    returnDispatch(recordId, { qty, reason = '' } = {}) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return { ok: false, msg: '派发记录不存在' }
      if (rec.status === 'held') return { ok: false, msg: '挂起中记录的物资已在库，无需退回' }
      if (rec.status === 'withdrawn') return { ok: false, msg: '该派发已撤回，在途余量已随撤回回库' }
      if (rec.status === 'done') return { ok: false, msg: '该派发已办结，不能重复退回' }
      const parts = dispatchParts(rec)
      qty = Math.max(0, Math.round(qty || 0))
      if (qty <= 0) return { ok: false, msg: '请填写退回数量' }
      if (qty > parts.outstanding) {
        return { ok: false, msg: `退回数量超出在途余量 ${parts.outstanding}${rec.unit}，不能重复回库` }
      }
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (base) base.stock[rec.type] = (base.stock[rec.type] || 0) + qty
      rec.returnedQty = parts.returned + qty
      if (!Array.isArray(rec.returnLogs)) rec.returnLogs = [] // 兼容旧记录
      rec.returnLogs.push({ at: nowStr(), qty, reason: (reason || '').trim() || '现场退回' })
      const left = dispatchParts(rec).outstanding
      if (left === 0) {
        rec.status = 'done'
        rec.doneReason = 'returned'
      }
      this._logDest(rec, `↩️ 物资退回：${rec.typeLabel} ${qty}${rec.unit} 退回 ${rec.baseName}（累计退回 ${rec.returnedQty}/${rec.qty}${rec.unit}）`)
      // 道路阻断联动：余量清零后该任务不再构成在途影响
      notifyDispatchChanged()
      return { ok: true, record: rec, returned: rec.returnedQty, outstanding: left }
    },
    /* ---------- 道路阻断处置：改道 / 改派 / 挂起 / 续派 ---------- */

    // 绕行改道：写入途经点并重算里程与到达时间（地图路线联动更新；仅在途余量任务可改道）
    rerouteDispatch(id, via, blockId = null, silent = false) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status !== 'enroute' || dispatchParts(rec).outstanding <= 0) return null
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (!base) return null
      const m = pathMetrics([[base.lng, base.lat], ...via, [rec.lng, rec.lat]])
      rec.via = via
      rec.distance = m.distance
      rec.minutes = m.minutes
      rec.detourBy = blockId
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev && !silent) ev.timeline.push({ at: nowStr(), text: `🔀 派发绕行改道：${rec.typeLabel} ${rec.qty}${rec.unit}，约 ${m.distance}km·${m.minutes}min` })
      return rec
    },
    // 改派出货基地：在途余量退回旧基地、新基地扣减，路线与 ETA 重算（已签收/短缺/退回部分不动）
    reassignDispatch(id, newBaseId) {
      const rec = this.dispatches.find((d) => d.id === id)
      const nb = this.bases.find((b) => b.id === newBaseId)
      if (!rec || !nb || rec.status !== 'enroute' || rec.baseId === newBaseId) return null
      const moveQty = dispatchParts(rec).outstanding
      if (moveQty <= 0) return null
      if ((nb.stock[rec.type] || 0) < moveQty) return null
      const ob = this.bases.find((b) => b.id === rec.baseId)
      if (ob) ob.stock[rec.type] = (ob.stock[rec.type] || 0) + moveQty
      nb.stock[rec.type] -= moveQty
      rec.baseId = nb.id
      rec.baseName = nb.name
      rec.via = []
      rec.detourBy = null
      const m = pathMetrics([[nb.lng, nb.lat], [rec.lng, rec.lat]])
      rec.distance = m.distance
      rec.minutes = m.minutes
      rec.source = '改派'
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text: `🔀 派发改派：${rec.typeLabel} 在途 ${moveQty}${rec.unit} 改由 ${nb.name} 出库` })
      return rec
    },
    // 挂起：在途余量退回基地、不计入保障量，待恢复通行后续派（已签收/短缺部分不受影响）
    holdDispatch(id, blockId) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status === 'held') return null
      const holdQty = dispatchParts(rec).outstanding
      if (holdQty <= 0) return null
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (base) base.stock[rec.type] = (base.stock[rec.type] || 0) + holdQty
      rec.status = 'held'
      rec.holdBy = blockId
      rec.via = []
      rec.detourBy = null
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text: `⏸ 派发挂起：${rec.typeLabel} 在途 ${holdQty}${rec.unit} 因道路阻断退回 ${rec.baseName}，待恢复通行后续派` })
      return rec
    },
    // 续派：按在途挂起余量复核库存后重新出库，重置路线与出发时间
    resumeDispatch(id) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status !== 'held') return { ok: false, msg: '记录不存在或未挂起' }
      const qty = dispatchParts(rec).outstanding
      if (qty <= 0) return { ok: false, msg: '该派发已无待续派余量' }
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (!base || (base.stock[rec.type] || 0) < qty) {
        return { ok: false, msg: `${base?.name || rec.baseName} 库存不足（需 ${qty}${rec.unit}），无法续派` }
      }
      base.stock[rec.type] -= qty
      rec.status = 'enroute'
      rec.holdBy = null
      rec.via = []
      rec.detourBy = null
      const m = pathMetrics([[base.lng, base.lat], [rec.lng, rec.lat]])
      rec.distance = m.distance
      rec.minutes = m.minutes
      rec.at = nowStr()
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text: `▶️ 恢复续派：${rec.typeLabel} ${qty}${rec.unit} 重新出库，约 ${m.distance}km·${m.minutes}min` })
      return { ok: true }
    },
    // 阻断解除后恢复直线（由道路阻断模块判定不再穿越其它阻断后调用）
    resetDispatchRoute(id) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status !== 'enroute') return
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (!base) return
      rec.via = []
      rec.detourBy = null
      const m = pathMetrics([[base.lng, base.lat], [rec.lng, rec.lat]])
      rec.distance = m.distance
      rec.minutes = m.minutes
    },
    // 内部：撤回单条派发。在途（或挂起待续派）余量原路回库，
    // 已发生的签收 / 短缺认定 / 退回 / 补派回执全部保留，记录转为 withdrawn 留档。
    // 若本单是短缺补派单，其被撤回的余量从原单 shortReplenished 冲回，缺口重新释放。
    _withdrawRecord(rec, reason = '撤回派发') {
      if (!rec || rec.status === 'withdrawn' || rec.status === 'done') return 0
      const parts = dispatchParts(rec)
      const left = parts.outstanding
      // 仅在途余量回库：挂起时物资已随挂起退回基地，不重复返还
      if (left > 0 && rec.status === 'enroute') {
        const base = this.bases.find((b) => b.id === rec.baseId)
        if (base) base.stock[rec.type] = (base.stock[rec.type] || 0) + left
      }
      if (left > 0) {
        rec.withdrawnQty = parts.withdrawn + left
        if (!Array.isArray(rec.withdrawLogs)) rec.withdrawLogs = []
        rec.withdrawLogs.push({ at: nowStr(), qty: left, reason })
      }
      rec.status = 'withdrawn'
      rec.doneReason = 'withdrawn'
      rec.holdBy = null
      rec.via = []
      rec.detourBy = null
      // 补派子单被撤回：未签收的补派量冲回原单「已补派」账，短缺缺口重新释放
      if (rec.replenishOf && left > 0) {
        const parent = this.dispatches.find((d) => d.id === rec.replenishOf)
        if (parent) {
          parent.shortReplenished = Math.max(0, (parent.shortReplenished || 0) - left)
          this._logDest(parent, `↩️ 补派撤回：${rec.typeLabel} ${left}${rec.unit} 回库，原短缺缺口重新释放`)
        }
      }
      this._logDest(rec, `🚫 派发撤回：${rec.typeLabel} 在途余量 ${left}${rec.unit} 退回 ${rec.baseName}`
        + (parts.received ? `，已实收 ${parts.received}${rec.unit} 保留` : '')
        + (parts.shortage ? `，已认定短缺 ${parts.shortage}${rec.unit} 保留` : '')
        + (parts.returned ? `，已退回 ${parts.returned}${rec.unit} 保留` : ''))
      return left
    },
    // 撤回派发：仅返还在途/挂起余量；签收、短缺认定、补派与退回记录全部留档
    withdrawDispatch(recordId) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec || rec.status === 'withdrawn') return
      this._withdrawRecord(rec)
      // 道路阻断联动：撤回后该任务退出影响评估
      notifyDispatchChanged()
    },

    /* ---------- 多灾点资源统筹 ---------- */

    // 按 灾情等级 → 需求缺口 → 运输时长 生成跨基地分配方案（预占不扣库存，提交时才锁定）
    generatePlan() {
      const avail = {}
      this.bases.forEach((b) => { avail[b.id] = { ...b.stock } })
      // 按等级权重、缺口规模排序事件
      const queue = this.events
        .filter((e) => e.status !== 'closed')
        .map((ev) => {
          const gap = {}
          let total = 0
          Object.entries(ev.demand || {}).forEach(([t, need]) => {
            const g = need - (this.sentMap[ev.id]?.[t] || 0)
            if (g > 0) { gap[t] = g; total += g }
          })
          return { ev, gap, total }
        })
        .filter((x) => x.total > 0)
        .sort((a, b) => (SEV_WEIGHT[b.ev.severity] - SEV_WEIGHT[a.ev.severity]) || (b.total - a.total))

      const items = []
      let seq = 0
      queue.forEach(({ ev, gap }) => {
        Object.entries(gap).forEach(([type, g]) => {
          let need = g
          // 候选基地按运输时长升序，就近优先、跨基地拆分
          const cands = this.bases
            .filter((b) => (avail[b.id][type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const c of cands) {
            if (need <= 0) break
            const take = Math.min(need, avail[c.b.id][type])
            avail[c.b.id][type] -= take
            need -= take
            items.push({
              id: 'pi-' + ++seq,
              eventId: ev.id, baseId: c.b.id, type, qty: take,
              distance: c.path.distance, minutes: c.path.minutes
            })
          }
        })
      })
      this.plan = items
      this.planResult = null
    },
    // 人工调整：改数量 / 换基地（自动重算运输时长）
    updatePlanItem(id, patch) {
      const it = this.plan.find((p) => p.id === id)
      if (!it) return
      if (patch.qty != null) it.qty = Math.max(1, Math.round(patch.qty))
      if (patch.baseId && patch.baseId !== it.baseId) {
        const base = this.bases.find((b) => b.id === patch.baseId)
        const ev = this.events.find((e) => e.id === it.eventId)
        if (base && ev) {
          it.baseId = patch.baseId
          const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
          it.distance = path.distance
          it.minutes = path.minutes
        }
      }
    },
    removePlanItem(id) {
      this.plan = this.plan.filter((p) => p.id !== id)
    },
    clearPlan() {
      this.plan = []
    },
    // 提交：统一校验 → 锁定库存 → 冲突重分配 → 批量派发（联动事件/路线/统计）
    submitPlan() {
      if (!this.plan.length) return null
      const remaining = {}
      this.bases.forEach((b) => { remaining[b.id] = { ...b.stock } })
      const evOf = (id) => this.events.find((e) => e.id === id)
      // 高等级事件、短运输时长优先锁定库存
      const items = [...this.plan].sort((a, b) => {
        const wa = SEV_WEIGHT[evOf(a.eventId)?.severity] || 0
        const wb = SEV_WEIGHT[evOf(b.eventId)?.severity] || 0
        return wb - wa || a.minutes - b.minutes
      })
      const takes = []
      const result = { total: items.length, ok: 0, realloc: 0, unmet: [], at: nowStr() }
      items.forEach((it) => {
        const ev = evOf(it.eventId)
        let need = it.qty
        const parts = []
        const own = Math.min(need, remaining[it.baseId]?.[it.type] || 0)
        if (own > 0) { parts.push({ baseId: it.baseId, qty: own }); need -= own }
        if (need > 0 && ev) {
          // 冲突：原基地库存不足，按运输时长从其他基地重新分配
          const alts = this.bases
            .filter((b) => b.id !== it.baseId && (remaining[b.id][it.type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const a of alts) {
            if (need <= 0) break
            const t = Math.min(need, remaining[a.b.id][it.type])
            parts.push({ baseId: a.b.id, qty: t })
            need -= t
          }
        }
        if (parts.some((p) => p.baseId !== it.baseId) || parts.length > 1) result.realloc++
        else if (parts.length) result.ok++
        if (need > 0) {
          result.unmet.push({ eventTitle: ev?.title || it.eventId, type: it.type, qty: need })
        }
        parts.forEach((p) => {
          remaining[p.baseId][it.type] -= p.qty // 锁定库存
          takes.push({ baseId: p.baseId, eventId: it.eventId, type: it.type, qty: p.qty })
        })
      })
      // 批量执行：扣库存 + 生成派发记录 + 联动事件状态/时间线（路线与统计由响应式自动更新）
      takes.forEach((t) => this._pushDispatch(t.baseId, t.eventId, t.type, t.qty, '统筹'))
      this.plan = []
      this.planResult = result
      return result
    },

    // 大屏数据自动刷新（模拟实时数据变化演示）
    startAutoPlay() {
      if (this.autoPlay) return
      this.autoPlay = true
      this.replayTimer = setInterval(() => {
        this.events.forEach((e) => {
          if (e.status !== 'closed' && Math.random() > 0.55) {
            e.affected += Math.floor(Math.random() * 60)
          }
        })
      }, 4000)
    },
    stopAutoPlay() {
      this.autoPlay = false
      clearInterval(this.replayTimer)
    },
    resetResource(eventId) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      // 撤回该事件关联的所有派发：在途/挂起余量回库，签收/短缺/补派/退回账目留档
      const rows = this.dispatches.filter((d) => d.eventId === eventId)
      if (!rows.length) return
      let back = 0
      rows.forEach((d) => { back += this._withdrawRecord(d, '重置事件资源') })
      ev.timeline.push({ at: nowStr(), text: `🚫 重置资源：${rows.length} 条派发撤回，在途余量 ${back} 已回库，历史签收/退回记录保留` })
      notifyDispatchChanged()
    }
  }
})
