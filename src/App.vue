<template>
  <div class="layout">
    <CommandHeader />
    <div class="body" :class="{ 'review-lock': replay.mode === 'review' }">
      <aside class="left">
        <div class="aside-title">📋 灾情事件</div>
        <EventList />
      </aside>

      <main class="center">
        <MapBoard />
      </main>

      <aside class="right">
        <div class="split-top">
          <div class="aside-title">🛠️ 资源调度</div>
          <DispatchPanel />
        </div>
        <div class="split-bottom">
          <EventDetail />
        </div>
      </aside>

      <!-- 复盘回放：主工作区只读遮罩（拦截一切业务点击；复盘抽屉与顶栏在遮罩层之外） -->
      <div v-if="replay.mode === 'review'" class="review-mask" @click="replay.openPanel()">
        <div class="mask-card">
          <span class="mask-icon">📼</span>
          <strong>历史复盘回放中</strong>
          <p>当前为历史节点快照，态势只读不可操作</p>
          <em>点击打开时间轴 · 可从任意节点「恢复演练」</em>
        </div>
      </div>
    </div>
    <ReplayPanel />
  </div>
</template>

<script setup>
import { onMounted, watch, nextTick } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { useReplayStore, installReplayRecorder } from '@/store/replay'
import CommandHeader from '@/components/CommandHeader.vue'
import EventList from '@/components/EventList.vue'
import MapBoard from '@/components/MapBoard.vue'
import DispatchPanel from '@/components/DispatchPanel.vue'
import EventDetail from '@/components/EventDetail.vue'
import ReplayPanel from '@/components/ReplayPanel.vue'

const store = useCommandStore()
const transfer = useTransferStore()
const roadblock = useRoadblockStore()
const repair = useRepairStore()
const replay = useReplayStore()

// 四 store 就绪后安装复盘录制器（包装业务 action：录制 + 回放锁定），再载入场景
installReplayRecorder()
onMounted(() => {
  store.loadScenario(store.scenarioId)
  transfer.load()
  repair.load()
  replay.begin()
})
// 切换灾情场景时重置转移安置、道路阻断与抢修工单数据，并以新场景为基线重新录制
watch(() => store.scenarioId, () => {
  transfer.load()
  roadblock.load()
  repair.load()
  if (replay.active) nextTick(() => replay.begin())
}, { flush: 'sync' })
</script>

<style scoped>
.layout {
  display: flex; flex-direction: column;
  width: 100vw; height: 100vh;
  background: #0a1224;
  overflow: hidden;
}
.body {
  flex: 1; display: flex;
  min-height: 0;
  gap: 10px; padding: 10px;
  position: relative;
}
/* 复盘回放只读遮罩：主工作区禁止业务操作 */
.review-lock { /* 位置基准由 .body 提供 */ }
.review-mask {
  position: absolute;
  inset: 10px;
  z-index: 1500;
  border-radius: 12px;
  background: rgba(7, 12, 26, 0.35);
  backdrop-filter: blur(1.5px);
  cursor: pointer;
  display: grid;
  place-items: center;
}
.mask-card {
  background: rgba(140, 40, 20, 0.88);
  border: 1px solid rgba(255, 180, 130, 0.5);
  box-shadow: 0 10px 36px rgba(0,0,0,0.5);
  border-radius: 14px;
  padding: 22px 34px;
  text-align: center;
  color: #ffe9d6;
  pointer-events: none;
}
.mask-icon { font-size: 30px; display: block; margin-bottom: 8px; }
.mask-card strong { font-size: 15px; color: #fff; display: block; }
.mask-card p { margin: 6px 0 4px; font-size: 12px; color: #ffd9c2; }
.mask-card em { font-style: normal; font-size: 11px; color: #ffb78f; }
.aside-title {
  font-size: 12px; color: #6f8cb8; font-weight: 700;
  margin-bottom: 6px; padding: 0 2px;
  letter-spacing: 1px;
}
.left {
  width: 300px; flex-shrink: 0;
  display: flex; flex-direction: column;
  background: #0d1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 12px; padding: 10px;
  min-height: 0;
}
.center { flex: 1; border-radius: 12px; overflow: hidden; min-width: 0; min-height: 0; position: relative; }
.right {
  width: 360px; flex-shrink: 0;
  display: flex; flex-direction: column; gap: 10px;
  min-height: 0;
}
.split-top {
  flex: 5; display: flex; flex-direction: column;
  background: #0d1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 12px; padding: 10px; min-height: 0;
}
.split-bottom {
  flex: 6;
  background: #0d1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 12px; min-height: 0;
}

@media (max-width: 1280px) {
  .left { width: 260px; }
  .right { width: 320px; }
}
@media (max-width: 1000px) {
  .body { flex-direction: column; overflow-y: auto; }
  .left, .right, .center { width: 100%; }
  .center { height: 60vh; }
}
</style>