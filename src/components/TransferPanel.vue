<template>
  <div class="transfer">
    <!-- 子页签：批次 / 安置点 -->
    <div class="sub-tabs">
      <button :class="{ active: view === 'batch' }" @click="view = 'batch'">
        🚌 转移批次<span v-if="transfer.stats.activeBatches" class="bd">{{ transfer.stats.activeBatches }}</span>
      </button>
      <button :class="{ active: view === 'shelter' }" @click="view = 'shelter'">🏕️ 安置点</button>
    </div>

    <!-- ================= 转移批次 ================= -->
    <template v-if="view === 'batch'">
      <div v-if="!selectedEvent" class="placeholder">← 先在左侧或地图选择一个灾情事件，再建立转移批次</div>
      <template v-else>
        <!-- 当前事件转移进度 -->
        <div class="ev-progress">
          <div class="ep-head">
            <strong>{{ selectedEvent.title }}</strong>
            <span class="ep-nums">已安置 {{ progress.checkedIn }}/需转移 {{ selectedEvent.evacuate || 0 }}</span>
          </div>
          <div class="ep-bar"><i :style="{ width: settlePct }"></i></div>
          <p class="ep-sub">
            接运 {{ progress.picked }} · 在住 {{ inHouseOfEvent }} · 转出 {{ progress.out }}
            · 计划 {{ progress.planned }} 人/{{ progress.batches }} 批
          </p>
        </div>

        <!-- 新建批次 -->
        <button v-if="!creating" class="new-btn" @click="openCreate">＋ 新建转移批次</button>
        <div v-else class="create-form">
          <div class="cf-title">🚌 新建转移批次 — {{ selectedEvent.location?.name }}</div>
          <div class="field">
            <label>批次名称</label>
            <input v-model="form.name" :placeholder="`第${eventBatches.length + 1}批 · ${selectedEvent.location?.name}`" />
          </div>
          <div class="grid2">
            <div class="field">
              <label>计划转移人数（需转移 {{ selectedEvent.evacuate || 0 }}）</label>
              <input type="number" min="1" v-model.number="form.headcount" />
            </div>
            <div class="field">
              <label>车辆数（约40人/辆）</label>
              <input type="number" min="1" v-model.number="form.vehicleCount" />
            </div>
          </div>
          <div class="field">
            <label>车辆来源（占用救援车辆库存）</label>
            <select v-model="form.vehicleBaseId">
              <option v-for="b in cmd.bases" :key="b.id" :value="b.id" :disabled="(b.stock.vehicle || 0) === 0">
                {{ b.name }}（余 {{ b.stock.vehicle || 0 }} 辆）
              </option>
            </select>
          </div>
          <div class="field">
            <label>安置点（剩余床位 / 容量）</label>
            <select v-model="form.shelterId">
              <option v-for="s in transfer.shelters" :key="s.id" :value="s.id" :disabled="bedOf(s.id).left === 0">
                {{ s.name }}（余 {{ bedOf(s.id).left }}/{{ s.capacity }}）
              </option>
            </select>
          </div>
          <p class="cf-eta" v-if="createEta">🚚 受灾点 → 安置点约 {{ createEta.distance }}km · {{ createEta.minutes }}min</p>
          <p v-if="createMsg" class="msg err">{{ createMsg }}</p>
          <div class="cf-actions">
            <button class="primary" @click="onCreate">✅ 创建批次</button>
            <button class="ghost" @click="creating = false">取消</button>
          </div>
        </div>

        <!-- 批次卡片 -->
        <div v-if="!eventBatches.length && !creating" class="tiny-empty">该事件暂无转移批次</div>
        <div v-for="b in eventBatches" :key="b.id" class="batch-card" :class="{ closed: b.status === 'closed', held: b.held }">
          <div class="bc-head">
            <span class="bc-status" :style="{ background: statusColor(b.status) }">{{ statusLabel(b.status) }}</span>
            <strong>{{ b.name }}</strong>
            <span v-if="b.held" class="bc-held">⏸ 阻断挂起</span>
            <span class="bc-time">{{ b.createdAt }}</span>
          </div>
          <div class="bc-progress">
            <div class="bp-row">
              <span>接运 {{ countOf(b, 'pickupAt') }}/{{ b.headcount }}</span>
              <span>入住 {{ countOf(b, 'checkinAt') }}</span>
              <span>转出 {{ countOf(b, 'checkoutAt') }}</span>
            </div>
            <div class="bp-bar">
              <i class="seg-pick" :style="{ width: pct(b, 'pickupAt') }"></i>
              <i class="seg-in" :style="{ width: pct(b, 'checkinAt') }"></i>
              <i class="seg-out" :style="{ width: pct(b, 'checkoutAt') }"></i>
            </div>
          </div>
          <p class="bc-meta">
            🚒 {{ baseName(b.vehicleBaseId) }} · {{ b.vehicleCount }}辆{{ b.vehicleReleased ? '（已回收）' : '' }}
            <br />🏕️ {{ shelterName(b.shelterId) }}
            <template v-if="b.eta">
              <br />🚚 约 {{ b.eta.distance }}km · {{ b.eta.minutes }}min{{ b.via && b.via.length ? '（绕行中）' : '' }}
            </template>
          </p>
          <p v-if="b.held" class="bc-held-hint">道路阻断挂起中：接运/入住登记暂停，恢复通行后可在「道路阻断」页签续派</p>
          <div class="bc-actions" v-if="b.status !== 'closed'">
            <button :disabled="b.held" @click="toggle(b.id, 'reg')">📝 登记</button>
            <button @click="toggle(b.id, 're')">🔀 改派</button>
            <button class="split" @click="toggle(b.id, 'split')">✂️ 拆分</button>
            <button class="ok" @click="onClose(b)">✅ 办结</button>
            <button v-if="!b.members.length" class="danger" @click="onCancel(b)">🗑 取消</button>
          </div>

          <!-- 登记面板 -->
          <div v-if="openId === b.id && openMode === 'reg'" class="reg-panel">
            <div class="reg-stages">
              <button
                v-for="st in REGISTER_STAGES" :key="st.value"
                :class="{ active: regStage === st.value }"
                @click="regStage = st.value"
              >{{ st.icon }} {{ st.label }}</button>
            </div>
            <p class="reg-hint">{{ stageHint }}</p>
            <div class="reg-form">
              <input v-model="regName" placeholder="姓名" />
              <input v-model="regIdNo" placeholder="证件号（查重）" />
              <button class="primary" @click="onRegister(b)">登记</button>
            </div>
            <div class="reg-form">
              <input type="number" min="1" v-model.number="regCount" placeholder="人数" />
              <button class="ghost" @click="onRegisterBulk(b)">批量登记</button>
            </div>
            <p v-if="fb[b.id]" class="msg" :class="fb[b.id].ok ? 'ok' : 'err'">{{ fb[b.id].msg }}</p>
            <button
              v-if="fb[b.id]?.dup === 'other'"
              class="move-btn"
              @click="onMove(fb[b.id].personId, b.id)"
            >🔀 改派到本批次（从「{{ fb[b.id].fromBatchName }}」移入）</button>
            <!-- 登记明细 -->
            <div v-if="b.members.length" class="member-list">
              <div v-for="m in [...b.members].slice(-8).reverse()" :key="m.id" class="member">
                <span class="m-name">{{ m.name }}<em v-if="m.idNo"> · {{ m.idNo }}</em></span>
                <span class="m-flags">
                  <i :class="{ on: m.pickupAt }" title="接运">接</i>
                  <i :class="{ on: m.checkinAt }" title="入住">住</i>
                  <i :class="{ on: m.checkoutAt }" title="转出">转</i>
                </span>
                <button
                  v-if="b.status !== 'closed' && !m.checkoutAt"
                  class="m-adv"
                  @click="onAdvance(b, m)"
                >{{ m.checkinAt ? '转出' : '入住' }}</button>
              </div>
              <p v-if="b.members.length > 8" class="more">… 共 {{ b.members.length }} 条登记</p>
            </div>
          </div>

          <!-- 改派面板 -->
          <div v-if="openId === b.id && openMode === 're'" class="reg-panel">
            <div class="field">
              <label>安置点{{ b.members.some(x => x.checkinAt) ? '（已有入住，不可改）' : '' }}</label>
              <select v-model="reForm.shelterId" :disabled="b.members.some(x => x.checkinAt)">
                <option v-for="s in transfer.shelters" :key="s.id" :value="s.id">
                  {{ s.name }}（余 {{ bedOf(s.id).left }}/{{ s.capacity }}）
                </option>
              </select>
            </div>
            <div class="grid2">
              <div class="field">
                <label>车辆来源</label>
                <select v-model="reForm.vehicleBaseId">
                  <option v-for="x in cmd.bases" :key="x.id" :value="x.id">{{ x.name }}（余 {{ x.stock.vehicle || 0 }}）</option>
                </select>
              </div>
              <div class="field">
                <label>车辆数</label>
                <input type="number" min="1" v-model.number="reForm.vehicleCount" />
              </div>
            </div>
            <p v-if="fb[b.id]" class="msg" :class="fb[b.id].ok ? 'ok' : 'err'">{{ fb[b.id].msg }}</p>
            <button class="primary wide" @click="onReassign(b)">确认改派</button>
          </div>

          <!-- 拆分面板：勾选成员组成新分组，独立安排车辆与安置点 -->
          <div v-if="openId === b.id && openMode === 'split'" class="reg-panel">
            <p class="reg-hint">
              ✂️ 勾选成员拆为新批次：登记历史（接运/入住/转出记录）随人保留，
              新批次独立分配车辆与安置点，床位预占、运输路线与事件转移进度自动联动
            </p>
            <div class="field">
              <label>新批次名称</label>
              <input v-model="spForm.name" :placeholder="`${b.name}-拆${eventBatches.length + 1}`" />
            </div>
            <div class="field">
              <label>
                勾选拆出成员（在途 {{ splitMovable(b).picked }} 人 · 在住 {{ splitMovable(b).inHouse }} 人可选
                <template v-if="splitMovable(b).out">；已转出 {{ splitMovable(b).out }} 人不参与拆分</template>）
              </label>
              <div class="split-members">
                <label v-for="m in splitMovable(b).list" :key="m.id" class="sm-item" :class="{ out: m.checkoutAt }">
                  <input
                    type="checkbox"
                    :value="m.id"
                    v-model="spForm.personIds"
                    :disabled="!!m.checkoutAt"
                  />
                  <span class="m-name">{{ m.name }}<em v-if="m.idNo"> · {{ m.idNo }}</em></span>
                  <span class="m-flags">
                    <i class="on" v-if="m.pickupAt">接</i>
                    <i class="on" v-if="m.checkinAt">住</i>
                    <i class="on" v-if="m.checkoutAt">转</i>
                  </span>
                </label>
              </div>
            </div>
            <div class="field">
              <label>已选 {{ spForm.personIds.length }} 人 · 在住 {{ splitInHouseCount(b) }} 人</label>
            </div>
            <div class="grid2">
              <div class="field">
                <label>新分组计划人数</label>
                <input type="number" min="1" v-model.number="spForm.headcount" />
              </div>
              <div class="field">
                <label>车辆数（约40人/辆）</label>
                <input type="number" min="1" v-model.number="spForm.vehicleCount" />
              </div>
            </div>
            <div class="field">
              <label>新分组车辆来源（占用车辆库存，原批次车辆保留）</label>
              <select v-model="spForm.vehicleBaseId">
                <option v-for="x in cmd.bases" :key="x.id" :value="x.id" :disabled="(x.stock.vehicle || 0) === 0">
                  {{ x.name }}（余 {{ x.stock.vehicle || 0 }} 辆）
                </option>
              </select>
            </div>
            <div class="field">
              <label>
                新分组安置点
                <template v-if="splitInHouseCount(b) > 0">（含已入住成员，锁定原安置点）</template>
              </label>
              <select v-model="spForm.shelterId" :disabled="splitInHouseCount(b) > 0">
                <option v-for="s in transfer.shelters" :key="s.id" :value="s.id">
                  {{ s.name }}（余 {{ bedOf(s.id).left }}/{{ s.capacity }}）
                </option>
              </select>
            </div>
            <p class="cf-eta" v-if="splitEta(b)">
              🚚 新分组路线约 {{ splitEta(b).distance }}km · {{ splitEta(b).minutes }}min
            </p>
            <p class="split-preview">
              拆分后原批次：计划 <b>{{ b.headcount - (spForm.headcount || 0) }}</b> 人
              · 保留成员 <b>{{ b.members.length - spForm.personIds.length }}</b> 人
              · 车辆/路线保持现状，剩余人员继续登记
            </p>
            <p v-if="fb[b.id]" class="msg" :class="fb[b.id].ok ? 'ok' : 'err'">{{ fb[b.id].msg }}</p>
            <button class="primary wide" @click="onSplit(b)">✂️ 确认拆分（分别安排车辆与安置点）</button>
          </div>
        </div>
      </template>
    </template>

    <!-- ================= 安置点 ================= -->
    <template v-else>
      <div class="sh-summary">
        在住 <b>{{ transfer.stats.housed }}</b> 人 · 在途 <b>{{ transfer.stats.inTransit }}</b> 人 · 累计转出 <b>{{ transfer.stats.out }}</b> 人
      </div>
      <!-- 按日补给：结算日 + 日结结转 -->
      <div class="day-bar">
        <span class="day-cur">📅 补给核算第 <b>{{ transfer.settleDay }}</b> 日</span>
        <button class="day-settle" @click="onSettle">🌙 日结结转</button>
      </div>
      <p class="day-hint">按实际入住时段折算人日消耗；日结后结余库存与在途物资自动结转至次日</p>
      <p v-if="settleMsg" class="msg ok">{{ settleMsg }}</p>
      <div v-for="item in transfer.shelterNeeds" :key="item.shelter.id" class="sh-card">
        <div class="sh-head">
          <strong>🏕️ {{ item.shelter.name }}</strong>
          <span class="sh-occ">{{ item.occ }}/{{ item.shelter.capacity }}</span>
        </div>
        <div class="sh-bar">
          <i class="in" :style="{ width: Math.min(100, (item.occ / item.shelter.capacity) * 100) + '%' }"></i>
          <i class="rsv" :style="reservedStyle(item.shelter)"></i>
        </div>
        <p class="sh-sub">
          在住 {{ item.occ }} · 批次预占 {{ bedOf(item.shelter.id).reserved }} · 余 {{ bedOf(item.shelter.id).left }} 床
          · 本日人日 {{ item.todayPd }} · 峰值 {{ item.peak }}
        </p>

        <!-- 消耗品账：按日消耗，跨日结转 -->
        <div class="acct">
          <p class="acct-title">🍚 消耗品（按日消耗 · 跨日结转）</p>
          <div v-for="(a, t) in item.consumables" :key="t" class="acct-row">
            <span class="a-name">{{ resIcon(t) }}{{ resLabel(t) }}</span>
            <span>本日需 {{ a.today }}</span>
            <span>结余 {{ a.onHand }}</span>
            <span>在途 {{ a.inTransit }}</span>
            <span>已耗 {{ a.consumed }}</span>
            <span v-if="a.gap" class="a-gap">缺 {{ a.gap }}</span>
            <span v-else class="a-ok">足</span>
          </div>
        </div>

        <!-- 耐用品账：峰值配备，不按日耗 -->
        <div class="acct">
          <p class="acct-title">⛺ 耐用品（峰值配备 · 不按日耗）</p>
          <div v-for="(a, t) in item.durables" :key="t" class="acct-row">
            <span class="a-name">{{ resIcon(t) }}{{ resLabel(t) }}</span>
            <span>峰值需 {{ a.need }}</span>
            <span>已收 {{ a.received }}</span>
            <span>在途 {{ a.inTransit }}</span>
            <span v-if="a.gap" class="a-gap">缺 {{ a.gap }}</span>
            <span v-else class="a-ok">足</span>
          </div>
        </div>

        <!-- 日结记录：消耗入账 + 库存/在途结转留痕 -->
        <div v-if="item.shelter.settlements && item.shelter.settlements.length" class="settle-log">
          <p v-for="st in item.shelter.settlements.slice(-2)" :key="st.day" class="settle-row">
            🌙 第{{ st.day }}日：人日 {{ st.personDays }} · 日终在住 {{ st.inHouse }}
            <template v-if="Object.keys(st.consumed).length"> · 耗 {{ fmtAcct(st.consumed) }}</template>
            <template v-if="Object.keys(st.carry).length"> · 结转结余 {{ fmtAcct(st.carry) }}</template>
            <template v-if="Object.keys(st.inTransit).length"> · 在途结转 {{ fmtAcct(st.inTransit) }}</template>
          </p>
        </div>

        <button class="supply-btn" :disabled="!Object.keys(item.gap).length" @click="onSupply(item.shelter.id)">
          📦 一键补给（按当日缺口就近调拨）
        </button>
        <p v-if="supplyMsg[item.shelter.id]" class="msg" :class="supplyMsg[item.shelter.id].ok ? 'ok' : 'err'">
          {{ supplyMsg[item.shelter.id].msg }}
        </p>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch } from 'vue'
import { useCommandStore, roughPath } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { RESOURCE_TYPES, REGISTER_STAGES, TRANSFER_STATUS } from '@/mock/data'

const cmd = useCommandStore()
const transfer = useTransferStore()

const view = ref('batch')
const creating = ref(false)
const createMsg = ref('')
const openId = ref(null)     // 展开的批次
const openMode = ref('reg')  // reg 登记 / re 改派
const regStage = ref('pickup')
const regName = ref('')
const regIdNo = ref('')
const regCount = ref(10)
const fb = reactive({})      // 批次反馈信息 batchId -> { ok, msg, dup... }
const supplyMsg = reactive({})
const settleMsg = ref('')

const form = ref({ name: '', headcount: 100, vehicleBaseId: '', vehicleCount: 3, shelterId: '' })
const reForm = ref({ shelterId: '', vehicleBaseId: '', vehicleCount: 1 })
const spForm = ref({ name: '', personIds: [], headcount: 1, vehicleBaseId: '', vehicleCount: 1, shelterId: '' })

const selectedEvent = computed(() => cmd.events.find((e) => e.id === cmd.selectedEventId) || null)
const eventBatches = computed(() =>
  transfer.batches.filter((b) => b.eventId === cmd.selectedEventId)
)
const progress = computed(() =>
  transfer.progressByEvent[cmd.selectedEventId] || { batches: 0, planned: 0, picked: 0, checkedIn: 0, out: 0 }
)
const inHouseOfEvent = computed(() =>
  eventBatches.value.reduce(
    (sum, b) => sum + b.members.filter((x) => x.checkinAt && !x.checkoutAt).length, 0
  )
)
const settlePct = computed(() => {
  const need = selectedEvent.value?.evacuate || 0
  if (!need) return '0%'
  return Math.min(100, Math.round((progress.value.checkedIn / need) * 100)) + '%'
})

const bedOf = (id) => transfer.bedMap[id] || { inHouse: 0, reserved: 0, left: 0 }
const baseName = (id) => cmd.bases.find((b) => b.id === id)?.name || '—'
const shelterName = (id) => transfer.shelters.find((s) => s.id === id)?.name || '—'
const statusLabel = (s) => TRANSFER_STATUS.find((x) => x.value === s)?.label || s
const statusColor = (s) => TRANSFER_STATUS.find((x) => x.value === s)?.color || '#999'
const resLabel = (k) => RESOURCE_TYPES[k]?.label || k
const resIcon = (k) => RESOURCE_TYPES[k]?.icon || ''
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''
const countOf = (b, key) => b.members.filter((x) => x[key]).length
const pct = (b, key) => Math.min(100, Math.round((countOf(b, key) / b.headcount) * 100)) + '%'
const reservedStyle = (s) => {
  const bed = bedOf(s.id)
  const inPct = (bed.inHouse / s.capacity) * 100
  const rPct = Math.min(100 - inPct, (bed.reserved / s.capacity) * 100)
  return { left: inPct + '%', width: rPct + '%' }
}
const stageHint = computed(() => REGISTER_STAGES.find((s) => s.value === regStage.value)?.hint || '')

// 建批默认参数：就近安置点 + 就近有车基地
const createEta = computed(() => {
  if (!selectedEvent.value || !form.value.shelterId) return null
  const s = transfer.shelters.find((x) => x.id === form.value.shelterId)
  if (!s) return null
  return roughPath(selectedEvent.value.location.lng, selectedEvent.value.location.lat, s.lng, s.lat)
})

function openCreate() {
  creating.value = true
  createMsg.value = ''
  const ev = selectedEvent.value
  // 默认安置点：剩余床位充足且距离最近
  let best = null, bestD = Infinity
  transfer.shelters.forEach((s) => {
    if (bedOf(s.id).left <= 0) return
    const d = Math.hypot(s.lng - ev.location.lng, s.lat - ev.location.lat)
    if (d < bestD) { bestD = d; best = s }
  })
  // 默认车辆基地：有车且最近
  let vb = null; bestD = Infinity
  cmd.bases.forEach((b) => {
    if ((b.stock.vehicle || 0) <= 0) return
    const d = Math.hypot(b.lng - ev.location.lng, b.lat - ev.location.lat)
    if (d < bestD) { bestD = d; vb = b }
  })
  const headcount = Math.min(100, ev.evacuate || 100)
  form.value = {
    name: '',
    headcount,
    vehicleBaseId: vb?.id || cmd.bases[0]?.id || '',
    vehicleCount: Math.max(1, Math.ceil(headcount / 40)),
    shelterId: best?.id || transfer.shelters[0]?.id || ''
  }
}
// 人数变化联动车辆数（40人/辆）
watch(() => form.value.headcount, (n) => {
  if (creating.value) form.value.vehicleCount = Math.max(1, Math.ceil((n || 1) / 40))
})

function onCreate() {
  const r = transfer.createBatch({ eventId: cmd.selectedEventId, ...form.value })
  if (!r.ok) { createMsg.value = r.msg; return }
  creating.value = false
  createMsg.value = ''
}

function toggle(id, mode) {
  if (openId.value === id && openMode.value === mode) { openId.value = null; return }
  openId.value = id
  openMode.value = mode
  if (mode === 're') {
    const b = transfer.batches.find((x) => x.id === id)
    reForm.value = { shelterId: b.shelterId, vehicleBaseId: b.vehicleBaseId, vehicleCount: b.vehicleCount }
  } else if (mode === 'split') {
    initSplitForm(transfer.batches.find((x) => x.id === id))
  }
}

/* ---------- 批次拆分 ---------- */
function splitMovable(b) {
  const list = b.members
  return {
    list,
    picked: list.filter((m) => m.pickupAt && !m.checkinAt && !m.checkoutAt).length,
    inHouse: list.filter((m) => m.checkinAt && !m.checkoutAt).length,
    out: list.filter((m) => m.checkoutAt).length
  }
}
function splitInHouseCount(b) {
  return b.members.filter((m) => m.checkinAt && !m.checkoutAt && spForm.value.personIds.includes(m.id)).length
}
const splitEta = (b) => {
  if (!selectedEvent.value || !spForm.value.shelterId) return null
  const s = transfer.shelters.find((x) => x.id === spForm.value.shelterId)
  if (!s) return null
  return roughPath(selectedEvent.value.location.lng, selectedEvent.value.location.lat, s.lng, s.lat)
}
function initSplitForm(b) {
  if (!b) return
  // 默认车辆来源：有车且距受灾点最近
  const ev = selectedEvent.value
  let vb = null, bestD = Infinity
  cmd.bases.forEach((x) => {
    if ((x.stock.vehicle || 0) <= 0 || !ev) return
    const d = Math.hypot(x.lng - ev.location.lng, x.lat - ev.location.lat)
    if (d < bestD) { bestD = d; vb = x }
  })
  spForm.value = {
    name: '',
    personIds: [],
    headcount: 1,
    vehicleBaseId: vb?.id || cmd.bases[0]?.id || '',
    vehicleCount: 1,
    shelterId: b.shelterId
  }
}
// 勾选人数变化：联动新分组计划人数与车辆数（不少于勾选人数）
watch(() => spForm.value.personIds.length, (n) => {
  if (openMode.value !== 'split' || !n) return
  if (spForm.value.headcount < n) spForm.value.headcount = n
  spForm.value.vehicleCount = Math.max(1, Math.ceil((spForm.value.headcount || 1) / 40))
})
watch(() => spForm.value.headcount, (n) => {
  if (openMode.value === 'split') spForm.value.vehicleCount = Math.max(1, Math.ceil((n || 1) / 40))
})
// 勾选含已入住成员时锁定原安置点
watch(() => spForm.value.personIds, (ids) => {
  if (openMode.value !== 'split') return
  const b = transfer.batches.find((x) => x.id === openId.value)
  const hasInHouse = b?.members.some((m) => m.checkinAt && !m.checkoutAt && ids.includes(m.id))
  if (hasInHouse && spForm.value.shelterId !== b.shelterId) spForm.value.shelterId = b.shelterId
}, { deep: true })
function onSplit(b) {
  // 安置点锁定保护：含在住成员时强制原安置点
  if (splitInHouseCount(b) > 0) spForm.value.shelterId = b.shelterId
  const r = transfer.splitBatch(b.id, { ...spForm.value })
  fb[b.id] = r
  if (r.ok) openId.value = null
}

function setFb(batchId, r) {
  fb[batchId] = r
  if (r.ok) { regName.value = ''; regIdNo.value = '' }
}
function onRegister(b) {
  setFb(b.id, transfer.register(b.id, regStage.value, { name: regName.value, idNo: regIdNo.value }))
}
function onRegisterBulk(b) {
  setFb(b.id, transfer.register(b.id, regStage.value, { count: regCount.value }))
}
function onAdvance(b, m) {
  setFb(b.id, transfer.advanceMember(b.id, m.id))
}
function onMove(personId, toBatchId) {
  const b = transfer.batches.find((x) => x.id === toBatchId)
  const r = transfer.movePerson(personId, toBatchId)
  if (b) fb[toBatchId] = r
}
function onReassign(b) {
  fb[b.id] = transfer.reassignBatch(b.id, { ...reForm.value })
}
function onClose(b) {
  const r = transfer.closeBatch(b.id)
  if (r && !r.ok) fb[b.id] = r
}
function onCancel(b) {
  transfer.cancelBatch(b.id)
}
function onSupply(shelterId) {
  const r = transfer.autoSupply(shelterId)
  supplyMsg[shelterId] = r.ok
    ? { ok: true, msg: `已生成 ${r.sent.length} 条补给派发${r.unmet.length ? `，${r.unmet.length} 类物资仍有缺口` : ''}` }
    : { ok: false, msg: r.msg }
}
// 日结：结算本日消耗，结余库存与在途物资结转至次日
function onSettle() {
  const day = transfer.settleDay
  const rows = transfer.settleShelters()
  const active = rows.filter((r) => r.personDays > 0 || r.inHouse > 0)
  settleMsg.value = `第 ${day} 日已日结：${active.length ? active.map((r) => `${r.shelter.name} 人日 ${r.personDays}`).join('；') : '各安置点暂无入住'}，进入第 ${day + 1} 日`
}
// 账目格式化：🥫24 💧8
const fmtAcct = (obj) => Object.entries(obj).map(([t, q]) => `${resIcon(t)}${q}${resUnit(t)}`).join(' ')
</script>

<style scoped>
.transfer { display: flex; flex-direction: column; gap: 10px; }
.sub-tabs { display: flex; gap: 6px; }
.sub-tabs button {
  flex: 1; padding: 7px; background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  color: #8ba2c8; font-size: 12px; font-weight: 600; border-radius: 8px; cursor: pointer;
  transition: all 0.2s; position: relative;
}
.sub-tabs button.active {
  background: linear-gradient(135deg, #0f5e52, #26a69a); color: #fff;
  border-color: transparent; box-shadow: 0 3px 10px rgba(38,166,154,0.35);
}
.bd {
  display: inline-block; min-width: 16px; margin-left: 5px; padding: 0 4px;
  background: #26a69a; color: #fff; font-size: 10px; line-height: 16px; border-radius: 8px;
}
.placeholder {
  color: #5b6f94; font-size: 12px; text-align: center;
  border: 1px dashed rgba(120,160,220,0.2); border-radius: 10px; padding: 24px 12px;
}
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }

/* 事件转移进度 */
.ev-progress {
  background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 10px; padding: 10px 12px;
}
.ep-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.ep-head strong { color: #fff; font-size: 12px; flex: 1; min-width: 0; }
.ep-nums { color: #7ef0c9; font-size: 11px; flex-shrink: 0; }
.ep-bar { height: 6px; background: #0c1730; border-radius: 3px; overflow: hidden; margin-top: 8px; }
.ep-bar i { display: block; height: 100%; background: linear-gradient(90deg, #26a69a, #7ef0c9); border-radius: 3px; }
.ep-sub { font-size: 10px; color: #8ba2c8; margin: 6px 0 0; }

/* 新建批次 */
.new-btn {
  width: 100%; padding: 9px; border: 1px dashed rgba(38,166,154,0.5); border-radius: 8px;
  background: rgba(38,166,154,0.08); color: #7ef0c9; font-size: 12px; font-weight: 600; cursor: pointer;
}
.new-btn:hover { background: rgba(38,166,154,0.16); }
.create-form { background: #101d39; border: 1px solid rgba(38,166,154,0.3); border-radius: 10px; padding: 12px; }
.cf-title { font-size: 12px; font-weight: 600; color: #7ef0c9; margin-bottom: 10px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { margin-bottom: 8px; }
.field label { display: block; font-size: 11px; color: #8ba2c8; margin-bottom: 4px; }
.field select, .field input, .reg-form input {
  width: 100%; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 7px 8px; font-size: 12px; box-sizing: border-box;
}
.cf-eta { font-size: 10px; color: #5b6f94; margin: 0 0 8px; }
.cf-actions { display: flex; gap: 8px; }
.primary {
  flex: 1; padding: 8px; border: none; border-radius: 7px;
  background: linear-gradient(135deg, #0f5e52, #26a69a);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
}
.primary:hover { filter: brightness(1.15); }
.primary.wide { width: 100%; flex: none; }
.ghost {
  padding: 8px 14px; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 12px; border-radius: 7px; cursor: pointer;
}
.ghost:hover { color: #fff; border-color: #4d8dff; }

/* 批次卡片 */
.batch-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 9px 10px;
}
.batch-card.closed { opacity: 0.62; }
.batch-card.held { border-color: rgba(255,193,7,0.4); }
.bc-held {
  font-size: 9px; padding: 1px 6px; border-radius: 4px; flex-shrink: 0;
  background: rgba(255,193,7,0.18); color: #ffd54f;
}
.bc-held-hint { font-size: 10px; color: #ffd54f; margin: 6px 0 0; }
.bc-head { display: flex; align-items: center; gap: 7px; }
.bc-status { color: #fff; font-size: 10px; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
.bc-head strong {
  flex: 1; min-width: 0; font-size: 12px; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bc-time { font-size: 10px; color: #5b6f94; flex-shrink: 0; }
.bc-progress { margin-top: 7px; }
.bp-row { display: flex; justify-content: space-between; font-size: 10px; color: #8ba2c8; margin-bottom: 4px; }
.bp-bar { position: relative; height: 6px; background: #0c1730; border-radius: 3px; overflow: hidden; }
.bp-bar i { position: absolute; left: 0; top: 0; height: 100%; border-radius: 3px; }
.seg-pick { background: rgba(47,156,245,0.45); }
.seg-in { background: rgba(142,68,173,0.75); }
.seg-out { background: #4caf50; }
.bc-meta { font-size: 10px; color: #8ba2c8; margin: 7px 0 0; line-height: 1.6; }
.bc-actions { display: flex; gap: 6px; margin-top: 8px; }
.bc-actions button {
  flex: 1; padding: 5px 0; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #8ba2c8; font-size: 11px; border-radius: 6px; cursor: pointer;
}
.bc-actions button:hover { color: #fff; border-color: #4d8dff; }
.bc-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
.bc-actions button:disabled:hover { color: #8ba2c8; border-color: rgba(120,160,220,0.2); }
.bc-actions .ok:hover { color: #7ef0c9; border-color: #26a69a; }
.bc-actions .split:hover { color: #ffd54f; border-color: #ffc107; }
.bc-actions .danger:hover { color: #ef5350; border-color: #ef5350; }

/* 拆分面板 */
.split-members {
  max-height: 168px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px;
  border: 1px solid rgba(120,160,220,0.15); border-radius: 7px; padding: 6px;
  background: #0c1730;
}
.sm-item {
  display: flex; align-items: center; gap: 7px; font-size: 11px;
  padding: 3px 5px; border-radius: 5px; cursor: pointer; color: #dbe4f3;
}
.sm-item:hover { background: #101d39; }
.sm-item.out { opacity: 0.5; cursor: not-allowed; }
.sm-item input[type="checkbox"] { flex-shrink: 0; accent-color: #26a69a; }
.split-preview { font-size: 10px; color: #8ba2c8; margin: 0; padding: 6px 8px; background: rgba(255,193,7,0.08); border-radius: 6px; }
.split-preview b { color: #ffd54f; }

/* 登记 / 改派面板 */
.reg-panel {
  margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(120,160,220,0.2);
  display: flex; flex-direction: column; gap: 7px;
}
.reg-stages { display: flex; gap: 5px; }
.reg-stages button {
  flex: 1; padding: 5px 0; font-size: 11px; border-radius: 6px; cursor: pointer;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #8ba2c8;
}
.reg-stages button.active { background: rgba(38,166,154,0.2); border-color: #26a69a; color: #7ef0c9; }
.reg-hint { font-size: 10px; color: #5b6f94; margin: 0; }
.reg-form { display: flex; gap: 6px; }
.reg-form input { flex: 1; min-width: 0; }
.reg-form .primary, .reg-form .ghost { flex: none; padding: 7px 12px; }
.msg { font-size: 11px; margin: 0; }
.msg.ok { color: #7ef0c9; }
.msg.err { color: #ef9a9a; }
.move-btn {
  padding: 7px; border: 1px solid rgba(255,193,7,0.5); border-radius: 7px;
  background: rgba(255,193,7,0.1); color: #ffc107; font-size: 11px; cursor: pointer;
}
.move-btn:hover { background: rgba(255,193,7,0.2); }

/* 登记明细 */
.member-list { display: flex; flex-direction: column; gap: 4px; }
.member {
  display: flex; align-items: center; gap: 7px;
  background: #0c1730; border-radius: 6px; padding: 5px 8px; font-size: 11px;
}
.m-name { flex: 1; min-width: 0; color: #dbe4f3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-name em { font-style: normal; color: #5b6f94; font-size: 10px; }
.m-flags { display: flex; gap: 3px; flex-shrink: 0; }
.m-flags i {
  font-style: normal; font-size: 9px; width: 15px; height: 15px; line-height: 15px;
  text-align: center; border-radius: 4px; background: #101d39; color: #4a5875;
}
.m-flags i.on { background: rgba(38,166,154,0.25); color: #7ef0c9; }
.m-adv {
  flex-shrink: 0; background: transparent; border: 1px solid rgba(38,166,154,0.4);
  color: #7ef0c9; font-size: 10px; border-radius: 5px; padding: 2px 7px; cursor: pointer;
}
.m-adv:hover { background: rgba(38,166,154,0.15); }
.more { font-size: 10px; color: #5b6f94; text-align: center; margin: 2px 0 0; }

/* 安置点 */
.sh-summary {
  background: rgba(38,166,154,0.1); border: 1px solid rgba(38,166,154,0.3);
  border-radius: 8px; padding: 8px 10px; font-size: 11px; color: #8ba2c8;
}
.sh-summary b { color: #7ef0c9; }
/* 按日补给：结算日栏 */
.day-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 8px; padding: 7px 10px;
}
.day-cur { font-size: 11px; color: #8ba2c8; }
.day-cur b { color: #ffd54f; }
.day-settle {
  padding: 5px 12px; border: 1px solid rgba(255,213,79,0.45); border-radius: 6px;
  background: rgba(255,213,79,0.1); color: #ffe082; font-size: 11px; font-weight: 600; cursor: pointer;
}
.day-settle:hover { background: rgba(255,213,79,0.2); }
.day-hint { font-size: 10px; color: #5b6f94; margin: -4px 0 0; }
.sh-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 9px 10px;
}
.sh-head { display: flex; justify-content: space-between; align-items: center; }
.sh-head strong { font-size: 12px; color: #fff; }
.sh-occ { font-size: 11px; color: #7ef0c9; font-weight: 700; }
.sh-bar { position: relative; height: 6px; background: #0c1730; border-radius: 3px; overflow: hidden; margin-top: 7px; }
.sh-bar .in { position: absolute; left: 0; top: 0; height: 100%; background: linear-gradient(90deg, #26a69a, #7ef0c9); }
.sh-bar .rsv { position: absolute; top: 0; height: 100%; background: rgba(255,193,7,0.4); }
.sh-sub { font-size: 10px; color: #5b6f94; margin: 5px 0 0; }
/* 分账视图 */
.acct {
  margin-top: 7px; background: #0c1730; border: 1px solid rgba(120,160,220,0.12);
  border-radius: 7px; padding: 6px 8px;
}
.acct-title { font-size: 10px; color: #8ba2c8; font-weight: 600; margin: 0 0 4px; }
.acct-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 10px; color: #8ba2c8; padding: 2px 0;
}
.acct-row + .acct-row { border-top: 1px dashed rgba(120,160,220,0.1); }
.a-name { color: #dbe4f3; min-width: 64px; }
.a-gap { color: #ef9a9a; font-weight: 700; }
.a-ok { color: #7ef0c9; }
/* 日结记录 */
.settle-log { margin-top: 6px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 5px; }
.settle-row { font-size: 10px; color: #5b6f94; margin: 2px 0 0; line-height: 1.5; }
.supply-btn {
  width: 100%; margin-top: 8px; padding: 7px; border: none; border-radius: 7px;
  background: linear-gradient(135deg, #0f5e52, #26a69a);
  color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;
}
.supply-btn:hover:not(:disabled) { filter: brightness(1.15); }
.supply-btn:disabled { background: #1a2747; color: #5b6f94; cursor: not-allowed; }
</style>
