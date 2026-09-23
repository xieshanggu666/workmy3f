// 演示用平面几何与球面里程工具：道路阻断影响判定 / 绕行路径生成
const R = 6371
const rad = (d) => (d * Math.PI) / 180
// 判定容差（度，约厘米级）：圈画/上报顶点经 6 位小数取整，贴边路线与边界会有微小偏差
const EPS = 1e-7
const EPS_T = 1e-7

// 两点球面距离（km），点格式 [lng, lat]
export function haversineKm(a, b) {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// 折线总长（km）
export function pathKm(points) {
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += haversineKm(points[i - 1], points[i])
  return sum
}

// 射线法：点是否在多边形内（严格内部，不含边界；边界点由 pathBlocked 统一按阻断处理）
export function pointInPolygon(pt, poly) {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// 叉积（z 分量），用于共线判定
function cross(ax, ay, bx, by) {
  return ax * by - ay * bx
}

// 点是否在线段上：叉积≈0 且坐标落在端点范围内
function pointOnSegment(pt, a, b, eps = EPS) {
  const [px, py] = pt
  if (Math.abs(cross(b[0] - a[0], b[1] - a[1], px - a[0], py - a[1])) > eps) return false
  return Math.min(a[0], b[0]) - eps <= px && px <= Math.max(a[0], b[0]) + eps &&
    Math.min(a[1], b[1]) - eps <= py && py <= Math.max(a[1], b[1]) + eps
}

// 点是否严格落在线段内部（不含端点），用于判定共线是否存在有长度的重叠
function pointInSegmentInterior(pt, a, b, eps = EPS) {
  if (!pointOnSegment(pt, a, b, eps)) return false
  const ta = Math.hypot(pt[0] - a[0], pt[1] - a[1])
  const tb = Math.hypot(pt[0] - b[0], pt[1] - b[1])
  return ta > eps && tb > eps
}

// 线段相交判定：含共线重叠与端点相接（贴着封闭区边界行走同样算阻断）
// looseEnds=true：仅放行两端点处的零长度接触（绕行 DFS 豁免起终点时使用），
//   严格内点相交与有长度的共线重叠仍算阻断
function segIntersect(p1, p2, p3, p4, looseEnds = false) {
  const eps = EPS
  const d = cross(p2[0] - p1[0], p2[1] - p1[1], p4[0] - p3[0], p4[1] - p3[1])
  if (Math.abs(d) <= eps) {
    // 共线：参数区间有重叠才算相交
    if (pointInSegmentInterior(p1, p3, p4, eps) || pointInSegmentInterior(p2, p3, p4, eps) ||
      pointInSegmentInterior(p3, p1, p2, eps) || pointInSegmentInterior(p4, p1, p2, eps)) return true
    if (looseEnds) return false // 仅端点相接（零长度重叠），豁免
    return pointOnSegment(p1, p3, p4, eps) || pointOnSegment(p2, p3, p4, eps) ||
      pointOnSegment(p3, p1, p2, eps) || pointOnSegment(p4, p1, p2, eps)
  }
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
  if (looseEnds) return t > EPS_T && t < 1 - EPS_T && u >= -EPS_T && u <= 1 + EPS_T
  return t >= -EPS_T && t <= 1 + EPS_T && u >= -EPS_T && u <= 1 + EPS_T
}

// 点是否落在多边形边界上（任一多边形边包含该点）
export function pointOnPolygon(pt, poly) {
  for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
    if (pointOnSegment(pt, poly[k], poly[j])) return true
  }
  return false
}

// 折线是否穿越多边形：任一顶点落入内部或压在边界上，或任一线段与边界相交/共线重叠
// （贴着封闭区边界行走同样视为阻断，避免贴边运输路线漏检）
// opts.ignoreEndpoints=true：仅看内部穿越——起终点压边界不算阻断（绕行 DFS 用，
// 起终点在边界上时应可绕行而非按"落入封闭区"处理）
export function pathBlocked(points, poly, opts = {}) {
  for (let n = 0; n < points.length; n++) {
    if (opts.ignoreEndpoints && (n === 0 || n === points.length - 1)) continue
    const pt = points[n]
    if (pointInPolygon(pt, poly) || pointOnPolygon(pt, poly)) return true
  }
  for (let i = 1; i < points.length; i++) {
    // 豁免起终点时，端点处的零长度接触也一并放行（从边界出发/到达的线段）
    const looseEnds = opts.ignoreEndpoints && (i === 1 || i === points.length - 1)
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      if (segIntersect(points[i - 1], points[i], poly[k], poly[j], looseEnds)) return true
    }
  }
  return false
}

// 联合判定：折线是否穿越任一多边形，返回首个命中的多边形索引（无命中返回 -1）
export function firstBlocker(points, polys, opts = {}) {
  for (let i = 0; i < polys.length; i++) {
    if (pathBlocked(points, polys[i], opts)) return i
  }
  return -1
}

// 外接矩形四侧绕行候选角点（每侧两个行进方向），margin 为外扩经纬度
function detourCandidates(poly, margin) {
  const lngs = poly.map((p) => p[0])
  const lats = poly.map((p) => p[1])
  const w = Math.min(...lngs) - margin
  const e = Math.max(...lngs) + margin
  const s = Math.min(...lats) - margin
  const n = Math.max(...lats) + margin
  const nw = [w, n], ne = [e, n], sw = [w, s], se = [e, s]
  return [
    [nw, ne], [ne, nw], // 北侧绕行
    [sw, se], [se, sw], // 南侧绕行
    [nw, sw], [sw, nw], // 西侧绕行
    [ne, se], [se, ne]  // 东侧绕行
  ]
}

// 生成绕行途经点：沿封闭区外接矩形四侧绕行（每侧两个方向），取最短可行方案；无解返回 null
// 兼容旧调用：单封闭区 = 联合避障只有一个多边形的特例
export function detourPath(a, b, poly) {
  const det = detourPathMulti(a, b, [poly])
  if (!det) return null
  return { via: det.via, km: det.km }
}

// 联合避障：一次绕行必须同时避开所有生效封闭区。
// 思路：DFS 在首个被穿越的封闭区处插入四侧途经点，再次校验剩余全部封闭区，
// 直到整条折线无穿越；任一起终点落入封闭区则无解（应改派/挂起）。
const DETOUR_MARGINS = [0.035, 0.07, 0.14]
export function detourPathMulti(a, b, polys, opts = {}) {
  const list = (polys || []).filter(Boolean)
  if (!list.length) return { via: [], km: pathKm([a, b]) }
  if (list.some((p) => pointInPolygon(a, p) || pointInPolygon(b, p))) return null
  if (firstBlocker([a, b], list) < 0) return { via: [], km: pathKm([a, b]) }

  const maxNodes = opts.maxNodes || 5000
  let nodes = 0
  let best = null
  const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7

  const dfs = (pts, depth) => {
    if (++nodes > maxNodes || depth > list.length + 2) return
    // 起终点压在边界上允许绕行（仅严格内部才算"落入封闭区"无解）；DFS 校验时豁免原始终端点
    const hit = firstBlocker(pts, list, { ignoreEndpoints: true })
    if (hit < 0) {
      const km = pathKm(pts)
      if (!best || km < best.km) best = { via: pts.slice(1, -1), km }
      return
    }
    const lower = pathKm(pts)
    if (best && lower >= best.km) return // 下界剪枝：当前折线已不短于最优解
    // 找整条折线上第一条穿越任一生效封闭区的线段，仅在该处插入途经点
    // （起终点压边界时，出发段本身可能穿入区内，需以实际穿越线段为准，不能只看首个命中的封闭区）
    let segIdx = -1
    for (let i = 1; i < pts.length; i++) {
      const atEnd = i === 1 || i === pts.length - 1
      if (firstBlocker([pts[i - 1], pts[i]], list, { ignoreEndpoints: atEnd }) >= 0) { segIdx = i; break }
    }
    if (segIdx < 0) return
    const seen = new Set()
    // 起/终点压在边界上：先插入一个区外撤点，把端点引出封闭区，再按常规绕行
    const pullOuts = []
    if (segIdx === 1 && pointOnPolygon(pts[0], list[hit])) {
      pullOutCandidates(pts[0], list[hit]).forEach((p) => {
        if (!same(p, pts[0]) && !same(p, pts[1])) pullOuts.push([1, p])
      })
    }
    if (segIdx === pts.length - 1 && pointOnPolygon(pts[pts.length - 1], list[hit])) {
      pullOutCandidates(pts[pts.length - 1], list[hit]).forEach((p) => {
        if (!same(p, pts[pts.length - 1]) && !same(p, pts[pts.length - 2])) pullOuts.push([segIdx, p])
      })
    }
    for (const [at, p] of pullOuts) {
      const key = 'pull:' + at + '>' + p.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      const next = [...pts.slice(0, at), p, ...pts.slice(at)]
      dfs(next, depth + 1)
    }
    for (const margin of DETOUR_MARGINS) {
      for (const via of detourCandidates(list[hit], margin)) {
        if (same(via[0], pts[segIdx - 1]) || same(via[1], pts[segIdx]) || same(via[0], via[1])) continue
        const key = via[0].join(',') + '>' + via[1].join(',')
        if (seen.has(key)) continue
        seen.add(key)
        const next = [...pts.slice(0, segIdx), ...via, ...pts.slice(segIdx)]
        dfs(next, depth + 1)
      }
    }
  }

  dfs([a, b], 0)
  return best
}

// 边界端点的区外撤点候选：沿封闭区外接矩形四角方向外扩，取不落入任何封闭区内部的点
function pullOutCandidates(pt, poly) {
  const lngs = poly.map((p) => p[0])
  const lats = poly.map((p) => p[1])
  const cx = (Math.min(...lngs) + Math.max(...lngs)) / 2
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2
  const out = []
  for (const margin of DETOUR_MARGINS) {
    const w = Math.min(...lngs) - margin
    const e = Math.max(...lngs) + margin
    const s = Math.min(...lats) - margin
    const n = Math.max(...lats) + margin
    // 沿端点相对中心的方向推到外扩矩形边，再辅以四个角点
    const corners = [[w, n], [e, n], [w, s], [e, s]]
    corners.forEach(([x, y]) => out.push([x, y]))
    const dx = pt[0] - cx || 1
    const dy = pt[1] - cy || 0
    const t = Math.max(Math.abs(dx) / ((e - w) / 2), Math.abs(dy) / ((n - s) / 2))
    if (t > 0) out.push([cx + (dx / t), cy + (dy / t)])
  }
  return out
}
