import { defineStore } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useRoadblockStore } from '@/store/roadblock'
import { RESOURCE_TYPES, REPAIR_STATUS, REPAIR_MATERIAL_TYPES } from '@/mock/data'

let roSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 仍在处理中的工单状态（验收通过/失败/撤单之前）
const LIVE_STATUS = ['dispatched', 'accepted', 'done']
const statusMeta = (v) => REPAIR_STATUS.find((s) => s.value === v) || { label: v, color: '#9e9e9e' }

// 道路抢修工单：阻断记录发起 → 指挥员分配队伍/车辆/物资 → 现场接单/上报进度
//            → 完工上报（实际消耗）→ 验收通过解除封闭并重算受影响运输
//            → 延期/失败保留阻断；撤单与完工按实际消耗归还资源
export const useRepairStore = defineStore('repair', {
  state: () => ({
    orders: [],           // 抢修工单
    assigningBlockId: null, // 正在派单（分配队伍/车辆/物资）的阻断
    focusOrderId: null    // 从阻断卡片跳转查看的工单
  }),

  getters: {
    activeOrders: (s) => s.orders.filter((o) => LIVE_STATUS.includes(o.status)),
    // 待接单 + 抢修中（含已延期）
    workingCount(s) {
      return s.orders.filter((o) => o.status === 'dispatched' || o.status === 'accepted').length
    },
    // 待验收
    verifyCount(s) {
      return s.orders.filter((o) => o.status === 'done').length
    },
    orderOfBlock: (s) => (blockId) =>
      s.orders.find((o) => o.blockId === blockId && LIVE_STATUS.includes(o.status)) || null
  },

  actions: {
    _cmd() { return useCommandStore() },
    _rb() { return useRoadblockStore() },
    _order(id) { return this.orders.find((o) => o.id === id) },
    _log(o, text) { o.logs.push({ at: nowStr(), text }) },
    _blockLog(blockId, text) {
      const blk = this._rb().blocks.find((b) => b.id === blockId)
      if (blk) blk.log.push({ at: nowStr(), text })
    },
    // 演示/测试：固定业务时钟（null 恢复真实时间）
    setClock(t) { this.clock = t || null },
    _now() { return this.clock || nowStr() },

    load() {
      this.orders = []
      this.assigningBlockId = null
      this.focusOrderId = null
      this.clock = null
    },
    startAssign(blockId) { this.assigningBlockId = blockId },
    cancelAssign() { this.assigningBlockId = null },
    focusOrder(id) { this.focusOrderId = id },

    /* ---------- 指挥员派单：由阻断记录发起，分配队伍/车辆/物资（即时扣减库存） ---------- */

    createOrder({ blockId, baseId, personnel, vehicles, materials = [], deadline = '', remark = '' }) {
      const rb = this._rb()
      const cmd = this._cmd()
      const blk = rb.blocks.find((b) => b.id === blockId)
      if (!blk) return { ok: false, msg: '阻断记录不存在' }
      if (blk.status !== 'active') return { ok: false, msg: '阻断已恢复，无需抢修' }
      if (this.orderOfBlock(blockId)) return { ok: false, msg: '该阻断已有进行中的抢修工单' }
      const base = cmd.bases.find((b) => b.id === baseId)
      if (!base) return { ok: false, msg: '请选择资源出库基地' }

      personnel = Math.max(0, Math.round(personnel || 0))
      vehicles = Math.max(0, Math.round(vehicles || 0))
      // 同一物资类型多行时合并为一条，防止重复领用
      const merged = {}
      ;(Array.isArray(materials) ? materials : []).forEach((m) => {
        if (!m.type || !REPAIR_MATERIAL_TYPES.includes(m.type)) return
        const qty = Math.max(0, Math.round(m.qty || 0))
        if (qty > 0) merged[m.type] = (merged[m.type] || 0) + qty
      })
      const mats = Object.entries(merged).map(([type, qty]) => ({ type, qty }))
      if (personnel <= 0 && vehicles <= 0 && !mats.length) {
        return { ok: false, msg: '请至少分配抢修人员、车辆或物资' }
      }
      // 库存校验（统一前置校验，避免部分扣减后回滚）
      if ((base.stock.personnel || 0) < personnel) {
        return { ok: false, msg: `${base.name} 救援人员不足（余 ${base.stock.personnel || 0} 人）` }
      }
      if ((base.stock.vehicle || 0) < vehicles) {
        return { ok: false, msg: `${base.name} 救援车辆不足（余 ${base.stock.vehicle || 0} 辆）` }
      }
      for (const m of mats) {
        if ((base.stock[m.type] || 0) < m.qty) {
          return { ok: false, msg: `${base.name} ${RESOURCE_TYPES[m.type].label}不足（余 ${base.stock[m.type] || 0} ${RESOURCE_TYPES[m.type].unit}）` }
        }
      }

      // 扣减占用：人员/车辆/物资出库
      base.stock.personnel = (base.stock.personnel || 0) - personnel
      base.stock.vehicle = (base.stock.vehicle || 0) - vehicles
      mats.forEach((m) => { base.stock[m.type] = (base.stock[m.type] || 0) - m.qty })

      const order = {
        id: 'ro-' + Date.now() + '-' + ++roSeq,
        blockId, blockName: blk.name,
        baseId, baseName: base.name,
        personnel,
        vehicles,
        materials: mats.map((m) => ({
          type: m.type,
          typeLabel: RESOURCE_TYPES[m.type].label,
          unit: RESOURCE_TYPES[m.type].unit,
          qty: m.qty,
          used: 0
        })),
        personnelUsed: 0,
        vehiclesUsed: 0,
        status: 'dispatched',
        progress: 0,
        delayed: false,
        delayCount: 0,
        deadline: deadline || '',
        remark: (remark || '').trim(),
        createdAt: nowStr(),
        acceptedAt: null, doneAt: null, closedAt: null,
        logs: [],
        settled: false,
        settlement: null,
        lastProgressAt: null
      }
      this.orders.unshift(order)
      const parts = []
      if (personnel) parts.push(`队伍 ${personnel} 人`)
      if (vehicles) parts.push(`车辆 ${vehicles} 辆`)
      mats.forEach((m) => parts.push(`${RESOURCE_TYPES[m.type].label} ${m.qty}${RESOURCE_TYPES[m.type].unit}`))
      this._log(order, `📋 指挥员派单：${parts.join('、')}（自 ${base.name} 出库）` + (deadline ? `，计划 ${deadline} 前完工` : ''))
      this._blockLog(blockId, `🔧 发起道路抢修工单：${parts.join('、')}，现场待接单`)
      this.assigningBlockId = null
      return { ok: true, order }
    },

    /* ---------- 现场接单 / 上报进度 / 完工 ---------- */

    // 现场接单
    acceptOrder(orderId) {
      const o = this._order(orderId)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (o.status !== 'dispatched') return { ok: false, msg: '该工单已接单或已办结' }
      o.status = 'accepted'
      o.acceptedAt = nowStr()
      this._log(o, `🙋 现场队伍已接单，抢修开始`)
      this._blockLog(o.blockId, `🔧 抢修队伍已到场接单，开始抢修`)
      return { ok: true }
    },

    // 现场上报进度（0-100，单调递增；到 100% 请完工上报实际消耗）
    reportProgress(orderId, { progress, note = '' } = {}) {
      const o = this._order(orderId)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (o.status !== 'accepted') return { ok: false, msg: '仅抢修中的工单可上报进度' }
      progress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)))
      if (progress < o.progress) {
        return { ok: false, msg: `进度不能回退（当前 ${o.progress}%）` }
      }
      const at = this._now()
      o.progress = progress
      o.lastProgressAt = at
      this._log(o, `📍 进度上报：${progress}%` + (note ? `（${note}）` : ''))
      return { ok: true, progress }
    },

    // 现场完工上报：记录实际消耗，进入待验收（阻断仍保留，验收通过才解除）
    finishOrder(orderId, used = {}) {
      const o = this._order(orderId)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (o.status !== 'accepted') return { ok: false, msg: '仅抢修中的工单可上报完工' }
      this._applyUsed(o, used)
      o.progress = 100
      o.status = 'done'
      o.doneAt = nowStr()
      this._log(o, `🏁 完工上报：现场抢修完成，已登记实际消耗（${this._usedText(o)}），请指挥员验收`)
      this._blockLog(o.blockId, `🔧 抢修完工待验收（道路仍封闭）：实际消耗 ${this._usedText(o)}`)
      return { ok: true }
    },

    /* ---------- 延期 / 失败：保留阻断 ---------- */

    // 延期：工单保持抢修中，阻断继续生效（可多次延期）
    delayOrder(orderId, { reason = '', deadline = '' } = {}) {
      const o = this._order(orderId)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (o.status !== 'accepted') return { ok: false, msg: '仅抢修中的工单可申请延期' }
      o.delayed = true
      o.delayCount += 1
      if (deadline) o.deadline = deadline
      this._log(o, `⏰ 延期申请（第 ${o.delayCount} 次）` + (deadline ? `，新计划完工 ${deadline}` : '') + (reason ? `：${reason}` : ''))
      this._blockLog(o.blockId, `⏰ 抢修延期（第 ${o.delayCount} 次），阻断继续保留`)
      return { ok: true }
    },

    // 失败（抢修失败 / 验收不通过）：保留阻断，按实际消耗结算归还资源
    failOrder(orderId, { reason = '', used = null } = {}) {
      const o = this._order(orderId)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (!LIVE_STATUS.includes(o.status)) return { ok: false, msg: '该工单已结束' }
      if (o.status === 'dispatched') return { ok: false, msg: '工单尚未接单，可直接撤单' }
      const wasVerify = o.status === 'done'
      if (used) this._applyUsed(o, used)
      const st = this._settle(o)
      o.status = 'failed'
      o.closedAt = nowStr()
      const cause = (reason || '').trim() || (wasVerify ? '验收不通过' : '抢修失败')
      this._log(o, `❌ ${cause}，阻断保留；资源结算：${this._returnText(st)}`)
      this._blockLog(o.blockId, `❌ ${wasVerify ? '验收不通过' : '抢修失败'}：阻断保留，可重新派单；剩余资源已归还 ${o.baseName}`)
      return { ok: true }
    },

    // 撤单（待接单/抢修中）：阻断保留，按实际消耗结算归还资源
    cancelOrder(orderId, { reason = '', used = null } = {}) {
      const o = this._order(orderId)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (!['dispatched', 'accepted'].includes(o.status)) {
        return { ok: false, msg: '待验收及已结束的工单不能撤单（待验收请走验收流程）' }
      }
      if (used) this._applyUsed(o, used)
      const st = this._settle(o)
      o.status = 'cancelled'
      o.closedAt = nowStr()
      this._log(o, `🚫 撤单${(reason || '').trim() ? `：${reason.trim()}` : ''}；资源结算：${this._returnText(st)}`)
      this._blockLog(o.blockId, `🚫 抢修工单已撤销，阻断保留，可重新派单；剩余资源已归还 ${o.baseName}`)
      return { ok: true }
    },

    /* ---------- 验收通过：解除封闭 + 重算受影响运输 + 按实际消耗归还 ---------- */

    acceptWork(orderId) {
      const o = this._order(orderId)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (o.status !== 'done') return { ok: false, msg: '仅待验收工单可执行验收' }
      const st = this._settle(o)
      o.status = 'cleared'
      o.closedAt = nowStr()
      this._log(o, `✅ 验收通过：解除道路封闭，受影响运输在剩余阻断视角下重算；资源结算：${this._returnText(st)}`)
      // 解除封闭并联合重排受影响运输（绕行回直/重排、ETA 重算由阻断模块统一处理）
      const rb = this._rb()
      const blk = rb.blocks.find((b) => b.id === o.blockId)
      if (blk?.status === 'active') rb.clearBlock(o.blockId)
      this._blockLog(o.blockId, `✅ 抢修验收通过，道路恢复通行，受影响运输已重算；剩余资源已归还 ${o.baseName}`)
      return { ok: true }
    },

    /* ---------- 阻断被手动恢复：自动办结仍挂在该阻断上的工单 ---------- */

    settleByBlock(blockId, note = '道路恢复通行') {
      const live = this.orders.filter((o) => o.blockId === blockId && LIVE_STATUS.includes(o.status))
      live.forEach((o) => {
        if (o.status === 'dispatched' || o.status === 'accepted') {
          const st = this._settle(o)
          o.status = 'cancelled'
          o.closedAt = nowStr()
          this._log(o, `🚫 阻断由指挥员直接恢复，工单自动撤单（${note}）；资源结算：${this._returnText(st)}`)
        } else if (o.status === 'done') {
          // 已完工待验收：道路已通，视同验收通过自动办结
          const st = this._settle(o)
          o.status = 'cleared'
          o.closedAt = nowStr()
          this._log(o, `✅ 阻断由指挥员直接恢复，待验收工单自动办结（${note}）；资源结算：${this._returnText(st)}`)
        }
      })
      return live.length
    },

    /* ---------- 实际消耗与资源结算 ---------- */

    // 登记实际消耗（不超过派单量；人员/车辆默认 0 消耗即全量归还）
    _applyUsed(o, used) {
      used = used || {}
      if (used.personnel != null) {
        o.personnelUsed = Math.max(0, Math.min(o.personnel, Math.round(Number(used.personnel) || 0)))
      }
      if (used.vehicles != null) {
        o.vehiclesUsed = Math.max(0, Math.min(o.vehicles, Math.round(Number(used.vehicles) || 0)))
      }
      const matUsed = used.materials || {}
      o.materials.forEach((m) => {
        if (matUsed[m.type] != null) {
          m.used = Math.max(0, Math.min(m.qty, Math.round(Number(matUsed[m.type]) || 0)))
        }
      })
    },

    // 结算（幂等）：派单量 − 实际消耗的剩余资源归还出库基地
    _settle(o) {
      if (o.settled) return o.settlement
      const base = this._cmd().bases.find((b) => b.id === o.baseId)
      const returned = { personnel: 0, vehicle: 0, materials: {} }
      if (o.personnel - o.personnelUsed > 0) {
        const n = o.personnel - o.personnelUsed
        if (base) base.stock.personnel = (base.stock.personnel || 0) + n
        returned.personnel = n
      }
      if (o.vehicles - o.vehiclesUsed > 0) {
        const n = o.vehicles - o.vehiclesUsed
        if (base) base.stock.vehicle = (base.stock.vehicle || 0) + n
        returned.vehicle = n
      }
      o.materials.forEach((m) => {
        const n = m.qty - m.used
        if (n > 0) {
          if (base) base.stock[m.type] = (base.stock[m.type] || 0) + n
          returned.materials[m.type] = n
        }
      })
      o.settled = true
      o.settlement = returned
      return returned
    },

    _usedText(o) {
      const parts = []
      if (o.personnel) parts.push(`人员 ${o.personnelUsed}/${o.personnel}人`)
      if (o.vehicles) parts.push(`车辆 ${o.vehiclesUsed}/${o.vehicles}辆`)
      o.materials.forEach((m) => parts.push(`${m.typeLabel} ${m.used}/${m.qty}${m.unit}`))
      return parts.join('、') || '无'
    },
    _returnText(st) {
      const parts = []
      if (st.personnel) parts.push(`人员 ${st.personnel}人`)
      if (st.vehicle) parts.push(`车辆 ${st.vehicle}辆`)
      Object.entries(st.materials).forEach(([type, n]) => {
        parts.push(`${RESOURCE_TYPES[type].label} ${n}${RESOURCE_TYPES[type].unit}`)
      })
      return parts.length ? `归还 ${parts.join('、')}` : '无剩余资源归还'
    },
    statusLabel(v) { return statusMeta(v).label },
    statusColor(v) { return statusMeta(v).color }
  }
})
