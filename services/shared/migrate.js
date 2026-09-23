/* =========================================================================
 * migrateLegacy —— 旧版全量快照历史 -> 事件流
 *
 * 旧前端（Pinia 单体）每个动作存一帧「全量快照」：
 *   frames[i] = { module, action, snapshot: { cmd:{events,bases,dispatches},
 *                                            tr:{shelters,batches}, rb, ro } }
 * 新架构只存不可变增量事件。迁移策略：
 *   1. 第 0 帧的 bases/shelters => realm.opened 基线；
 *   2. 相邻帧按主键 diff，把库存/床位/运输/阻断/抢修的变化翻译成对应事件；
 *      翻译结果在 reducer 上逐帧试折叠，任何一帧折叠后视图与原快照关键账目不一致，
 *      则把该帧降级为「快照锚点」（snapshot.anchor 事件，整体兜底校准），保证不丢真值；
 *   3. 旧单线 frames => 单主干分支 main（loadLegacyFrames 的语义延续），首次分叉即升级。
 *
 * 迁移是一次性、纯函数、可重跑的（输出带 migratedFrom 标记；已迁移过的快照拒绝二次迁移）。
 * ========================================================================= */

import { clone, ensure, stableStringify } from './util.js'
import { EVENT_TYPES, makeEvent } from './events.js'
import { emptyState, fold, projectView } from './reducer.js'

// 旧资源类型/状态字段到新模型的映射（旧 mock 中 stock key 直接沿用）
const DP_OLD_STATUS = { enroute: 'enroute', held: 'held', done: 'closed', withdrawn: 'withdrawn' }

function baseStock(prevFrame, nextFrame, baseId) {
  const a = prevFrame?.snapshot?.cmd?.bases?.find((b) => b.id === baseId)?.stock || {}
  const b = nextFrame.snapshot.cmd.bases.find((x) => x.id === baseId)?.stock || {}
  return { a, b }
}

// 一帧内的床位在住：旧快照按 batches 成员 checkinAt/checkoutAt 汇总
function shelterOccupied(snap, shelterId) {
  return (snap.tr?.batches || [])
    .filter((bt) => bt.shelterId === shelterId)
    .reduce((n, bt) => n + (bt.members || []).filter((m) => m.checkinAt && !m.checkoutAt).length, 0)
}

let _seq = 0
const migrationId = (kind, key) => `mig-${kind}-${key}-${_seq++}`

/**
 * @param {object} legacy { frames: [...], realm?, name? }  旧版单线历史（或纯场景快照）
 * @returns {{ events: object[], report: object }}
 */
export function migrateLegacy(legacy = {}) {
  const frames = Array.isArray(legacy.frames) ? legacy.frames : null
  ensure(frames && frames.length, 'no_legacy_frames', '旧快照为空或结构不被识别（需要 frames[]）', 400)
  const firstSnap = frames[0].snapshot
  ensure(firstSnap?.cmd?.bases, 'bad_legacy_snapshot', '旧快照缺少 cmd.bases，无法迁移', 400)

  const realm = legacy.realm || 'real' // 旧数据来自真实前端时默认进真实域；演练导入可指定
  const events = []
  const push = (type, data, frame, extra = {}) => {
    events.push(makeEvent({
      realm,
      branchId: 'main',
      type,
      data,
      clientId: 'migration',
      actor: 'legacy-migrator',
      happenedAt: frame?.t || Date.now(),
      ...extra
    }))
  }

  /* 1) 基线帧 */
  const baselineBases = firstSnap.cmd.bases.map((b) => ({ id: b.id, name: b.name, stock: { ...(b.stock || {}) } }))
  const baselineShelters = (firstSnap.tr?.shelters || []).map((s) => ({
    id: s.id, name: s.name, capacity: s.capacity
  }))
  push(EVENT_TYPES.REALM_OPENED, {
    realm,
    name: legacy.name || '迁移自旧版快照',
    bases: baselineBases,
    shelters: baselineShelters,
    settleDay: firstSnap.tr?.settleDay || 1,
    migratedFrom: 'legacy-frames-v1'
  }, frames[0], { eventId: 'mig-realm-open' })

  /* 2) 逐帧 diff */
  const report = { frames: frames.length, translated: 0, anchors: 0, skipped: 0, warnings: [] }
  // 记录旧实体 -> 新 refId 的映射（库存变动通过事件直接表达，运输单按旧 dispatch id 迁移）
  const migratedShipments = new Map()
  const migrationState = emptyState()
  fold(events.slice(), migrationState)

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]
    const next = frames[i]
    const beforeEvents = events.length

    /* --- 库存：各基地各资源余量变化 -> granted 调整（迁移期不还原预占过程，只对齐实物账） --- */
    next.snapshot.cmd.bases.forEach((b) => {
      const { a, b: nb } = baseStock(prev, next, b.id)
      Object.keys({ ...a, ...nb }).forEach((res) => {
        const ov = a[res] ?? nb[res]
        const nv = nb[res] ?? 0
        if (ov !== nv) {
          push(EVENT_TYPES.STOCK_GRANTED, {
            baseId: b.id, resource: res, qty: nv - ov,
            reason: `legacy-diff frame#${i}（余量 ${ov}→${nv}，预占过程不回溯）`
          }, next)
        }
      })
    })

    /* --- 床位：在住人数变化（容量不变） --- */
    next.snapshot.tr.shelters.forEach((s) => {
      const ov = shelterOccupied(prev.snapshot, s.id)
      const nv = shelterOccupied(next.snapshot, s.id)
      if (ov !== nv) {
        const d = nv - ov
        if (d > 0) push(EVENT_TYPES.BED_OCCUPIED, { shelterId: s.id, qty: d, refId: migrationId('bed', s.id) }, next)
        else push(EVENT_TYPES.BED_FREED, { shelterId: s.id, qty: -d, refId: migrationId('bedfree', s.id) }, next)
      }
    })

    /* --- 运输单：新增 / 状态变化 / 签收 / 退回 --- */
    const oldDps = new Map((prev.snapshot.cmd.dispatches || []).map((d) => [d.id, d]))
    ;(next.snapshot.cmd.dispatches || []).forEach((d) => {
      const old = oldDps.get(d.id)
      if (!old) {
        migratedShipments.set(d.id, d.id)
        push(EVENT_TYPES.SHIPMENT_CREATED, {
          shipmentId: d.id, kind: 'supply',
          resource: d.type, qty: d.qty, baseId: d.baseId,
          target: d.eventId ? { eventId: d.eventId } : { shelterId: d.shelterId },
          route: d.distance != null ? { distance: d.distance, minutes: d.minutes, via: d.via || [] } : null,
          legacy: true
        }, next)
        if ((d.signedQty || 0) > 0) {
          push(EVENT_TYPES.SHIPMENT_DELIVERED, { shipmentId: d.id, qty: d.signedQty, shortQty: d.shortQty || 0 }, next)
        }
      } else {
        if ((old.signedQty || 0) !== (d.signedQty || 0)) {
          push(EVENT_TYPES.SHIPMENT_DELIVERED, {
            shipmentId: d.id,
            qty: (d.signedQty || 0) - (old.signedQty || 0),
            shortQty: (d.shortQty || 0) - (old.signedQty || 0),
            partial: d.status === 'enroute'
          }, next)
        }
        if ((old.returnedQty || 0) !== (d.returnedQty || 0)) {
          push(EVENT_TYPES.SHIPMENT_DELIVERED === '' ? '' : EVENT_TYPES.SHIPMENT_RETURNED, {
            shipmentId: d.id, qty: (d.returnedQty || 0) - (old.returnedQty || 0)
          }, next)
        }
        const oldStatus = DP_OLD_STATUS[old.status] || old.status
        const newStatus = DP_OLD_STATUS[d.status] || d.status
        if (oldStatus !== newStatus) {
          push(EVENT_TYPES.SHIPMENT_CLOSED, {
            shipmentId: d.id, status: newStatus, withdrawn: d.status === 'withdrawn'
          }, next)
        }
      }
    })

    /* --- 阻断 --- */
    const oldBlocks = new Map((prev.snapshot.rb?.blocks || []).map((b) => [b.id, b]))
    ;(next.snapshot.rb?.blocks || []).forEach((b) => {
      if (!oldBlocks.has(b.id)) {
        push(EVENT_TYPES.BLOCK_REPORTED, { blockId: b.id, name: b.name, polygon: b.polygon || [] }, next)
      } else if (oldBlocks.get(b.id).status !== b.status && b.status !== 'active') {
        push(EVENT_TYPES.BLOCK_CLEARED, { blockId: b.id }, next)
      }
    })

    /* --- 抢修工单 --- */
    const oldOrders = new Map((prev.snapshot.ro?.orders || []).map((o) => [o.id, o]))
    ;(next.snapshot.ro?.orders || []).forEach((o) => {
      const old = oldOrders.get(o.id)
      if (!old) {
        push(EVENT_TYPES.REPAIR_ORDER_CREATED, { orderId: o.id, blockId: o.blockId, baseId: o.baseId }, next)
      } else {
        if ((old.progress || 0) !== (o.progress || 0)) {
          push(EVENT_TYPES.REPAIR_PROGRESS, { orderId: o.id, progress: o.progress || 0 }, next)
        }
        if (old.status !== o.status && ['cleared', 'failed', 'cancelled'].includes(o.status)) {
          push(EVENT_TYPES.REPAIR_SETTLED, { orderId: o.id, outcome: o.status, consumed: o.consumed || null }, next)
        }
      }
    })

    /* 3) 试折叠校验：翻译事件折叠后，关键账目若对不上旧快照，加快照锚点兜底 */
    const newEvents = events.slice(beforeEvents)
    try {
      fold(clone(newEvents), migrationState)
      const view = projectView(migrationState)
      const mismatch = checkFrameAgainst(view, next.snapshot)
      if (mismatch) {
        events.push(makeEvent({
          realm, branchId: 'main', type: EVENT_TYPES.SNAPSHOT_ANCHOR,
          data: { frameIndex: i, snapshot: redactLegacy(next.snapshot), reason: mismatch },
          clientId: 'migration', happenedAt: next.t || Date.now()
        }))
        report.anchors++
        report.warnings.push(`frame#${i} 翻译后账目不一致（${mismatch}），已挂快照锚点`)
      }
      report.translated += newEvents.length
    } catch (err) {
      events.push(makeEvent({
        realm, branchId: 'main', type: '__snapshot_anchor__',
        data: { frameIndex: i, snapshot: redactLegacy(next.snapshot), reason: err.message },
        clientId: 'migration', happenedAt: next.t || Date.now()
      }))
      report.anchors++
      report.warnings.push(`frame#${i} 折叠失败（${err.message}），已挂快照锚点`)
    }
  }

  return { events, report }
}

// 折叠视图 vs 旧快照的关键账目（库存余量、床位在住、运输签收）
function checkFrameAgainst(view, snap) {
  for (const b of snap.cmd.bases) {
    const vb = view.bases[b.id]
    if (!vb) return `基地 ${b.id} 缺失`
    for (const [res, q] of Object.entries(b.stock || {})) {
      const vl = vb.stock[res]
      // 迁移用 granted 直调表达余量，折叠后 qty 必须等于旧余量
      if (!vl || vl.qty !== q) return `库存 ${b.id}/${res} 期望 ${q} 实际 ${vl?.qty}`
    }
  }
  for (const s of snap.tr.shelters) {
    const vs = view.shelters[s.id]
    const expectOccupied = shelterOccupied(snap, s.id)
    if (!vs || vs.occupied !== expectOccupied) return `床位 ${s.id} 在住期望 ${expectOccupied} 实际 ${vs?.occupied}`
  }
  return null
}

// 锚点快照剔除地图覆盖物等不可序列化字段（旧结构里 block._poly 已在录制时剔除，双保险）
function redactLegacy(snap) {
  const s = clone(snap)
  if (s.rb?.blocks) s.rb.blocks.forEach((b) => { delete b._poly })
  return s
}

export function isMigrated(openEventData) {
  return !!(openEventData && openEventData.migratedFrom)
}

export { stableStringify }
