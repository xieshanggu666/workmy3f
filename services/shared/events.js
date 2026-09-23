/* =========================================================================
 * 事件信封（Event Envelope）与因果模型
 *
 * 三个服务之间只传递「不可变事件」，从不互相直接改对方的状态：
 *
 *   collector（采集）  --append--> archive（历史存储，唯一事实源）
 *   archive（订阅推送） ------------> replay（回放计算：折叠/投影）
 *
 * 因果顺序不靠物理时钟（现场端可能时钟漂移/弱网延迟），而靠：
 *   realm / branchId   —— 作用域隔离（真实调度 real 与任何演练分支互不相见）
 *   seq                —— 服务端在 (realm, branchId) 内分配的单调序号
 *   prevId / causal    —— 显式因果链：客户端基于「我看到的最后一帧」乐观提交，
 *                         并发写入冲突时服务端不拒绝，而是标记 concurrent，
 *                         由分支合并/分叉策略处理
 *   Lamport clock      —— 跨分支/跨端可比较的逻辑时钟（取 max+1）
 *
 * 乱序到达：collector 允许「迟到事件」（seq 空洞后补），archive 按 seq 排序
 *           持久化；replay 折叠时按 seq 为 tie-breaker、Lamport 为辅助，
 *           并对乱序到达做增量重放（不是从头全量快照替换）。
 * ========================================================================= */

import { DomainError, ensure, genId, nowMs } from './util.js'

export const REALM_REAL = 'real'            // 真实调度域（生产调度，永远不被演练污染）
export const MAIN_BRANCH = 'main'           // 演练主干
export const EVENT_VERSION = 1

export const EVENT_TYPES = Object.freeze({
  // —— 生命周期 / 会话 ——
  REALM_OPENED: 'realm.opened',             // 开启演练（含初始基线，data.snapshot 可带旧快照）
  BRANCH_FORKED: 'branch.forked',           // 从某一帧分叉
  BRANCH_SEALED: 'branch.sealed',           // 分支封存（只读，不可再写）
  PARTICIPANT_JOINED: 'session.joined',
  PARTICIPANT_LEFT: 'session.left',

  // —— 库存（资源基地）——
  STOCK_GRANTED: 'stock.granted',           // 基线/调拨入账（初始库存、上级增拨）
  STOCK_RESERVED: 'stock.reserved',         // 预占（统筹方案/转移派车，不扣实物）
  STOCK_RESERVE_RELEASED: 'stock.reserve.released',
  STOCK_ALLOCATED: 'stock.allocated',       // 出库扣减（派发/抢修派单）
  STOCK_RETURNED: 'stock.returned',         // 退回/结算回库（撤回、抢修按实耗归还）

  // —— 床位（安置点）——
  BED_RESERVED: 'bed.reserved',             // 批次预占床位
  BED_RESERVE_RELEASED: 'bed.reserve.released',
  BED_OCCUPIED: 'bed.occupied',             // 入住占用
  BED_FREED: 'bed.freed',                   // 转出释放

  // —— 运输（物资派发 / 转移批次 / 抢修投送统一建模为 shipment）——
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_ROUTED: 'shipment.routed',       // 路线/ETA（含绕行途经点、改派基地/安置点）
  SHIPMENT_HELD: 'shipment.held',           // 阻断挂起
  SHIPMENT_RESUMED: 'shipment.resumed',
  SHIPMENT_DELIVERED: 'shipment.delivered', // 签收（物资）/ 入住（人员）
  SHIPMENT_RETURNED: 'shipment.returned',
  SHIPMENT_CLOSED: 'shipment.closed',       // 办结 / 撤回留账

  // —— 道路与抢修（影响运输可达性）——
  BLOCK_REPORTED: 'block.reported',
  BLOCK_CLEARED: 'block.cleared',
  REPAIR_ORDER_CREATED: 'repair.created',
  REPAIR_PROGRESS: 'repair.progress',
  REPAIR_SETTLED: 'repair.settled', // 验收通过/失败/撤单，带实际消耗

  // —— 迁移兜底：旧版全量快照无法被增量事件完整还原时挂锚点，reducer 直接校准 ——
  SNAPSHOT_ANCHOR: 'snapshot.anchor'
})

// 每个事件必填的 data 主键（最小校验，更多业务约束在 reducer）
const SCHEMA = {
  [EVENT_TYPES.REALM_OPENED]: ['realm'],
  [EVENT_TYPES.BRANCH_FORKED]: ['fromBranchId', 'fromSeq'],
  [EVENT_TYPES.STOCK_GRANTED]: ['baseId', 'resource', 'qty'],
  [EVENT_TYPES.STOCK_RESERVED]: ['baseId', 'resource', 'qty', 'refId'],
  [EVENT_TYPES.STOCK_RESERVE_RELEASED]: ['refId'],
  [EVENT_TYPES.STOCK_ALLOCATED]: ['baseId', 'resource', 'qty', 'refId'],
  [EVENT_TYPES.STOCK_RETURNED]: ['baseId', 'resource', 'qty', 'refId'],
  [EVENT_TYPES.BED_RESERVED]: ['shelterId', 'qty', 'refId'],
  [EVENT_TYPES.BED_RESERVE_RELEASED]: ['refId'],
  [EVENT_TYPES.BED_OCCUPIED]: ['shelterId', 'qty', 'refId'],
  [EVENT_TYPES.BED_FREED]: ['shelterId', 'qty', 'refId'],
  [EVENT_TYPES.SHIPMENT_CREATED]: ['shipmentId', 'kind'],
  [EVENT_TYPES.SHIPMENT_ROUTED]: ['shipmentId'],
  [EVENT_TYPES.SHIPMENT_DELIVERED]: ['shipmentId', 'qty'],
  [EVENT_TYPES.BLOCK_REPORTED]: ['blockId'],
  [EVENT_TYPES.BLOCK_CLEARED]: ['blockId'],
  [EVENT_TYPES.REPAIR_ORDER_CREATED]: ['orderId', 'blockId'],
  [EVENT_TYPES.REPAIR_PROGRESS]: ['orderId', 'progress'],
  [EVENT_TYPES.REPAIR_SETTLED]: ['orderId', 'outcome']
}

export function validateEventType(type) {
  ensure(typeof type === 'string' && Object.values(EVENT_TYPES).includes(type),
    'bad_event_type', `未知事件类型: ${type}`, 400)
}

export function validatePayload(type, data = {}) {
  const required = SCHEMA[type]
  if (required) {
    const missing = required.filter((k) => data[k] === undefined)
    ensure(!missing.length, 'bad_payload', `事件 ${type} 缺少字段: ${missing.join(', ')}`, 422, { missing })
  }
  return data
}

/**
 * 构造事件信封（不分配 seq —— seq 由 archive 在追加时原子分配）。
 * @param {object} p
 *  realm, branchId, type, data
 *  eventId      幂等键（客户端重试复用同一 id；缺省由服务端生成）
 *  clientId/actor
 *  prevId       客户端看到的最后事件 id（乐观并发的因果链）
 *  expectedSeq  客户端看到的分支末序号（>0 时做乐观并发检测）
 *  lamport      客户端已知最大 lamport（服务端取 max+1）
 *  happenedAt   现场发生时刻（业务时间，可乱序；与服务端入库时间分开）
 *  idempotencyKey 业务侧去重键（如 抢修派单：同一阻断只允许一张在途工单）
 */
export function makeEvent(p = {}) {
  validateEventType(p.type)
  validatePayload(p.type, p.data)
  const realm = p.realm || REALM_REAL
  const branchId = p.branchId || MAIN_BRANCH
  const happenedAt = Number.isFinite(+p.happenedAt) ? +p.happenedAt : nowMs()
  return {
    v: EVENT_VERSION,
    eventId: p.eventId || genId('ev'),
    realm,
    branchId,
    type: p.type,
    data: p.data || {},
    clientId: p.clientId || 'server',
    actor: p.actor || null,
    prevId: p.prevId || null,
    expectedSeq: Number.isInteger(p.expectedSeq) ? p.expectedSeq : null,
    lamport: Math.max(0, Number(p.lamport) || 0) + 1,
    happenedAt,
    idempotencyKey: p.idempotencyKey || null,
    // —— 以下由 archive 追加时补全 ——
    seq: -1,
    concurrent: false,          // 与分支末端无直接因果（并发写入）
    branchSeq: -1,              // 分支自身序号（分叉链上的连续序号）
    ingestedAt: null
  }
}

// 排序规则：同 (realm, branchId) 内 seq 升序；seq 相同（仅理论）按 lamport、再按 eventId
export function causalCompare(a, b) {
  return a.seq - b.seq || a.lamport - b.lamport || (a.eventId < b.eventId ? -1 : 1)
}

// 跨分支拓扑序：先按分叉点（forkSeq），分支内再按 causalCompare —— 对照/审计时用
export function eventScopeKey(e) { return `${e.realm}::${e.branchId}` }

export function isSealedScopeEvent(type) {
  return type === EVENT_TYPES.BRANCH_SEALED
}

export { DomainError }
