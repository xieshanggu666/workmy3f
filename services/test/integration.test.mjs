import {
  startAll, stopAll, waitAll, waitHealthy, sleep, call, GW, POST, HIST, ING, REP,
  TPORTS, restartService, cleanupData, stopService, startService
} from './helpers.js'

let failed = 0
let passed = 0
const assert = (cond, msg) => {
  if (cond) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗ FAIL:', msg) }
}
const assertEq = (a, b, msg) => assert(a === b, `${msg}（期望 ${b}，实际 ${a}）`)
const j = (r) => r.body

async function stateOf(simId, branchId = 'main') {
  const r = await GW(`/sims/${simId}/state?branch=${branchId}`)
  if (r.status !== 200) throw new Error('state fetch failed ' + r.status + ' ' + JSON.stringify(r.body))
  return r.body.state
}
const stock = (st, baseId, type) => st.bases.find((b) => b.id === baseId).stock[type]
const base2Food = (st) => stock(st, 'rb-2', 'food')

async function waitForPortDown(port, timeoutMs = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { await call('GET', port, '/healthz') } catch { return true }
    await sleep(80)
  }
  return false
}

// 轮询回放投影直到满足谓词（用于等待异步送达/重放）
async function waitForState(simId, branchId, pred, timeoutMs = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const st = await stateOf(simId, branchId)
      if (pred(st)) return true
    } catch { /* 服务重启中 */ }
    await sleep(150)
  }
  return false
}

async function main() {
  cleanupData()
  startAll()
  await waitAll()
  console.log('— 四个独立服务已就绪 —')
  for (const [n, p] of Object.entries(TPORTS)) {
    const r = await call('GET', p, '/healthz')
    assertEq(r.body.service || r.body.ok, n === 'history' ? 'history' : (r.body.service || true), `${n} (:${p}) 健康`)
  }

  /* ================= 1. 建推演 + 因果重建库存 ================= */
  console.log('\n— 1. 创建推演，命令→事件→投影，库存按因果序重建 —')
  let r = await POST('/sims', { id: 'sim-a', name: '主推演', scenarioId: 's1', clientId: 'cmdr-1' })
  assertEq(r.status, 200, '创建推演 sim-a')
  assert(!!j(r).clientId, '返回指挥员会话 clientId')

  let st = await stateOf('sim-a')
  const food0 = base2Food(st)
  assertEq(st.events.length, 3, '基线含 3 个灾情事件')
  assertEq(st.bases.length, 5, '基线含 5 个资源基地')

  // 派发食品 100（绵阳库 rb-2）
  r = await POST('/sims/sim-a/commands/dispatchResource', {
    clientId: 'cmdr-1', baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 100
  })
  assertEq(r.status, 200, '派发命令被接受')
  assertEq(j(r).events.length, 1, '生成 1 个领域事件')
  st = await stateOf('sim-a')
  assertEq(base2Food(st), food0 - 100, '事件折叠后库存扣减 100')
  assertEq(st.dispatches.length, 1, '产生 1 条在途派发')

  // 前置校验：超量派发被拒，不产生事件、库存不变
  const before = j(await GW('/sims/sim-a/timeline')).frames.length
  r = await POST('/sims/sim-a/commands/dispatchResource', {
    clientId: 'cmdr-1', baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 999999
  })
  assertEq(r.status, 409, '超量派发被快速失败（409）')
  st = await stateOf('sim-a')
  assertEq(base2Food(st), food0 - 100, '被拒命令不影响库存')
  assertEq(j(await GW('/sims/sim-a/timeline')).frames.length, before, '被拒命令不入时间轴')

  /* ================= 2. 派发闭环：签收/短缺/补派，四本账守恒 ================= */
  console.log('\n— 2. 签收/短缺/补派，四本账守恒 —')
  const dpId = st.dispatches[0].id
  r = await POST('/sims/sim-a/commands/signDispatch', { clientId: 'cmdr-1', dispatchId: dpId, qty: 80, shortQty: 20 })
  assertEq(r.status, 200, '签收 80 + 认定短缺 20')
  st = await stateOf('sim-a')
  let dp = st.dispatches.find((d) => d.id === dpId)
  assertEq(dp.status, 'done', '在途余量 0 → 已办结')
  assertEq(dp.signedQty, 80, '累计实收 80')

  r = await POST('/sims/sim-a/commands/replenishShortage', { clientId: 'cmdr-1', dispatchId: dpId })
  assertEq(r.status, 200, '短缺 20 触发补派（就近基地拆单）')
  st = await stateOf('sim-a')
  const children = st.dispatches.filter((d) => d.replenishOf === dpId)
  const made = children.reduce((n, d) => n + d.qty, 0)
  assertEq(made, 20, '补派子单总量 20，缺口补齐')
  // 重复补派应被拒绝
  r = await POST('/sims/sim-a/commands/replenishShortage', { clientId: 'cmdr-1', dispatchId: dpId })
  assertEq(r.status, 409, '无待补短缺时重复补派被拒')

  /* ================= 3. 床位与转移批次（床位守恒/车辆回收） ================= */
  console.log('\n— 3. 建批/接运/入住/转出/办结，床位与车辆守恒 —')
  st = await stateOf('sim-a')
  const vehBefore = stock(st, 'rb-2', 'vehicle')
  r = await POST('/sims/sim-a/commands/createBatch', {
    clientId: 'cmdr-1', eventId: 'ev-001', name: '首批', headcount: 40,
    vehicleBaseId: 'rb-2', vehicleCount: 2, shelterId: 'sh-2'
  })
  assertEq(r.status, 200, '创建转移批次 40 人/2 车 → sh-2')
  st = await stateOf('sim-a')
  const batch = st.batches.find((b) => b.name === '首批')
  assertEq(stock(st, 'rb-2', 'vehicle'), vehBefore - 2, '车辆占用 2')
  assertEq(st.shelters.find((s) => s.id === 'sh-2').capacity > 0, true, '安置点在位')

  await POST(`/sims/sim-a/commands/register`, { clientId: 'cmdr-1', batchId: batch.id, stage: 'pickup', count: 40 })
  await POST(`/sims/sim-a/commands/register`, { clientId: 'cmdr-1', batchId: batch.id, stage: 'checkin', count: 40 })
  st = await stateOf('sim-a')
  let b0 = st.batches.find((x) => x.id === batch.id)
  assertEq(b0.members.length, 40, '40 人完成接运+入住')
  assertEq(b0.status, 'settled', '满员入住 → 已安置')
  // 床位：40 在住
  let inHouse = 0
  st.batches.forEach((bb) => bb.members.forEach((m) => { if (m.checkinAt && !m.checkoutAt) inHouse++ }))
  assertEq(inHouse, 40, '在住人数 40（床位占用）')

  // 转出 40 → 自动办结 → 车辆回收
  await POST(`/sims/sim-a/commands/register`, { clientId: 'cmdr-1', batchId: batch.id, stage: 'checkout', count: 40 })
  st = await stateOf('sim-a')
  b0 = st.batches.find((x) => x.id === batch.id)
  assertEq(b0.status, 'closed', '全部转出 → 自动办结')
  assertEq(stock(st, 'rb-2', 'vehicle'), vehBefore, '办结后车辆全部回收（库存守恒）')

  /* ================= 4. 阻断 → 绕行（运输状态因果重建） ================= */
  console.log('\n— 4. 道路阻断影响评估 + 绕行/挂起，运输路线重建 —')
  // 新派发一条会被阻断切到的水：rb-2(绵阳 104.74,31.46) → ev-001(江油 104.7456,31.7777)，走廊在经度 104.74 附近
  await POST('/sims/sim-a/commands/dispatchResource', { clientId: 'cmdr-1', baseId: 'rb-2', eventId: 'ev-001', type: 'water', qty: 60 })
  st = await stateOf('sim-a')
  const waterDp = st.dispatches.find((d) => d.type === 'water' && d.status === 'enroute')
  assert(!!waterDp, '存在在途饮水派发')
  const poly = [
    [104.6438, 31.5209], [104.8438, 31.5209],
    [104.8438, 31.7209], [104.6438, 31.7209]
  ]
  r = await POST('/sims/sim-a/commands/reportBlock', { clientId: 'cmdr-1', name: '绵江公路积水', polygon: poly })
  assertEq(r.status, 200, '上报阻断')
  st = await stateOf('sim-a')
  const blk = st.blocks.find((b) => b.name === '绵江公路积水')
  assert(!!blk, '阻断已入库')

  r = await POST(`/sims/sim-a/blocks/${blk.id}/assess`, { clientId: 'cmdr-1' })
  assertEq(r.status, 200, '影响评估')
  const impact = j(r).impacts.find((i) => i.kind === 'dispatch' && i.id === waterDp.id)
  assert(!!impact, '检出水派发受阻断影响')
  const detourOpt = impact.options.find((o) => o.action === 'detour')
  assert(!!detourOpt && detourOpt.via.length > 0, '生成联合绕行方案（含途经点）')

  r = await POST(`/sims/sim-a/blocks/${blk.id}/apply`, {
    clientId: 'cmdr-1', kind: 'dispatch', id: waterDp.id, action: 'detour'
  })
  assertEq(r.status, 200, '执行绕行')
  st = await stateOf('sim-a')
  const dpNow = st.dispatches.find((d) => d.id === waterDp.id)
  assert(dpNow.via.length > 0, '运输状态：绕行途经点已重建')
  assert(dpNow.detourBy === blk.id, '绕行来源阻断已记录')

  /* ================= 5. 恢复通行 → 路线联合重排回直 + 工单联动 ================= */
  console.log('\n— 5. 恢复通行，绕行回直，在途运输重算 —')
  r = await POST(`/sims/sim-a/blocks/${blk.id}/clear`, { clientId: 'cmdr-1' })
  assertEq(r.status, 200, '清除阻断并联合重排')
  st = await stateOf('sim-a')
  const dpStraight = st.dispatches.find((d) => d.id === waterDp.id)
  assertEq(dpStraight.via.length, 0, '绕行路线恢复为直线')
  assertEq(st.blocks.find((b) => b.id === blk.id).status, 'cleared', '阻断已恢复')

  /* ================= 6. 多人并行推演：分支隔离 + 分叉 ================= */
  console.log('\n— 6. 多人并行：分叉独立推演，库存/床位互不污染 —')
  // 记录分叉前绵阳食品库存
  st = await stateOf('sim-a')
  const foodMainNow = base2Food(st)
  // 指挥员 B 从主干末端分叉
  r = await POST('/sims/sim-a/fork', { clientId: 'cmdr-2', name: 'B方案-优先食品' })
  assertEq(r.status, 200, '指挥员 B 分叉新分支')
  const branchB = j(r).branch.id
  assert(branchB && branchB !== 'main', '新分支 id 非主干')

  // B 在自己分支再派发食品 500
  r = await POST('/sims/sim-a/commands/dispatchResource', {
    clientId: 'cmdr-2', branchId: branchB, baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 500
  })
  assertEq(r.status, 200, 'B 分支派发食品 500')
  const stB = await stateOf('sim-a', branchB)
  assertEq(base2Food(stB), foodMainNow - 500, 'B 分支库存扣减 500')
  // 主干库存不受影响
  const stMain = await stateOf('sim-a', 'main')
  assertEq(base2Food(stMain), foodMainNow, '主干库存不受分支写入污染（隔离）')

  // 指挥员 C 也分叉（兄弟分支并行）
  r = await POST('/sims/sim-a/fork', { clientId: 'cmdr-3', name: 'C方案-保守' })
  assertEq(r.status, 200, '指挥员 C 分叉兄弟分支')
  const branchC = j(r).branch.id
  r = await POST('/sims/sim-a/commands/dispatchResource', {
    clientId: 'cmdr-3', branchId: branchC, baseId: 'rb-1', eventId: 'ev-002', type: 'medical', qty: 30
  })
  assertEq(r.status, 200, 'C 分支独立派发医疗物资')

  // 分支树：main + 两个子分支
  r = await HIST('GET', '/sims/sim-a/branches')
  assertEq(j(r).branches.length, 3, '分支树含主干 + 2 个分叉')
  const parents = j(r).branches.filter((b) => b.parentId === 'main').length
  assertEq(parents, 2, '两个子分支都源自主干')

  /* ================= 7. 双分支末端对照 ================= */
  console.log('\n— 7. 双分支处置结果对照 —')
  r = await GW(`/sims/sim-a/compare?a=main&b=${branchB}`)
  assertEq(r.status, 200, '对照查询成功')
  const cmp = j(r).compare
  const stockDiff = cmp.groups.find((g) => g.dim === '基地库存')
  assert(!!stockDiff && stockDiff.rows.some((row) => row.label.includes('应急食品')), '对照检出绵阳食品库存差异')
  assert(cmp.groups.find((g) => g.dim === '物资派发'), '对照检出派发差异')

  /* ================= 8. 断线续演 ================= */
  console.log('\n— 8. 断线续演：会话恢复 + 增量事件 + 长轮询 —')
  // cmdr-2 断开
  await ING('POST', '/sessions/cmdr-2/disconnect', {})
  // 恢复：resume 拿回分支与末端态势
  r = await POST('/sims/sim-a/resume', { clientId: 'cmdr-2', branchId: branchB })
  assertEq(r.status, 200, '断线后 resume 成功')
  assert(!!j(r).state && j(r).state.bases.length === 5, '续演带回完整末端态势（可直接重绘）')
  assertEq(j(r).branches.find((b) => b.id === branchB).eventCount > 1, true, '续演带回分支事件位置')

  // 长轮询：先记录 lastSeq，再产生新事件，poll 应及时返回
  const tl = j(await GW(`/sims/sim-a/timeline?branch=${branchB}`))
  const lastSeq = tl.frames[tl.frames.length - 1].eventSeq
  const pollPromise = GW(`/sims/sim-a/poll?branch=${branchB}&afterSeq=${lastSeq}`)
  await sleep(300)
  await POST('/sims/sim-a/commands/dispatchResource', {
    clientId: 'cmdr-2', branchId: branchB, baseId: 'rb-2', eventId: 'ev-001', type: 'water', qty: 10
  })
  const poll = await pollPromise
  assertEq(poll.status, 200, '长轮询返回')
  assert(j(poll).lastSeq > lastSeq, '长轮询感知到新事件（断线期间增量）')

  /* ================= 9. 事件乱序：HLC 重排 + after 因果 + 幂等 ================= */
  console.log('\n— 9. 事件乱序/并发写入：HLC 重排、after 因果、幂等去重 —')
  // 新建独立推演，直接打采集服务，制造乱序：先发"签收"再发"派发"，
  // 但用 after 强制派发先于签收（因果序恢复）
  await POST('/sims', { id: 'sim-o', scenarioId: 's1', clientId: 'raw-1' })
  // 直接构造两个事件：派发事件 id=root，签收 after=root；投递顺序先发签收
  const rootEv = { id: 'root-dp', type: 'resource.dispatched', payload: { baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 50 }, at: '09:00' }
  const childEv = { id: 'sign-dp', type: 'dispatch.signed', payload: { dispatchId: 'root-dp', qty: 50 }, at: '09:05', after: ['root-dp'] }
  // 先发子（签收）后发父（派发），制造乱序
  await ING('POST', '/sims/sim-o/branches/main/events', { clientId: 'raw-1', events: [childEv] })
  await ING('POST', '/sims/sim-o/branches/main/events', { clientId: 'raw-1', events: [rootEv] })
  await ING('POST', '/flush', { simId: 'sim-o', branchId: 'main' })
  st = await stateOf('sim-o')
  const rdp = st.dispatches.find((d) => d.id === 'root-dp')
  assert(!!rdp, '乱序到达后派发事件仍被重建')
  assertEq(rdp.status, 'done', 'after 因果约束使签收在派发之后应用 → 办结')
  assertEq(rdp.signedQty, 50, '因果序下签收量正确')

  // 幂等：重复投递同一事件 id 不重复生效
  const foodBeforeDup = base2Food(st)
  await ING('POST', '/sims/sim-o/branches/main/events', { clientId: 'raw-1', events: [rootEv] })
  await ING('POST', '/flush', { simId: 'sim-o', branchId: 'main' })
  st = await stateOf('sim-o')
  assertEq(st.dispatches.filter((d) => d.id === 'root-dp').length, 1, '重复事件去重（仍只有 1 条派发）')
  assertEq(base2Food(st), foodBeforeDup, '重复投递不重复扣库存（幂等）')

  // 纯乱序（无 after）：两批无依赖事件按 HLC 稳定排序，结果确定
  const e1 = { type: 'event.statusChanged', payload: { eventId: 'ev-002', status: 'controlled' }, at: '10:00', hlc: '0000018f00000000-000005' }
  const e2 = { type: 'event.statusChanged', payload: { eventId: 'ev-003', status: 'assessing' }, at: '09:00', hlc: '0000018f00000000-000001' }
  await ING('POST', '/sims/sim-o/branches/main/events', { clientId: 'raw-1', events: [e1, e2] })
  await ING('POST', '/flush', { simId: 'sim-o', branchId: 'main' })
  const evs = j(await HIST('GET', '/sims/sim-o/branches/main/events')).events
  const idx2 = evs.findIndex((x) => x.payload?.eventId === 'ev-003')
  const idx1 = evs.findIndex((x) => x.payload?.eventId === 'ev-002')
  assert(idx2 >= 0 && idx1 >= 0 && idx2 < idx1, '无依赖并发事件按 HLC 因果序归位（早 HLC 在前）')

  /* ================= 10. 并发写入乐观冲突：库存守恒 ================= */
  console.log('\n— 10. 分支并发写入竞态：乐观冲突入账，库存不为负 —')
  await POST('/sims', { id: 'sim-c', scenarioId: 's1' })
  st = await stateOf('sim-c')
  const medical0 = stock(st, 'rb-3', 'medical') // 南充 8000
  // 两个并发命令都想拿走超过库存的量（绕过网关前置校验，直接并发提交事件到采集）
  const big = (tag) => ({
    type: 'resource.dispatched',
    payload: { baseId: 'rb-3', eventId: 'ev-001', type: 'medical', qty: medical0 },
    at: '11:00'
  })
  // 同一时刻并发打两批（各 8000，共 16000 > 库存 8000）
  await Promise.all([
    ING('POST', '/sims/sim-c/branches/main/events', { events: [big('a')] }),
    ING('POST', '/sims/sim-c/branches/main/events', { events: [big('b')] })
  ])
  await ING('POST', '/flush', { simId: 'sim-c', branchId: 'main' })
  st = await stateOf('sim-c')
  assert(stock(st, 'rb-3', 'medical') >= 0, '并发超扣后库存绝不为负（守恒）')
  const appliedCount = st.dispatches.filter((d) => d.type === 'medical' && d.baseId === 'rb-3').length
  assert(appliedCount >= 1, '至少一笔并发派发成立')
  assert((st.conflicts || []).some((c) => c.reason === 'insufficient-stock'), '失败的并发写入记为因果冲突（不破坏状态）')

  /* ================= 11. 故障恢复：杀进程 + 重启，事件/检查点不丢 ================= */
  console.log('\n— 11. 故障恢复：历史/采集进程崩溃重启后状态完整 —')
  // 重启历史服务（模拟宕机）
  await restartService('history', 500)
  await waitAll()
  st = await stateOf('sim-a')
  assertEq(st.events.length, 3, '历史服务重启后基线事件仍在（追加日志恢复）')
  assert(!!st.bases.find((b) => b.id === 'rb-2'), '基地数据恢复')
  const dpAfter = st.dispatches.find((d) => d.id === waterDp.id)
  assert(!!dpAfter, '重启后在途派发记录完整')
  const blkAfter = st.blocks.find((b) => b.id === blk.id)
  assertEq(blkAfter.status, 'cleared', '重启后阻断恢复状态正确')

  // 检查点：主动落盘
  let cp = await HIST('POST', '/sims/sim-a/branches/main/checkpoint', {})
  assertEq(cp.status, 200, '主干检查点落盘')
  assert(j(cp).untilSeq >= 0, '检查点记录偏移')

  // 采集崩溃：未确认事件 WAL 恢复重投
  // 模拟：停历史→事件积压在采集 WAL→杀采集→先恢复历史→再重启采集→WAL 重放送达
  stopService('history')
  await waitForPortDown(TPORTS.history, 3000)
  await ING('POST', '/sims/sim-a/branches/main/events', {
    clientId: 'crash-1',
    events: [{ type: 'event.statusChanged', payload: { eventId: 'ev-001', status: 'controlled' }, at: '12:00' }]
  })
  await sleep(200)
  // 确认事件确实卡在采集（历史不可达）
  const pend = j(await ING('GET', '/pending'))
  assert(pend.pending.length >= 1, '历史宕机期间事件滞留在采集 WAL（待重投）')
  // 杀采集（崩溃，事件仅存于 WAL）
  stopService('ingestion')
  await waitForPortDown(TPORTS.ingestion, 3000)
  // 先恢复历史
  startService('history')
  await waitHealthy(TPORTS.history)
  // 再恢复采集：recover() 重放 WAL
  startService('ingestion')
  await waitHealthy(TPORTS.ingestion)
  // 轮询等待 WAL 重放送达（幂等，不依赖固定 sleep）
  const delivered = await waitForState('sim-a', 'main',
    (s) => s.events.find((e) => e.id === 'ev-001')?.status === 'controlled')
  assert(delivered, '采集崩溃 + 历史宕机期间事件经 WAL 重放最终送达（不丢）')

  /* ================= 12. 旧快照迁移 ================= */
  console.log('\n— 12. 旧版单线 frames 快照迁移 —')
  // 构造一个 v1 格式旧快照（{cmd,tr,rb,ro} 全量快照帧）
  const legacyFrames = [
    {
      seq: 0, at: '08:00', title: '旧演练基线',
      snapshot: {
        cmd: {
          events: [{ id: 'old-ev-1', type: 'flood', title: '旧系统洪灾', status: 'dispatching', timeline: [], location: { lng: 104.7, lat: 31.7 }, demand: {} }],
          bases: [{ id: 'rb-2', name: '绵阳物资储备库', lng: 104.742, lat: 31.4641, stock: { food: 1000, water: 500, vehicle: 10, medical: 0, personnel: 0, tent: 0 } }],
          dispatches: [], plan: [], planResult: null
        },
        tr: { shelters: [{ id: 'sh-2', name: '绵阳会展中心安置点', lng: 104.73, lat: 31.45, capacity: 2000 }], batches: [], settleDay: 1, clock: null },
        rb: { blocks: [], selectedBlockId: null },
        ro: { orders: [], focusOrderId: null }
      }
    }
  ]
  r = await call('POST', TPORTS.replay, '/sims/migrate-snapshot', { simId: 'sim-legacy', name: '旧快照', frames: legacyFrames })
  assertEq(r.status, 200, '旧快照迁移受理')
  assertEq(j(r).migrated, true, '迁移成功标记')
  await sleep(200)
  st = await stateOf('sim-legacy')
  assert(!!st.events.find((e) => e.id === 'old-ev-1'), '旧快照事件迁移到事件流投影')
  assertEq(st.bases.find((b) => b.id === 'rb-2').stock.food, 1000, '旧快照库存迁移正确')
  assertEq(st.shelters.find((s) => s.id === 'sh-2').capacity, 2000, '旧快照安置点/床位迁移正确')
  // 迁移后可以正常分叉继续推演
  r = await POST('/sims/sim-legacy/fork', { clientId: 'legacy-1', name: '迁移后新推演' })
  assertEq(r.status, 200, '迁移后的推演可正常分叉续写')

  /* ================= 13. 真实调度隔离 ================= */
  console.log('\n— 13. 真实调度（live）与演练物理隔离 —')
  // 推演命令写 live 一律拒绝
  r = await POST('/sims/live/commands/dispatchResource', { baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 1 })
  assertEq(r.status, 403, '推演命令通道写真实流被拒绝')
  // 伪造令牌拒绝
  r = await call('POST', TPORTS.gateway, '/live/commands/dispatchResource', {
    baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 1
  }, { 'x-live-token': 'wrong' })
  assertEq(r.status, 401, '错误的真实流令牌被拒绝（401）')
  // 正确令牌可初始化并写真实流
  r = await call('POST', TPORTS.gateway, '/live/commands/dispatchResource', {
    scenarioId: 's1', baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 30
  }, { 'x-live-token': 'test-live-token' })
  assertEq(r.status, 200, '带外令牌的真实命令成功')
  assertEq(j(r).live, true, '标记为真实流写入')
  const liveState = j(await GW('/live/state')).state
  assertEq(liveState.simId, 'live', '真实流 simId=live')
  assertEq(liveState.bases.find((b) => b.id === 'rb-2').stock.food, 12000 - 30, '真实流独立库存（与演练互不影响）')
  // live 不允许分叉
  r = await POST('/sims/live/fork', { clientId: 'x' })
  assertEq(r.status, 403, '真实流禁止分叉演练')
  // live 不出现在普通推演列表
  r = await GW('/sims')
  assert(!j(r).sims.some((s) => s.id === 'live'), '真实流对推演列表不可见')
  // 直接打历史服务写 live（绕过令牌）也被拒
  r = await HIST('POST', '/sims/live/branches/main/events', { events: [{ type: 'event.statusChanged', payload: {} }] })
  assertEq(r.status, 403, '历史服务层面再次拦截对真实流的未授权写入')
  // 演练 sim 的库存没有被真实流操作影响
  const simAFood = base2Food(await stateOf('sim-a'))
  assert(simAFood !== 12000 - 30, '真实流扣减不影响任何演练分支（物理隔离）')

  /* ================= 汇总 ================= */
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  stopAll()
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); stopAll(); process.exit(1) })
