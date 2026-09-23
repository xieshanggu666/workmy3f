<template>
  <div class="rb">
    <!-- 总览 -->
    <div class="rb-summary">
      <span>🚧 生效中 <b>{{ roadblock.activeBlocks.length }}</b></span>
      <span>⏸ 挂起任务 <b>{{ roadblock.heldCount }}</b></span>
      <span>✅ 已恢复 <b>{{ clearedCount }}</b></span>
    </div>

    <!-- 现场上报入口 -->
    <template v-if="!roadblock.drawing && !roadblock.reporting">
      <button class="report-btn" @click="roadblock.startDrawing()">🗺️ 地图圈画上报封闭范围</button>
      <button class="quick-btn" :disabled="!selectedEvent" @click="onQuick">
        ⚡ 快捷上报（当前事件运输走廊）
      </button>
      <p class="rb-hint">现场人员上报封闭范围 → 指挥员确认影响 → 生成绕行/改派方案 → 恢复通行后续派</p>
    </template>

    <!-- 圈画中 -->
    <div v-if="roadblock.drawing" class="draw-box">
      <p>🖱️ 在地图上单击标点（已 {{ roadblock.draft.length }} 点），右键或双击完成圈画</p>
      <div class="draw-actions">
        <button :disabled="!roadblock.draft.length" @click="roadblock.undoDraftPoint()">↩ 撤点</button>
        <button class="ok" :disabled="roadblock.draft.length < 3" @click="roadblock.finishDrawing()">✔ 完成圈画</button>
        <button @click="roadblock.cancelDrawing()">✕ 取消</button>
      </div>
    </div>

    <!-- 上报表单 -->
    <div v-if="roadblock.reporting" class="report-form">
      <div class="rf-title">🚧 现场道路阻断上报（封闭范围 {{ roadblock.draft.length }} 个顶点）</div>
      <div class="field">
        <label>阻断名称</label>
        <input v-model="form.name" placeholder="如：G543 青川段塌方断道" />
      </div>
      <div class="grid2">
        <div class="field">
          <label>阻断原因</label>
          <select v-model="form.reason">
            <option>塌方/滑坡</option>
            <option>积水内涝</option>
            <option>桥梁受损</option>
            <option>路面塌陷</option>
            <option>交通管制</option>
            <option>其他</option>
          </select>
        </div>
        <div class="field">
          <label>上报人</label>
          <input v-model="form.reporter" placeholder="现场巡查员" />
        </div>
      </div>
      <p v-if="reportMsg" class="msg err">{{ reportMsg }}</p>
      <div class="rf-actions">
        <button class="primary" @click="onReport">📤 提交上报</button>
        <button class="ghost" @click="roadblock.cancelReport()">取消</button>
      </div>
    </div>

    <!-- 阻断卡片 -->
    <div
      v-for="blk in roadblock.blocks" :key="blk.id"
      class="blk-card" :class="{ cleared: blk.status === 'cleared', sel: roadblock.selectedBlockId === blk.id }"
      @click="roadblock.selectedBlockId = blk.id"
    >
      <div class="bc-head">
        <span class="bc-status" :class="blk.status">{{ blk.status === 'active' ? '生效中' : '已恢复' }}</span>
        <strong>{{ blk.name }}</strong>
        <span class="bc-time">{{ blk.reportedAt }}</span>
      </div>
      <p class="bc-meta">📋 {{ blk.reason }} · 👤 {{ blk.reporter }} · ⬠ {{ blk.polygon.length }} 顶点</p>

      <template v-if="blk.status === 'active'">
        <!-- 影响评估 -->
        <div class="imp-head">
          <span>影响评估：派发 {{ countOf(blk, 'dispatch') }} 条 · 批次 {{ countOf(blk, 'batch') }} 个</span>
          <button class="mini" @click.stop="roadblock.assess(blk.id)">↻ 重新评估</button>
        </div>
        <div v-if="!blk.impacts.length" class="tiny-empty">当前无在途任务受影响</div>
        <div v-for="imp in blk.impacts" :key="imp.key" class="imp" :class="{ done: imp.done, off: !imp.checked }">
          <label class="imp-line" @click.stop>
            <input type="checkbox" v-model="imp.checked" :disabled="imp.done" />
            <span class="imp-kind" :class="imp.kind">{{ imp.kind === 'dispatch' ? '📦 派发' : '🚌 批次' }}</span>
            <span class="imp-label" :title="imp.label">{{ imp.label }}</span>
          </label>
          <!-- 方案选择与执行 -->
          <div v-if="blk.confirmed && imp.checked && !imp.done" class="imp-plan" @click.stop>
            <select v-model="imp.plan">
              <option v-for="(opt, oi) in imp.options" :key="oi" :value="opt">{{ optLabel(opt) }}</option>
            </select>
            <button class="mini apply" @click="onApply(blk, imp)">执行</button>
          </div>
          <p v-if="imp.done && imp.result" class="imp-result">✓ {{ imp.result.msg }}</p>
        </div>

        <!-- 指挥员操作 -->
        <div v-if="blk.impacts.length" class="bc-actions">
          <button v-if="!blk.confirmed" class="primary" @click.stop="roadblock.confirmImpacts(blk.id)">
            ✔️ 指挥员确认影响 · 生成方案
          </button>
          <button v-else class="primary" :disabled="!pendingCount(blk)" @click.stop="onApplyAll(blk)">
            🚀 执行全部方案（{{ pendingCount(blk) }}）
          </button>
        </div>

        <!-- 道路抢修工单入口 / 进行中工单状态 -->
        <div class="repair-box" @click.stop>
          <template v-if="orderOf(blk)">
            <button class="repair-link" @click="onFocusOrder(orderOf(blk))">
              🔧 抢修工单：{{ repair.statusLabel(orderOf(blk).status)
                }}<template v-if="orderOf(blk).status === 'accepted'">（{{ orderOf(blk).progress }}%）</template>
                <template v-if="orderOf(blk).delayed"> · ⏰已延期×{{ orderOf(blk).delayCount }}</template>
                <em>查看 ›</em>
            </button>
          </template>
          <button v-else class="repair-btn" @click="repair.startAssign(blk.id)">
            🔧 发起抢修（分配队伍/车辆/物资）
          </button>
        </div>

        <button class="clear-btn" @click.stop="onClear(blk)">
          {{ orderOf(blk) ? '✅ 强制恢复通行（自动办结抢修单）' : '✅ 恢复通行' }}
        </button>
      </template>
      <p v-else class="bc-meta">✅ {{ blk.clearedAt }} 恢复通行</p>

      <!-- 处置日志 -->
      <div class="blk-log">
        <p v-for="(l, i) in blk.log.slice(-4)" :key="i"><span>{{ l.at }}</span>{{ l.text }}</p>
      </div>
      <button v-if="blk.status === 'cleared'" class="blk-del" title="删除记录" @click.stop="roadblock.removeBlock(blk.id)">✕</button>
    </div>

    <!-- 挂起任务（恢复通行后续派） -->
    <template v-if="roadblock.heldCount">
      <div class="panel-sub">⏸ 挂起任务（{{ roadblock.heldCount }}）</div>
      <div v-for="d in roadblock.heldDispatches" :key="d.id" class="held-item">
        <span class="h-kind">📦</span>
        <span class="h-label">{{ d.typeLabel }} {{ heldQty(d) }}{{ d.unit }}｜{{ d.baseName }} → {{ d.eventTitle || d.shelterName }}</span>
      </div>
      <div v-for="b in roadblock.heldBatches" :key="b.id" class="held-item">
        <span class="h-kind">🚌</span>
        <span class="h-label">{{ b.name }} · {{ b.headcount }}人 → {{ shelterName(b.shelterId) }}</span>
      </div>
      <button class="resume-btn" @click="onResumeAll">▶️ 一键续派（自动校验路线与库存）</button>
      <p v-if="resumeMsg" class="msg ok">{{ resumeMsg }}</p>
    </template>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'

const cmd = useCommandStore()
const transfer = useTransferStore()
const roadblock = useRoadblockStore()
const repair = useRepairStore()

const form = ref({ name: '', reason: '塌方/滑坡', reporter: '' })
const reportMsg = ref('')
const resumeMsg = ref('')

const selectedEvent = computed(() => cmd.events.find((e) => e.id === cmd.selectedEventId) || null)
const clearedCount = computed(() => roadblock.blocks.filter((b) => b.status === 'cleared').length)
const countOf = (blk, kind) => blk.impacts.filter((i) => i.kind === kind).length
const pendingCount = (blk) => blk.impacts.filter((i) => i.checked && !i.done && i.plan).length
const heldQty = (d) => dispatchParts(d).heldQty
const shelterName = (id) => transfer.shelters.find((s) => s.id === id)?.name || '—'
// 该阻断进行中的抢修工单
const orderOf = (blk) => repair.orderOfBlock(blk.id)
// 跳转到抢修页签并定位工单（DispatchPanel 监听 focusOrderId 自动切页签）
function onFocusOrder(o) {
  repair.focusOrder(o.id)
}

const ACTION_ICON = { detour: '🔀', reassign: '🔁', suspend: '⏸' }
const optLabel = (opt) => `${ACTION_ICON[opt.action] || ''} ${opt.label}`

// 快捷上报：围绕当前事件运输走廊生成封闭区
function onQuick() {
  const ev = selectedEvent.value
  const poly = roadblock.quickPolygon(cmd.selectedEventId)
  if (!poly) return
  roadblock.draft = poly
  roadblock.reporting = true
  form.value.name = `${ev.location?.name || ''} 运输走廊道路阻断`
}

function onReport() {
  const r = roadblock.reportBlock({ ...form.value, polygon: [...roadblock.draft] })
  if (!r.ok) { reportMsg.value = r.msg; return }
  reportMsg.value = ''
  form.value = { name: '', reason: '塌方/滑坡', reporter: '' }
}

function onApply(blk, imp) {
  roadblock.applyImpact(blk.id, imp.key)
}
function onApplyAll(blk) {
  roadblock.applyAll(blk.id)
}
function onClear(blk) {
  resumeMsg.value = ''
  const o = repair.orderOfBlock(blk.id)
  if (o) {
    const tip = o.status === 'done'
      ? '该阻断有「待验收」抢修工单，直接恢复将按验收通过自动办结并归还资源，是否继续？'
      : '该阻断有进行中的抢修工单，直接恢复将自动撤单（按实际消耗归还资源），是否继续？'
    if (!window.confirm(tip)) return
  }
  roadblock.clearBlock(blk.id)
}
function onResumeAll() {
  const r = roadblock.resumeHeld()
  resumeMsg.value = `已续派 ${r.resumed} 项` +
    (r.kept ? `，${r.kept} 项仍受其它阻断影响保持挂起` : '') +
    (r.failed ? `，${r.failed} 项库存不足续派失败` : '')
}
</script>

<style scoped>
.rb { display: flex; flex-direction: column; gap: 10px; }
.rb-summary {
  display: flex; justify-content: space-between; gap: 8px;
  background: rgba(239,83,80,0.08); border: 1px solid rgba(239,83,80,0.3);
  border-radius: 8px; padding: 8px 10px; font-size: 11px; color: #8ba2c8;
}
.rb-summary b { color: #ef9a9a; }
.rb-hint { font-size: 10px; color: #5b6f94; margin: 0; line-height: 1.5; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 6px; }
.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #ef5350; padding-left: 8px; margin: 4px 0 2px;
}
.msg { font-size: 11px; margin: 0; }
.msg.ok { color: #7ef0c9; }
.msg.err { color: #ef9a9a; }

/* 上报入口 */
.report-btn {
  width: 100%; padding: 9px; border: 1px dashed rgba(239,83,80,0.5); border-radius: 8px;
  background: rgba(239,83,80,0.08); color: #ef9a9a; font-size: 12px; font-weight: 600; cursor: pointer;
}
.report-btn:hover { background: rgba(239,83,80,0.16); }
.quick-btn {
  width: 100%; padding: 8px; border: 1px solid rgba(255,193,7,0.35); border-radius: 8px;
  background: rgba(255,193,7,0.06); color: #ffd54f; font-size: 12px; cursor: pointer;
}
.quick-btn:hover:not(:disabled) { background: rgba(255,193,7,0.14); }
.quick-btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* 圈画中 */
.draw-box {
  background: rgba(239,83,80,0.08); border: 1px solid rgba(239,83,80,0.35);
  border-radius: 9px; padding: 9px 10px;
}
.draw-box p { font-size: 11px; color: #ef9a9a; margin: 0 0 8px; }
.draw-actions { display: flex; gap: 6px; }
.draw-actions button {
  flex: 1; padding: 6px 0; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #8ba2c8; font-size: 11px; border-radius: 6px; cursor: pointer;
}
.draw-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
.draw-actions .ok { border-color: rgba(239,83,80,0.5); color: #ef9a9a; }

/* 上报表单 */
.report-form { background: #101d39; border: 1px solid rgba(239,83,80,0.3); border-radius: 10px; padding: 12px; }
.rf-title { font-size: 12px; font-weight: 600; color: #ef9a9a; margin-bottom: 10px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { margin-bottom: 8px; }
.field label { display: block; font-size: 11px; color: #8ba2c8; margin-bottom: 4px; }
.field select, .field input {
  width: 100%; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 7px 8px; font-size: 12px; box-sizing: border-box;
}
.rf-actions { display: flex; gap: 8px; }
.primary {
  flex: 1; padding: 8px; border: none; border-radius: 7px;
  background: linear-gradient(135deg, #8e2424, #d32f2f);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
}
.primary:hover:not(:disabled) { filter: brightness(1.15); }
.primary:disabled { background: #1a2747; color: #5b6f94; cursor: not-allowed; }
.ghost {
  padding: 8px 14px; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 12px; border-radius: 7px; cursor: pointer;
}
.ghost:hover { color: #fff; border-color: #4d8dff; }

/* 阻断卡片 */
.blk-card {
  position: relative;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(239,83,80,0.3);
  border-radius: 9px; padding: 9px 10px; cursor: pointer;
}
.blk-card.sel { border-color: #ef5350; box-shadow: 0 0 0 1px rgba(239,83,80,0.35); }
.blk-card.cleared { border-color: rgba(120,160,220,0.12); opacity: 0.75; }
.bc-head { display: flex; align-items: center; gap: 7px; }
.bc-status { color: #fff; font-size: 10px; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; background: #c62828; }
.bc-status.cleared { background: #4caf50; }
.bc-head strong {
  flex: 1; min-width: 0; font-size: 12px; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bc-time { font-size: 10px; color: #5b6f94; flex-shrink: 0; }
.bc-meta { font-size: 10px; color: #8ba2c8; margin: 6px 0 0; }

/* 影响评估 */
.imp-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 8px; font-size: 11px; color: #ffc107;
}
.mini {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25); color: #8ba2c8;
  font-size: 10px; border-radius: 5px; padding: 2px 7px; cursor: pointer;
}
.mini:hover { color: #fff; border-color: #4d8dff; }
.imp { margin-top: 6px; background: #0c1730; border: 1px solid rgba(120,160,220,0.15); border-radius: 7px; padding: 6px 8px; }
.imp.off { opacity: 0.5; }
.imp.done { border-color: rgba(76,175,80,0.35); }
.imp-line { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.imp-line input { accent-color: #ef5350; flex-shrink: 0; }
.imp-kind { font-size: 10px; color: #8ba2c8; flex-shrink: 0; }
.imp-label {
  flex: 1; min-width: 0; font-size: 11px; color: #dbe4f3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.imp-plan { display: flex; gap: 6px; margin-top: 6px; }
.imp-plan select {
  flex: 1; min-width: 0; background: #101d39; border: 1px solid rgba(255,193,7,0.35);
  color: #ffd54f; border-radius: 6px; padding: 4px 6px; font-size: 10px;
}
.imp-plan .apply { border-color: rgba(76,175,80,0.5); color: #a5d6a7; }
.imp-result { font-size: 10px; color: #a5d6a7; margin: 5px 0 0; }

.bc-actions { display: flex; gap: 6px; margin-top: 8px; }
.clear-btn {
  width: 100%; margin-top: 7px; padding: 7px; border: 1px solid rgba(76,175,80,0.45); border-radius: 7px;
  background: rgba(76,175,80,0.08); color: #a5d6a7; font-size: 11px; font-weight: 600; cursor: pointer;
}
.clear-btn:hover { background: rgba(76,175,80,0.18); }

/* 道路抢修入口 */
.repair-box { margin-top: 7px; }
.repair-btn {
  width: 100%; padding: 7px; border: 1px dashed rgba(255,152,0,0.55); border-radius: 7px;
  background: rgba(255,152,0,0.07); color: #ffcc80; font-size: 11px; font-weight: 600; cursor: pointer;
}
.repair-btn:hover { background: rgba(255,152,0,0.16); }
.repair-link {
  width: 100%; padding: 7px 9px; border: 1px solid rgba(255,152,0,0.45); border-radius: 7px;
  background: rgba(255,152,0,0.1); color: #ffcc80; font-size: 11px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 5px;
}
.repair-link em { margin-left: auto; font-style: normal; font-size: 10px; color: #ffe0b2; font-weight: 400; }
.repair-link:hover { background: rgba(255,152,0,0.18); }

/* 处置日志 */
.blk-log { margin-top: 8px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 6px; }
.blk-log p { font-size: 10px; color: #5b6f94; margin: 2px 0; display: flex; gap: 6px; }
.blk-log span { color: #ffc107; font-family: monospace; flex-shrink: 0; }
.blk-del {
  position: absolute; top: 8px; right: 8px; background: none; border: none;
  color: #5b6f94; font-size: 11px; cursor: pointer; padding: 2px 4px;
}
.blk-del:hover { color: #ef5350; }

/* 挂起任务 */
.held-item {
  display: flex; align-items: center; gap: 7px;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(255,193,7,0.25);
  border-radius: 7px; padding: 6px 8px;
}
.h-kind { flex-shrink: 0; font-size: 12px; }
.h-label {
  flex: 1; min-width: 0; font-size: 11px; color: #ffd54f;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.resume-btn {
  width: 100%; padding: 9px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #1d6f3f, #2e7d32);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
}
.resume-btn:hover { filter: brightness(1.15); }
</style>
