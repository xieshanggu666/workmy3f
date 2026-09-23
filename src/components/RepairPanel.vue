<template>
  <div class="rp">
    <div class="rp-summary">
      <span>🔧 抢修中 <b>{{ repair.workingCount }}</b></span>
      <span>🔍 待验收 <b class="verify">{{ repair.verifyCount }}</b></span>
      <span>✅ 已办结 <b class="ok">{{ finishedCount }}</b></span>
    </div>

    <!-- 指挥员派单：分配队伍 / 车辆 / 物资 -->
    <div v-if="assignBlock" class="assign-form">
      <div class="af-title">
        🔧 发起抢修工单
        <span class="af-blk">🚧 {{ assignBlock.name }}</span>
      </div>
      <div class="field">
        <label>资源出库基地</label>
        <select v-model="form.baseId">
          <option v-for="b in cmd.bases" :key="b.id" :value="b.id">
            {{ b.name }}（人员 {{ b.stock.personnel || 0 }} · 车辆 {{ b.stock.vehicle || 0 }}）
          </option>
        </select>
      </div>
      <div class="grid2">
        <div class="field">
          <label>抢修队伍（人）</label>
          <input type="number" min="0" :max="personnelMax" v-model.number="form.personnel" />
          <em class="stock-tip">库存 {{ personnelMax }}</em>
        </div>
        <div class="field">
          <label>抢修车辆（辆）</label>
          <input type="number" min="0" :max="vehicleMax" v-model.number="form.vehicles" />
          <em class="stock-tip">库存 {{ vehicleMax }}</em>
        </div>
      </div>
      <div class="field">
        <label>抢修物资（按实际作业需要领用）</label>
        <div v-for="(row, i) in form.materials" :key="i" class="mat-row">
          <select v-model="row.type">
            <option v-for="t in availableMaterialTypes(i)" :key="t" :value="t">{{ resLabel(t) }}（库 {{ baseStock(t) }}{{ resUnit(t) }}）</option>
          </select>
          <input type="number" min="0" v-model.number="row.qty" placeholder="数量" />
          <button class="mat-del" title="移除" @click="form.materials.splice(i, 1)">✕</button>
        </div>
        <button class="mat-add" @click="addMaterial">＋ 添加物资</button>
      </div>
      <div class="grid2">
        <div class="field">
          <label>计划完工时间（可空）</label>
          <input v-model="form.deadline" placeholder="如 今日 18:00" />
        </div>
        <div class="field">
          <label>备注（可空）</label>
          <input v-model="form.remark" placeholder="作业要点" />
        </div>
      </div>
      <p v-if="assignMsg" class="msg err">{{ assignMsg }}</p>
      <div class="af-actions">
        <button class="primary" @click="onAssign">📋 确认派单</button>
        <button class="ghost" @click="repair.cancelAssign()">取消</button>
      </div>
    </div>

    <!-- 工单列表 -->
    <div v-if="repair.orders.length === 0" class="tiny-empty">
      暂无抢修工单，可在生效阻断卡片上点「🔧 发起抢修」
    </div>
    <div
      v-for="o in repair.orders" :key="o.id"
      class="ro-card"
      :class="[o.status, { focus: repair.focusOrderId === o.id }]"
      :ref="(el) => bindCardRef(el, o.id)"
    >
      <div class="ro-head">
        <span class="ro-status" :style="{ background: repair.statusColor(o.status) }">{{ repair.statusLabel(o.status) }}</span>
        <strong :title="o.blockName">🚧 {{ o.blockName }}</strong>
        <span v-if="o.delayed" class="ro-delay" :title="`已延期 ${o.delayCount} 次`">⏰ 延期×{{ o.delayCount }}</span>
        <span class="ro-time">{{ o.createdAt }}</span>
      </div>
      <p class="ro-meta">🏗️ {{ o.baseName }} · 👷 {{ o.personnel }}人 · 🚒 {{ o.vehicles }}辆
        <template v-if="o.materials.length"> · {{ o.materials.map(m => m.typeLabel + m.qty + m.unit).join('、') }}</template>
      </p>

      <!-- 进度条 -->
      <div v-if="o.status === 'accepted' || o.status === 'done'" class="ro-prog">
        <b class="ro-track"><i :style="{ width: o.progress + '%' }" :class="{ full: o.progress === 100 }"></i></b>
        <em>{{ o.progress }}%</em>
      </div>

      <!-- 消耗/结算信息 -->
      <p v-if="o.settled" class="ro-settle">
        📒 实际消耗：{{ usedText(o) }}
      </p>

      <!-- 操作区 -->
      <div v-if="isLive(o)" class="ro-actions">
        <button v-if="o.status === 'dispatched'" class="act sign" @click="onAccept(o)">🙋 现场接单</button>
        <template v-if="o.status === 'accepted'">
          <button class="act prog" @click="openForm(o, 'progress')">📍 上报进度{{ o.progress ? `（${o.progress}%）` : '' }}</button>
          <button class="act finish" @click="openForm(o, 'finish')">🏁 完工上报</button>
          <button class="act delay" @click="openForm(o, 'delay')">⏰ 延期</button>
        </template>
        <button v-if="o.status === 'done'" class="act verify" @click="onAcceptWork(o)">✅ 验收通过·解除封闭</button>
        <button v-if="o.status === 'done'" class="act fail" @click="openForm(o, 'fail')">❌ 验收不通过</button>
        <button v-if="o.status === 'accepted'" class="act fail" @click="openForm(o, 'fail')">❌ 抢修失败</button>
        <button v-if="o.status === 'dispatched' || o.status === 'accepted'" class="act cancel" @click="openForm(o, 'cancel')">🚫 撤单</button>
      </div>

      <!-- 行内表单 -->
      <div v-if="formOf[o.id]" class="mini-form" @click.stop>
        <!-- 上报进度 -->
        <template v-if="formOf[o.id].mode === 'progress'">
          <p class="mf-hint">现场进度：<b>{{ formOf[o.id].progress }}%</b>（当前 {{ o.progress }}%，单调递增）</p>
          <input type="range" min="0" max="100" v-model.number="formOf[o.id].progress" />
          <input v-model="formOf[o.id].note" placeholder="进度说明（可空），如：半幅已清障" />
          <div class="mf-btns">
            <button class="ok" @click="onProgress(o)">提交进度</button>
            <button @click="clearForm(o.id)">取消</button>
          </div>
        </template>
        <!-- 延期 -->
        <template v-else-if="formOf[o.id].mode === 'delay'">
          <p class="mf-hint">延期申请（阻断将继续保留，可多次延期）</p>
          <input v-model="formOf[o.id].deadline" placeholder="新计划完工时间（可空）" />
          <input v-model="formOf[o.id].reason" placeholder="延期原因（可空），如：夜间暴雨不宜作业" />
          <div class="mf-btns">
            <button class="warn" @click="onDelay(o)">确认延期</button>
            <button @click="clearForm(o.id)">取消</button>
          </div>
        </template>
        <!-- 完工 / 失败 / 撤单：登记实际消耗 -->
        <template v-else>
          <p class="mf-hint">{{ settleHint(formOf[o.id].mode) }}（未消耗资源将归还 {{ o.baseName }}）</p>
          <div v-if="o.personnel" class="use-row">
            <span>👷 人员消耗</span>
            <input type="number" min="0" :max="o.personnel" v-model.number="formOf[o.id].used.personnel" />
            <em>/ {{ o.personnel }} 人</em>
          </div>
          <div v-if="o.vehicles" class="use-row">
            <span>🚒 车辆损毁</span>
            <input type="number" min="0" :max="o.vehicles" v-model.number="formOf[o.id].used.vehicles" />
            <em>/ {{ o.vehicles }} 辆</em>
          </div>
          <div v-for="m in o.materials" :key="m.type" class="use-row">
            <span>{{ m.typeLabel }}消耗</span>
            <input type="number" min="0" :max="m.qty" v-model.number="formOf[o.id].used.materials[m.type]" />
            <em>/ {{ m.qty }} {{ m.unit }}</em>
          </div>
          <input v-if="formOf[o.id].mode === 'fail'" v-model="formOf[o.id].reason" placeholder="失败原因（可空）" />
          <input v-if="formOf[o.id].mode === 'cancel'" v-model="formOf[o.id].reason" placeholder="撤单原因（可空）" />
          <div class="mf-btns">
            <button :class="formOf[o.id].mode === 'finish' ? 'ok' : 'warn'" @click="onSettle(o)">
              {{ formOf[o.id].mode === 'finish' ? '确认完工上报' : formOf[o.id].mode === 'fail' ? '确认失败（保留阻断）' : '确认撤单（保留阻断）' }}
            </button>
            <button @click="clearForm(o.id)">取消</button>
          </div>
        </template>
      </div>

      <p v-if="fb[o.id]" class="ro-fb" :class="fb[o.id].ok ? 'ok' : 'err'">{{ fb[o.id].msg }}</p>

      <!-- 工单日志（最近 3 条） -->
      <div class="ro-log">
        <p v-for="(l, i) in o.logs.slice(-3)" :key="i"><span>{{ l.at }}</span>{{ l.text }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { useCommandStore } from '@/store/command'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { RESOURCE_TYPES, REPAIR_MATERIAL_TYPES } from '@/mock/data'

const cmd = useCommandStore()
const roadblock = useRoadblockStore()
const repair = useRepairStore()

const MATERIAL_TYPES = REPAIR_MATERIAL_TYPES
const resLabel = (t) => RESOURCE_TYPES[t]?.label || t
const resUnit = (t) => RESOURCE_TYPES[t]?.unit || ''

const assignMsg = ref('')
const form = ref({
  baseId: '', personnel: 10, vehicles: 2,
  materials: [{ type: 'medical', qty: 20 }],
  deadline: '', remark: ''
})
// 各工单行内表单：{ [id]: { mode, progress, note, reason, deadline, used: {...} } }
const formOf = reactive({})
const fb = reactive({})

const assignBlock = computed(() =>
  repair.assigningBlockId ? roadblock.blocks.find((b) => b.id === repair.assigningBlockId) || null : null
)

const currentBase = computed(() => cmd.bases.find((b) => b.id === form.value.baseId))
const personnelMax = computed(() => currentBase.value?.stock.personnel || 0)
const vehicleMax = computed(() => currentBase.value?.stock.vehicle || 0)
const baseStock = (type) => currentBase.value?.stock[type] || 0

const finishedCount = computed(() =>
  repair.orders.filter((o) => ['cleared', 'failed', 'cancelled'].includes(o.status)).length
)
const isLive = (o) => ['dispatched', 'accepted', 'done'].includes(o.status)

function usedText(o) {
  const parts = []
  if (o.personnel) parts.push(`人员 ${o.personnelUsed}/${o.personnel}人`)
  if (o.vehicles) parts.push(`车辆 ${o.vehiclesUsed}/${o.vehicles}辆`)
  o.materials.forEach((m) => parts.push(`${m.typeLabel} ${m.used}/${m.qty}${m.unit}`))
  return parts.join('、') || '无'
}

function addMaterial() {
  const exist = new Set(form.value.materials.map((m) => m.type))
  const next = MATERIAL_TYPES.find((t) => !exist.has(t))
  form.value.materials.push({ type: next || MATERIAL_TYPES[0], qty: 10 })
}
// 每行下拉：当前行类型始终保留，其余行已选的类型过滤掉（防重复领用同一物资）
function availableMaterialTypes(rowIdx) {
  const current = form.value.materials[rowIdx]?.type
  const used = new Set(
    form.value.materials
      .map((m, i) => (i === rowIdx ? null : m.type))
      .filter(Boolean)
  )
  return MATERIAL_TYPES.filter((t) => t === current || !used.has(t))
}

function onAssign() {
  const r = repair.createOrder({
    blockId: repair.assigningBlockId,
    baseId: form.value.baseId,
    personnel: form.value.personnel,
    vehicles: form.value.vehicles,
    materials: form.value.materials,
    deadline: form.value.deadline,
    remark: form.value.remark
  })
  if (!r.ok) { assignMsg.value = r.msg; return }
  assignMsg.value = ''
  form.value = {
    baseId: form.value.baseId, personnel: 10, vehicles: 2,
    materials: [{ type: 'medical', qty: 20 }],
    deadline: '', remark: ''
  }
}

function onAccept(o) {
  const r = repair.acceptOrder(o.id)
  fb[o.id] = r.ok ? { ok: true, msg: '现场已接单，抢修开始' } : { ok: false, msg: r.msg }
}

function openForm(o, mode) {
  delete fb[o.id]
  if (mode === 'progress') {
    formOf[o.id] = { mode, progress: Math.max(o.progress, 10), note: '' }
  } else if (mode === 'delay') {
    formOf[o.id] = { mode, reason: '', deadline: o.deadline || '' }
  } else {
    formOf[o.id] = {
      mode, reason: '',
      used: {
        personnel: 0, vehicles: 0,
        materials: Object.fromEntries(o.materials.map((m) => [m.type, 0]))
      }
    }
  }
}
function clearForm(id) { delete formOf[id] }

function onProgress(o) {
  const f = formOf[o.id]
  const r = repair.reportProgress(o.id, { progress: f.progress, note: f.note })
  fb[o.id] = r.ok ? { ok: true, msg: `进度已上报：${r.progress}%` } : { ok: false, msg: r.msg }
  if (r.ok) clearForm(o.id)
}
function onDelay(o) {
  const f = formOf[o.id]
  const r = repair.delayOrder(o.id, { reason: f.reason, deadline: f.deadline })
  fb[o.id] = r.ok ? { ok: true, msg: '已延期，阻断继续保留' } : { ok: false, msg: r.msg }
  if (r.ok) clearForm(o.id)
}
function onSettle(o) {
  const f = formOf[o.id]
  let r
  if (f.mode === 'finish') {
    r = repair.finishOrder(o.id, f.used)
  } else if (f.mode === 'fail') {
    r = repair.failOrder(o.id, { reason: f.reason, used: f.used })
  } else {
    r = repair.cancelOrder(o.id, { reason: f.reason, used: f.used })
  }
  fb[o.id] = r.ok
    ? {
        ok: true,
        msg: f.mode === 'finish'
          ? '已完工，等待指挥员验收（阻断仍保留）'
          : f.mode === 'fail'
            ? '已记为失败，阻断保留，剩余资源已归还'
            : '已撤单，阻断保留，剩余资源已归还'
      }
    : { ok: false, msg: r.msg }
  if (r.ok) clearForm(o.id)
}
function onAcceptWork(o) {
  const r = repair.acceptWork(o.id)
  fb[o.id] = r.ok
    ? { ok: true, msg: '验收通过：已解除封闭，受影响运输已重算，剩余资源已归还' }
    : { ok: false, msg: r.msg }
}

const SETTLE_HINT = {
  finish: '登记现场实际消耗（完工上报）',
  fail: '登记实际消耗（抢修失败）',
  cancel: '登记实际消耗（撤单）'
}
const settleHint = (mode) => SETTLE_HINT[mode] || '登记实际消耗'

// 派单表单打开时默认选距阻断区质心最近的基地（与单点派发口径一致）
watch(() => repair.assigningBlockId, (id) => {
  if (!id) return
  assignMsg.value = ''
  const blk = roadblock.blocks.find((b) => b.id === id)
  if (!blk || form.value.baseId) return
  const cx = blk.polygon.reduce((s, p) => s + p[0], 0) / blk.polygon.length
  const cy = blk.polygon.reduce((s, p) => s + p[1], 0) / blk.polygon.length
  let nearest = null, best = Infinity
  cmd.bases.forEach((b) => {
    const d = Math.hypot(b.lng - cx, b.lat - cy)
    if (d < best) { best = d; nearest = b }
  })
  form.value.baseId = nearest ? nearest.id : (cmd.bases[0]?.id || '')
}, { immediate: true })

// 从阻断卡片跳转：滚动定位并短暂高亮目标工单
const cardEls = {}
function bindCardRef(el, id) {
  if (el) cardEls[id] = el.$el || el
}
watch(() => repair.focusOrderId, (id) => {
  if (!id) return
  requestAnimationFrame(() => {
    cardEls[id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setTimeout(() => { if (repair.focusOrderId === id) repair.focusOrder(null) }, 2200)
  })
})
</script>

<style scoped>
.rp { display: flex; flex-direction: column; gap: 10px; }
.rp-summary {
  display: flex; justify-content: space-between; gap: 8px;
  background: rgba(255,152,0,0.08); border: 1px solid rgba(255,152,0,0.28);
  border-radius: 8px; padding: 8px 10px; font-size: 11px; color: #8ba2c8;
}
.rp-summary b { color: #ffcc80; }
.rp-summary b.verify { color: #ce93ff; }
.rp-summary b.ok { color: #a5d6a7; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 6px; }
.msg { font-size: 11px; margin: 0; }
.msg.err { color: #ef9a9a; }

/* 派单表单 */
.assign-form {
  background: #101d39; border: 1px solid rgba(255,152,0,0.35);
  border-radius: 10px; padding: 12px;
}
.af-title { font-size: 12px; font-weight: 600; color: #ffcc80; margin-bottom: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.af-blk { font-size: 10px; color: #ef9a9a; background: rgba(239,83,80,0.12); padding: 2px 7px; border-radius: 4px; font-weight: 400; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { margin-bottom: 8px; position: relative; }
.field label { display: block; font-size: 11px; color: #8ba2c8; margin-bottom: 4px; }
.field select, .field input {
  width: 100%; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 7px 8px; font-size: 12px; box-sizing: border-box;
}
.stock-tip { position: absolute; right: 8px; top: 30px; font-size: 9px; color: #5b6f94; font-style: normal; pointer-events: none; }
.mat-row { display: flex; gap: 5px; margin-bottom: 5px; }
.mat-row select {
  flex: 1.4; min-width: 0; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 6px; padding: 6px; font-size: 11px;
}
.mat-row input {
  flex: 1; min-width: 0; width: 0; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 6px; padding: 6px; font-size: 11px;
}
.mat-del {
  width: 28px; background: transparent; border: 1px solid rgba(239,83,80,0.35);
  color: #ef9a9a; border-radius: 6px; font-size: 10px; cursor: pointer;
}
.mat-add {
  width: 100%; padding: 6px; border: 1px dashed rgba(255,152,0,0.4); border-radius: 7px;
  background: rgba(255,152,0,0.05); color: #ffcc80; font-size: 11px; cursor: pointer;
}
.mat-add:hover { background: rgba(255,152,0,0.12); }
.af-actions { display: flex; gap: 8px; }
.primary {
  flex: 1; padding: 8px; border: none; border-radius: 7px;
  background: linear-gradient(135deg, #b26a00, #ff9800);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
}
.primary:hover { filter: brightness(1.15); }
.ghost {
  padding: 8px 14px; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 12px; border-radius: 7px; cursor: pointer;
}
.ghost:hover { color: #fff; border-color: #4d8dff; }

/* 工单卡片 */
.ro-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(255,152,0,0.3);
  border-radius: 9px; padding: 9px 10px;
  transition: box-shadow 0.3s, border-color 0.3s;
}
.ro-card.focus {
  border-color: #ffc107;
  box-shadow: 0 0 0 2px rgba(255,193,7,0.35), 0 0 16px rgba(255,193,7,0.25);
}
.ro-card.cleared { border-color: rgba(76,175,80,0.3); opacity: 0.78; }
.ro-card.failed { border-color: rgba(239,83,80,0.35); }
.ro-card.cancelled { border-color: rgba(120,144,156,0.3); opacity: 0.7; }
.ro-head { display: flex; align-items: center; gap: 7px; }
.ro-status { color: #fff; font-size: 10px; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
.ro-head strong {
  flex: 1; min-width: 0; font-size: 12px; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ro-delay {
  font-size: 9px; padding: 1px 5px; border-radius: 4px; flex-shrink: 0;
  background: rgba(255,152,0,0.18); color: #ffcc80;
}
.ro-time { font-size: 10px; color: #5b6f94; flex-shrink: 0; }
.ro-meta { font-size: 10px; color: #8ba2c8; margin: 6px 0 0; }

/* 进度条 */
.ro-prog { display: flex; align-items: center; gap: 7px; margin-top: 7px; }
.ro-track { flex: 1; display: block; background: #0c1730; border-radius: 4px; height: 8px; overflow: hidden; }
.ro-track i {
  display: block; height: 8px; border-radius: 4px;
  background: linear-gradient(90deg, #ff9800, #ffc107);
}
.ro-track i.full { background: linear-gradient(90deg, #2e7d32, #4caf50); }
.ro-prog em { font-style: normal; font-size: 10px; color: #ffc107; font-weight: 700; flex-shrink: 0; }
.ro-settle { font-size: 10px; color: #a5d6a7; margin: 6px 0 0; }

/* 操作 */
.ro-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.act {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
.act:hover { color: #fff; border-color: #4d8dff; }
.act.sign { border-color: rgba(38,166,154,0.45); color: #7ef0c9; }
.act.sign:hover { background: rgba(38,166,154,0.15); }
.act.prog { border-color: rgba(41,98,255,0.5); color: #7ea8e8; }
.act.prog:hover { background: rgba(41,98,255,0.12); }
.act.finish { border-color: rgba(171,71,188,0.5); color: #ce93ff; }
.act.finish:hover { background: rgba(171,71,188,0.12); }
.act.verify { border-color: rgba(76,175,80,0.55); color: #a5d6a7; font-weight: 600; }
.act.verify:hover { background: rgba(76,175,80,0.15); }
.act.delay { border-color: rgba(255,152,0,0.5); color: #ffcc80; }
.act.delay:hover { background: rgba(255,152,0,0.12); }
.act.fail { border-color: rgba(239,83,80,0.45); color: #ef9a9a; }
.act.fail:hover { background: rgba(239,83,80,0.12); }
.act.cancel { border-color: rgba(120,144,156,0.5); color: #b0bec5; margin-left: auto; }
.act.cancel:hover { background: rgba(120,144,156,0.12); }

/* 行内表单 */
.mini-form {
  margin-top: 7px; background: #0c1730; border: 1px solid rgba(120,160,220,0.18);
  border-radius: 7px; padding: 8px;
}
.mf-hint { font-size: 10px; color: #8ba2c8; margin: 0 0 6px; }
.mf-hint b { color: #ffc107; }
.mini-form input[type=range] { width: 100%; margin-bottom: 6px; accent-color: #ff9800; }
.mini-form input:not([type=range]) {
  width: 100%; margin-bottom: 6px;
  background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 5px; padding: 6px 8px; font-size: 11px; box-sizing: border-box;
}
.use-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.use-row span { flex: 1; font-size: 11px; color: #aebadd; }
.use-row input { width: 80px; margin-bottom: 0 !important; text-align: right; }
.use-row em { font-style: normal; font-size: 10px; color: #5b6f94; width: 56px; }
.mf-btns { display: flex; gap: 6px; margin-top: 2px; }
.mf-btns button {
  padding: 4px 12px; font-size: 11px; border-radius: 5px; cursor: pointer;
  background: transparent; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
}
.mf-btns button.ok { border-color: #26a69a; color: #7ef0c9; }
.mf-btns button.ok:hover { background: rgba(38,166,154,0.15); }
.mf-btns button.warn { border-color: #ff9800; color: #ffcc80; }
.mf-btns button.warn:hover { background: rgba(255,152,0,0.12); }
.ro-fb { font-size: 10px; margin: 6px 0 0; }
.ro-fb.ok { color: #a5d6a7; }
.ro-fb.err { color: #ef9a9a; }

/* 工单日志 */
.ro-log { margin-top: 8px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 6px; }
.ro-log p { font-size: 10px; color: #5b6f94; margin: 2px 0; display: flex; gap: 6px; }
.ro-log span { color: #ffc107; font-family: monospace; flex-shrink: 0; }
</style>
