/* 共享工具：ID、时间、JSON（确定性序列化）、深度克隆、断言错误 */

export function nowMs() { return Date.now() }

let seqCounter = 0
// 进程内单调：同一毫秒也不撞 id
export function genId(prefix) {
  seqCounter = (seqCounter + 1) % 0xfffff
  return `${prefix}_${Date.now().toString(36)}${seqCounter.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`
}

export const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)))

// 确定性序列化：对象键排序，保证「同状态同快照字节」（旧快照比对、幂等、快照指纹都依赖它）
export function stableStringify(value) {
  const seen = new WeakSet()
  return JSON.stringify(value, (key, val) => {
    if (val && typeof val === 'object') {
      if (seen.has(val)) throw new TypeError('Converting circular structure to JSON')
      seen.add(val)
      if (!Array.isArray(val)) {
        const out = {}
        Object.keys(val).sort().forEach((k) => { out[k] = val[k] })
        return out
      }
    }
    return val
  })
}

export class DomainError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

// 事件校验失败的字段明细可直接回给采集端，便于其修复后重投
export function ensure(cond, code, message, status = 400, details = null) {
  if (!cond) throw new DomainError(code, message, status, details)
}

export const pick = (obj, keys) => {
  const out = {}
  keys.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k] })
  return out
}

// 简单线性插值用不到，但数值兜底到处在用
export const num = (v, dft = 0) => (Number.isFinite(Number(v)) ? Number(v) : dft)
