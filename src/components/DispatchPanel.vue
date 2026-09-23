<template>
  <div class="dispatch">
    <!-- 页签：单点派发 / 统筹方案 / 转移安置 / 道路阻断 -->
    <div class="tabs">
      <button :class="{ active: tab === 'single' }" @click="tab = 'single'">🎯 单点派发</button>
      <button :class="{ active: tab === 'plan' }" @click="tab = 'plan'">
        🧮 统筹方案<span v-if="store.plan.length" class="badge">{{ store.plan.length }}</span>
      </button>
      <button :class="{ active: tab === 'transfer' }" @click="tab = 'transfer'">
        🚌 转移安置<span v-if="transfer.stats.activeBatches" class="badge teal">{{ transfer.stats.activeBatches }}</span>
      </button>
      <button :class="{ active: tab === 'road' }" @click="tab = 'road'">
        🚧 道路阻断<span v-if="roadblock.activeBlocks.length" class="badge red">{{ roadblock.activeBlocks.length }}</span>
      </button>
      <button :class="{ active: tab === 'repair' }" @click="tab = 'repair'">
        🔧 道路抢修<span v-if="repair.activeOrders.length" class="badge orange">{{ repair.activeOrders.length }}</span>
      </button>
    </div>

    <template v-if="tab === 'single'">
    <!-- 当前选中事件 -->
    <div v-if="selectedEvent" class="current-ev">
      <strong>{{ selectedEvent.title }}</strong>
      <p>🧑‍🚒 所需资源清单（保障=实收+在途 / 需求）</p>
      <div class="demand-row" v-for="(qty, type) in selectedEvent.demand" :key="type">
        <span class="d-label">{{ resLabel(type) }} {{ resIcon(type) }}</span>
        <div class="d-bar"><i :style="{ width: fillPct(type) }"></i></div>
        <span class="d-qty">
          <em>{{ sentOf(type) }}/{{ qty }}{{ resUnit(type) }}</em>
          <i v-if="receivedOf(type) > 0">📥 实收 {{ receivedOf(type) }}</i>
          <i v-else-if="shortOf(type) > 0" class="short">⚠ 短缺待补 {{ shortOf(type) }}</i>
        </span>
      </div>
    </div>
    <div v-else class="placeholder">← 在地图上或左侧选择一个事件进行调度</div>

    <!-- 派发表单 -->
    <div class="dispatch-form" v-if="selectedEvent">
      <div class="form-title">派发救援资源</div>
      <div class="grid">
        <div class="field">
          <label>资源基地</label>
          <select v-model="form.baseId">
            <option v-for="b in store.bases" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>资源类型</label>
          <select v-model="form.type">
            <option v-for="(v,k) in RESOURCE_TYPES" :key="k" :value="k">{{ v.label }}</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>数量（库存：{{ maxQty }}）</label>
        <input type="number" min="0" :max="maxQty" v-model.number="form.qty" />
      </div>
      <button class="dispatch-btn" :disabled="!canDispatch" @click="onDispatch">
        🚀 派发 {{ formQtyLabel }}
      </button>
      <p class="hint">派发后自动在地图绘制路线、估算距离与到达时间</p>
    </div>

    <!-- 资源库库存总览 -->
    <div class="bases">
      <div class="panel-sub">📦 资源库 / 救援点库存</div>
      <div class="base-card" v-for="b in store.bases" :key="b.id">
        <div class="base-head">
          <span class="base-icon">🏗️</span>
          <div class="base-info">
            <strong>{{ b.name }}</strong>
            <p>余量可视列</p>
          </div>
        </div>
        <div class="base-stocks" v-if="b.stock">
          <span v-for="(v,k) in b.stock" :key="k" class="stock-chip"
                :class="{ zero: v === 0 }">{{ resLabel(k) }} {{ v }}</span>
        </div>
      </div>
    </div>

    <!-- 派发记录（闭环：分批签收 / 短缺补派 / 退回入库） -->
    <div class="dispatches">
      <div class="panel-sub">🚚 派发记录（在途 / 实收 / 短缺 / 退回分账）</div>
      <div v-if="store.dispatches.length === 0" class="tiny-empty">暂无派发</div>
      <div
        v-for="d in store.dispatches" :key="d.id"
        class="dispatch-item"
        :class="{ held: d.status === 'held', done: d.status === 'done', withdrawn: d.status === 'withdrawn' }"
      >
        <div class="di-head">
          <span class="di-dot" :style="{ background: d.color }"></span>
          <strong>{{ d.typeLabel }}</strong>
          <span v-if="d.status === 'held'" class="di-held">⏸ 挂起</span>
          <span v-else-if="d.status === 'withdrawn'" class="di-withdrawn">🚫 已撤回</span>
          <span v-else-if="d.status === 'done'" class="di-done" :class="d.doneReason">
            {{ d.doneReason === 'returned' ? '↩️ 已退库' : d.doneReason === 'short' ? '⚠ 含短缺办结' : '✅ 已签收' }}
          </span>
          <span v-else-if="d.via && d.via.length" class="di-detour">🔀 绕行</span>
          <span v-if="d.source" class="di-src" :class="{ plan: d.source === '统筹', replenish: (d.source || '').includes('补派') }">{{ d.source }}</span>
          <span class="di-qty">
            <em>{{ partsOf(d).received }}/{{ d.qty }}{{ d.unit }}</em>
            <i v-if="partsOf(d).inTransit > 0" class="q-transit">在途 {{ partsOf(d).inTransit }}</i>
          </span>
        </div>
        <p class="di-sub">{{ d.baseName }} → {{ d.eventTitle || d.shelterName }}</p>
        <!-- 数量分账条 -->
        <div class="di-ledger" :title="`在途${partsOf(d).inTransit} · 实收${partsOf(d).received} · 短缺${partsOf(d).shortage} · 退回${partsOf(d).returned} · 撤回${partsOf(d).withdrawn}`">
          <i class="lg-transit" :style="{ width: pctOf(d, partsOf(d).inTransit) }"></i>
          <i class="lg-recv" :style="{ width: pctOf(d, partsOf(d).received) }"></i>
          <i class="lg-short" :style="{ width: pctOf(d, partsOf(d).shortage) }"></i>
          <i class="lg-ret" :style="{ width: pctOf(d, partsOf(d).returned) }"></i>
          <i class="lg-withdrawn" :style="{ width: pctOf(d, partsOf(d).withdrawn) }"></i>
        </div>
        <p class="di-ledger-txt">
          🚚 在途 <b>{{ partsOf(d).inTransit }}</b> · 📥 实收 <b>{{ partsOf(d).received }}</b>
          <template v-if="partsOf(d).shortage">· ⚠ 短缺 <b>{{ partsOf(d).shortage }}</b>
            <em v-if="partsOf(d).resupplied">（已补 {{ partsOf(d).resupplied }}）</em>
          </template>
          <template v-if="partsOf(d).returned">· ↩️ 退回 <b>{{ partsOf(d).returned }}</b></template>
          <template v-if="partsOf(d).withdrawn">· 🚫 撤回 <b>{{ partsOf(d).withdrawn }}</b></template>
          {{ d.unit }}
        </p>
        <p class="di-meta">{{ d.at }} · {{ d.distance }}km · 约{{ d.minutes }}min</p>

        <!-- 闭环操作（仅在途记录） -->
        <div v-if="d.status === 'enroute'" class="di-actions">
          <button class="act sign" @click="openForm(d.id, 'sign')">📥 签收</button>
          <button class="act ret" @click="openForm(d.id, 'return')">↩️ 退回</button>
          <button
            v-if="partsOf(d).shortPending > 0"
            class="act replenish"
            @click="onReplenish(d)"
          >🔁 短缺补派 {{ partsOf(d).shortPending }}{{ d.unit }}</button>
          <button class="act withdraw" @click="store.withdrawDispatch(d.id)">撤回</button>
        </div>

        <!-- 签收表单：分批签收 + 本次可同时认定短缺 -->
        <div v-if="formOf[d.id]?.mode === 'sign'" class="mini-form">
          <p class="mf-hint">本次签收（在途余量 {{ partsOf(d).inTransit }}{{ d.unit }}，可分多批）</p>
          <div class="mf-row">
            <input type="number" min="0" :max="partsOf(d).inTransit" v-model.number="formOf[d.id].qty" placeholder="签收数" />
            <input type="number" min="0" :max="partsOf(d).inTransit" v-model.number="formOf[d.id].shortQty" placeholder="短缺数（可空）" />
            <input v-model="formOf[d.id].receiver" placeholder="签收人（可空）" />
          </div>
          <div class="mf-btns">
            <button class="ok" @click="onSign(d)">确认签收</button>
            <button @click="clearForm(d.id)">取消</button>
          </div>
        </div>
        <!-- 退回表单 -->
        <div v-else-if="formOf[d.id]?.mode === 'return'" class="mini-form">
          <p class="mf-hint">退回入库（在途余量 {{ partsOf(d).inTransit }}{{ d.unit }}，退回后库存回补）</p>
          <div class="mf-row">
            <input type="number" min="0" :max="partsOf(d).inTransit" v-model.number="formOf[d.id].qty" placeholder="退回数" />
            <input v-model="formOf[d.id].reason" placeholder="退回原因（可空）" />
          </div>
          <div class="mf-btns">
            <button class="warn" @click="onReturn(d)">确认退回</button>
            <button @click="clearForm(d.id)">取消</button>
          </div>
        </div>

        <p v-if="fb[d.id]" class="di-fb" :class="fb[d.id].ok ? 'ok' : 'err'">{{ fb[d.id].msg }}</p>
        <!-- 最近签收回执 -->
        <p v-if="d.signLogs && d.signLogs.length" class="di-signlog">
          最近签收：{{ d.signLogs[d.signLogs.length - 1].at }}
          {{ d.signLogs[d.signLogs.length - 1].qty }}{{ d.unit }} · {{ d.signLogs[d.signLogs.length - 1].receiver }}
        </p>
        <p v-if="d.withdrawLogs && d.withdrawLogs.length" class="di-signlog">
          撤回留痕：{{ d.withdrawLogs[d.withdrawLogs.length - 1].at }}
          回库 {{ d.withdrawLogs[d.withdrawLogs.length - 1].qty }}{{ d.unit }} · {{ d.withdrawLogs[d.withdrawLogs.length - 1].reason }}
        </p>
      </div>
    </div>
    </template>

    <!-- 多灾点统筹方案 -->
    <PlanPanel v-else-if="tab === 'plan'" />

    <!-- 群众转移安置 -->
    <TransferPanel v-else-if="tab === 'transfer'" />

    <!-- 道路阻断处置 -->
    <RoadBlockPanel v-else-if="tab === 'road'" />

    <!-- 道路抢修工单 -->
    <RepairPanel v-else-if="tab === 'repair'" />
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch } from 'vue'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { RESOURCE_TYPES } from '@/mock/data'
import PlanPanel from '@/components/PlanPanel.vue'
import TransferPanel from '@/components/TransferPanel.vue'
import RoadBlockPanel from '@/components/RoadBlockPanel.vue'
import RepairPanel from '@/components/RepairPanel.vue'

const store = useCommandStore()
const transfer = useTransferStore()
const roadblock = useRoadblockStore()
const repair = useRepairStore()
const tab = ref('single')
const form = ref({ baseId: '', type: 'personnel', qty: 0 })

const selectedEvent = computed(() =>
  store.events.find((e) => e.id === store.selectedEventId) || null
)
const resLabel = computed(() => (k) => RESOURCE_TYPES[k]?.label || k)
const resIcon = (k) => RESOURCE_TYPES[k]?.icon || ''
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''

// 当前选中的基地与类型剩余库存
const currentBase = computed(() => store.bases.find((b) => b.id === form.value.baseId))
const maxQty = computed(() => {
  if (!currentBase.value || !form.value.type) return 0
  return currentBase.value.stock[form.value.type] || 0
})
const canDispatch = computed(() =>
  !!selectedEvent.value && !!form.value.baseId && form.value.qty > 0 && form.value.qty <= maxQty.value
)
const formQtyLabel = computed(() => {
  if (!selectedEvent.value) return ''
  const qty = form.value.qty > 0 ? `${form.value.qty}` : '0'
  return `${qty}${resUnit(form.value.type)}`
})

// 事件需求条：在途保障量（实收+在途）与满足率
const sentOf = (type) => {
  if (!selectedEvent.value) return 0
  return store.sentMap[selectedEvent.value.id]?.[type] || 0
}
// 实际签收量（闭环实收口径）
const receivedOf = (type) => {
  if (!selectedEvent.value) return 0
  return store.receivedMap[selectedEvent.value.id]?.[type] || 0
}
// 已认定未补派的短缺量
const shortOf = (type) => {
  if (!selectedEvent.value) return 0
  return store.shortageMap[selectedEvent.value.id]?.[type] || 0
}
function fillPct(type) {
  const need = selectedEvent.value?.demand?.[type] || 0
  if (!need) return '0%'
  return Math.min(100, Math.round((sentOf(type) / need) * 100)) + '%'
}

/* ---------- 派发闭环：签收 / 短缺补派 / 退回入库 ---------- */
// 各记录行内表单：{ [id]: { mode: 'sign'|'return', qty, shortQty, receiver, reason } }
const formOf = reactive({})
const fb = reactive({})
const partsOf = (d) => dispatchParts(d)
const pctOf = (d, v) => Math.min(100, Math.round((v / d.qty) * 100)) + '%'

function openForm(id, mode) {
  const p = store.dispatches.find((d) => d.id === id)
  if (!p) return
  formOf[id] = { mode, qty: dispatchParts(p).inTransit, shortQty: 0, receiver: '', reason: '' }
  delete fb[id]
}
function clearForm(id) { delete formOf[id] }

function onSign(d) {
  const f = formOf[d.id]
  const r = store.signDispatch(d.id, { qty: f.qty, shortQty: f.shortQty, receiver: f.receiver })
  fb[d.id] = r.ok
    ? {
        ok: true,
        msg: `签收成功，累计实收 ${r.received}/${d.qty}${d.unit}`
          + (r.shortage ? `，短缺 ${r.shortage}${d.unit}` : '')
          + (r.outstanding > 0 ? `，在途余量 ${r.outstanding}${d.unit}` : '，已办结')
      }
    : { ok: false, msg: r.msg }
  if (r.ok) clearForm(d.id)
}
function onReturn(d) {
  const f = formOf[d.id]
  const r = store.returnDispatch(d.id, { qty: f.qty, reason: f.reason })
  fb[d.id] = r.ok
    ? { ok: true, msg: `已退回入库 ${f.qty}${d.unit}，库存已回补` + (r.outstanding > 0 ? `，在途余量 ${r.outstanding}${d.unit}` : '，已办结') }
    : { ok: false, msg: r.msg }
  if (r.ok) clearForm(d.id)
}
function onReplenish(d) {
  const r = store.replenishShortage(d.id)
  fb[d.id] = r.ok
    ? { ok: true, msg: `短缺补派 ${r.sent.length} 单共 ${r.sent.reduce((s, x) => s + x.qty, 0)}${d.unit} 已出库` + (r.unmet ? `，仍缺 ${r.unmet}${d.unit}` : '') }
    : { ok: false, msg: r.msg }
}

function onDispatch() {
  const rec = store.dispatchResource({
    baseId: form.value.baseId,
    eventId: selectedEvent.value.id,
    type: form.value.type,
    qty: form.value.qty
  })
  if (rec) form.value.qty = 0
}

watch(() => store.scenarioId, () => {
  form.value = { baseId: '', type: 'personnel', qty: 0 }
})
// 阻断卡片发起抢修 / 查看工单 → 自动跳到抢修页签
watch(() => repair.assigningBlockId, (id) => {
  if (id) tab.value = 'repair'
})
watch(() => repair.focusOrderId, (id) => {
  if (id) tab.value = 'repair'
})
watch(selectedEvent, (ev) => {
  if (ev) {
    // 默认选择距受灾点最近的基地
    let nearest = null, best = Infinity
    store.bases.forEach((b) => {
      const d = Math.hypot(b.lng - ev.location.lng, b.lat - ev.location.lat)
      if (d < best) { best = d; nearest = b }
    })
    form.value.baseId = nearest ? nearest.id : (store.bases[0]?.id || '')
  }
}, { immediate: true })
</script>

<style scoped>
.dispatch {
  display: flex; flex-direction: column; height: 100%;
  min-height: 0; padding: 12px; gap: 12px; overflow-y: auto;
}
.dispatch::-webkit-scrollbar { width: 6px; }
.dispatch::-webkit-scrollbar-thumb { background: #1c2b4a; border-radius: 4px; }
.panel-title { font-size: 15px; font-weight: 700; color: #fff; }
.tabs { display: flex; gap: 6px; }
.tabs button {
  flex: 1; padding: 8px; background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  color: #8ba2c8; font-size: 12px; font-weight: 600; border-radius: 8px; cursor: pointer;
  transition: all 0.2s; position: relative;
}
.tabs button.active {
  background: linear-gradient(135deg, #1d3f8f, #2962ff); color: #fff;
  border-color: transparent; box-shadow: 0 3px 10px rgba(41,98,255,0.35);
}
.badge {
  display: inline-block; min-width: 16px; margin-left: 5px; padding: 0 4px;
  background: #9c4dff; color: #fff; font-size: 10px; line-height: 16px;
  border-radius: 8px; vertical-align: 1px;
}
.badge.teal { background: #26a69a; }
.badge.red { background: #ef5350; }
.badge.orange { background: #ff9800; }
.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #4d8dff; padding-left: 8px; margin: 6px 0;
}

.current-ev {
  background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 10px; padding: 12px;
}
.current-ev strong { color: #fff; font-size: 13px; display: block; margin-bottom: 8px; }
.current-ev P { color: #8ba2c8; font-size: 11px; margin: 0 0 6px; }
.demand-row {
  display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: 11px;
}
.d-label { width: 78px; color: #aebadd; flex-shrink: 0; }
.d-bar { flex: 1; height: 6px; background: #0c1730; border-radius: 3px; overflow: hidden; }
.d-bar i { display: block; height: 100%; background: linear-gradient(90deg, #4d8dff, #7e9ff5); border-radius: 3px; }
.d-qty { width: 108px; text-align: right; color: #ffc107; flex-shrink: 0; font-size: 10px; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.35; }
.d-qty em { font-style: normal; }
.d-qty i { font-style: normal; color: #7ef0c9; font-size: 9px; }
.d-qty i.short { color: #ffab91; }
.placeholder {
  color: #5b6f94; font-size: 12px; text-align: center;
  border: 1px dashed rgba(120,160,220,0.2); border-radius: 10px; padding: 24px 12px;
}

.dispatch-form { background: #101d39; border: 1px solid rgba(120,160,220,0.15); border-radius: 10px; padding: 12px; }
.form-title { font-size: 12px; font-weight: 600; color: #8ba2c8; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { margin-bottom: 8px; }
.field label { display: block; font-size: 11px; color: #8ba2c8; margin-bottom: 4px; }
.field select, .field input {
  width: 100%; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 8px; font-size: 12px;
  box-sizing: border-box;
}
.dispatch-btn {
  width: 100%; padding: 10px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #1d3f8f, #2962ff);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  transition: all 0.2s;
}
.dispatch-btn:hover:not(:disabled) { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(41,98,255,0.4); }
.dispatch-btn:disabled { background: #1a2747; color: #5b6f94; cursor: not-allowed; }
.hint { font-size: 10px; color: #5b6f94; margin: 8px 0 0; }

.bases { display: flex; flex-direction: column; gap: 8px; }
.base-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 9px 10px;
}
.base-head { display: flex; align-items: center; gap: 8px; }
.base-icon { font-size: 18px; }
.base-info strong { color: #dbe4f3; font-size: 12px; }
.base-info P { font-size: 10px; color: #5b6f94; margin: 0; }
.base-stocks { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.stock-chip {
  font-size: 10px; background: #0c1730; border: 1px solid rgba(120,160,220,0.15);
  color: #8ba2c8; padding: 2px 6px; border-radius: 4px;
}
.stock-chip.zero { color: #4a5875; text-decoration: line-through; }

.dispatches { display: flex; flex-direction: column; gap: 8px; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }
.dispatch-item {
  position: relative;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 9px 10px;
}
.dispatch-item.held { border-color: rgba(255,193,7,0.35); opacity: 0.75; }
.dispatch-item.done { opacity: 0.7; border-color: rgba(76,175,80,0.25); }
.dispatch-item.withdrawn { opacity: 0.65; border-color: rgba(239,83,80,0.25); }
.di-head { display: flex; align-items: center; gap: 7px; }
.di-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.di-head strong { color: #dbe4f3; font-size: 12px; }
.di-src {
  font-size: 9px; padding: 1px 5px; border-radius: 4px;
  background: rgba(120,160,220,0.15); color: #8ba2c8;
}
.di-src.plan { background: rgba(156,77,255,0.2); color: #ce93ff; }
.di-src.replenish { background: rgba(255,152,0,0.18); color: #ffcc80; }
.di-held {
  font-size: 9px; padding: 1px 5px; border-radius: 4px;
  background: rgba(255,193,7,0.18); color: #ffd54f;
}
.di-withdrawn {
  font-size: 9px; padding: 1px 5px; border-radius: 4px;
  background: rgba(239,83,80,0.16); color: #ef9a9a;
}
.di-done {
  font-size: 9px; padding: 1px 5px; border-radius: 4px;
  background: rgba(76,175,80,0.18); color: #a5d6a7;
}
.di-done.short { background: rgba(255,152,0,0.18); color: #ffcc80; }
.di-done.returned { background: rgba(120,160,220,0.15); color: #8ba2c8; }
.di-detour {
  font-size: 9px; padding: 1px 5px; border-radius: 4px;
  background: rgba(255,152,0,0.15); color: #ffcc80;
}
.di-qty { margin-left: auto; color: #ffc107; font-size: 12px; font-weight: 700; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.25; }
.di-qty em { font-style: normal; }
.di-qty i { font-style: normal; font-size: 9px; color: #7ea8e8; font-weight: 400; }
.di-qty i.short { color: #ffab91; }
.di-sub { font-size: 10px; color: #8ba2c8; margin: 4px 0 0; }
.di-meta { font-size: 10px; color: #5b6f94; margin: 2px 0 0; }

/* 数量分账条 */
.di-ledger {
  display: flex; height: 5px; border-radius: 3px; overflow: hidden;
  background: #0c1730; margin-top: 6px;
}
.di-ledger i { display: block; height: 100%; }
.lg-transit { background: linear-gradient(90deg, #4d8dff, #7e9ff5); }
.lg-recv { background: linear-gradient(90deg, #26a69a, #7ef0c9); }
.lg-short { background: #ff9800; }
.lg-ret { background: #6f8cb8; }
.lg-withdrawn { background: #ef5350; }
.di-ledger-txt { font-size: 10px; color: #8ba2c8; margin: 4px 0 0; }
.di-ledger-txt b { color: #dbe4f3; font-weight: 700; }
.di-ledger-txt em { font-style: normal; color: #5b6f94; }

/* 闭环操作 */
.di-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.act {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
.act:hover { color: #fff; border-color: #4d8dff; }
.act.sign { border-color: rgba(38,166,154,0.45); color: #7ef0c9; }
.act.sign:hover { background: rgba(38,166,154,0.15); }
.act.ret { border-color: rgba(120,160,220,0.35); }
.act.replenish { border-color: rgba(255,152,0,0.5); color: #ffcc80; }
.act.replenish:hover { background: rgba(255,152,0,0.12); }
.act.withdraw { border-color: rgba(239,83,80,0.4); color: #ef5350; margin-left: auto; }
.act.withdraw:hover { background: rgba(239,83,80,0.12); }

/* 行内迷你表单 */
.mini-form {
  margin-top: 7px; background: #0c1730; border: 1px solid rgba(120,160,220,0.18);
  border-radius: 7px; padding: 8px;
}
.mf-hint { font-size: 10px; color: #8ba2c8; margin: 0 0 6px; }
.mf-row { display: flex; gap: 5px; }
.mf-row input {
  flex: 1; min-width: 0; width: 0;
  background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 5px; padding: 5px 7px; font-size: 11px; box-sizing: border-box;
}
.mf-btns { display: flex; gap: 6px; margin-top: 6px; }
.mf-btns button {
  padding: 4px 12px; font-size: 11px; border-radius: 5px; cursor: pointer;
  background: transparent; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
}
.mf-btns button.ok { border-color: #26a69a; color: #7ef0c9; }
.mf-btns button.ok:hover { background: rgba(38,166,154,0.15); }
.mf-btns button.warn { border-color: #ff9800; color: #ffcc80; }
.mf-btns button.warn:hover { background: rgba(255,152,0,0.12); }
.di-fb { font-size: 10px; margin: 5px 0 0; }
.di-fb.ok { color: #7ef0c9; }
.di-fb.err { color: #ef9a9a; }
.di-signlog { font-size: 9px; color: #5b6f94; margin: 4px 0 0; }
</style>