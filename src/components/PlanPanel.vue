<template>
  <div class="plan-panel">
    <div class="pp-actions">
      <button class="gen-btn" @click="store.generatePlan()">⚙️ 生成统筹方案</button>
      <button v-if="store.plan.length" class="ghost-btn" @click="store.clearPlan()">清空</button>
    </div>
    <p class="pp-hint">按 灾情等级 → 需求缺口 → 运输时长 自动跨基地分配，可人工调整后统一提交</p>

    <!-- 批量派发结果 -->
    <div v-if="store.planResult" class="pp-result">
      <div class="pr-head">
        <strong>🧾 批量派发结果（{{ store.planResult.at }}）</strong>
        <button class="x" @click="store.planResult = null">✕</button>
      </div>
      <p class="pr-line">✅ 直接执行 {{ store.planResult.ok }} 项 · 🔀 冲突重分配 {{ store.planResult.realloc }} 项</p>
      <template v-if="store.planResult.unmet.length">
        <p class="pr-line warn">⚠️ 库存不足，{{ store.planResult.unmet.length }} 项缺口未满足：</p>
        <p v-for="(u, i) in store.planResult.unmet" :key="i" class="pr-unmet">
          · {{ u.eventTitle }} — {{ resLabel(u.type) }} 缺 {{ u.qty }}{{ resUnit(u.type) }}
        </p>
      </template>
    </div>

    <!-- 需求缺口总览 -->
    <div class="pp-gaps">
      <div class="panel-sub">📊 需求缺口（已抵扣在途与方案预占）</div>
      <div v-if="!gapList.length" class="tiny-empty">各事件需求均已满足 🎉</div>
      <div v-for="g in gapList" :key="g.ev.id" class="gap-row">
        <i class="sev-dot" :style="{ background: sevColor(g.ev.severity) }"></i>
        <span class="g-title" :title="g.ev.title">{{ g.ev.title }}</span>
        <span class="g-chips">
          <em v-for="(q, t) in g.gap" :key="t">{{ resIcon(t) }}{{ q }}</em>
        </span>
      </div>
    </div>

    <!-- 方案明细（人工调整区） -->
    <template v-if="store.plan.length">
      <div class="panel-sub">📦 跨基地分配方案（{{ store.plan.length }} 项）</div>
      <div v-for="grp in groups" :key="grp.ev.id" class="plan-group">
        <div class="pg-head">
          <i class="sev-dot" :style="{ background: sevColor(grp.ev.severity) }"></i>
          <strong>{{ grp.ev.title }}</strong>
          <span class="pg-sev" :style="{ color: sevColor(grp.ev.severity) }">{{ sevLabel(grp.ev.severity) }}</span>
        </div>
        <div v-for="it in grp.items" :key="it.id" class="plan-item" :class="{ conflict: isConflict(it) }">
          <div class="pi-top">
            <span class="pi-type">{{ resIcon(it.type) }} {{ resLabel(it.type) }}</span>
            <input
              class="pi-qty" type="number" min="1" :value="it.qty"
              @change="(e) => store.updatePlanItem(it.id, { qty: +e.target.value })"
            />
            <span class="pi-unit">{{ resUnit(it.type) }}</span>
            <button class="pi-del" title="移除该项" @click="store.removePlanItem(it.id)">✕</button>
          </div>
          <div class="pi-bottom">
            <select :value="it.baseId" @change="(e) => store.updatePlanItem(it.id, { baseId: e.target.value })">
              <option v-for="b in store.bases" :key="b.id" :value="b.id">
                {{ b.name }}（余 {{ b.stock[it.type] || 0 }}）
              </option>
            </select>
            <span class="pi-eta">🚚 {{ it.distance }}km·{{ it.minutes }}min</span>
          </div>
          <p v-if="isConflict(it)" class="pi-warn">⚠️ {{ baseName(it.baseId) }} 库存不足，提交时将自动重新分配</p>
        </div>
      </div>
      <button class="submit-btn" @click="store.submitPlan()">✅ 统一校验 · 锁定库存 · 批量派发</button>
    </template>
    <div v-else-if="!store.planResult" class="tiny-empty">点击「生成统筹方案」自动计算跨基地分配</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCommandStore } from '@/store/command'
import { RESOURCE_TYPES, SEVERITY } from '@/mock/data'

const store = useCommandStore()

const resLabel = (k) => RESOURCE_TYPES[k]?.label || k
const resIcon = (k) => RESOURCE_TYPES[k]?.icon || ''
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''
const sevColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const sevLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s
const baseName = (id) => store.bases.find((b) => b.id === id)?.name || ''

const SEV_ORDER = { red: 0, orange: 1, yellow: 2, blue: 3 }
const bySeverity = (a, b) => (SEV_ORDER[a.ev.severity] ?? 9) - (SEV_ORDER[b.ev.severity] ?? 9)

// 有缺口的事件（按等级排序）
const gapList = computed(() =>
  store.gaps
    .map((g) => ({ ev: store.events.find((e) => e.id === g.eventId), gap: g.gap }))
    .filter((x) => x.ev && Object.keys(x.gap).length)
    .sort(bySeverity)
)

// 方案按事件分组展示
const groups = computed(() => {
  const m = new Map()
  store.plan.forEach((it) => {
    if (!m.has(it.eventId)) m.set(it.eventId, [])
    m.get(it.eventId).push(it)
  })
  return [...m.entries()]
    .map(([eventId, items]) => ({ ev: store.events.find((e) => e.id === eventId), items }))
    .filter((g) => g.ev)
    .sort(bySeverity)
})

// 该项所属 基地+类型 预占超出库存即冲突
const isConflict = (it) => !!store.planConflicts[it.baseId + '|' + it.type]
</script>

<style scoped>
.plan-panel { display: flex; flex-direction: column; gap: 10px; }
.pp-actions { display: flex; gap: 8px; }
.gen-btn {
  flex: 1; padding: 9px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #7b1fa2, #9c4dff);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s;
}
.gen-btn:hover { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(156,77,255,0.4); }
.ghost-btn {
  padding: 9px 12px; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 12px; border-radius: 8px; cursor: pointer;
}
.ghost-btn:hover { color: #fff; border-color: #4d8dff; }
.pp-hint { font-size: 10px; color: #5b6f94; margin: 0; line-height: 1.5; }

.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #9c4dff; padding-left: 8px; margin: 4px 0 2px;
}
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }

/* 结果反馈 */
.pp-result {
  background: rgba(20,40,30,0.6); border: 1px solid rgba(76,175,80,0.35);
  border-radius: 9px; padding: 9px 10px;
}
.pr-head { display: flex; justify-content: space-between; align-items: center; }
.pr-head strong { color: #a5d6a7; font-size: 12px; }
.pr-head .x { background: none; border: none; color: #5b6f94; cursor: pointer; font-size: 12px; }
.pr-head .x:hover { color: #fff; }
.pr-line { font-size: 11px; color: #8ba2c8; margin: 6px 0 0; }
.pr-line.warn { color: #ffc107; }
.pr-unmet { font-size: 10px; color: #ef9a9a; margin: 3px 0 0; }

/* 缺口总览 */
.pp-gaps { display: flex; flex-direction: column; gap: 5px; }
.gap-row {
  display: flex; align-items: center; gap: 7px;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 8px; padding: 6px 8px;
}
.sev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.g-title {
  flex: 1; min-width: 0; font-size: 11px; color: #dbe4f3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.g-chips { display: flex; gap: 4px; flex-shrink: 0; }
.g-chips em { font-style: normal; font-size: 10px; color: #ffc107; }

/* 方案分组与条目 */
.plan-group {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 8px; display: flex; flex-direction: column; gap: 7px;
}
.pg-head { display: flex; align-items: center; gap: 7px; }
.pg-head strong {
  flex: 1; min-width: 0; font-size: 12px; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pg-sev { font-size: 10px; flex-shrink: 0; }
.plan-item {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 8px; padding: 7px 8px;
}
.plan-item.conflict { border-color: rgba(255,193,7,0.55); }
.pi-top { display: flex; align-items: center; gap: 6px; }
.pi-type { flex: 1; font-size: 11px; color: #dbe4f3; }
.pi-qty {
  width: 64px; background: #101d39; border: 1px solid rgba(120,160,220,0.25);
  color: #ffc107; border-radius: 6px; padding: 4px 6px; font-size: 12px; text-align: right;
}
.pi-unit { font-size: 10px; color: #8ba2c8; width: 16px; }
.pi-del {
  background: none; border: none; color: #5b6f94; font-size: 11px;
  cursor: pointer; padding: 2px 4px;
}
.pi-del:hover { color: #ef5350; }
.pi-bottom { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.pi-bottom select {
  flex: 1; min-width: 0; background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #aebadd; border-radius: 6px; padding: 4px 6px; font-size: 10px;
}
.pi-eta { font-size: 10px; color: #5b6f94; flex-shrink: 0; }
.pi-warn { font-size: 10px; color: #ffc107; margin: 6px 0 0; }

.submit-btn {
  width: 100%; padding: 10px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #1d6f3f, #2e7d32);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;
}
.submit-btn:hover { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(46,125,50,0.45); }
</style>
