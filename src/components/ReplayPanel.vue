<template>
  <Teleport to="body">
    <!-- 复盘回放锁定横幅（面板关闭后仍可见，保证可返回） -->
    <div v-if="replay.mode === 'review'" class="replay-lockbar">
      <span class="lb-dot"></span>
      <strong>复盘回放中 · 演练态势只读</strong>
      <em>{{ currentBranchName }} · {{ replay.currentFrame?.at }} · 节点 {{ replay.cursor + 1 }}/{{ replay.frameCount }}</em>
      <button class="lb-btn" @click="replay.openPanel()">📼 查看时间轴</button>
      <button class="lb-btn fork" @click="onFork()">🌿 从此节点分叉演练</button>
      <button class="lb-btn switch" @click="openBranchMenu = !openBranchMenu">🔀 切换分支 ▾</button>
      <button class="lb-btn live" @click="replay.exitToLive()">⏭ 回到分支末端</button>

      <div v-if="openBranchMenu" class="lb-menu" @click.stop>
        <div class="lb-menu-title">切换到其它分支继续推演</div>
        <button
          v-for="br in flatBranches"
          :key="br.id"
          class="lb-menu-item"
          :class="{ current: br.id === replay.currentBranchId }"
          @click="onSwitch(br.id)"
        >
          <span class="bm-name">{{ br.id === 'main' ? '🌳' : '🌿' }} {{ br.name }}</span>
          <span class="bm-meta">{{ br.frames.length - (br.parentId ? br.forkFrameIndex + 1 : 0) }} 个本分支动作</span>
        </button>
      </div>
    </div>

    <!-- live 模式下的当前分支徽标（多分支时显示，便于知道正在哪条线上推演） -->
    <div v-if="replay.mode === 'live' && replay.branchCount > 1" class="branch-badge" @click="replay.openPanel()">
      <span>🌿</span>
      <span>{{ currentBranchName }}</span>
      <em>共 {{ replay.branchCount }} 条分支 · 点击管理</em>
    </div>

    <transition name="rp-slide">
      <section v-if="replay.panelOpen" class="replay-drawer">
        <header class="rp-head">
          <div class="rp-title">
            <span class="rp-icon">📼</span>
            <div>
              <h2>历史复盘 · 多分支演练时间轴</h2>
              <p>事件 / 派发 / 转移 / 阻断 / 抢修全程留痕，逐节点回放、分叉保留原线、分支切换与结果对照</p>
            </div>
          </div>
          <div class="rp-head-actions">
            <button class="rp-compare" @click="onOpenCompare()">⚖️ 分支对照</button>
            <button class="rp-close" @click="replay.closePanel()">✕</button>
          </div>
        </header>

        <!-- 分支切换条 -->
        <div class="rp-branches">
          <button
            v-for="br in flatBranches"
            :key="br.id"
            class="branch-chip"
            :class="{ active: br.id === replay.currentBranchId, main: br.id === 'main' }"
            @click="onSelectBranch(br.id)"
          >
            <span class="chip-icon">{{ br.id === 'main' ? '🌳' : '🌿' }}</span>
            <span class="chip-name">{{ br.name }}</span>
            <span class="chip-count">{{ br.frames.length }} 帧</span>
            <span v-if="br.id === replay.currentBranchId" class="chip-cur">当前</span>
          </button>
        </div>

        <!-- 播放控制条 -->
        <div class="rp-controls">
          <div class="rp-transport">
            <button title="回到首帧" @click="replay.first()">⏮</button>
            <button title="上一节点" @click="replay.prev()">◀</button>
            <button class="rp-play" @click="replay.playing ? replay.pause() : replay.play()">
              {{ replay.playing ? '⏸' : '▶' }}
            </button>
            <button title="下一节点" @click="replay.next()">▶</button>
            <button title="跳到最新" @click="replay.last()">⏭</button>
          </div>
          <input
            class="rp-scrub"
            type="range"
            min="0"
            :max="Math.max(0, replay.frameCount - 1)"
            :value="replay.cursor"
            @input="onScrub"
          />
          <div class="rp-position">
            <strong>{{ replay.cursor + 1 }}</strong> / {{ replay.frameCount }}
            <span class="rp-clock">{{ replay.currentFrame?.at }}</span>
          </div>
          <div class="rp-speed">
            <button
              v-for="s in [1, 2, 4]"
              :key="s"
              :class="{ on: replay.speed === s }"
              @click="replay.setSpeed(s)"
            >{{ s }}×</button>
          </div>
        </div>

        <!-- 分类筛选 -->
        <div class="rp-filters">
          <button :class="{ on: replay.filterCat === 'all' }" @click="replay.setFilter('all')">
            全部 {{ replay.frameCount }}
          </button>
          <button
            v-for="(meta, key) in replay.categoryMeta"
            :key="key"
            :class="{ on: replay.filterCat === key }"
            @click="replay.setFilter(key)"
          >
            <span>{{ meta.icon }}</span>{{ meta.label }}
          </button>
        </div>

        <div class="rp-body">
          <!-- 左：时间轴节点列表 -->
          <div class="rp-timeline">
            <div class="timeline-hint" v-if="currentBranchMeta.parentId">
              🌱 本分支自节点 #{{ currentBranchMeta.forkFrameIndex + 1 }} 从「{{ parentBranchName }}」分叉，
              此前 {{ currentBranchMeta.forkFrameIndex + 1 }} 帧为共同祖先，之后为本分支独立推演。
            </div>
            <div
              v-for="f in replay.visibleFrames"
              :key="f.seq + ':' + (f.branchId || 'main')"
              class="rp-node"
              :class="{ active: f.index === replay.cursor, baseline: f.seq === 0, fork: f.fork, ancestor: isAncestor(f.index) }"
              @click="onSelect(f.index)"
            >
              <div class="node-marker" :style="{ background: replay.categoryMeta[f.category].color }">
                {{ f.seq === 0 ? '🎬' : replay.categoryMeta[f.category].icon }}
              </div>
              <div class="node-body">
                <div class="node-line">
                  <span class="node-at">{{ f.at }}</span>
                  <span class="node-cat" :style="{ color: replay.categoryMeta[f.category].color }">
                    {{ replay.categoryMeta[f.category].label }}
                  </span>
                  <span v-if="f.fork" class="node-fork">🌿 分叉点</span>
                  <span v-else-if="isAncestor(f.index)" class="node-ancestor">共同祖先</span>
                </div>
                <div class="node-title">{{ f.title }}</div>
                <div v-if="f.logs.length" class="node-logcount">📝 {{ f.logs.length }} 条处置日志</div>
              </div>
            </div>
            <div v-if="!replay.visibleFrames.length" class="rp-empty">该分类暂无节点</div>
          </div>

          <!-- 右：选中节点复盘详情 -->
          <div class="rp-detail" v-if="replay.currentFrame">
            <div class="detail-head">
              <span
                class="detail-badge"
                :style="{ background: replay.categoryMeta[replay.currentFrame.category].color }"
              >{{ replay.categoryMeta[replay.currentFrame.category].icon }}
                {{ replay.categoryMeta[replay.currentFrame.category].label }}</span>
              <h3>{{ replay.currentFrame.title }}</h3>
              <span class="detail-time">
                🕐 {{ replay.currentFrame.at }} · 节点 #{{ replay.currentFrame.seq }}
                · {{ currentBranchName }}
              </span>
            </div>

            <!-- 态势计数 -->
            <div class="detail-counters" v-if="diff">
              <div class="counter"><strong>{{ diff.counters.events }}</strong><span>事件</span></div>
              <div class="counter"><strong>{{ diff.counters.dispatches }}</strong><span>派发记录</span></div>
              <div class="counter"><strong>{{ diff.counters.batches }}</strong><span>转移批次</span></div>
              <div class="counter"><strong>{{ diff.counters.blocks }}</strong><span>生效阻断</span></div>
              <div class="counter"><strong>{{ diff.counters.orders }}</strong><span>抢修工单</span></div>
              <div class="counter"><strong>第{{ diff.counters.settleDay }}日</strong><span>补给结算</span></div>
            </div>

            <div class="detail-grid">
              <!-- 状态变化 -->
              <div class="detail-card">
                <h4>🔁 状态变化</h4>
                <ul v-if="diff.statusChanges.length">
                  <li v-for="(x, i) in diff.statusChanges" :key="'s'+i">
                    <span :style="{ color: x.color }">{{ x.icon }}</span>{{ x.text }}
                  </li>
                </ul>
                <ul v-else-if="baseline.length">
                  <li v-for="(x, i) in baseline" :key="'b'+i">
                    <span :style="{ color: x.color }">{{ x.icon }}</span>{{ x.text }}
                  </li>
                </ul>
                <p v-else class="dim">本节点无状态变化</p>
              </div>

              <!-- 路线调整 -->
              <div class="detail-card">
                <h4>🗺️ 路线调整</h4>
                <ul v-if="diff.routes.length">
                  <li v-for="(r, i) in diff.routes" :key="'r'+i">
                    <div class="route-line">
                      <span :style="{ color: r.color }">🛣️</span>
                      <strong>{{ r.name }}</strong>
                      <em class="route-kind">{{ r.kind }}</em>
                    </div>
                    <div class="route-metrics" v-if="r.from">
                      <span :class="{ up: r.to.minutes > (r.from.minutes || 0) }">
                        {{ r.from.distance ?? '-' }}km·{{ r.from.minutes ?? '-' }}min
                        → {{ r.to.distance }}km·{{ r.to.minutes }}min
                      </span>
                      <span v-if="r.to.base !== r.from.base">出发/到达点：{{ r.from.base || '—' }} → {{ r.to.base }}</span>
                      <span>途经点 {{ r.from.via || 0 }} → {{ r.to.via }}</span>
                    </div>
                    <div class="route-metrics" v-else>
                      <span>{{ r.to.distance }}km · {{ r.to.minutes }}min · 途经点 {{ r.to.via }}</span>
                    </div>
                  </li>
                </ul>
                <p v-else class="dim">本节点无路线调整</p>
              </div>

              <!-- 资源占用 -->
              <div class="detail-card">
                <h4>🏗️ 资源占用（基地库存）</h4>
                <ul v-if="diff.stocks.length">
                  <li v-for="(x, i) in diff.stocks" :key="'k'+i">
                    <span>📦</span>{{ x.base }} · {{ x.type }}
                    <em class="num" :class="x.delta < 0 ? 'down' : 'up'">
                      {{ x.from }} → {{ x.to }}{{ x.unit }}
                      （{{ x.delta > 0 ? '+' : '' }}{{ x.delta }}）
                    </em>
                  </li>
                </ul>
                <p v-else class="dim">本节点无库存变动</p>

                <h4 class="mt">🏕️ 安置点占用（在住/床位）</h4>
                <ul v-if="diff.occupancy.length">
                  <li v-for="(x, i) in diff.occupancy" :key="'o'+i">
                    <span>🛏️</span>{{ x.shelter }}
                    <em class="num" :class="x.delta < 0 ? 'down' : 'up'">
                      {{ x.from }} → {{ x.to }} / {{ x.capacity }}
                      （{{ x.delta > 0 ? '+' : '' }}{{ x.delta }}）
                    </em>
                  </li>
                </ul>
                <p v-else class="dim">本节点无床位占用变动</p>
              </div>

              <!-- 处置日志 -->
              <div class="detail-card">
                <h4>📝 处置日志</h4>
                <ul class="log-list" v-if="logs.length">
                  <li v-for="(l, i) in logs" :key="'l'+i">
                    <div class="log-head">
                      <span class="log-src" :class="l.source">{{ logSourceLabel(l.source) }}</span>
                      <span class="log-tag">{{ l.tag }}</span>
                      <span class="log-at">{{ l.at }}</span>
                    </div>
                    <div class="log-text">{{ l.text }}</div>
                  </li>
                </ul>
                <p v-else-if="replay.currentFrame.seq === 0" class="dim">演练基线节点，后续每个动作产生的事件时间线、阻断处置日志与抢修工单日志都会在此汇总。</p>
                <p v-else class="dim">本节点无新增处置日志</p>
              </div>
            </div>

            <!-- 节点操作 -->
            <div class="detail-actions">
              <button class="act-fork" @click="onFork()">
                🌿 从此节点分叉新分支继续演练
                <small>保留「{{ currentBranchName }}」原线不动，新建子分支沿此节点态势推演（库存/床位/派发/抢修独立）</small>
              </button>
              <button class="act-switch" @click="onSwitchPrompt()">🔀 切换分支</button>
              <button class="act-live" @click="replay.exitToLive()">⏭ 回到分支末端</button>
            </div>
          </div>
        </div>

        <!-- 分支对照抽屉（二级面板） -->
        <transition name="rp-compare-slide">
          <div v-if="replay.compare" class="compare-panel">
            <div class="cmp-head">
              <span class="cmp-icon">⚖️</span>
              <h3>分支处置结果对照</h3>
              <div class="cmp-sides">
                <select :value="replay.compare.a" @change="replay.setCompareSide('a', $event.target.value)">
                  <option v-for="br in replay.branches" :key="br.id" :value="br.id">{{ br.name }}</option>
                </select>
                <button class="cmp-swap" title="交换两侧" @click="replay.swapCompare()">⇄</button>
                <select :value="replay.compare.b" @change="replay.setCompareSide('b', $event.target.value)">
                  <option v-for="br in replay.branches" :key="br.id" :value="br.id">{{ br.name }}</option>
                </select>
              </div>
              <button class="rp-close" @click="replay.closeCompare()">✕</button>
            </div>

            <div v-if="cmp" class="cmp-body">
              <p class="cmp-note">
                两侧均取分支<strong>末端态势</strong>对照（共同祖先之后各自独立演进的最终处置结果）：
                {{ cmp.a.branch.name }}（{{ cmp.a.frame.at }}）⇄ {{ cmp.b.branch.name }}（{{ cmp.b.frame.at }}）
              </p>

              <div class="cmp-summary">
                <div class="cmp-col">
                  <h4>{{ cmp.a.branch.id === 'main' ? '🌳' : '🌿' }} {{ cmp.a.branch.name }}</h4>
                  <ul>
                    <li>派发记录 <strong>{{ cmp.a.branch.frames[cmp.a.branch.frames.length-1].snapshot.cmd.dispatches.length }}</strong></li>
                    <li>转移批次 <strong>{{ cmp.a.branch.frames[cmp.a.branch.frames.length-1].snapshot.tr.batches.length }}</strong></li>
                    <li>生效阻断 <strong>{{ cmp.a.branch.frames[cmp.a.branch.frames.length-1].snapshot.rb.blocks.filter((x)=>x.status==='active').length }}</strong></li>
                    <li>抢修工单 <strong>{{ cmp.a.branch.frames[cmp.a.branch.frames.length-1].snapshot.ro.orders.length }}</strong></li>
                    <li>结算 <strong>第{{ cmp.a.branch.frames[cmp.a.branch.frames.length-1].snapshot.tr.settleDay }}日</strong></li>
                  </ul>
                </div>
                <div class="cmp-col alt">
                  <h4>{{ cmp.b.branch.id === 'main' ? '🌳' : '🌿' }} {{ cmp.b.branch.name }}</h4>
                  <ul>
                    <li>派发记录 <strong>{{ cmp.b.branch.frames[cmp.b.branch.frames.length-1].snapshot.cmd.dispatches.length }}</strong></li>
                    <li>转移批次 <strong>{{ cmp.b.branch.frames[cmp.b.branch.frames.length-1].snapshot.tr.batches.length }}</strong></li>
                    <li>生效阻断 <strong>{{ cmp.b.branch.frames[cmp.b.branch.frames.length-1].snapshot.rb.blocks.filter((x)=>x.status==='active').length }}</strong></li>
                    <li>抢修工单 <strong>{{ cmp.b.branch.frames[cmp.b.branch.frames.length-1].snapshot.ro.orders.length }}</strong></li>
                    <li>结算 <strong>第{{ cmp.b.branch.frames[cmp.b.branch.frames.length-1].snapshot.tr.settleDay }}日</strong></li>
                  </ul>
                </div>
              </div>

              <div class="cmp-table-wrap">
                <table class="cmp-table">
                  <thead>
                    <tr>
                      <th class="t-dim">维度</th>
                      <th>对象</th>
                      <th class="t-a">{{ cmp.a.branch.name }}</th>
                      <th class="t-b">{{ cmp.b.branch.name }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="g in cmp.groups" :key="g.dim">
                      <tr class="cmp-group-row"><td colspan="4">{{ dimIcon(g.dim) }} {{ g.dim }}（{{ g.rows.length }} 项差异）</td></tr>
                      <tr v-for="(r, i) in g.rows" :key="g.dim + i">
                        <td class="t-dim">{{ r.dim }}</td>
                        <td class="t-label">{{ r.label }}</td>
                        <td class="t-a">{{ r.a }}</td>
                        <td class="t-b">{{ r.b }}</td>
                      </tr>
                    </template>
                    <tr v-if="!cmp.rows.length">
                      <td colspan="4" class="cmp-identical">
                        ✅ 两条分支末端态势完全一致（事件/库存/床位/派发/批次/阻断/抢修均无差异）
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="cmp-jump">
                <button @click="replay.switchBranch(cmp.a.branch.id)">▶ 切到「{{ cmp.a.branch.name }}」继续推演</button>
                <button @click="replay.switchBranch(cmp.b.branch.id)">▶ 切到「{{ cmp.b.branch.name }}」继续推演</button>
              </div>
            </div>
          </div>
        </transition>
      </section>
    </transition>
  </Teleport>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useReplayStore } from '@/store/replay'

const replay = useReplayStore()

const diff = computed(() => replay.currentDiff)
const logs = computed(() => replay.currentLogs)
const baseline = computed(() => replay.baselineItems)
const cmp = computed(() => replay.compareResult)

const openBranchMenu = ref(false)

const flatBranches = computed(() => {
  // 主干在前，子分支按创建顺序
  return [...replay.branches].sort((a, b) => {
    if (a.id === 'main') return -1
    if (b.id === 'main') return 1
    return a.createdAt - b.createdAt
  })
})

const currentBranchName = computed(() => replay.currentBranch?.name || '主干演练')
const currentBranchMeta = computed(() => replay.currentBranch || { parentId: null, forkFrameIndex: -1 })
const parentBranchName = computed(() => {
  const br = replay.currentBranch
  return replay.branchById(br?.parentId)?.name || ''
})

function isAncestor(index) {
  const br = replay.currentBranch
  return br?.parentId && index <= br.forkFrameIndex
}

function onScrub(e) {
  replay.pause()
  replay.seek(Number(e.target.value))
}
function onSelect(i) {
  replay.pause()
  replay.seek(i)
}
function logSourceLabel(s) {
  return { event: '事件时间线', block: '阻断处置', repair: '抢修工单' }[s] || s
}
function dimIcon(dim) {
  return {
    事件状态: '🚨', 基地库存: '🏗️', 安置床位: '🛏️', 物资派发: '📦',
    转移批次: '🚌', 道路阻断: '🚧', 抢修工单: '🔧', 补给结算: '🌙'
  }[dim] || '•'
}

// 在回放的某帧上分叉：保留原分支，新建子分支
function onFork() {
  const name = window.prompt('新分支名称（可留空自动命名）：', '')
  replay.resumeHere({ name })
  openBranchMenu.value = false
}

function onSelectBranch(id) {
  if (id === replay.currentBranchId) return
  // 回放中切换：进入目标分支的回放（只读，不影响任何分支的已录历史）
  replay.selectBranchForReview(id)
}

function onSwitchPrompt() {
  if (replay.branchCount <= 1) { alert('目前只有主干分支，先从某历史节点分叉即可产生新分支。'); return }
  openBranchMenu.value = !openBranchMenu.value
}

function onSwitch(id) {
  openBranchMenu.value = false
  replay.switchBranch(id)
}

function onOpenCompare() {
  if (replay.branchCount < 2) {
    alert('至少需要两条分支才能对照：先在回放任一节点点「从此节点分叉新分支继续演练」。')
    return
  }
  replay.openCompare()
}
</script>

<style scoped>
/* 锁定横幅 */
.replay-lockbar {
  position: fixed;
  top: 74px; left: 50%; transform: translateX(-50%);
  z-index: 2000;
  display: flex; align-items: center; gap: 12px;
  background: linear-gradient(90deg, rgba(120,28,28,0.96), rgba(154,52,18,0.96));
  border: 1px solid rgba(255,180,120,0.45);
  box-shadow: 0 8px 28px rgba(0,0,0,0.5);
  border-radius: 10px; padding: 8px 14px;
  color: #ffe9d6; font-size: 12px;
  backdrop-filter: blur(6px);
}
.replay-lockbar strong { color: #fff; font-size: 12px; }
.replay-lockbar em { font-style: normal; color: #ffc9a0; font-size: 11px; }
.lb-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: #ff8a65; animation: lbPulse 1.2s ease-in-out infinite;
}
@keyframes lbPulse { 50% { opacity: 0.35; } }
.lb-btn {
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25);
  color: #fff; font-size: 11px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  position: relative;
}
.lb-btn:hover { background: rgba(255,255,255,0.22); }
.lb-btn.fork { background: rgba(205,120,40,0.55); border-color: rgba(255,200,140,0.6); }
.lb-btn.switch { background: rgba(80,70,180,0.5); border-color: rgba(170,160,255,0.55); }
.lb-btn.live { background: rgba(46,125,50,0.55); border-color: rgba(150,230,160,0.6); }
.lb-menu {
  position: absolute; top: 110%; right: 70px;
  width: 280px; max-height: 320px; overflow-y: auto;
  background: #101d36; border: 1px solid rgba(120,160,220,0.35);
  border-radius: 10px; box-shadow: 0 12px 36px rgba(0,0,0,0.6);
  padding: 6px; z-index: 2010;
}
.lb-menu-title { font-size: 10px; color: #7d92b6; padding: 5px 8px; }
.lb-menu-item {
  display: flex; flex-direction: column; gap: 2px;
  width: 100%; text-align: left;
  background: transparent; border: 1px solid transparent;
  border-radius: 7px; padding: 7px 9px; cursor: pointer;
}
.lb-menu-item:hover { background: rgba(77,141,255,0.12); }
.lb-menu-item.current { background: rgba(77,141,255,0.2); border-color: rgba(77,141,255,0.5); }
.bm-name { font-size: 12px; color: #dbe4f3; }
.bm-meta { font-size: 10px; color: #7d92b6; }

/* live 分支徽标 */
.branch-badge {
  position: fixed; top: 74px; right: 18px; z-index: 1900;
  display: flex; align-items: center; gap: 7px;
  background: rgba(20,34,61,0.92); border: 1px solid rgba(120,200,140,0.4);
  border-radius: 18px; padding: 5px 12px; cursor: pointer;
  color: #b9f6ca; font-size: 11px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.branch-badge em { font-style: normal; color: #7d92b6; font-size: 10px; }

/* 抽屉 */
.replay-drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(940px, 92vw);
  z-index: 2100;
  background: #0b1428;
  border-left: 1px solid rgba(120,160,220,0.25);
  box-shadow: -12px 0 40px rgba(0,0,0,0.55);
  display: flex; flex-direction: column;
}
.rp-slide-enter-active, .rp-slide-leave-active { transition: transform 0.25s ease; }
.rp-slide-enter-from, .rp-slide-leave-to { transform: translateX(100%); }

.rp-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 14px 18px 10px;
  border-bottom: 1px solid rgba(120,160,220,0.15);
}
.rp-title { display: flex; gap: 12px; align-items: center; }
.rp-icon {
  width: 40px; height: 40px; border-radius: 10px;
  display: grid; place-items: center; font-size: 20px;
  background: linear-gradient(135deg, #1d3f8f, #2962ff);
  box-shadow: 0 3px 12px rgba(41,98,255,0.45);
}
.rp-title h2 { margin: 0; font-size: 15px; color: #fff; }
.rp-title p { margin: 2px 0 0; font-size: 11px; color: #6f84ab; }
.rp-head-actions { display: flex; gap: 8px; align-items: center; }
.rp-compare {
  background: rgba(171,71,188,0.22); border: 1px solid rgba(206,147,216,0.5);
  color: #e1bee7; font-size: 11px; border-radius: 7px; padding: 6px 11px; cursor: pointer;
}
.rp-compare:hover { background: rgba(171,71,188,0.4); color: #fff; }
.rp-close {
  background: transparent; border: none; color: #8ea1c4;
  font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 6px;
}
.rp-close:hover { background: rgba(255,255,255,0.08); color: #fff; }

/* 分支条 */
.rp-branches {
  display: flex; gap: 6px; flex-wrap: wrap;
  padding: 9px 18px;
  border-bottom: 1px solid rgba(120,160,220,0.12);
}
.branch-chip {
  display: flex; align-items: center; gap: 6px;
  background: #101d36; border: 1px solid rgba(120,160,220,0.2);
  color: #9db1d4; font-size: 11px; border-radius: 16px;
  padding: 4px 11px; cursor: pointer;
}
.branch-chip:hover { border-color: #4d8dff; color: #fff; }
.branch-chip.active { background: rgba(77,141,255,0.22); border-color: #4d8dff; color: #fff; }
.branch-chip.main .chip-icon { filter: none; }
.chip-count { font-size: 10px; color: #6f84ab; }
.branch-chip.active .chip-count { color: #9db1d4; }
.chip-cur {
  font-size: 9px; background: #2962ff; color: #fff;
  border-radius: 8px; padding: 0 6px;
}

/* 控制条 */
.rp-controls {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 18px;
  border-bottom: 1px solid rgba(120,160,220,0.12);
}
.rp-transport { display: flex; gap: 4px; }
.rp-transport button {
  width: 30px; height: 30px; border-radius: 7px;
  background: #14223d; border: 1px solid rgba(120,160,220,0.2);
  color: #bcd0ee; cursor: pointer; font-size: 12px;
}
.rp-transport button:hover { border-color: #4d8dff; color: #fff; }
.rp-transport .rp-play {
  width: 38px; background: linear-gradient(135deg, #1d3f8f, #2962ff);
  color: #fff; border-color: transparent;
}
.rp-scrub { flex: 1; accent-color: #4d8dff; cursor: pointer; }
.rp-position {
  font-size: 12px; color: #9db1d4; min-width: 96px; text-align: right;
  font-variant-numeric: tabular-nums;
}
.rp-position strong { color: #fff; font-size: 14px; }
.rp-clock { display: block; color: #7ef0c9; font-family: Consolas, monospace; font-size: 11px; }
.rp-speed { display: flex; gap: 3px; }
.rp-speed button {
  background: transparent; border: 1px solid rgba(120,160,220,0.25);
  color: #8ea1c4; font-size: 11px; border-radius: 6px; padding: 4px 8px; cursor: pointer;
}
.rp-speed button.on { background: rgba(77,141,255,0.25); border-color: #4d8dff; color: #fff; }

/* 筛选 */
.rp-filters {
  display: flex; gap: 6px; flex-wrap: wrap;
  padding: 10px 18px;
  border-bottom: 1px solid rgba(120,160,220,0.12);
}
.rp-filters button {
  background: #101d36; border: 1px solid rgba(120,160,220,0.18);
  color: #9db1d4; font-size: 11px; border-radius: 14px;
  padding: 4px 11px; cursor: pointer;
}
.rp-filters button.on { background: rgba(77,141,255,0.22); border-color: #4d8dff; color: #fff; }

/* 主体两栏 */
.rp-body { flex: 1; display: flex; min-height: 0; }
.rp-timeline {
  width: 320px; flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid rgba(120,160,220,0.12);
  padding: 10px 12px;
}
.timeline-hint {
  font-size: 10px; line-height: 1.6; color: #a08b5e;
  background: rgba(230,145,0,0.08); border: 1px solid rgba(230,145,0,0.25);
  border-radius: 7px; padding: 7px 9px; margin-bottom: 8px;
}
.rp-node {
  display: flex; gap: 9px;
  padding: 8px 9px; border-radius: 9px;
  cursor: pointer; position: relative;
  border: 1px solid transparent;
}
.rp-node:hover { background: rgba(77,141,255,0.08); }
.rp-node.active { background: rgba(77,141,255,0.16); border-color: rgba(77,141,255,0.5); }
.rp-node.ancestor { opacity: 0.72; }
.node-marker {
  width: 26px; height: 26px; flex-shrink: 0;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: 12px; color: #fff;
  border: 2px solid rgba(255,255,255,0.25);
}
.rp-node.baseline .node-marker { background: #455a64 !important; }
.node-body { min-width: 0; }
.node-line { display: flex; align-items: center; gap: 7px; }
.node-at { font-size: 10px; color: #6f84ab; font-family: Consolas, monospace; }
.node-cat { font-size: 10px; font-weight: 700; }
.node-fork { font-size: 10px; color: #ffb74d; }
.node-ancestor { font-size: 9px; color: #8d7a55; }
.node-title {
  font-size: 12px; color: #dbe4f3; line-height: 1.45;
  margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.node-logcount { font-size: 10px; color: #7ef0c9; margin-top: 2px; }
.rp-empty { text-align: center; color: #5f739a; font-size: 12px; padding: 30px 0; }

/* 详情 */
.rp-detail {
  flex: 1; overflow-y: auto;
  padding: 14px 18px; min-width: 0;
}
.detail-head { margin-bottom: 10px; }
.detail-badge {
  display: inline-block; color: #fff; font-size: 10px;
  padding: 2px 9px; border-radius: 10px; margin-bottom: 6px;
}
.detail-head h3 { margin: 0 0 3px; font-size: 15px; color: #fff; line-height: 1.4; }
.detail-time { font-size: 11px; color: #7ef0c9; font-family: Consolas, monospace; }

.detail-counters {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 7px;
  margin-bottom: 12px;
}
.counter {
  background: #101d36; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 8px; padding: 7px 4px; text-align: center;
}
.counter strong { display: block; font-size: 14px; color: #fff; }
.counter span { font-size: 10px; color: #7d92b6; }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.detail-card {
  background: #0e1a32; border: 1px solid rgba(120,160,220,0.14);
  border-radius: 10px; padding: 11px 13px;
}
.detail-card h4 { margin: 0 0 8px; font-size: 12px; color: #cdd9ee; }
.detail-card h4.mt { margin-top: 14px; }
.detail-card ul { margin: 0; padding: 0; list-style: none; }
.detail-card li {
  font-size: 12px; color: #aebadd; line-height: 1.55;
  padding: 3px 0; display: flex; gap: 6px; align-items: baseline;
}
.detail-card li > span { flex-shrink: 0; }
.dim { font-size: 11px; color: #5f739a; margin: 0; }
.num { font-style: normal; margin-left: auto; font-variant-numeric: tabular-nums; }
.num.down { color: #7ef0c9; }
.num.up { color: #ff8a65; }

.route-line { display: flex; gap: 6px; align-items: baseline; }
.route-line strong { font-size: 12px; color: #dbe4f3; font-weight: 600; }
.route-kind {
  font-style: normal; font-size: 10px; color: #ffd180;
  background: rgba(255,160,0,0.12); border: 1px solid rgba(255,160,0,0.3);
  border-radius: 4px; padding: 0 5px; margin-left: auto;
}
.route-metrics {
  width: 100%; padding-left: 20px;
  display: flex; flex-direction: column;
  font-size: 11px; color: #8ea1c4; font-variant-numeric: tabular-nums;
}
.route-metrics .up { color: #ff8a65; }

.log-list li {
  flex-direction: column; gap: 2px; align-items: stretch;
  border-left: 2px solid rgba(126,240,201,0.35);
  padding: 4px 0 6px 8px; margin-bottom: 6px;
}
.log-head { display: flex; align-items: center; gap: 7px; }
.log-src {
  font-size: 9px; border-radius: 4px; padding: 1px 6px; color: #fff;
}
.log-src.event { background: #e69100; }
.log-src.block { background: #c62828; }
.log-src.repair { background: #b8860b; }
.log-tag { font-size: 10px; color: #9db1d4; }
.log-at { margin-left: auto; font-size: 10px; color: #6f84ab; font-family: Consolas, monospace; }
.log-text { font-size: 12px; color: #c6d2e6; line-height: 1.5; }

.detail-actions {
  display: flex; gap: 10px; margin-top: 14px;
}
.act-fork {
  flex: 1;
  background: linear-gradient(135deg, #c77828, #e69100);
  border: none; border-radius: 10px; padding: 10px 14px;
  color: #fff; font-size: 13px; font-weight: 700; cursor: pointer;
  box-shadow: 0 3px 12px rgba(230,145,0,0.35);
}
.act-fork small { display: block; font-weight: 400; font-size: 10px; opacity: 0.85; margin-top: 2px; }
.act-switch, .act-live {
  background: rgba(46,125,50,0.35); border: 1px solid rgba(150,230,160,0.5);
  border-radius: 10px; padding: 0 16px; color: #b9f6ca;
  font-size: 12px; cursor: pointer;
}
.act-switch { background: rgba(80,70,180,0.35); border-color: rgba(170,160,255,0.5); color: #d1c4e9; }

/* 分支对照面板 */
.compare-panel {
  position: absolute;
  top: 0; right: 0; bottom: 0; width: min(720px, 80%);
  background: #0d1830; border-left: 2px solid rgba(171,71,188,0.45);
  box-shadow: -16px 0 48px rgba(0,0,0,0.6);
  display: flex; flex-direction: column;
  z-index: 5;
}
.rp-compare-slide-enter-active, .rp-compare-slide-leave-active { transition: transform 0.22s ease; }
.rp-compare-slide-enter-from, .rp-compare-slide-leave-to { transform: translateX(100%); }
.cmp-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(120,160,220,0.15);
}
.cmp-icon { font-size: 18px; }
.cmp-head h3 { margin: 0; font-size: 14px; color: #fff; flex-shrink: 0; }
.cmp-sides { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.cmp-sides select {
  background: #14223d; color: #dbe4f3; border: 1px solid rgba(120,160,220,0.3);
  border-radius: 6px; font-size: 11px; padding: 4px 7px; max-width: 150px;
}
.cmp-swap {
  background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #9db1d4; border-radius: 6px; padding: 3px 8px; cursor: pointer;
}
.cmp-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.cmp-note { font-size: 11px; color: #8ea1c4; line-height: 1.6; margin: 0 0 10px; }
.cmp-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
.cmp-col {
  background: #0e1a32; border: 1px solid rgba(77,141,255,0.25);
  border-radius: 9px; padding: 9px 12px;
}
.cmp-col.alt { border-color: rgba(171,71,188,0.35); }
.cmp-col h4 { margin: 0 0 6px; font-size: 12px; color: #dbe4f3; }
.cmp-col ul { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.cmp-col li { font-size: 11px; color: #8ea1c4; }
.cmp-col li strong { color: #fff; font-size: 13px; margin-left: 3px; }
.cmp-table-wrap {
  border: 1px solid rgba(120,160,220,0.18); border-radius: 9px; overflow: hidden;
}
.cmp-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.cmp-table th {
  background: #101d36; color: #cdd9ee; font-weight: 600;
  padding: 7px 10px; text-align: left;
  border-bottom: 1px solid rgba(120,160,220,0.2);
}
.cmp-table th.t-a { color: #82b1ff; }
.cmp-table th.t-b { color: #ce93d8; }
.cmp-table td { padding: 6px 10px; border-bottom: 1px solid rgba(120,160,220,0.08); color: #aebadd; vertical-align: top; }
.cmp-table .t-dim { color: #7d92b6; white-space: nowrap; }
.cmp-table .t-label { color: #dbe4f3; }
.cmp-table .t-a { color: #90caf9; }
.cmp-table .t-b { color: #ce93d8; }
.cmp-group-row td {
  background: rgba(77,141,255,0.08); color: #cdd9ee;
  font-weight: 700; font-size: 11px; padding: 5px 10px;
}
.cmp-identical { text-align: center; color: #7ef0c9; padding: 24px 10px !important; }
.cmp-jump { display: flex; gap: 8px; margin-top: 12px; }
.cmp-jump button {
  flex: 1; background: rgba(46,125,50,0.3); border: 1px solid rgba(150,230,160,0.45);
  color: #b9f6ca; font-size: 11px; border-radius: 8px; padding: 8px; cursor: pointer;
}
.cmp-jump button:hover { background: rgba(46,125,50,0.5); }

@media (max-width: 1000px) {
  .detail-grid { grid-template-columns: 1fr; }
  .detail-counters { grid-template-columns: repeat(3, 1fr); }
}
</style>
