import { defineStore } from 'pinia'
import { useCommandStore, pathMetrics, dispatchParts } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRepairStore } from '@/store/repair'
import { pointInPolygon, pathBlocked, firstBlocker, detourPathMulti } from '@/utils/geo'

let blkSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 阻断恢复后联动抢修工单自动办结（repair store 尚未注册时静默跳过）
function notifyBlockCleared(blockId) {
  try {
    useRepairStore().settleByBlock(blockId, '道路恢复通行')
  } catch { /* 抢修模块未初始化 */ }
}

// 道路阻断处置：现场上报 → 影响评估 → 指挥员确认 → 绕行/改派/挂起 → 恢复通行 → 续派
export const useRoadblockStore = defineStore('roadblock', {
  state: () => ({
    blocks: [],          // 道路阻断记录
    drawing: false,      // 地图圈画模式
    draft: [],           // 圈画中的顶点
    reporting: false,    // 上报表单打开中
    selectedBlockId: null
  }),

  getters: {
    activeBlocks: (s) => s.blocks.filter((b) => b.status === 'active'),
    // 所有生效阻断的封闭范围（绕行/改派/续派必须全部避开——联合避障）
    activePolygons() { return this.activeBlocks.map((b) => b.polygon) },
    heldDispatches() {
      return useCommandStore().dispatches.filter((d) => d.status === 'held' && dispatchParts(d).outstanding > 0)
    },
    heldBatches() {
      return useTransferStore().batches.filter((b) => b.held)
    },
    heldCount() { return this.heldDispatches.length + this.heldBatches.length }
  },

  actions: {
    _cmd() { return useCommandStore() },
    _tr() { return useTransferStore() },
    _block(id) { return this.blocks.find((b) => b.id === id) },
    _log(blk, text) { blk.log.push({ at: nowStr(), text }) },

    // 任务当前状态快照：起点/终点/当前路线折点/持有状态
    _taskState(kind, id) {
      const cmd = this._cmd()
      const tr = this._tr()
      if (kind === 'dispatch') {
        const d = cmd.dispatches.find((x) => x.id === id)
        if (!d) return null
        const base = cmd.bases.find((b) => b.id === d.baseId)
        if (!base) return null
        const a = [base.lng, base.lat], z = [d.lng, d.lat]
        return {
          kind, ref: d, a, z,
          pts: [a, ...(d.via || []), z],
          held: d.status === 'held',
          dist: d.distance, mins: d.minutes
        }
      }
      const b = tr.batches.find((x) => x.id === id)
      if (!b) return null
      const ev = cmd.events.find((e) => e.id === b.eventId)
      const sh = tr.shelters.find((s) => s.id === b.shelterId)
      if (!ev || !sh) return null
      const a = [ev.location.lng, ev.location.lat], z = [sh.lng, sh.lat]
      return {
        kind, ref: b, a, z,
        pts: [a, ...(b.via || []), z],
        held: !!b.held,
        dist: b.eta?.distance || 0, mins: b.eta?.minutes || 0
      }
    },

    load() {
      this.blocks = []
      this.drawing = false
      this.draft = []
      this.reporting = false
      this.selectedBlockId = null
    },

    /* ---------- 现场上报：地图圈画封闭范围 ---------- */

    startDrawing() {
      this.drawing = true
      this.draft = []
      this.reporting = false
    },
    addDraftPoint(lng, lat) {
      const last = this.draft[this.draft.length - 1]
      if (last && Math.abs(last[0] - lng) < 1e-6 && Math.abs(last[1] - lat) < 1e-6) return
      this.draft.push([+lng.toFixed(6), +lat.toFixed(6)])
    },
    undoDraftPoint() { this.draft.pop() },
    cancelDrawing() { this.drawing = false; this.draft = [] },
    cancelReport() { this.reporting = false; this.draft = [] },
    finishDrawing() {
      // 双击/右键收尾时去除过近的重复点
      const pts = []
      this.draft.forEach((p) => {
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.0005) pts.push(p)
      })
      if (pts.length < 3) return false
      this.draft = pts
      this.drawing = false
      this.reporting = true
      return true
    },
    // 快捷上报：在当前事件与最近资源基地的运输走廊上生成封闭区（演示用）
    quickPolygon(eventId) {
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === eventId)
      if (!ev) return null
      let nb = null, best = Infinity
      cmd.bases.forEach((b) => {
        const d = Math.hypot(b.lng - ev.location.lng, b.lat - ev.location.lat)
        if (d < best) { best = d; nb = b }
      })
      const cx = (ev.location.lng + (nb?.lng ?? ev.location.lng + 0.2)) / 2
      const cy = (ev.location.lat + (nb?.lat ?? ev.location.lat)) / 2
      const r = 0.055
      const poly = []
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6
        poly.push([+(cx + r * Math.cos(a)).toFixed(5), +(cy + r * Math.sin(a) * 1.15).toFixed(5)])
      }
      return poly
    },

    // 提交上报：落库并自动做影响评估
    reportBlock({ name, reason, reporter, polygon }) {
      if (!polygon || polygon.length < 3) return { ok: false, msg: '封闭范围至少需要 3 个顶点' }
      const blk = {
        id: 'blk-' + Date.now() + '-' + ++blkSeq,
        name: name?.trim() || `道路阻断-${this.blocks.length + 1}`,
        reason: reason || '道路中断',
        reporter: reporter?.trim() || '现场巡查员',
        polygon,
        status: 'active',
        reportedAt: nowStr(),
        clearedAt: null,
        impacts: [],     // 影响评估结果（指挥员确认后生成方案）
        confirmed: false,
        log: []
      }
      this.blocks.unshift(blk)
      this._log(blk, `🚧 ${blk.reporter} 上报道路封闭范围（${polygon.length} 个顶点）`)
      this.reporting = false
      this.draft = []
      this.selectedBlockId = blk.id
      this.assess(blk.id)
      // 新阻断上报后，已生效阻断的既有方案也需在联合视角下重新复核
      this.assessActive(blk.id)
      return { ok: true, block: blk }
    },

    /* ---------- 影响评估：路线与封闭范围相交的在途派发 / 转移批次 ---------- */

    // 扫描单个阻断，产出原始影响清单
    _scanImpacts(blk) {
      const cmd = this._cmd()
      const tr = this._tr()
      const impacts = []
      cmd.dispatches.forEach((d) => {
        // 挂起（已退回基地）、已办结（全部签收/短缺/退回）与已撤回（在途回库留档）的派发均不构成在途影响
        if (d.status === 'held' || d.status === 'done' || d.status === 'withdrawn') return
        if (dispatchParts(d).outstanding <= 0) return
        const base = cmd.bases.find((b) => b.id === d.baseId)
        if (!base) return
        const pts = [[base.lng, base.lat], ...(d.via || []), [d.lng, d.lat]]
        const destIn = pointInPolygon([d.lng, d.lat], blk.polygon)
        const originIn = pointInPolygon([base.lng, base.lat], blk.polygon)
        if (destIn || originIn || pathBlocked(pts, blk.polygon)) {
          impacts.push({
            key: d.id, kind: 'dispatch', id: d.id, checked: true,
            destInside: destIn, originInside: originIn,
            label: `${d.typeLabel} ${dispatchParts(d).inTransit}${d.unit}｜${d.baseName} → ${d.eventTitle || d.shelterName}`,
            done: false, plan: null, options: [], result: null
          })
        }
      })
      tr.batches.forEach((b) => {
        if (b.status === 'closed' || b.held) return
        const ev = cmd.events.find((e) => e.id === b.eventId)
        const sh = tr.shelters.find((s) => s.id === b.shelterId)
        if (!ev || !sh) return
        const pts = [[ev.location.lng, ev.location.lat], ...(b.via || []), [sh.lng, sh.lat]]
        const destIn = pointInPolygon([sh.lng, sh.lat], blk.polygon)
        const originIn = pointInPolygon([ev.location.lng, ev.location.lat], blk.polygon)
        if (destIn || originIn || pathBlocked(pts, blk.polygon)) {
          impacts.push({
            key: b.id, kind: 'batch', id: b.id, checked: true,
            destInside: destIn, originInside: originIn,
            label: `${b.name} ${b.headcount}人｜${ev.location.name} → ${sh.name}`,
            done: false, plan: null, options: [], result: null
          })
        }
      })
      return impacts
    },

    // 全量重新评估（手动 / 新上报）：丢弃指挥员尚未执行的旧方案
    assess(blockId) {
      const blk = this._block(blockId)
      if (!blk) return
      blk.impacts = this._scanImpacts(blk)
      blk.confirmed = false
      const nd = blk.impacts.filter((i) => i.kind === 'dispatch').length
      const nb = blk.impacts.filter((i) => i.kind === 'batch').length
      this._log(blk, `🔍 影响评估：${nd} 条物资派发、${nb} 个转移批次受影响`)
    },

    // 合并式复核（任务新建 / 新阻断生效后自动触发）：保留已确认/已执行状态，仅刷新未决项
    assessActive(skipBlockId = null) {
      this.activeBlocks.forEach((blk) => {
        if (blk.id === skipBlockId) return
        const scanned = this._scanImpacts(blk)
        const freshByKey = new Map(scanned.map((i) => [i.key, i]))
        const kept = []
        blk.impacts.forEach((old) => {
          const fresh = freshByKey.get(old.key)
          if (!fresh) {
            // 路线已不再穿越本阻断：未决项移除（由联动处置/复核消费）；
            // 已执行项保留为历史记录，便于卡片展示处置结论
            if (old.done) kept.push(old)
            return
          }
          if (old.done) {
            const st = this._taskState(old.kind, old.id)
            if (st?.held) { kept.push(old); return } // 已挂起：销项结论仍成立
            // 路线因后续绕行/改派再次穿越本阻断 → 已处置结论失效，重新转为待处置
            fresh.checked = true
            kept.push(fresh)
            if (blk.confirmed) this._refreshOptions(blk, fresh)
            return
          }
          fresh.checked = old.checked
          fresh.options = old.options
          fresh.plan = old.plan
          kept.push(fresh)
        })
        // 新出现的影响（如新建立的派发穿越本阻断）
        scanned.forEach((fresh) => {
          if (!blk.impacts.some((o) => o.key === fresh.key)) {
            kept.push(fresh)
            if (blk.confirmed) this._refreshOptions(blk, fresh)
          }
        })
        blk.impacts = kept
      })
    },

    /* ---------- 指挥员确认影响 → 生成绕行/改派方案 ---------- */

    confirmImpacts(blockId) {
      const blk = this._block(blockId)
      if (!blk) return
      blk.impacts.forEach((imp) => {
        if (imp.checked && !imp.done) this._refreshOptions(blk, imp)
      })
      blk.confirmed = true
      const n = blk.impacts.filter((i) => i.checked).length
      this._log(blk, `✔️ 指挥员确认 ${n} 项影响，已生成绕行/改派方案`)
      // 回写受影响事件时间线
      const cmd = this._cmd()
      const tr = this._tr()
      const evIds = new Set()
      blk.impacts.filter((i) => i.checked).forEach((i) => {
        if (i.kind === 'dispatch') {
          const d = cmd.dispatches.find((x) => x.id === i.id)
          if (d?.eventId) evIds.add(d.eventId)
        } else {
          const b = tr.batches.find((x) => x.id === i.id)
          if (b) evIds.add(b.eventId)
        }
      })
      evIds.forEach((id) => {
        const ev = cmd.events.find((e) => e.id === id)
        if (ev) ev.timeline.push({ at: nowStr(), text: `🚧 道路阻断「${blk.name}」生效，相关派发/转移任务已生成绕行或改派方案` })
      })
    },

    // 刷新候选方案并保留指挥员已选动作（原动作仍可行时）
    _refreshOptions(blk, imp) {
      const opts = this._optionsFor(blk, imp)
      const prev = imp.plan
      imp.options = opts
      if (prev) {
        const same = opts.find((o) =>
          o.action === prev.action &&
          (o.baseId === undefined || o.baseId === prev.baseId) &&
          (o.shelterId === undefined || o.shelterId === prev.shelterId))
        imp.plan = same || opts[0] || null
      } else {
        imp.plan = opts[0] || null // 默认推荐：绕行优先，其次改派，兜底挂起
      }
    },

    // 单个影响对象的候选方案：联合避障绕行 → 改派（路线避开全部生效阻断）→ 挂起
    _optionsFor(blk, imp) {
      const cmd = this._cmd()
      const tr = this._tr()
      const opts = []
      const polys = this.activePolygons
      const st = this._taskState(imp.kind, imp.id)
      if (!st) return opts
      const destInsideAny = polys.some((p) => pointInPolygon(st.z, p))
      const originInsideAny = polys.some((p) => pointInPolygon(st.a, p))

      if (imp.kind === 'dispatch') {
        const d = st.ref
        const moveQty = dispatchParts(d).outstanding
        if (!destInsideAny) {
          if (!originInsideAny) {
            // 联合绕行：一次绕行同时避开所有生效封闭区
            const det = detourPathMulti(st.a, st.z, polys)
            if (det) {
              const m = pathMetrics([st.a, ...det.via, st.z])
              opts.push({
                action: 'detour', via: det.via, distance: m.distance, minutes: m.minutes,
                label: det.via.length
                  ? `联合绕行 +${(m.distance - (d.distance || m.distance)).toFixed(1)}km·+${m.minutes - (d.minutes || m.minutes)}min`
                  : '当前路线已可直接通行'
              })
            }
          }
          // 改派基地：在途余量库存足够、新路线不穿越任何生效阻断（出发地在区内时靠换基地撤出）
          const alt = cmd.bases
            .filter((b) => b.id !== d.baseId && (b.stock[d.type] || 0) >= moveQty)
            .filter((b) => firstBlocker([[b.lng, b.lat], st.z], polys) < 0)
            .map((b) => ({ b, m: pathMetrics([[b.lng, b.lat], st.z]) }))
            .sort((x, y) => x.m.minutes - y.m.minutes)[0]
          if (alt) {
            opts.push({
              action: 'reassign', baseId: alt.b.id, baseName: alt.b.name,
              distance: alt.m.distance, minutes: alt.m.minutes,
              label: `改派自「${alt.b.name}」 ${alt.m.distance}km·${alt.m.minutes}min`
            })
          }
        }
        const why = destInsideAny ? '目的地在封闭区内 · 挂起待通（物资退回基地）'
          : originInsideAny ? '出发基地在封闭区内 · 挂起待通（物资退回基地）'
          : '挂起待通（物资退回基地）'
        opts.push({ action: 'suspend', label: why })
      } else {
        const b = st.ref
        if (!destInsideAny && !originInsideAny) {
          const det = detourPathMulti(st.a, st.z, polys)
          if (det) {
            const m = pathMetrics([st.a, ...det.via, st.z])
            opts.push({
              action: 'detour', via: det.via, distance: m.distance, minutes: m.minutes,
              label: det.via.length
                ? `联合绕行 +${(m.distance - (b.eta?.distance || m.distance)).toFixed(1)}km·+${m.minutes - (b.eta?.minutes || m.minutes)}min`
                : '当前路线已可直接通行'
            })
          }
        }
        if (!originInsideAny && !b.members.some((x) => x.checkinAt)) {
          // 改派安置点：床位足够、新路线不穿越任何生效阻断
          const alt = tr.shelters
            .filter((s) => s.id !== b.shelterId && tr.bedMap[s.id].left >= b.headcount)
            .filter((s) => firstBlocker([st.a, [s.lng, s.lat]], polys) < 0)
            .map((s) => ({ s, m: pathMetrics([st.a, [s.lng, s.lat]]) }))
            .sort((x, y) => x.m.minutes - y.m.minutes)[0]
          if (alt) {
            opts.push({
              action: 'reassign', shelterId: alt.s.id, shelterName: alt.s.name,
              distance: alt.m.distance, minutes: alt.m.minutes,
              label: `改派至「${alt.s.name}」 ${alt.m.distance}km·${alt.m.minutes}min`
            })
          }
        }
        const why = destInsideAny ? '安置点在封闭区内 · 挂起待通（保留车辆/床位预占）'
          : originInsideAny ? '受灾点在封闭区内 · 挂起待通（保留车辆/床位预占）'
          : '挂起待通（保留车辆/床位预占）'
        opts.push({ action: 'suspend', label: why })
      }
      return opts
    },

    /* ---------- 执行方案：执行前复核 + 同步路线/ETA/车辆床位 + 跨阻断联动 ---------- */

    applyImpact(blockId, key) {
      const blk = this._block(blockId)
      const imp = blk?.impacts.find((i) => i.key === key)
      if (!blk || !imp || imp.done || !imp.plan) return { ok: false, msg: '无待执行方案' }
      const cmd = this._cmd()
      const tr = this._tr()

      // 方案执行前复核：按当前库存/床位与全部生效阻断重新生成候选
      const fresh = this._optionsFor(blk, imp)
      const wanted = imp.plan
      let p = fresh.find((o) =>
        o.action === wanted.action &&
        (o.baseId === undefined || o.baseId === wanted.baseId) &&
        (o.shelterId === undefined || o.shelterId === wanted.shelterId))
      let adjusted = false
      if (!p) {
        // 原方案已不可行（库存被占用 / 新阻断封堵）：按 绕行 → 改派 → 挂起 自动调整
        p = fresh.find((o) => o.action === 'detour')
          || fresh.find((o) => o.action === 'reassign')
          || fresh.find((o) => o.action === 'suspend')
        adjusted = true
      }
      if (!p) return { ok: false, msg: '复核失败：当前无可行方案' }

      let ok = true, msg = ''
      if (imp.kind === 'dispatch') {
        if (p.action === 'detour') {
          const r = cmd.rerouteDispatch(imp.id, p.via, blk.id)
          ok = !!r
          msg = ok ? `派发已绕行改道（${p.distance}km·${p.minutes}min）` : '绕行失败：派发状态异常'
        } else if (p.action === 'reassign') {
          const r = cmd.reassignDispatch(imp.id, p.baseId)
          ok = !!r
          msg = ok ? `派发已改派自 ${p.baseName}` : '改派失败：目标基地库存不足'
        } else {
          cmd.holdDispatch(imp.id, blk.id)
          msg = '派发已挂起，物资退回基地'
        }
        // 改派在复核后仍失败（库存竞态）：兜底挂起
        if (!ok && p.action === 'reassign') {
          cmd.holdDispatch(imp.id, blk.id)
          p = fresh.find((o) => o.action === 'suspend') || { action: 'suspend' }
          msg = '改派目标库存已不足，已转为挂起待通'
          ok = true
          adjusted = true
        }
      } else {
        if (p.action === 'detour') {
          const r = tr.rerouteBatch(imp.id, p.via, blk.id)
          ok = !!r
          msg = ok ? `批次已绕行改道（${p.distance}km·${p.minutes}min）` : '绕行失败：批次状态异常'
        } else if (p.action === 'reassign') {
          const r = tr.reassignBatch(imp.id, { shelterId: p.shelterId })
          ok = r.ok
          msg = ok ? `批次已改派至 ${p.shelterName}（车辆/床位占用已同步）` : r.msg
        } else {
          tr.holdBatch(imp.id, blk.id)
          msg = '批次已挂起（保留车辆/床位预占）'
        }
        if (!ok && p.action === 'reassign') {
          tr.holdBatch(imp.id, blk.id)
          p = fresh.find((o) => o.action === 'suspend') || { action: 'suspend' }
          msg = '改派安置点已不可用，已转为挂起待通'
          ok = true
          adjusted = true
        }
      }
      if (!ok) return { ok, msg }

      imp.plan = p
      imp.done = true
      imp.result = { action: p.action, msg }
      if (adjusted) {
        const note = `⚠️ 方案执行前复核：原方案（${wanted.action}）已不可行，自动调整为「${p.action}」`
        this._log(blk, note)
      }
      this._log(blk, `✅ ${msg}`)

      // 跨阻断联动：同步其它生效阻断上同一任务的影响项与路线状态
      this._reconcileOthers(imp.kind, imp.id, blk.id)
      return { ok: true, msg }
    },

    // 联动处理其它生效阻断上同一任务的影响：挂起/已绕开即销项，仍受影响则刷新方案
    _reconcileOthers(kind, id, sourceBlockId) {
      const st = this._taskState(kind, id)
      if (!st) return
      this.activeBlocks.forEach((blk) => {
        if (blk.id === sourceBlockId) return
        const imp = blk.impacts.find((i) => i.key === id)
        if (!imp || imp.done) return
        if (st.held) {
          imp.checked = true
          imp.done = true
          imp.result = { action: 'suspend', msg: `由阻断联动挂起（${this._block(sourceBlockId)?.name || '其它阻断'} 处置）` }
          return
        }
        // 当前路线是否仍穿越该阻断（仅看它自己的封闭区）
        const destIn = pointInPolygon(st.z, blk.polygon)
        const originIn = pointInPolygon(st.a, blk.polygon)
        if (!destIn && !originIn && !pathBlocked(st.pts, blk.polygon)) {
          imp.checked = true
          imp.done = true
          imp.result = { action: 'linked', msg: `由「${this._block(sourceBlockId)?.name || '其它阻断'}」联动处置，路线已绕开本阻断` }
          return
        }
        // 仍受影响：同步最新几何标记并刷新候选，保持待执行
        imp.destInside = destIn
        imp.originInside = originIn
        if (imp.checked) this._refreshOptions(blk, imp)
      })
    },

    applyAll(blockId) {
      const blk = this._block(blockId)
      if (!blk) return 0
      let n = 0
      // 每次执行后态势可能变化（改派扣库存等），逐个复核后顺序执行
      blk.impacts.filter((i) => i.checked && !i.done && i.plan).forEach((i) => {
        if (this.applyImpact(blockId, i.key).ok) n++
      })
      return n
    },

    /* ---------- 恢复通行 → 路线联合重算 / 挂起任务续派 ---------- */

    clearBlock(blockId) {
      const blk = this._block(blockId)
      if (!blk || blk.status !== 'active') return
      blk.status = 'cleared'
      blk.clearedAt = nowStr()
      this._log(blk, '✅ 道路恢复通行')
      const cmd = this._cmd()
      const tr = this._tr()
      const polys = this.activePolygons
      let straightened = 0, rerouted = 0, stranded = 0

      // 所有绕行中的路线都在剩余阻断视角下联合重算：能回直则回直，仍需绕行则重排
      cmd.dispatches.forEach((d) => {
        if (d.status !== 'enroute' || dispatchParts(d).outstanding <= 0) return
        if (!d.detourBy || !(d.via || []).length) return
        const base = cmd.bases.find((b) => b.id === d.baseId)
        if (!base) return
        const a = [base.lng, base.lat], z = [d.lng, d.lat]
        const cur = [a, ...d.via, z]
        if (firstBlocker(cur, polys) < 0 && firstBlocker([a, z], polys) < 0) {
          cmd.resetDispatchRoute(d.id)
          straightened++
          return
        }
        const det = detourPathMulti(a, z, polys)
        if (det && det.via.length) {
          const ownerIdx = firstBlocker([a, z], polys)
          const ownerId = ownerIdx >= 0 ? this.activeBlocks[ownerIdx].id : d.detourBy
          cmd.rerouteDispatch(d.id, det.via, ownerId, true)
          rerouted++
        } else if (!det) {
          stranded++
        } else {
          // 联合解为直线
          cmd.resetDispatchRoute(d.id)
          straightened++
        }
      })

      tr.batches.forEach((b) => {
        if (b.status === 'closed' || b.held || !b.detourBy || !(b.via || []).length) return
        const ev = cmd.events.find((e) => e.id === b.eventId)
        const sh = tr.shelters.find((s) => s.id === b.shelterId)
        if (!ev || !sh) return
        const a = [ev.location.lng, ev.location.lat], z = [sh.lng, sh.lat]
        const cur = [a, ...b.via, z]
        if (firstBlocker(cur, polys) < 0 && firstBlocker([a, z], polys) < 0) {
          tr.resetBatchRoute(b.id)
          straightened++
          return
        }
        const det = detourPathMulti(a, z, polys)
        if (det && det.via.length) {
          const ownerIdx = firstBlocker([a, z], polys)
          const ownerId = ownerIdx >= 0 ? this.activeBlocks[ownerIdx].id : b.detourBy
          tr.rerouteBatch(b.id, det.via, ownerId, true)
          rerouted++
        } else if (!det) {
          stranded++
        } else {
          tr.resetBatchRoute(b.id)
          straightened++
        }
      })

      if (straightened) this._log(blk, `↩️ ${straightened} 条绕行路线恢复直线`)
      if (rerouted) this._log(blk, `🔀 ${rerouted} 条路线在剩余生效阻断下重新联合绕行`)
      if (stranded) this._log(blk, `⚠️ ${stranded} 条任务的起/终点仍在其它封闭区内，保持现有路线待处置`)

      // 联动：该阻断上仍在进行的抢修工单自动办结/撤单并按实际消耗归还资源
      notifyBlockCleared(blk.id)
    },

    // 一键续派：挂起任务逐个复核路线与库存（仍被任一生效阻断穿越的保持挂起）
    resumeHeld() {
      const cmd = this._cmd()
      const tr = this._tr()
      const polys = this.activePolygons
      const destBlocked = (lng, lat) => polys.some((p) => pointInPolygon([lng, lat], p))
      let resumed = 0, kept = 0, failed = 0
      cmd.dispatches.filter((d) => d.status === 'held' && dispatchParts(d).outstanding > 0).forEach((d) => {
        const base = cmd.bases.find((b) => b.id === d.baseId)
        if (!base) { kept++; return }
        const straight = [[base.lng, base.lat], [d.lng, d.lat]]
        if (destBlocked(d.lng, d.lat) || polys.some((p) => pathBlocked(straight, p))) { kept++; return }
        if (cmd.resumeDispatch(d.id).ok) resumed++
        else failed++
      })
      tr.batches.filter((b) => b.held).forEach((b) => {
        const ev = cmd.events.find((e) => e.id === b.eventId)
        const sh = tr.shelters.find((s) => s.id === b.shelterId)
        if (!ev || !sh) { kept++; return }
        const straight = [[ev.location.lng, ev.location.lat], [sh.lng, sh.lat]]
        if (destBlocked(sh.lng, sh.lat) || polys.some((p) => pathBlocked(straight, p))) { kept++; return }
        tr.resumeBatch(b.id)
        resumed++
      })
      return { resumed, kept, failed }
    },

    // 删除已恢复的历史阻断记录
    removeBlock(id) {
      const blk = this._block(id)
      if (!blk || blk.status !== 'cleared') return
      this.blocks = this.blocks.filter((b) => b.id !== id)
      if (this.selectedBlockId === id) this.selectedBlockId = null
    }
  }
})
