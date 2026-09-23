<template>
  <div class="side">
    <!-- 过滤器 -->
    <div class="filters">
      <input v-model="store.search" class="search" placeholder="🔍 搜索事件/地点" />
      <select v-model="store.filter.type">
        <option value="all">全部类型</option>
        <option v-for="(v,k) in typeLabels" :key="k" :value="k">{{ v.label }}</option>
      </select>
      <select v-model="store.filter.severity">
        <option value="all">全部等级</option>
        <option v-for="s in SEVERITY" :key="s.value" :value="s.value">{{ s.label }}</option>
      </select>
    </div>

    <!-- 事件列表 -->
    <div class="event-scroll">
      <div
        v-for="ev in store.filteredEvents"
        :key="ev.id"
        class="ev-card"
        :class="{ active: ev.id === store.selectedEventId }"
        @click="store.selectEvent(ev.id)"
      >
        <div class="ev-row">
          <span class="ev-badge" :style="{ background: eventColor(ev.type) }">{{ typeLabel(ev.type) }}</span>
          <strong>{{ ev.title }}</strong>
          <span class="sev" :style="{ color: severityColor(ev.severity) }">{{ severityLabel(ev.severity) }}</span>
        </div>
        <div class="ev-row meta">
          <span>📍 {{ ev.location?.name }}</span>
          <span :style="{ color: statusColor(ev.status) }">● {{ statusLabel(ev.status) }}</span>
        </div>
        <div class="ev-row tags">
          <span class="tag">👥 {{ (ev.affected||0).toLocaleString() }}人</span>
          <span class="tag">{{ ev.reportedAt }} 上报</span>
        </div>
      </div>
      <div v-if="store.filteredEvents.length === 0" class="empty">无匹配事件</div>
    </div>
  </div>
</template>

<script setup>
import { useCommandStore } from '@/store/command'
import { EVENT_TYPES, SEVERITY, EVENT_STATUS } from '@/mock/data'

const store = useCommandStore()
const typeLabels = EVENT_TYPES
const typeLabel = (t) => EVENT_TYPES[t]?.label || t
const eventColor = (t) => EVENT_TYPES[t]?.color || '#777'
const severityColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const severityLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s
const statusLabel = (s) => EVENT_STATUS.find((x) => x.value === s)?.label || s
const statusColor = (s) => EVENT_STATUS.find((x) => x.value === s)?.color || '#999'
</script>

<style scoped>
.side {
  display: flex; flex-direction: column; height: 100%;
  min-height: 0;
}
.filters { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-bottom: 1px solid rgba(120,160,220,0.15); }
.search, .filters select {
  background: #0f1c36; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 8px 10px; font-size: 12px;
  width: 100%;
}
.event-scroll { flex: 1; overflow-y: auto; padding: 10px 12px; }
.event-scroll::-webkit-scrollbar { width: 6px; }
.event-scroll::-webkit-scrollbar-thumb { background: #1c2b4a; border-radius: 4px; }

.ev-card {
  background: #101d39; border: 1px solid rgba(120,160,220,0.13);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
  cursor: pointer; transition: all 0.18s;
}
.ev-card:hover { border-color: #2f4d86; transform: translateY(-1px); }
.ev-card.active {
  border-color: #4d8dff; background: linear-gradient(180deg, #14264a, #101d39);
  box-shadow: 0 0 0 1px rgba(77,141,255,0.35), 0 6px 16px rgba(0,0,0,0.3);
}
.ev-row { display: flex; align-items: center; gap: 8px; }
.ev-row.meta { margin-top: 7px; font-size: 11px; color: #8ba2c8; justify-content: space-between; }
.ev-row.tags { margin-top: 7px; gap: 6px; }
.ev-badge {
  color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 5px; flex-shrink: 0;
}
.ev-row strong { font-size: 13px; color: #e8eefb; flex: 1; line-height: 1.4; }
.sev { font-size: 11px; flex-shrink: 0; font-weight: 700; }
.tag {
  font-size: 10px; background: #0c1730; border: 1px solid rgba(120,160,220,0.15);
  color: #8ba2c8; padding: 2px 7px; border-radius: 4px;
}
.empty { text-align: center; color: #5b6f94; padding: 30px 0; font-size: 13px; }
</style>