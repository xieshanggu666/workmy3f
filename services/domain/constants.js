// 领域常量（与前端 mock 保持一致；服务端推演独立数据，不直接依赖前端源码）
export const EVENT_TYPES = {
  flood: { label: '洪涝', icon: '🌊', color: '#2f9cf5' },
  quake: { label: '地震', icon: '⚠️', color: '#f56c2f' },
  fire: { label: '火灾', icon: '🔥', color: '#ef5350' },
  landslide: { label: '山体滑坡', icon: '⛰️', color: '#9c6b2f' },
  typhoon: { label: '台风', icon: '🌀', color: '#8e44ad' }
}

export const SEVERITY = ['red', 'orange', 'yellow', 'blue']

export const EVENT_STATUS = ['reported', 'assessing', 'dispatching', 'controlled', 'closed']

export const RESOURCE_TYPES = {
  personnel: { label: '救援人员', unit: '人' },
  medical: { label: '医疗物资', unit: '件' },
  food: { label: '应急食品', unit: '份' },
  water: { label: '饮用水', unit: '箱' },
  vehicle: { label: '救援车辆', unit: '辆' },
  tent: { label: '帐篷', unit: '顶' }
}

export const TRANSFER_STATUS = ['pending', 'transporting', 'settled', 'closed']
export const REPAIR_STATUS = ['dispatched', 'accepted', 'done', 'cleared', 'failed', 'cancelled']
export const REPAIR_MATERIAL_TYPES = ['medical', 'food', 'water', 'tent']

export const SUPPLY_PER_CAPITA = { food: 0.6, water: 0.2, tent: 0.25, medical: 0.05 }
export const SUPPLY_DURABLES = ['tent']

export const DEFAULT_BASES = [
  { id: 'rb-1', name: '川西应急救援基地', lng: 104.0657, lat: 30.6594, stock: { personnel: 800, medical: 12000, food: 25000, water: 18000, vehicle: 200, tent: 6000 } },
  { id: 'rb-2', name: '绵阳物资储备库', lng: 104.742, lat: 31.4641, stock: { personnel: 0, medical: 5000, food: 12000, water: 9000, vehicle: 40, tent: 3000 } },
  { id: 'rb-3', name: '南充医疗应急中心', lng: 106.0829, lat: 30.7953, stock: { personnel: 300, medical: 8000, food: 0, water: 0, vehicle: 25, tent: 0 } },
  { id: 'rb-4', name: '达州消防特勤站', lng: 107.4078, lat: 31.2094, stock: { personnel: 150, medical: 1000, food: 2000, water: 1500, vehicle: 60, tent: 500 } },
  { id: 'rb-5', name: '宜宾一线指挥部物资点', lng: 104.633, lat: 28.7696, stock: { personnel: 400, medical: 4000, food: 8000, water: 7000, vehicle: 80, tent: 2500 } }
]

export const DEFAULT_SHELTERS = [
  { id: 'sh-1', name: '江油一中临时安置点', lng: 104.7705, lat: 31.778, capacity: 1200 },
  { id: 'sh-2', name: '绵阳会展中心安置点', lng: 104.7333, lat: 31.455, capacity: 2000 },
  { id: 'sh-3', name: '青川体育馆安置点', lng: 105.241, lat: 32.575, capacity: 600 },
  { id: 'sh-4', name: '广元奥体中心安置点', lng: 105.85, lat: 32.42, capacity: 900 },
  { id: 'sh-5', name: '成都高新应急避难所', lng: 104.06, lat: 30.58, capacity: 1500 }
]

// 事件类型目录：reducer 按 type 分派
export const EVENT_KINDS = [
  'sim.init', 'state.snapshot',
  'event.statusChanged',
  'resource.dispatched',
  'dispatch.signed', 'dispatch.shortageReplenished', 'dispatch.returned',
  'dispatch.rerouted', 'dispatch.reassigned', 'dispatch.held', 'dispatch.resumed', 'dispatch.withdrawn',
  'batch.created', 'batch.reassigned', 'batch.registered', 'batch.personMoved', 'batch.split',
  'batch.held', 'batch.resumed', 'batch.rerouted', 'batch.closed', 'batch.cancelled',
  'shelter.settled',
  'block.reported', 'block.impactConfirmed', 'block.impactApplied', 'block.cleared', 'block.removed',
  'repair.created', 'repair.accepted', 'repair.progress', 'repair.finished',
  'repair.delayed', 'repair.failed', 'repair.cancelled', 'repair.acceptedWork'
]
