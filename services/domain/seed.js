// 复用前端纯数据场景（mock/data.js 无框架依赖，可直接被服务端引用）
import { SCENARIOS } from '../../src/mock/data.js'
import { DEFAULT_BASES, DEFAULT_SHELTERS } from './constants.js'

export function listScenarios() {
  return SCENARIOS.map((s) => ({ id: s.id, name: s.name, desc: s.desc, events: s.events.length }))
}

// 生成 sim.init 事件载荷：事件补时间线，基地/安置点深拷贝
export function buildInitPayload({ simId, scenarioId = 's1', name }) {
  const scenario = SCENARIOS.find((x) => x.id === scenarioId) || SCENARIOS[0]
  const events = scenario.events.map((e) => ({
    ...e,
    timeline: [{ at: e.reportedAt, text: `事件上报：${e.title}` }]
  }))
  return {
    simId,
    scenarioId: scenario.id,
    name: name || scenario.name,
    events,
    bases: DEFAULT_BASES.map((b) => ({ ...b, stock: { ...b.stock } })),
    shelters: DEFAULT_SHELTERS.map((s) => ({ ...s, consumed: {}, settlements: [], peakInHouse: 0 }))
  }
}
