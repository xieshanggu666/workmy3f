<template>
  <div class="detail" v-if="selectedEvent">
    <div class="panel-title">📋 事件详情与处置</div>

    <div class="ev-head">
      <span class="ev-badge" :style="{ background: eventColor(selectedEvent.type) }">{{ typeLabel(selectedEvent.type) }}</span>
      <strong>{{ selectedEvent.title }}</strong>
    </div>

    <div class="ev-sev">
      <span>严重等级：</span>
      <span class="sev-chip" :style="{ background: severityColor(selectedEvent.severity), color: '#fff' }">{{ severityLabel(selectedEvent.severity) }}</span>
    </div>

    <p class="ev-desc">{{ selectedEvent.desc }}</p>

    <div class="ev-meta-grid">
      <div class="m-item"><span>📍</span><span>{{ selectedEvent.location?.name }}</span></div>
      <div class="m-item"><span>👥</span><span>{{ (selectedEvent.affected||0).toLocaleString() }} 人受影响</span></div>
      <div class="m-item"><span>🕐</span><span>{{ selectedEvent.reportedAt }} 上报</span></div>
      <div class="m-item"><span>📌</span><span :style="{color: statusColor(selectedEvent.status)}">{{ statusLabel(selectedEvent.status) }}</span></div>
    </div>

    <!-- 状态流转 -->
    <div class="flow">
      <div class="flow-title">处置状态流转</div>
      <div class="flow-steps">
        <template v-for="(s, i) in flowSteps" :key="s.value">
          <div class="step" :class="{
            done: stepIndex(selectedEvent.status) >= i,
            current: selectedEvent.status === s.value
          }">
            <span class="dot"></span>
            <span class="lab">{{ s.label }}</span>
          </div>
        </template>
      </div>
      <div class="flow-actions">
        <button
          v-for="s in nextSteps"
          :key="s.value"
          class="flow-btn"
          :style="{ borderColor: s.color, color: s.color }"
          @click="store.advanceStatus(selectedEvent.id, s.value)"
        >➜ {{ s.label }}</button>
      </div>
    </div>

    <!-- 转移安置进度（联动转移批次登记数据回写） -->
    <div class="transfer-box">
      <div class="transfer-title">🚌 转移安置进度</div>
      <div class="tf-nums">
        <span>已安置 <b>{{ transferProgress.checkedIn }}</b>/{{ selectedEvent.evacuate || 0 }}</span>
        <span>接运 {{ transferProgress.picked }} · 转出 {{ transferProgress.out }}</span>
      </div>
      <div class="tf-bar"><i :style="{ width: transferPct }"></i></div>
      <p class="tf-sub" v-if="transferProgress.batches">
        {{ transferProgress.batches }} 个批次 · 计划 {{ transferProgress.planned }} 人
      </p>
      <p class="tf-sub" v-else>暂无转移批次，可在「资源调度 → 转移安置」页签建批</p>
    </div>

    <!-- 时间线 -->
    <div class="timeline">
      <div class="timeline-title">⏱ 处置时间线</div>
      <div v-if="selectedEvent.timeline.length === 0" class="t-empty">暂无记录</div>
      <div v-for="(t, i) in [...selectedEvent.timeline].reverse()" :key="i" class="t-item">
        <div class="t-rail"></div>
        <span class="t-time">{{ t.at }}</span>
        <span class="t-text">{{ t.text }}</span>
      </div>
    </div>
  </div>
  <div v-else class="placeholder">
    <div class="ph-icon">📌</div>
    <p>在地图或左侧事件列表中选择一个事件，查看详情并推进处置状态。</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { EVENT_TYPES, SEVERITY, EVENT_STATUS } from '@/mock/data'

const store = useCommandStore()
const transfer = useTransferStore()
const selectedEvent = computed(() =>
  store.events.find((e) => e.id === store.selectedEventId) || null
)
// 转移安置进度（由转移批次登记数据回写）
const transferProgress = computed(() =>
  transfer.progressByEvent[store.selectedEventId] || { batches: 0, planned: 0, picked: 0, checkedIn: 0, out: 0 }
)
const transferPct = computed(() => {
  const need = selectedEvent.value?.evacuate || 0
  if (!need) return '0%'
  return Math.min(100, Math.round((transferProgress.value.checkedIn / need) * 100)) + '%'
})
const typeLabel = (t) => EVENT_TYPES[t]?.label || t
const eventColor = (t) => EVENT_TYPES[t]?.color || '#777'
const severityColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const severityLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s
const statusLabel = (s) => EVENT_STATUS.find((x) => x.value === s)?.label || s
const statusColor = (s) => EVENT_STATUS.find((x) => x.value === s)?.color || '#999'

const flowSteps = EVENT_STATUS
const stepIndex = (s) => EVENT_STATUS.findIndex((x) => x.value === s)

// 可推进的状态（后置可选，允许跳跃）
const nextSteps = computed(() => {
  if (!selectedEvent.value) return []
  const idx = stepIndex(selectedEvent.value.status)
  return EVENT_STATUS.slice(idx + 1)
})
</script>

<style scoped>
.detail { padding: 12px; display: flex; flex-direction: column; gap: 12px; height: 100%; overflow-y: auto; }
.detail::-webkit-scrollbar { width: 6px; }
.detail::-webkit-scrollbar-thumb { background: #1c2b4a; border-radius: 4px; }
.panel-title { font-size: 15px; font-weight: 700; color: #fff; }

.ev-head { display: flex; align-items: center; gap: 8px; }
.ev-badge { color: #fff; font-size: 11px; padding: 3px 9px; border-radius: 5px; flex-shrink: 0; }
.ev-head strong { color: #fff; font-size: 14px; line-height: 1.4; }

.ev-sev { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #8ba2c8; }
.sev-chip { padding: 2px 10px; border-radius: 5px; font-weight: 700; }
.ev-desc { color: #aebadd; font-size: 12px; line-height: 1.6; margin: 0; }

.ev-meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.m-item {
  display: flex; align-items: center; gap: 6px; font-size: 12px; color: #c6d2e6;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 7px; padding: 7px 9px;
}

.flow { background: #101d39; border: 1px solid rgba(120,160,220,0.15); border-radius: 10px; padding: 12px; }
.flow-title, .timeline-title { font-size: 12px; color: #8ba2c8; font-weight: 600; margin-bottom: 10px; }
.flow-steps { display: flex; align-items: center; justify-content: space-between; }
.step { display: flex; flex-direction: column; align-items: center; gap: 5px; flex: 1; position: relative; }
.step .dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: #0c1730; border: 2px solid #2a3a5e; z-index: 1;
}
.step.done .dot { background: #4d8dff; border-color: #4d8dff; }
.step.current .dot { box-shadow: 0 0 0 4px rgba(77,141,255,0.25); }
.step .lab { font-size: 10px; color: #5b6f94; text-align: center; }
.step.done .lab { color: #8ba2c8; }
.step.current .lab { color: #fff; font-weight: 600; }
.step:not(:last-child)::after {
  content: ''; position: absolute; top: 5px; left: 50%; width: 100%; height: 2px;
  background: #1c2b4a; z-index: 0;
}
.step.done:not(:last-child)::after { background: #4d8dff; }

.flow-actions { display: flex; gap: 8px; margin-top: 12px; }
.flow-btn {
  background: rgba(16,29,57,0.8); border: 1px solid; border-radius: 7px;
  font-size: 12px; padding: 7px 12px; cursor: pointer; transition: all 0.18s;
}
.flow-btn:hover { background: rgba(255,255,255,0.08); }

.transfer-box { background: #101d39; border: 1px solid rgba(38,166,154,0.3); border-radius: 10px; padding: 12px; }
.transfer-title { font-size: 12px; color: #7ef0c9; font-weight: 600; margin-bottom: 8px; }
.tf-nums { display: flex; justify-content: space-between; font-size: 11px; color: #8ba2c8; }
.tf-nums b { color: #7ef0c9; font-size: 13px; }
.tf-bar { height: 6px; background: #0c1730; border-radius: 3px; overflow: hidden; margin-top: 7px; }
.tf-bar i { display: block; height: 100%; background: linear-gradient(90deg, #26a69a, #7ef0c9); border-radius: 3px; }
.tf-sub { font-size: 10px; color: #5b6f94; margin: 6px 0 0; }

.timeline { background: #101d39; border: 1px solid rgba(120,160,220,0.15); border-radius: 10px; padding: 12px; }.t-item { display: flex; align-items: baseline; gap: 8px; position: relative; padding: 4px 0 4px 10px; font-size: 12px; }
.t-rail { position: absolute; left: 2px; top: 0; bottom: 0; width: 2px; background: #1c2b4a; }
.t-item:first-child .t-rail { background: linear-gradient(#4d8dff, #1c2b4a); }
.t-time { color: #ffc107; font-size: 11px; flex-shrink: 0; font-family: monospace; }
.t-text { color: #aebadd; }
.t-empty { color: #5b6f94; font-size: 11px; }

.placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #5b6f94; padding: 20px; text-align: center; }
.ph-icon { font-size: 40px; margin-bottom: 10px; }
.placeholder P { font-size: 13px; max-width: 260px; }
</style>