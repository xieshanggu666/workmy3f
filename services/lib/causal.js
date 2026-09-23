// 混合逻辑时钟 HLC：物理毫秒 + 逻辑计数；各采集节点本地生成，合并后仍可比较
// 编码为 16 进制字符串，字典序即因果序（同 ts 时按逻辑计数）
export function hlcNow(last) {
  const pt = Date.now()
  const l = last && last.ts === pt ? last.l + 1 : 0
  return { ts: pt, l }
}

export function hlcEncode(h) {
  return h.ts.toString(16).padStart(12, '0') + '-' + h.l.toString(16).padStart(6, '0')
}

export function hlcDecode(s) {
  if (!s || typeof s !== 'string' || !s.includes('-')) return null
  const [ts, l] = s.split('-')
  const n = { ts: parseInt(ts, 16), l: parseInt(l, 16) }
  return Number.isFinite(n.ts) && Number.isFinite(n.l) ? n : null
}

// 收到远端时间戳后推进本地时钟（Lamport 风格），保证因果不回退
export function hlcReceive(local, remote) {
  const now = Date.now()
  const ts = Math.max(local?.ts || 0, remote?.ts || 0, now)
  let l = 0
  if (ts === local?.ts && ts === remote?.ts) l = Math.max(local.l, remote.l) + 1
  else if (ts === local?.ts) l = local.l + 1
  else if (ts === remote?.ts) l = remote.l + 1
  return { ts, l }
}

// 因果序比较键：
//  1) 若事件显式声明 after（父事件 id），父必须先于子 —— 由调用方（回放器）做拓扑约束；
//  2) 同分支序号 seq 是分支内全序；
//  3) 兜底使用 HLC；
//  4) 相同时间戳用稳定 eventId 打散，保证乱序到达时重排结果确定。
export function orderKey(ev) {
  return [
    ev.hlc || hlcEncode({ ts: ev.ts || 0, l: 0 }),
    ev.id || ''
  ].join('|')
}

// 稳定排序（Array.sort 在 V8 已稳定，这里显式固定比较规则）
export function causalStableSort(events) {
  return [...events].sort((a, b) => {
    const ka = orderKey(a)
    const kb = orderKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

// 拓扑+时间的因果重排：先按 after 做 Kahn 拓扑，同就绪集合按 HLC 稳定排序。
// 缺失父引用的事件视为就绪（父可能属于主干已截断的历史，如分支复制点之前的事件）。
export function causalTopoSort(events, knownIds = null) {
  const byId = new Map()
  events.forEach((e) => { if (e.id) byId.set(e.id, e) })
  const indeg = new Map()
  const children = new Map()
  const ready = []
  events.forEach((e) => {
    let d = 0
    if (Array.isArray(e.after)) {
      e.after.forEach((p) => {
        // 父在待排集合中才构成约束；knownIds 里的父（已应用历史）不阻塞
        if (byId.has(p)) { d++; if (!children.has(p)) children.set(p, []); children.get(p).push(e.id) }
      })
    }
    indeg.set(e.id, d)
    if (d === 0) ready.push(e)
  })

  const out = []
  const popped = new Set()
  while (ready.length) {
    ready.sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : 0))
    const e = ready.shift()
    popped.add(e.id)
    out.push(e)
    for (const cid of children.get(e.id) || []) {
      indeg.set(cid, indeg.get(cid) - 1)
      if (indeg.get(cid) === 0) {
        const c = byId.get(cid)
        if (c) ready.push(c)
      }
    }
  }
  if (out.length !== events.length) {
    // after 环（不应发生）：把剩余事件按时间追加，避免卡死投影
    events.forEach((e) => { if (!popped.has(e.id)) out.push(e) })
  }
  return out
}

// 新事件相对已见集合是否满足全部因果前置
export function depsSatisfied(ev, appliedIds) {
  if (!Array.isArray(ev.after)) return true
  return ev.after.every((p) => !p || appliedIds.has(p))
}
