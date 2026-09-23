# 事件溯源三服务架构（采集 / 历史存储 / 回放计算）

把原本耦合在浏览器（Pinia 单体、每动作一帧全量快照）的事件采集、历史存储、回放计算
拆为三个**独立部署、零运行时第三方依赖**的 Node 服务，统一在不可变事件日志上协作。

```
                         现场端 / 演练端（多人并行）
                                      │ POST /v1/events（单条/批量，可乱序、可重发）
                                      ▼
        ┌──────────────────────────────────────────────┐
        │  collector  :7101   事件采集（无状态业务）     │
        │  · 信封校验 · 域隔离守门(real 令牌 / wg: 前缀) │
        │  · 本地 outbox 落盘 → 转发（宕机不丢、自动补投）│
        └──────────────────────────────────────────────┘
                          │ append（幂等/乐观并发）
                          ▼
        ┌──────────────────────────────────────────────┐
        │  archive    :7102   历史存储（唯一事实源）     │
        │  · JSONL 只追加日志 + fsync · 崩溃扫描恢复     │
        │  · (realm,branch) 单调 seq · 分叉指针不复制事件 │
        │  · /events 因果流 · /since 增量 · /stream SSE  │
        │  · 旧快照迁移 /v1/migrate/legacy               │
        └──────────────────────────────────────────────┘
                          │ 拉取 / 订阅（断线 since 补拉）
                          ▼
        ┌──────────────────────────────────────────────┐
        │  replay     :7103   回放计算（派生缓存）       │
        │  · 纯函数 reducer 折叠：库存/床位/运输投影      │
        │  · 增量折叠，因果断裂自动全量重建（确定性）     │
        │  · 多人会话 resumeToken 断线续演 · seek 只读锁  │
        │  · 分支末端对照 diff                           │
        └──────────────────────────────────────────────┘
```

## 快速开始

```bash
# 一键起三服务（开发演示）
npm run svc:all

# 或分别启动（生产独立部署，可按服务水平扩容/分片）
npm run svc:archive      # 必须先起；collector 会重试等待
npm run svc:collector
npm run svc:replay

# 服务化回归（内核单元 + 三服务 HTTP 联调，67 项断言）
npm run test:services
```

环境变量样板见 `services/.env.services.example`。

## 因果模型与乱序处理

事件信封（`services/shared/events.js`）不依赖物理时钟判定因果：

| 字段 | 作用 |
| --- | --- |
| `realm` / `branchId` | 作用域隔离。真实调度固定 `real`；演练域强制 `wg:` 前缀 |
| `seq` | archive 在 `(realm, branchId)` 内原子分配的单调序号，回放主次序 |
| `prevId` / `expectedSeq` | 客户端「我看到的最后一帧」，乐观并发依据 |
| `lamport` | 跨端逻辑时钟（max+1），seq 相同时的次级次序 |
| `happenedAt` | 现场业务时间（可迟到乱序），与入库时间 `ingestedAt` 分离 |
| `concurrent` | 服务端对「基于旧末端」提交打的并发标记（不拒绝、不静默丢） |
| `idempotencyKey` | 业务幂等键（如同一阻断只允许一张在途抢修工单） |

- **乱序/迟到**：日志按 `seq` 持久化与读取；replay 先尝试增量折叠，
  一旦发现 `prevId` 对不上（`causal_gap`）立即降级为**从事实源全量重建**。
  reducer 是纯函数，同一事件集无论实时到、乱序补到、还是重启重放，
  折叠结果**逐字节一致**（`stableStringify` 指纹可验证）。
- **并发写入**：两指挥员基于同一末端同时提交，都受理并落账，后到者标 `concurrent=true`，
  由业务层（分叉/方案对照）消化；业务不变量（超扣/超占）在 reducer 折叠时硬拦截。

## 分叉与并发分支

分叉只登记指针、**不物理复制事件**（`scopes.json`：parentRealm/parentBranchId/forkSeq）。
读取某分支时沿分叉链展开：父支段按 `forkSeq` 截断，再接本支段（支持多级分叉）。
各分支库存/床位/运输独立折叠，天然互不污染；分支可封存（sealed 拒写）。

```bash
curl -s localhost:7102/v1/branches/fork -d '{
  "realm":"wg:demo","parentBranchId":"main","forkSeq":11,"branchId":"planB"}'
curl -s localhost:7103/v1/branches/compare -d '{"realm":"wg:demo","a":"main","b":"planB"}'
```

## 故障恢复

- **archive**：只追加 JSONL，单行 `write + fsync` 后应答；重启扫描日志，
  截断末尾半行（崩溃写一半），重建每作用域 seq 水位、幂等表、分叉元数据。
- **collector**：先落本地 outbox 再转发；archive 宕机时返回 `202` 并排队，
  指数退避重试，恢复后自动补投；同 `eventId` 重放被 archive 幂等去重（不重不丢）；
  不可修复的坏消息隔离进 `deadletter.jsonl`。
- **replay**：不持有事实状态，仅缓存派生投影；与 archive 对账 `tipSeq`，
  任何时刻崩溃/重启都从事件流确定性重建。

## 断线续演（多人）

- `POST /v1/sessions` 建会话；响应中的 `resumeToken`（= sessionId）在断线后原样带回即续演。
- `POST /v1/sessions/:id/resync` 带 `lastSeq`，服务端补推缺失事件并回送当前投影与指纹，
  客户端据此追平。

## 真实调度隔离

- 写 `realm=real` 必须带 `X-Realm-Token`（collector 403 守门）；
  演练域必须 `wg:` 前缀，与真实域是不同的日志作用域，物理不可见。
- real 域默认禁止分叉（`allowReal` 才能建审计副本）；
  回放 seek 期间会话进入只读，`/v1/guard/writable` 对业务网关拦截一切写操作，
  必须先 `resume-live` 回到末端——历史推演绝不回灌真实调度。

## 按因果序重建的三类投影（reducer）

- **库存** `stock.granted/reserved/allocated/returned`：
  余量 = granted − allocated + returned，可用 = 余量 − reserved；预占→实扣凭 refId 核销。
- **床位** `bed.reserved/occupied/freed`：capacity = reserved + occupied + free 守恒。
- **运输** `shipment.created/routed/held/resumed/delivered/returned/closed`：
  物资/人员/抢修投送统一聚合，路线/ETA 与挂起续派全部进 timeline。
另含阻断与抢修（进度单调、验收才解封）。所有越界操作抛 `invariant_violation`。

## 旧快照迁移

`POST /v1/migrate/legacy` 接收旧前端 `{ frames:[{snapshot…}] }`：
基线帧 → `realm.opened`；相邻帧 diff 出库存/床位/运输/阻断/抢修增量事件；
逐帧试折叠校验，任何对不上的帧挂 `snapshot.anchor`（旧全量快照整体校准）兜底；
单线 frames 归一为 `main` 主干，之后可正常分叉。同一作用域拒绝二次迁移（防双写）。

## HTTP 速查

| 服务 | 方法/路径 | 说明 |
| --- | --- | --- |
| collector | `POST /v1/events` | 采集（批量≤500，离线 202 入 outbox） |
| collector | `POST /v1/outbox/flush` · `GET /v1/outbox` | 手动补投 / 查看积压 |
| archive | `POST /v1/events/append` | 直接追加（服务间；幂等） |
| archive | `GET /v1/events?realm=&branchId=` | 分叉链完整因果流 |
| archive | `GET /v1/events/since?...&fromSeq=` | 断线增量补拉 |
| archive | `GET /v1/stream` | SSE 实时事件 |
| archive | `POST /v1/branches/fork` · `/seal` · `GET /v1/scopes` | 分支管理 |
| archive | `POST /v1/migrate/legacy` | 旧快照迁移 |
| replay | `GET /v1/state` · `/state/stock|beds|transport` | 末端投影 / 三类子视图 |
| replay | `POST /v1/sessions` · `/sessions/:id/resync` | 多人会话 / 断线续演 |
| replay | `POST /v1/replay/seek` · `/resume-live` | 历史只读回放 / 回末端 |
| replay | `POST /v1/branches/compare` · `/guard/writable` | 分支对照 / 只读守门 |

## 目录

```
services/
├── shared/        事件信封 / EventLog / 纯函数 reducer / 旧快照迁移 / HTTP 工具
├── collector/     事件采集（outbox 可靠转发、域守门）
├── archive/       历史存储（唯一事实源、分叉、SSE、迁移）
├── replay/        回放计算（投影、会话、seek、对照、只读锁）
└── bin/start-all.js
```
