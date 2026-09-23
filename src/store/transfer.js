import { defineStore } from 'pinia'
import { useCommandStore, roughPath, pathMetrics, dispatchParts } from '@/store/command'
import { useRoadblockStore } from '@/store/roadblock'
import { SHELTERS, SUPPLY_PER_CAPITA, SUPPLY_DURABLES } from '@/mock/data'

let batchSeq = 0
let personSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100

// 人员查重键：优先证件号，无证件号用姓名
const personKey = (p) => (p.idNo && p.idNo.trim()) ? 'id:' + p.idNo.trim() : 'nm:' + (p.name || '').trim()

// 时刻字符串 → 当日小时数（兼容 "09:05" / "上午9:05" / "下午3:05"）
export function timeToHours(s) {
  if (!s) return 0
  const m = String(s).match(/(上午|下午|中午|晚上)?\s*(\d{1,2}):(\d{2})/)
  if (!m) return 0
  let h = +m[2]
  const ap = m[1]
  if ((ap === '下午' || ap === '晚上' || ap === '中午') && h < 12) h += 12
  if (ap === '上午' && h === 12) h = 0
  return Math.min(24, h + (+m[3]) / 60)
}

// 成员在第 day 日的入住时长占比（按实际入住/转出时段折算，0~1）
// checkinDay/checkoutDay 缺失的历史记录按第 1 日兼容处理
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

// 成员在第 day 日日终是否仍在住（用于在住峰值快照）
function memberInHouseEndOf(m, day) {
  if (!m.checkinAt) return false
  const ciDay = m.checkinDay ?? 1
  if (ciDay > day) return false
  const coDay = m.checkoutAt ? (m.checkoutDay ?? ciDay) : null
  return coDay == null || coDay > day
}

export const useTransferStore = defineStore('transfer', {
  state: () => ({
    shelters: [],   // 安置点（床位容量 + 按日补给账目：consumed 累计消耗 / settlements 日结记录 / peakInHouse 在住峰值）
    batches: [],    // 转移批次
    settleDay: 1,   // 当前补给结算日（第 N 日，日结后 +1）
    clock: null     // 演示/测试用时钟覆盖（'HH:MM'），为空取真实时间
  }),

  getters: {
    /* ---------- 安置点床位 ---------- */
    // shelterId -> { inHouse 在住, reserved 批次计划余量预占, left 剩余可登记 }
    bedMap(state) {
      const m = {}
      state.shelters.forEach((s) => { m[s.id] = { inHouse: 0, reserved: 0, left: s.capacity } })
      state.batches.forEach((b) => {
        if (!b.shelterId || !m[b.shelterId]) return
        const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
        const out = b.members.filter((x) => x.checkoutAt).length
        m[b.shelterId].inHouse += inHouse
        if (b.status !== 'closed') {
          // 计划转移中尚未入住/转出的部分视为床位预占
          m[b.shelterId].reserved += Math.max(0, b.headcount - inHouse - out)
        }
      })
      Object.values(m).forEach((v) => { v.left = Math.max(0, v.left - v.inHouse - v.reserved) })
      return m
    },
    /* ---------- 安置点按日补给核算 ----------
     * 消耗品：累计需求 = 已结日消耗(Σ 人日×系数) + 本日预计(实时人日×系数)，
     *         结余库存 = 实收 - 已耗（跨日结转），缺口 = 累计需求 - 实收 - 在途；
     * 耐用品：按在住峰值一次性配备（峰值 = 历史日结在住与当前在住的最大值），
     *         不按日消耗，缺口 = 峰值需求 - 实收 - 在途；
     * 签收/短缺/退回/撤回/人员转出均通过派发四本账与实时人日联动重算缺口；
     * 无闭环字段的历史派发记录按全量在途计入，避免重复补给。 */
    shelterNeeds(state) {
      const cmd = useCommandStore()
      const day = state.settleDay
      return state.shelters.map((s) => {
        const occ = this.bedMap[s.id]?.inHouse || 0
        // 本日（未结算）实时人日：按各成员实际入住时段折算
        let todayPd = 0
        state.batches.forEach((b) => {
          if (b.shelterId !== s.id) return
          b.members.forEach((m) => { todayPd += memberDayFrac(m, day) })
        })
        todayPd = round2(todayPd)
        // 派发四本账（兼容无闭环字段的旧记录：dispatchParts 默认全量在途）
        const received = {}
        const inTransit = {}
        cmd.dispatches.forEach((d) => {
          if (d.shelterId !== s.id) return
          const p = dispatchParts(d)
          if (p.received > 0) received[d.type] = (received[d.type] || 0) + p.received
          if (p.inTransit > 0) inTransit[d.type] = (inTransit[d.type] || 0) + p.inTransit
        })
        const consumed = s.consumed || {}
        const peak = Math.max(occ, s.peakInHouse || 0, ...(s.settlements || []).map((x) => x.inHouse), 0)
        const consumables = {}
        const durables = {}
        const need = {}
        const gap = {}
        Object.entries(SUPPLY_PER_CAPITA).forEach(([t, coef]) => {
          const rec = received[t] || 0
          const itr = inTransit[t] || 0
          if (SUPPLY_DURABLES.includes(t)) {
            // 耐用品账：峰值配备，不逐日消耗
            const nd = Math.ceil(peak * coef)
            const g = Math.max(0, nd - rec - itr)
            durables[t] = { coef, peak, need: nd, received: rec, inTransit: itr, gap: g }
            need[t] = nd
            if (g > 0) gap[t] = g
          } else {
            // 消耗品账：按日消耗、跨日结转
            const used = consumed[t] || 0
            const today = round2(todayPd * coef)
            const cumNeed = round2(used + today)
            const onHand = Math.max(0, round2(rec - used))
            const g = Math.max(0, Math.ceil(cumNeed - rec - itr - 1e-9))
            consumables[t] = { coef, today, consumed: used, onHand, received: rec, inTransit: itr, need: cumNeed, gap: g }
            need[t] = Math.ceil(cumNeed - 1e-9)
            if (g > 0) gap[t] = g
          }
        })
        // 兼容旧视图：sent = 实收 + 在途（保障量），仅保留有量条目
        const sent = {}
        Object.keys(SUPPLY_PER_CAPITA).forEach((t) => {
          const v = (received[t] || 0) + (inTransit[t] || 0)
          if (v > 0) sent[t] = v
        })
        return { shelter: s, day, occ, todayPd, peak, need, sent, received, gap, consumables, durables }
      })
    },
    /* ---------- 事件转移进度（回写事件详情） ---------- */
    // eventId -> { batches, planned, picked, checkedIn, out }
    progressByEvent(state) {
      const m = {}
      state.batches.forEach((b) => {
        const p = (m[b.eventId] = m[b.eventId] || { batches: 0, planned: 0, picked: 0, checkedIn: 0, out: 0 })
        p.batches++
        p.planned += b.headcount
        b.members.forEach((x) => {
          if (x.pickupAt) p.picked++
          if (x.checkinAt) p.checkedIn++
          if (x.checkoutAt) p.out++
        })
      })
      return m
    },
    /* ---------- 大屏统计 ---------- */
    stats(state) {
      let inTransit = 0, housed = 0, out = 0, registered = 0
      state.batches.forEach((b) => {
        b.members.forEach((x) => {
          if (x.pickupAt) registered++
          if (x.checkoutAt) out++
          else if (x.checkinAt) housed++
          else if (x.pickupAt) inTransit++
        })
      })
      return {
        activeBatches: state.batches.filter((b) => b.status !== 'closed').length,
        inTransit, housed, out, registered
      }
    }
  },

  actions: {
    load() {
      this.shelters = SHELTERS.map((s) => ({ ...s, consumed: {}, settlements: [], peakInHouse: 0 }))
      this.batches = []
      this.settleDay = 1
      this.clock = null
    },

    _cmd() { return useCommandStore() },
    _event(eventId) { return this._cmd().events.find((e) => e.id === eventId) },
    _log(eventId, text) {
      const ev = this._event(eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
    },
    _batch(id) { return this.batches.find((b) => b.id === id) },
    // 当前业务时刻（测试/演示可经 setClock 覆盖）
    _now() { return this.clock || nowStr() },
    _shelter(id) { return this.shelters.find((s) => s.id === id) },
    // 在住峰值跟踪：入住增长时刷新（耐用品按峰值配备，人员转出后峰值不回溯）
    _touchPeak(shelterId) {
      const s = this._shelter(shelterId)
      if (!s) return
      const inHouse = this.batches
        .filter((b) => b.shelterId === shelterId)
        .reduce((n, b) => n + b.members.filter((x) => x.checkinAt && !x.checkoutAt).length, 0)
      s.peakInHouse = Math.max(s.peakInHouse || 0, inHouse)
    },
    // 演示/测试：固定业务时钟（null 恢复真实时间）
    setClock(t) { this.clock = t || null },

    /* ---------- 道路阻断处置：挂起 / 绕行 / 续派 ---------- */

    // 重算批次路线 ETA（受灾点 → 途经点 → 安置点）
    _syncEta(b) {
      const ev = this._event(b.eventId)
      const sh = this.shelters.find((s) => s.id === b.shelterId)
      if (!ev || !sh) return
      const pts = [[ev.location.lng, ev.location.lat], ...(b.via || []), [sh.lng, sh.lat]]
      b.eta = pathMetrics(pts)
    },
    // 挂起：车辆与床位预占保留，接运/入住登记暂停，恢复通行后续派
    holdBatch(batchId, blockId) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed' || b.held) return
      b.held = true
      b.holdBy = blockId
      b.via = []
      b.detourBy = null
      this._log(b.eventId, `⏸ 批次「${b.name}」因道路阻断挂起（车辆/床位预占保留，待续派）`)
    },
    // 续派：解除挂起并恢复直线 ETA
    resumeBatch(batchId) {
      const b = this._batch(batchId)
      if (!b || !b.held) return
      b.held = false
      b.holdBy = null
      b.via = []
      b.detourBy = null
      this._syncEta(b)
      this._log(b.eventId, `▶️ 批次「${b.name}」恢复通行续派，预计 ${b.eta?.minutes}min 抵达安置点`)
    },
    // 绕行改道：写入途经点并重算 ETA（地图转移路线联动更新）
    rerouteBatch(batchId, via, blockId = null, silent = false) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return null
      b.via = via
      b.detourBy = blockId
      this._syncEta(b)
      if (!silent) this._log(b.eventId, `🔀 批次「${b.name}」绕行改道，约 ${b.eta?.distance}km·${b.eta?.minutes}min`)
      return b
    },
    // 阻断解除后恢复直线（由道路阻断模块判定后调用）
    resetBatchRoute(batchId) {
      const b = this._batch(batchId)
      if (!b) return
      b.via = []
      b.detourBy = null
      this._syncEta(b)
    },

    /* ---------- 批次生命周期 ---------- */

    // 指挥员建批：分配车辆（占用资源库车辆库存）与安置点（预占床位）
    createBatch({ eventId, name, headcount, vehicleBaseId, vehicleCount, shelterId }) {
      const cmd = this._cmd()
      const ev = this._event(eventId)
      const base = cmd.bases.find((b) => b.id === vehicleBaseId)
      const shelter = this.shelters.find((s) => s.id === shelterId)
      headcount = Math.max(1, Math.round(headcount || 0))
      vehicleCount = Math.max(1, Math.round(vehicleCount || 0))
      if (!ev || !base || !shelter) return { ok: false, msg: '参数不完整，请检查事件、车辆来源与安置点' }
      if ((base.stock.vehicle || 0) < vehicleCount) {
        return { ok: false, msg: `${base.name} 车辆不足（余 ${base.stock.vehicle || 0} 辆）` }
      }
      const beds = this.bedMap[shelterId]
      if (beds.left < headcount) {
        return { ok: false, msg: `${shelter.name} 剩余床位 ${beds.left}，不足 ${headcount} 人，请减少人数或更换安置点` }
      }
      base.stock.vehicle -= vehicleCount // 占用车辆
      const batch = {
        id: 'tb-' + Date.now() + '-' + ++batchSeq,
        eventId,
        name: name?.trim() || `第${this.batches.filter((b) => b.eventId === eventId).length + 1}批`,
        headcount,
        vehicleBaseId, vehicleCount,
        shelterId,
        vehicleReleased: false,
        status: 'pending',
        members: [],
        createdAt: nowStr(),
        // 道路阻断处置：挂起状态、绕行途经点与预计到达
        held: false, holdBy: null, via: [], detourBy: null, eta: null
      }
      this._syncEta(batch)
      this.batches.unshift(batch)
      // 回写事件：时间线 + 状态联动
      this._log(eventId, `🚌 创建转移批次「${batch.name}」：计划 ${headcount} 人，${base.name} 出车 ${vehicleCount} 辆 → ${shelter.name}`)
      if (ev.status === 'reported' || ev.status === 'assessing') ev.status = 'dispatching'
      // 联动：新建批次立即接受生效阻断复核
      try { useRoadblockStore().assessActive() } catch { /* 道路阻断模块未初始化 */ }
      return { ok: true, batch }
    },

    // 改派：更换安置点 / 调整车辆（释放旧占用、校验新库存与床位）
    reassignBatch(batchId, { shelterId, vehicleBaseId, vehicleCount }) {
      const cmd = this._cmd()
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return { ok: false, msg: '批次不存在或已办结' }
      const changes = []
      // 换安置点：已有入住登记后不允许（人员已落床位）
      if (shelterId && shelterId !== b.shelterId) {
        if (b.members.some((x) => x.checkinAt)) return { ok: false, msg: '已有群众入住，不能再改派安置点' }
        const target = this.shelters.find((s) => s.id === shelterId)
        if (!target) return { ok: false, msg: '安置点不存在' }
        if (this.bedMap[shelterId].left < b.headcount) {
          return { ok: false, msg: `${target.name} 剩余床位 ${this.bedMap[shelterId].left}，不足 ${b.headcount} 人` }
        }
        changes.push(`安置点改派：${this.shelters.find((s) => s.id === b.shelterId)?.name} → ${target.name}`)
        b.shelterId = shelterId
        b.via = [] // 安置点变更后路线重算
        b.detourBy = null
        this._syncEta(b)
      }
      // 调整车辆：先释放旧占用，再占用新配置
      if (vehicleBaseId && vehicleCount != null) {
        vehicleCount = Math.max(1, Math.round(vehicleCount))
        const oldBase = cmd.bases.find((x) => x.id === b.vehicleBaseId)
        const newBase = cmd.bases.find((x) => x.id === vehicleBaseId)
        if (!newBase) return { ok: false, msg: '车辆来源不存在' }
        const avail = (newBase.stock.vehicle || 0) + (newBase.id === b.vehicleBaseId && !b.vehicleReleased ? b.vehicleCount : 0)
        if (avail < vehicleCount) return { ok: false, msg: `${newBase.name} 车辆不足（可调 ${avail} 辆）` }
        if (oldBase && !b.vehicleReleased) oldBase.stock.vehicle += b.vehicleCount
        newBase.stock.vehicle -= vehicleCount
        b.vehicleReleased = false
        if (vehicleBaseId !== b.vehicleBaseId || vehicleCount !== b.vehicleCount) {
          changes.push(`车辆改派：${newBase.name} ${vehicleCount} 辆`)
        }
        b.vehicleBaseId = vehicleBaseId
        b.vehicleCount = vehicleCount
      }
      if (changes.length) this._log(b.eventId, `🔀 批次「${b.name}」${changes.join('；')}`)
      return { ok: true, msg: changes.length ? changes.join('；') : '配置未变化' }
    },

    // 办结：全部转出或提前办结，回收车辆
    closeBatch(batchId) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return
      const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
      if (inHouse > 0) return { ok: false, msg: `仍有 ${inHouse} 人在住，请先办理转出登记` }
      this._close(b)
      return { ok: true }
    },
    _close(b) {
      b.status = 'closed'
      this._releaseVehicles(b)
      this._log(b.eventId, `✅ 批次「${b.name}」办结：累计转移 ${b.members.length} 人，车辆已回收`)
    },
    _releaseVehicles(b) {
      if (b.vehicleReleased) return
      const base = this._cmd().bases.find((x) => x.id === b.vehicleBaseId)
      if (base) base.stock.vehicle += b.vehicleCount
      b.vehicleReleased = true
    },
    // 取消（仅未开始接运的批次）
    cancelBatch(batchId) {
      const b = this._batch(batchId)
      if (!b) return { ok: false, msg: '批次不存在' }
      if (b.members.length > 0) return { ok: false, msg: '已有登记记录，不能取消，请走办结流程' }
      this._releaseVehicles(b)
      this.batches = this.batches.filter((x) => x.id !== batchId)
      this._log(b.eventId, `🗑 批次「${b.name}」已取消，车辆已释放`)
      return { ok: true }
    },

    /* ---------- 现场登记：接运 / 入住 / 转出 ---------- */

    // 单人登记（带查重）；批量登记传 { count }
    register(batchId, stage, payload) {
      const b = this._batch(batchId)
      if (!b) return { ok: false, msg: '批次不存在' }
      if (b.status === 'closed') return { ok: false, msg: '批次已办结' }
      // 道路阻断挂起中：接运/入住暂停（转出不受影响，在住群众可正常疏解）
      if (b.held && stage !== 'checkout') {
        return { ok: false, msg: '批次因道路阻断挂起中，待恢复通行续派后再登记' }
      }
      if (payload.count != null) return this._registerBulk(b, stage, payload.count)
      const name = (payload.name || '').trim()
      const idNo = (payload.idNo || '').trim()
      if (!name && !idNo) return { ok: false, msg: '请填写姓名或证件号' }
      const person = { name: name || '（未留姓名）', idNo }
      if (stage === 'pickup') return this._pickup(b, person)
      // 入住 / 转出：需先在本批次完成上一环节登记
      const m = b.members.find((x) => personKey(x) === personKey(person))
      if (!m) return { ok: false, msg: stage === 'checkin' ? '该人员未登记接运，请先接运登记' : '该人员未入住，无法转出' }
      if (stage === 'checkin') {
        if (m.checkinAt) return { ok: false, dup: 'self', msg: `「${person.name}」已办理入住，请勿重复登记` }
        return this._checkin(b, [m])
      }
      if (m.checkoutAt) return { ok: false, dup: 'self', msg: `「${person.name}」已办理转出，请勿重复登记` }
      if (!m.checkinAt) return { ok: false, msg: '该人员尚未入住，无法转出' }
      return this._checkout(b, [m])
    },

    _pickup(b, person) {
      const key = personKey(person)
      // 重复登记：本批次已存在
      if (b.members.some((x) => personKey(x) === key)) {
        return { ok: false, dup: 'self', msg: `「${person.name}」已在本批次登记，请勿重复登记` }
      }
      // 重复登记：其他批次已存在 → 提示改派
      for (const ob of this.batches) {
        if (ob.id === b.id || ob.status === 'closed') continue
        const hit = ob.members.find((x) => personKey(x) === key)
        if (hit) {
          return {
            ok: false, dup: 'other',
            fromBatchId: ob.id, fromBatchName: ob.name, personId: hit.id,
            msg: `「${person.name}」已在批次「${ob.name}」登记，可改派至本批次`
          }
        }
      }
      if (b.members.length >= b.headcount) {
        return { ok: false, msg: `已达计划人数 ${b.headcount} 人，请新建批次或调整计划` }
      }
      b.members.push({ id: 'p-' + ++personSeq, ...person, pickupAt: nowStr(), checkinAt: null, checkoutAt: null })
      this._afterRegister(b, 'pickup', `🚌「${person.name}」接运登记`)
      return { ok: true }
    },

    _registerBulk(b, stage, count) {
      count = Math.max(1, Math.round(count || 0))
      if (stage === 'pickup') {
        const room = b.headcount - b.members.length
        const n = Math.min(count, room)
        if (n <= 0) return { ok: false, msg: `已达计划人数 ${b.headcount} 人` }
        for (let i = 0; i < n; i++) {
          b.members.push({ id: 'p-' + ++personSeq, name: `群众${personSeq}号`, idNo: '', anon: true, pickupAt: nowStr(), checkinAt: null, checkoutAt: null })
        }
        this._afterRegister(b, 'pickup', `🚌 批量接运登记 ${n} 人`)
        return { ok: true, msg: n < count ? `仅登记 ${n} 人（受计划人数限制）` : `已登记 ${n} 人` }
      }
      // 批量入住 / 转出：取本批次中处于上一环节的成员
      const pool = stage === 'checkin'
        ? b.members.filter((x) => x.pickupAt && !x.checkinAt)
        : b.members.filter((x) => x.checkinAt && !x.checkoutAt)
      const targets = pool.slice(0, count)
      if (!targets.length) return { ok: false, msg: stage === 'checkin' ? '暂无待入住人员' : '暂无在住人员' }
      return stage === 'checkin' ? this._checkin(b, targets) : this._checkout(b, targets)
    },

    _checkin(b, members) {
      // 可用床位 = 全局剩余 + 本批次自身预占（本批次的待入住人员已计入预占，不能重复扣减）
      const bed = this.bedMap[b.shelterId]
      const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
      const out = b.members.filter((x) => x.checkoutAt).length
      const ownReserved = b.status === 'closed' ? 0 : Math.max(0, b.headcount - inHouse - out)
      const avail = bed.left + ownReserved
      if (avail < members.length) {
        return { ok: false, msg: `${this.shelters.find((s) => s.id === b.shelterId)?.name} 剩余床位 ${avail}，不足 ${members.length} 人，请改派安置点` }
      }
      const at = this._now()
      members.forEach((m) => { m.checkinAt = at; m.checkinDay = this.settleDay })
      this._touchPeak(b.shelterId)
      this._afterRegister(b, 'checkin', `🏕️ 入住登记 ${members.length} 人 → ${this.shelters.find((s) => s.id === b.shelterId)?.name}`)
      return { ok: true, msg: `已入住 ${members.length} 人` }
    },

    _checkout(b, members) {
      const at = this._now()
      members.forEach((m) => { m.checkoutAt = at; m.checkoutDay = this.settleDay })
      this._afterRegister(b, 'checkout', `🚪 转出登记 ${members.length} 人（返乡/投亲/转院）`)
      return { ok: true, msg: `已转出 ${members.length} 人` }
    },

    // 登记后：推进批次状态、回写事件时间线
    _afterRegister(b, stage, text) {
      const picked = b.members.filter((x) => x.pickupAt).length
      const inDone = b.members.filter((x) => x.checkinAt).length
      const out = b.members.filter((x) => x.checkoutAt).length
      if (b.status === 'pending' && picked > 0) b.status = 'transporting'
      if (b.status === 'transporting' && inDone >= b.headcount) b.status = 'settled'
      this._log(b.eventId, `${text}（批次「${b.name}」${picked}/${b.headcount}）`)
      // 已安置批次的在册人员全部转出 → 自动办结（未满员的批次需手动办结）
      if (b.status === 'settled' && b.members.length > 0 && out === b.members.length) this._close(b)
    },

    // 单成员快捷推进：未入住 → 入住；在住 → 转出（列表行内操作）
    advanceMember(batchId, memberId) {
      const b = this._batch(batchId)
      const m = b?.members.find((x) => x.id === memberId)
      if (!b || !m || b.status === 'closed') return { ok: false, msg: '不可操作' }
      if (!m.checkinAt) return this._checkin(b, [m])
      if (!m.checkoutAt) return this._checkout(b, [m])
      return { ok: false, msg: '该人员已转出' }
    },

    // 人员改派：从原批次移动到目标批次（保留登记进度，校验目标批次计划与床位）
    movePerson(personId, toBatchId) {
      const to = this._batch(toBatchId)
      if (!to || to.status === 'closed') return { ok: false, msg: '目标批次不可用' }
      let from = null, person = null
      for (const b of this.batches) {
        const i = b.members.findIndex((x) => x.id === personId)
        if (i >= 0) { from = b; person = b.members[i]; break }
      }
      if (!from || !person) return { ok: false, msg: '未找到该人员登记记录' }
      if (from.id === to.id) return { ok: false, msg: '人员已在本批次' }
      if (to.members.length >= to.headcount) return { ok: false, msg: `目标批次「${to.name}」已达计划人数` }
      // 已入住人员跨安置点改派：可用床位 = 目标点剩余 + 目标批次自身预占
      if (person.checkinAt && !person.checkoutAt && from.shelterId !== to.shelterId) {
        const inHouse = to.members.filter((x) => x.checkinAt && !x.checkoutAt).length
        const outN = to.members.filter((x) => x.checkoutAt).length
        const ownReserved = Math.max(0, to.headcount - inHouse - outN)
        if (this.bedMap[to.shelterId].left + ownReserved < 1) {
          return { ok: false, msg: `目标安置点剩余床位不足，无法改派` }
        }
      }
      from.members = from.members.filter((x) => x.id !== personId)
      to.members.push(person)
      this._touchPeak(to.shelterId) // 已入住人员改派跨点：目标安置点在住峰值联动
      this._log(from.eventId, `🔀「${person.name}」由批次「${from.name}」改派至「${to.name}」`)
      return { ok: true, msg: `已改派至「${to.name}」` }
    },

    /* ---------- 批次拆分：按人员分组拆出未完成批次 ---------- */

    // 拆分未办结批次：选中的成员带着全部登记历史移入新批次，
    // 新批次独立安排车辆（从基地库存新占）与安置点（床位预占联动重算），
    // 原批次保留剩余成员与车辆配置；两批各自按登记进度重新推导状态与办结条件。
    splitBatch(batchId, { name, personIds, headcount, vehicleBaseId, vehicleCount, shelterId }) {
      const cmd = this._cmd()
      const src = this._batch(batchId)
      if (!src) return { ok: false, msg: '批次不存在' }
      if (src.status === 'closed') return { ok: false, msg: '批次已办结，不能拆分' }
      personIds = Array.isArray(personIds) ? [...new Set(personIds)] : []
      if (!personIds.length) return { ok: false, msg: '请勾选至少一名成员组成新分组' }
      const move = []
      for (const pid of personIds) {
        const m = src.members.find((x) => x.id === pid)
        if (!m) return { ok: false, msg: '勾选成员不属于原批次' }
        if (m.checkoutAt) return { ok: false, msg: `「${m.name}」已转出，不能参与拆分` }
        move.push(m)
      }
      const stay = src.members.filter((x) => !personIds.includes(x.id))
      headcount = Math.max(1, Math.round(headcount || 0))
      vehicleCount = Math.max(1, Math.round(vehicleCount || 0))
      if (headcount < move.length) {
        return { ok: false, msg: `新分组计划人数 ${headcount} 少于勾选成员 ${move.length} 人` }
      }
      // 保留在原批次的成员（含已转出）不能超过原批次剩余计划
      if (src.headcount - headcount < stay.length) {
        return { ok: false, msg: `原批次剩余计划 ${src.headcount - headcount} 人，容不下保留的 ${stay.length} 人，请调大新分组人数或多选成员` }
      }
      // 新分组车辆：从所选基地库存新占（原批次车辆维持原配置，必要时指挥员可再改派）
      const base = cmd.bases.find((x) => x.id === vehicleBaseId)
      if (!base) return { ok: false, msg: '请选择车辆来源' }
      if ((base.stock.vehicle || 0) < vehicleCount) {
        return { ok: false, msg: `${base.name} 车辆不足（余 ${base.stock.vehicle || 0} 辆）` }
      }
      const shelter = this.shelters.find((s) => s.id === shelterId)
      if (!shelter) return { ok: false, msg: '请选择安置点' }
      // 已入住成员必须随原安置点：其床位已实际占用
      const inHouse = move.filter((x) => x.checkinAt && !x.checkoutAt)
      if (inHouse.length && shelterId !== src.shelterId) {
        return { ok: false, msg: `勾选中有 ${inHouse.length} 人已入住「${this.shelters.find((s) => s.id === src.shelterId)?.name}」，不能改投其它安置点（请先转出或取消勾选）` }
      }
      // 换到其它安置点：按当前床位余量校验新分组预占（本分组在目标点尚无预占）
      if (shelterId !== src.shelterId && this.bedMap[shelterId].left < headcount) {
        return { ok: false, msg: `${shelter.name} 剩余床位 ${this.bedMap[shelterId].left}，不足 ${headcount} 人，请减少人数或更换安置点` }
      }

      /* --- 校验通过，执行拆分（床位预占按 headcount 归属重算，getter 自动联动） --- */
      const moveIds = new Set(personIds)
      src.members = src.members.filter((x) => !moveIds.has(x.id))
      src.headcount -= headcount

      const nb = {
        id: 'tb-' + Date.now() + '-' + ++batchSeq,
        eventId: src.eventId,
        name: name?.trim() || `${src.name}-拆${this.batches.filter((b) => b.eventId === src.eventId).length + 1}`,
        headcount,
        vehicleBaseId, vehicleCount,
        shelterId,
        vehicleReleased: false,
        status: 'pending',
        members: move,           // 登记历史（接运/入住/转出时间戳）原样保留
        createdAt: nowStr(),
        splitFrom: src.id,       // 拆分溯源
        // 新分组走全新路线，重新接受阻断评估
        held: false, holdBy: null, via: [], detourBy: null, eta: null
      }
      base.stock.vehicle -= vehicleCount
      this.batches.unshift(nb)

      // 同步两批的办结条件：按各自登记进度重新推导状态
      this._recomputeStatus(src)
      this._recomputeStatus(nb)
      this._syncEta(nb)

      const srcShelterName = this.shelters.find((s) => s.id === src.shelterId)?.name
      this._log(src.eventId, `✂️ 批次「${src.name}」按人员分组拆分出「${nb.name}」：${move.length} 人（${base.name} 出车 ${vehicleCount} 辆 → ${shelter.name}）；原批次剩 ${src.headcount} 人继续 → ${srcShelterName}`)

      // 联动：新分组路线立即接受生效阻断复核（绕行/改派/挂起）
      try { useRoadblockStore().assessActive() } catch { /* 道路阻断模块未初始化 */ }
      return { ok: true, batch: nb, source: src }
    },

    // 按现有登记进度推导批次状态（拆分后同步办结条件）：
    // 无接运 → 待接运；未全部入住 → 接运中；全部入住 → 已安置；
    // 已安置且在册人员全部转出 → 自动办结并回收车辆（满员批次的自动办结规则）
    _recomputeStatus(b) {
      const picked = b.members.filter((x) => x.pickupAt).length
      const checkedIn = b.members.filter((x) => x.checkinAt).length
      if (picked === 0) b.status = 'pending'
      else if (checkedIn < picked || picked < b.headcount) b.status = 'transporting'
      else b.status = 'settled'
      if (b.status === 'settled' && b.members.length > 0 && b.members.every((x) => x.checkoutAt)) {
        this._close(b)
      }
    },

    /* ---------- 安置点物资联动（按日补给） ---------- */

    // 日结：按实际入住时段结算本日人日与消耗品消耗，库存结余与在途物资结转至次日；
    // 在住快照计入耐用品峰值。日结后结算日 +1，后续登记落入新一日。
    settleShelters() {
      const cmd = this._cmd()
      const day = this.settleDay
      const results = []
      this.shelters.forEach((s) => {
        const members = this.batches.filter((b) => b.shelterId === s.id).flatMap((b) => b.members)
        // 本日人日：Σ 各成员当日入住时段占比
        let personDays = 0
        members.forEach((m) => { personDays += memberDayFrac(m, day) })
        personDays = round2(personDays)
        // 消耗品本日消耗入账（耐用品不耗）
        const consumed = {}
        Object.entries(SUPPLY_PER_CAPITA).forEach(([t, coef]) => {
          if (SUPPLY_DURABLES.includes(t)) return
          const c = round2(personDays * coef)
          if (c > 0) {
            consumed[t] = c
            s.consumed[t] = round2((s.consumed[t] || 0) + c)
          }
        })
        // 日终在住快照 → 耐用品峰值
        const inHouse = members.filter((m) => memberInHouseEndOf(m, day)).length
        s.peakInHouse = Math.max(s.peakInHouse || 0, inHouse)
        // 跨日结转快照：结余库存（实收 - 累计已耗）与在途物资滚存至次日
        const received = {}
        const transit = {}
        cmd.dispatches.forEach((d) => {
          if (d.shelterId !== s.id) return
          const p = dispatchParts(d)
          if (p.received > 0) received[d.type] = (received[d.type] || 0) + p.received
          if (p.inTransit > 0) transit[d.type] = (transit[d.type] || 0) + p.inTransit
        })
        const carry = {}
        Object.keys(SUPPLY_PER_CAPITA).forEach((t) => {
          if (SUPPLY_DURABLES.includes(t)) return
          const oh = round2((received[t] || 0) - (s.consumed[t] || 0))
          if (oh > 0) carry[t] = oh
        })
        const rec = { day, personDays, inHouse, consumed, carry, inTransit: transit }
        s.settlements.push(rec)
        results.push({ shelter: s, ...rec })
      })
      this.settleDay = day + 1
      // 回写关联事件时间线（该安置点服务中的批次所属事件）
      const evIds = [...new Set(this.batches.map((b) => b.eventId))]
      evIds.forEach((id) => this._log(id, `🌙 安置点补给第 ${day} 日日结：消耗按实际入住时段入账，结余库存与在途物资结转至第 ${day + 1} 日`))
      return results
    },

    // 一键补给：按当日核算缺口就近调拨（缺口已扣除实收/结余/在途，不会重复补给）
    autoSupply(shelterId) {
      const cmd = this._cmd()
      const item = this.shelterNeeds.find((x) => x.shelter.id === shelterId)
      if (!item) return { ok: false, msg: '安置点不存在' }
      const gaps = Object.entries(item.gap)
      if (!gaps.length) return { ok: false, msg: '当前无物资缺口（实收+在途已覆盖按日核算需求）' }
      const sent = []
      const unmet = []
      gaps.forEach(([type, g]) => {
        let need = g
        const cands = cmd.bases
          .filter((b) => (b.stock[type] || 0) > 0)
          .map((b) => ({ b, path: roughPath(b.lng, b.lat, item.shelter.lng, item.shelter.lat) }))
          .sort((x, y) => x.path.minutes - y.path.minutes)
        for (const c of cands) {
          if (need <= 0) break
          const take = Math.min(need, c.b.stock[type])
          const rec = cmd.dispatchToShelter({
            baseId: c.b.id, shelterId, shelterName: item.shelter.name,
            lng: item.shelter.lng, lat: item.shelter.lat, type, qty: take
          })
          if (rec) { sent.push(rec); need -= take }
        }
        if (need > 0) unmet.push({ type, qty: need })
      })
      // 补给量回写关联事件时间线（该安置点服务的未办结批次所属事件）
      const evIds = [...new Set(this.batches.filter((b) => b.shelterId === shelterId && b.status !== 'closed').map((b) => b.eventId))]
      evIds.forEach((id) => this._log(id, `📦 安置点「${item.shelter.name}」按日补给 ${sent.length} 批物资（第 ${this.settleDay} 日缺口）`))
      return { ok: true, sent, unmet }
    }
  }
})
