<template>
  <div class="map-wrap">
    <!-- 地图容器 -->
    <div ref="mapRef" class="map-container"></div>

    <!-- 地图加载状态 -->
    <div v-if="loading" class="map-loading">
      <span class="spinner"></span>
      <p>{{ loadError ? '地图加载失败，请检查 VITE_AMAP_KEY' : '正在加载高德地图…' }}</p>
      <p v-if="loadError" class="err">{{ loadError }}</p>
    </div>

    <!-- 图例 -->
    <div class="legend">
      <div class="legend-title">图例</div>
      <div class="legend-item"><i class="dot" style="background:#ef5350"></i>Ⅰ级·特大</div>
      <div class="legend-item"><i class="dot" style="background:#ff9800"></i>Ⅱ级·重大</div>
      <div class="legend-item"><i class="dot" style="background:#ffc107"></i>Ⅲ级·较大</div>
      <div class="legend-item"><i class="dot" style="background:#4caf50"></i>Ⅳ级·一般</div>
      <div class="legend-item"><i class="dot" style="background:#2962ff"></i>资源库/救援点</div>
      <div class="legend-item"><i class="dot" style="background:#26a69a"></i>安置点/转移路线</div>
      <div class="legend-item"><i class="dot" style="background:#c62828"></i>道路阻断区</div>
      <div class="legend-item"><i class="dot" style="background:#ff9800"></i>道路抢修中</div>
    </div>

    <!-- 圈画提示 -->
    <div v-if="roadblock.drawing" class="draw-tip">
      🖱️ 圈画封闭范围：已 {{ roadblock.draft.length }} 点（右键/双击完成）
    </div>

    <!-- 事件选中浮层（右下角信息卡） -->
    <div v-if="selectedEvent" class="event-pop">
      <div class="pop-head" :style="{ borderColor: severityColor(selectedEvent.severity) }">
        <span class="pop-type" :style="{ background: eventColor(selectedEvent.type) }">{{ typeLabel(selectedEvent.type) }}</span>
        <strong>{{ selectedEvent.title }}</strong>
        <span class="pop-sev" :style="{ color: severityColor(selectedEvent.severity) }">{{ severityLabel(selectedEvent.severity) }}</span>
      </div>
      <p class="pop-desc">{{ selectedEvent.desc }}</p>
      <div class="pop-meta">
        <span>📍 {{ selectedEvent.location?.name }}</span>
        <span>👥 影响 {{ (selectedEvent.affected || 0).toLocaleString() }} 人</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { loadAMap } from '@/config/amap'
import { EVENT_TYPES, SEVERITY, RESOURCE_TYPES } from '@/mock/data'

const store = useCommandStore()
const transfer = useTransferStore()
const roadblock = useRoadblockStore()
const repair = useRepairStore()
const mapRef = ref(null)
const loading = ref(true)
const loadError = ref('')

let map = null
let amap = null
let heatmap = null
let overlays = {
  poly: [], markers: [], lines: [], baseMarkers: [], shelterMarkers: [], transferLines: [],
  blocks: [], blockMarkers: [], draft: []
}

const selectedEvent = computed(() =>
  store.events.find((e) => e.id === store.selectedEventId) || null
)

const typeLabel = (t) => EVENT_TYPES[t]?.label || t
const eventColor = (t) => EVENT_TYPES[t]?.color || '#777'
const severityColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const severityLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s

// 事件 Marker 内容
function eventMarkerContent(ev) {
  const color = eventColor(ev.type)
  return `
    <div class="ev-marker" style="--c:${color}" title="${ev.title}">
      <span class="ev-icon">${EVENT_TYPES[ev.type]?.icon}</span>
      <span class="ev-pulse"></span>
    </div>`
}

function baseMarkerContent(base) {
  return `
    <div class="base-marker" title="${base.name}">
      <i></i><span>🏗️</span>
    </div>`
}

// 渲染受灾范围 + 事件 Marker + 资源库
function renderEvents() {
  clearEvents()
  store.filteredEvents.forEach((ev) => {
    // Polygon 受灾范围
    if (amap && ev.affectedPolygon) {
      const poly = new amap.Polygon({
        path: ev.affectedPolygon,
        fillColor: eventColor(ev.type),
        fillOpacity: ev.status === 'closed' ? 0.12 : 0.28,
        strokeColor: eventColor(ev.type),
        strokeWeight: 2,
        strokeOpacity: 0.9,
        bubble: true
      })
      poly.on('click', () => store.selectEvent(ev.id))
      map.add(poly)
      overlays.poly.push(poly)
    }
    // 事件 Marker（气泡会转发点击）
    if (amap) {
      const marker = new amap.Marker({
        position: [ev.location?.lng, ev.location?.lat],
        content: eventMarkerContent(ev),
        anchor: 'center',
        offset: [0, -10],
        cursor: 'pointer'
      })
      marker.on('click', () => store.selectEvent(ev.id))
      map.add(marker)
      overlays.markers.push(marker)
    }
  })
  // 资源库 Marker
  store.bases.forEach((base) => {
    if (!amap) return
    const marker = new amap.Marker({
      position: [base.lng, base.lat],
      content: baseMarkerContent(base),
      anchor: 'center',
      cursor: 'pointer'
    })
    marker.on('click', () => {
      store.selectedEventId = null
      map.setFitView([marker], false, [100, 100, 120, 100])
    })
    map.add(marker)
    overlays.baseMarkers.push(marker)
  })
}

function clearEvents() {
  overlays.markers.forEach((m) => map?.remove(m))
  overlays.poly.forEach((p) => map?.remove(p))
  overlays.baseMarkers.forEach((m) => map?.remove(m))
  overlays.markers = []
  overlays.poly = []
  overlays.baseMarkers = []
}

// 热力图层（汇总所有受灾范围质心模拟人口密度）
function renderHeatmap() {
  const points = []
  store.filteredEvents.forEach((ev) => {
    if (!ev.heatRadius) return
    const rings = ev.heatRadius
    for (let k = 0; k < 60; k++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * rings
      const dLng = (r * Math.cos(a)) / (111.32 * Math.cos((ev.location.lat * Math.PI) / 180))
      const dLat = (r * Math.sin(a)) / 111.32
      points.push({ lng: ev.location.lng + dLng, lat: ev.location.lat + dLat, count: 1 })
    }
  })
  if (!points.length) return
  // Heatmap 插件需通过 map.plugin 异步就绪后再创建
  if (map && !heatmap) {
    try {
      map.plugin(['AMap.Heatmap'], () => {
        const HeatmapCtor = amap.HeatMap || amap.Heatmap
        heatmap = new HeatmapCtor(map, {
          radius: 40,
          gradient: {
            0.2: '#2f9cf5', 0.4: '#4caf50', 0.6: '#ffc107',
            0.8: '#ff9800', 1.0: '#ef5350'
          },
          opacity: [0, 0.6]
        })
        heatmap.setDataSet({ data: points, max: 10 })
      })
    } catch (e) {
      console.warn('热力图层加载失败（不影响主流程）', e)
    }
  } else if (heatmap) {
    heatmap.setDataSet({ data: points, max: 10 })
  }
}

// 渲染派发路径线（资源库 → 受灾点，含绕行途经点；挂起任务置灰；已办结路线撤除）
function renderDispatches() {
  clearLines()
  store.dispatches.forEach((d) => {
    if (d.status === 'done' || d.status === 'withdrawn') return
    const base = store.bases.find((b) => b.id === d.baseId)
    if (!base) return
    const held = d.status === 'held'
    const line = new amap.Polyline({
      path: [[base.lng, base.lat], ...(d.via || []), [d.lng, d.lat]],
      strokeColor: held ? '#5b6f94' : d.color,
      strokeOpacity: held ? 0.45 : 0.85,
      strokeWeight: 4,
      lineJoin: 'round',
      lineCap: 'round',
      strokeStyle: 'dashed',
      showDir: !held
    })
    map.add(line)
    overlays.lines.push(line)
  })
}

function clearLines() {
  overlays.lines.forEach((l) => map?.remove(l))
  overlays.lines = []
}

// 安置点 Marker（🏕️ + 在住/容量角标）
function shelterMarkerContent(s) {
  const bed = transfer.bedMap[s.id] || { inHouse: 0 }
  return `
    <div class="shelter-marker" title="${s.name}（在住 ${bed.inHouse}/${s.capacity}）">
      <span>🏕️</span><em>${bed.inHouse}/${s.capacity}</em>
    </div>`
}

function renderShelters() {
  overlays.shelterMarkers.forEach((m) => map?.remove(m))
  overlays.shelterMarkers = []
  if (!amap || !map) return
  transfer.shelters.forEach((s) => {
    const marker = new amap.Marker({
      position: [s.lng, s.lat],
      content: shelterMarkerContent(s),
      anchor: 'center',
      cursor: 'pointer'
    })
    map.add(marker)
    overlays.shelterMarkers.push(marker)
  })
}

// 转移路线（受灾点 → 安置点，未办结批次；含绕行途经点，挂起批次置灰）
function renderTransfers() {
  overlays.transferLines.forEach((l) => map?.remove(l))
  overlays.transferLines = []
  if (!amap || !map) return
  transfer.batches.forEach((b) => {
    if (b.status === 'closed') return
    const ev = store.events.find((e) => e.id === b.eventId)
    const sh = transfer.shelters.find((s) => s.id === b.shelterId)
    if (!ev || !sh) return
    const line = new amap.Polyline({
      path: [[ev.location.lng, ev.location.lat], ...(b.via || []), [sh.lng, sh.lat]],
      strokeColor: b.held ? '#5b6f94' : '#26a69a',
      strokeOpacity: b.held ? 0.45 : 0.8,
      strokeWeight: 3,
      lineJoin: 'round',
      lineCap: 'round',
      strokeStyle: 'dashed',
      showDir: !b.held
    })
    map.add(line)
    overlays.transferLines.push(line)
  })
}

// 道路阻断区（红色封闭范围 + 🚧 标记；已恢复置灰）
function renderBlocks() {
  overlays.blocks.forEach((p) => map?.remove(p))
  overlays.blockMarkers.forEach((m) => map?.remove(m))
  overlays.blocks = []
  overlays.blockMarkers = []
  if (!amap || !map) return
  roadblock.blocks.forEach((blk) => {
    const active = blk.status === 'active'
    const poly = new amap.Polygon({
      path: blk.polygon,
      fillColor: active ? '#c62828' : '#9e9e9e',
      fillOpacity: active ? 0.22 : 0.08,
      strokeColor: active ? '#ef5350' : '#9e9e9e',
      strokeWeight: 2,
      strokeOpacity: 0.9,
      strokeStyle: active ? 'solid' : 'dashed',
      bubble: true
    })
    poly.on('click', () => { roadblock.selectedBlockId = blk.id })
    map.add(poly)
    overlays.blocks.push(poly)
    blk._poly = poly
    const cx = blk.polygon.reduce((s, p) => s + p[0], 0) / blk.polygon.length
    const cy = blk.polygon.reduce((s, p) => s + p[1], 0) / blk.polygon.length
    // 阻断上进行中的抢修工单：标记进度/状态（待验收显示 ✓）
    const ro = active ? repair.orderOfBlock(blk.id) : null
    const badge = ro
      ? `<i class="blk-repair ${ro.status}">${ro.status === 'done' ? '✓' : '🔧'}${ro.status === 'accepted' ? ro.progress + '%' : ''}</i>`
      : ''
    const marker = new amap.Marker({
      position: [cx, cy],
      content: `<div class="blk-marker ${active ? '' : 'cleared'}" title="${blk.name}${ro ? `（抢修：${repair.statusLabel(ro.status)}）` : ''}">🚧${badge}</div>`,
      anchor: 'center',
      cursor: 'pointer'
    })
    marker.on('click', () => { roadblock.selectedBlockId = blk.id })
    map.add(marker)
    overlays.blockMarkers.push(marker)
  })
}

// 圈画中的草稿（顶点 + 闭合虚线预览）
function renderDraft() {
  overlays.draft.forEach((o) => map?.remove(o))
  overlays.draft = []
  if (!amap || !map || !roadblock.draft.length) return
  const path = roadblock.draft.length > 2 ? [...roadblock.draft, roadblock.draft[0]] : roadblock.draft
  const line = new amap.Polyline({
    path,
    strokeColor: '#ef5350',
    strokeWeight: 2,
    strokeOpacity: 0.9,
    strokeStyle: 'dashed',
    lineJoin: 'round'
  })
  map.add(line)
  overlays.draft.push(line)
  roadblock.draft.forEach((pt) => {
    const m = new amap.Marker({
      position: pt,
      content: '<div class="draft-dot"></div>',
      anchor: 'center'
    })
    map.add(m)
    overlays.draft.push(m)
  })
}

// 圈画模式：地图事件挂载/卸载
function onDrawClick(e) {
  roadblock.addDraftPoint(e.lnglat.lng, e.lnglat.lat)
}
function onDrawFinish() {
  roadblock.finishDrawing()
}
function bindDrawing(on) {
  if (!map) return
  if (on) {
    map.setDefaultCursor('crosshair')
    map.setStatus({ doubleClickZoom: false })
    map.on('click', onDrawClick)
    map.on('rightclick', onDrawFinish)
    map.on('dblclick', onDrawFinish)
  } else {
    map.setDefaultCursor('default')
    map.setStatus({ doubleClickZoom: true })
    map.off('click', onDrawClick)
    map.off('rightclick', onDrawFinish)
    map.off('dblclick', onDrawFinish)
  }
}

onMounted(async () => {
  try {
    amap = await loadAMap()
    map = new amap.Map(mapRef.value, {
      zoom: 8,
      center: [104.5, 30.9],
      mapStyle: 'amap://styles/fresh',
      viewMode: '2D',
      showLabel: true,
      features: ['bg', 'road', 'building']
    })
    const scale = new amap.Scale({ position: 'LB' })
    const toolbar = new amap.ToolBar({ position: 'RT' })
    map.addControl(scale)
    map.addControl(toolbar)
    renderEvents()
    renderHeatmap()
    renderShelters()
    renderTransfers()
    renderBlocks()
    loading.value = false
    map.setFitView(null, false, [100, 80, 120, 80], 1)
  } catch (e) {
    loadError.value = e.message
    loading.value = false
    console.error(e)
  }
})

onBeforeUnmount(() => {
  store.stopAutoPlay()
  bindDrawing(false)
  overlays.markers.forEach((m) => map?.remove(m))
  overlays.poly.forEach((p) => map?.remove(p))
  overlays.lines.forEach((l) => map?.remove(l))
  overlays.baseMarkers.forEach((m) => map?.remove(m))
  overlays.shelterMarkers.forEach((m) => map?.remove(m))
  overlays.transferLines.forEach((l) => map?.remove(l))
  overlays.blocks.forEach((p) => map?.remove(p))
  overlays.blockMarkers.forEach((m) => map?.remove(m))
  overlays.draft.forEach((o) => map?.remove(o))
  map?.destroy()
})

// 数据变化时重绘（事件状态/等级/位置/增删变化都需重绘——历史回放恢复快照同样走此通道）
watch(
  () => store.events.map((e) => e.id + e.status + e.severity + e.location.lng + e.location.lat).join(',')
    + '|' + store.filter.type + store.filter.severity + store.filter.status + store.search
    + '|' + store.scenarioId,
  () => renderEvents()
)
watch(() => store.selectedEventId, (id) => {
  const ev = store.events.find((e) => e.id === id)
  if (ev && map) map.setFitView([], false, [100, 80, 120, 80])
})
// 派发记录：增删、挂起/续派、绕行/改派、联合重排（途经点坐标变化）均触发路线重绘
watch(
  () => store.dispatches
    .map((d) => d.id + d.status + d.baseId + (d.detourBy || '') + (d.via || []).map((p) => p.join(',')).join(';'))
    .join(','),
  () => renderDispatches()
)
watch(() => store.filteredEvents.map((e) => e.affected).join(','), () => {
  if (amap) renderHeatmap()
})
// 转移安置：批次变化 → 重绘转移路线；登记人数变化 → 刷新安置点角标
watch(
  () => transfer.batches
    .map((b) => b.id + b.status + b.shelterId + (b.held ? 1 : 0) + (b.detourBy || '') + (b.via || []).map((p) => p.join(',')).join(';'))
    .join(',') + store.scenarioId,
  () => { renderTransfers(); renderShelters() }
)
watch(
  () => transfer.batches.reduce((sum, b) => sum + b.members.filter((x) => x.checkinAt && !x.checkoutAt).length, 0),
  () => renderShelters()
)
// 道路阻断：阻断区增删/状态/封闭范围变化 → 重绘（历史回放恢复快照同样触发）
watch(
  () => roadblock.blocks.map((b) => b.id + b.status + b.polygon.map((p) => p.join(',')).join(';')).join(','),
  () => renderBlocks()
)
// 抢修工单状态/进度变化 → 刷新阻断标记上的抢修角标
watch(
  () => repair.orders.map((o) => o.id + o.status + o.progress).join(','),
  () => renderBlocks()
)
watch(() => roadblock.draft.length, () => renderDraft())
watch(() => roadblock.drawing, (on) => bindDrawing(on))
// 选中阻断 → 地图聚焦该封闭区
watch(() => roadblock.selectedBlockId, (id) => {
  const blk = roadblock.blocks.find((b) => b.id === id)
  if (blk?._poly && map) map.setFitView([blk._poly], false, [120, 100, 120, 100])
})

// 展平 dispatch 里带坐标的辅助（供模板使用）
</script>

<style scoped>
.map-wrap {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 420px;
}
.map-container {
  width: 100%;
  height: 100%;
}
.map-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #0d1429;
  color: #8ea1c4;
  font-size: 14px;
  z-index: 2;
}
.spinner {
  width: 34px; height: 34px;
  border: 3px solid #1c2b4a;
  border-top-color: #4d8dff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}
@keyframes spin { to { transform: rotate(360deg); } }
.err { color: #ef5350; font-size: 12px; max-width: 320px; text-align: center; }

/* 图例 */
.legend {
  position: absolute;
  left: 12px; bottom: 40px;
  background: rgba(13, 20, 41, 0.85);
  border: 1px solid rgba(150, 180, 220, 0.2);
  border-radius: 10px;
  padding: 10px 12px;
  z-index: 3;
  color: #c6d2e6;
  font-size: 12px;
  backdrop-filter: blur(4px);
  min-width: 132px;
}
.legend-title {
  font-weight: 600; color: #fff; margin-bottom: 6px; font-size: 12px;
}
.legend-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }

/* 事件弹出卡 */
.event-pop {
  position: absolute;
  right: 14px; bottom: 40px;
  width: 300px;
  background: rgba(15, 23, 46, 0.92);
  border: 1px solid rgba(150, 180, 220, 0.25);
  border-left: 3px solid #4d8dff;
  border-radius: 10px;
  padding: 12px 14px;
  z-index: 3;
  color: #dbe4f3;
  backdrop-filter: blur(6px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.pop-head { border-bottom: 1px dashed #2a3a5e; padding-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.pop-type {
  color: #fff; padding: 1px 8px; border-radius: 4px; font-size: 12px; flex-shrink: 0;
}
.pop-head strong { font-size: 13px; flex: 1; color: #fff; }
.pop-sev { font-size: 12px; flex-shrink: 0; }
.pop-desc { color: #aebadd; font-size: 12px; line-height: 1.6; margin: 8px 0; }
.pop-meta { display: flex; gap: 12px; font-size: 12px; color: #8ea1c4; }

/* 圈画提示 */
.draw-tip {
  position: absolute;
  top: 14px; left: 50%; transform: translateX(-50%);
  background: rgba(183,28,28,0.92); color: #fff;
  border: 1px solid rgba(255,255,255,0.35);
  border-radius: 8px; padding: 8px 16px;
  font-size: 12px; z-index: 4;
  box-shadow: 0 6px 18px rgba(0,0,0,0.4);
  backdrop-filter: blur(4px);
}
</style>

<style>
/* 全局覆盖物样式（AMap 注入 DOM，不能用 scoped 控制） */
.ev-marker {
  position: relative;
  width: 30px; height: 30px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--c);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 3px 10px rgba(0,0,0,0.4);
  border: 2px solid #fff;
}
.ev-marker .ev-icon {
  transform: rotate(45deg);
  font-size: 15px;
  color: #fff;
}
.ev-marker .ev-pulse {
  position: absolute;
  inset: -4px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(45deg);
  border: 2px solid var(--c);
  animation: evPulse 1.6s ease-out infinite;
  opacity: 0;
}
@keyframes evPulse {
  0% { transform: rotate(45deg) scale(0.7); opacity: 0.8; }
  100% { transform: rotate(45deg) scale(1.6); opacity: 0; }
}
.base-marker {
  width: 26px; height: 26px;
  border-radius: 50%;
  background: #2962ff;
  display: flex; align-items: center; justify-content: center;
  border: 2.5px solid #fff;
  box-shadow: 0 3px 8px rgba(41,98,255,0.6);
}
.base-marker span { font-size: 13px; }
.base-marker i {
  position: absolute; width: 8px; height: 8px; border-radius: 50%;
  background: #4fc3f7; bottom: -3px; right: -2px; border: 1px solid #fff;
}
.shelter-marker {
  position: relative;
  min-width: 26px; height: 26px; padding: 0 5px;
  border-radius: 13px;
  background: #0f5e52;
  display: flex; align-items: center; justify-content: center; gap: 2px;
  border: 2.5px solid #fff;
  box-shadow: 0 3px 8px rgba(38,166,154,0.6);
}
.shelter-marker span { font-size: 13px; }
.shelter-marker em {
  font-style: normal; font-size: 9px; color: #a7f3d0; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
/* 道路阻断标记与圈画草稿点 */
.blk-marker {
  position: relative;
  width: 30px; height: 30px; border-radius: 50%;
  background: #b71c1c; border: 2.5px solid #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; cursor: pointer;
  animation: blkPulse 1.8s ease-out infinite;
}
.blk-marker.cleared { background: #616161; animation: none; opacity: 0.75; }
/* 抢修角标：待接单/抢修中橙色，待验收绿色 */
.blk-repair {
  position: absolute; top: -7px; right: -10px;
  font-style: normal; font-size: 9px; font-weight: 700; line-height: 14px;
  padding: 0 4px; min-width: 16px; text-align: center;
  border-radius: 8px; border: 1.5px solid #fff;
  background: #ff9800; color: #fff; white-space: nowrap;
}
.blk-repair.done { background: #ab47bc; }
@keyframes blkPulse {
  0% { box-shadow: 0 0 0 0 rgba(239,83,80,0.55); }
  100% { box-shadow: 0 0 0 14px rgba(239,83,80,0); }
}
.draft-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: #ef5350; border: 2px solid #fff;
  box-shadow: 0 1px 5px rgba(0,0,0,0.5);
}
</style>