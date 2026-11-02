# 真实数据桥 · 集成说明（第一阶段）

> 目标：把真实智能体数据接进 `agent-hq-upstream` 的模拟层，但不改 `src/`。
> 本阶段交付：`scripts/real-snapshot.js` + `public/snapshot.json` + 本文档 + 一份报告。
> 上游类型以 `src/data/types.ts` 为准，模拟世界以 `src/data/world.ts` 为准（只读分析）。

---

## 1. 结论摘要

- 已实现零依赖生成器 `scripts/real-snapshot.js`：读取
  `D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl` 与 `metrics-history.jsonl`，
  输出符合 `Snapshot` 结构的 `public/snapshot.json`。
- 当前真实数据可支撑：**任务、任务状态、起止时间、部门、Agent 标识、Agent Token、总会话数、总 Token**。
- 不能支撑、已明确标注 `未接` 的字段：**会议（meeting）、逐任务 tool、逐任务 progress、逐任务 tokens、真实工具调用事件流**。
- Agent 的 **部门 / 状态 / 工位 / 热度** 是由“最近一条任务”推导的，不是实时心跳；文档和 JSON 的 `meta.derived` 都已注明。
- 当前生成结果：5 条任务、3 个可落位 Agent、9 个无部门 Agent（只进 `meta`）、10 条派生事件、
  `kpis.tokens=15,535,235`、`totalSessions=206`，文件约 **14.7 KiB**。
- 第二阶段的最小改法是：**在 React 挂载前 fetch `snapshot.json`，调用 `world.applySnapshot(snap)` 并暂停模拟 tick**。
  不能只改 `useHQ` 的初始值——3D 场景、Drawer、TaskTable 都直接读 `world`，只换 store 不会生效。

---

## 2. 数据流

```
agent-hq\tasks.jsonl ─────────┐
                              ├─> scripts/real-snapshot.js ─> public/snapshot.json
agent-hq\metrics-history.jsonl┘        （映射/派生/校验）          │
                                                                  │ 第二阶段
                                                                  ▼
                                              main.tsx boot ─> world.applySnapshot(snap)
                                                                  │
                                      ┌───────────────────────────┼───────────────────────────┐
                                      ▼                           ▼                           ▼
                                  useHQ.snap                  HQScene 每帧读 world        Drawer/TaskTable
```

真实数据只读；脚本不写 `tasks.jsonl` / `metrics-history.jsonl`，不触碰 NAS，不调用 agent。

---

## 3. 真实数据源

| 数据源 | 位置 | 用途 | 读取方式 |
|---|---|---|---|
| 任务队列 | `D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl` | 任务、状态、agent、部门、起止时间、回复、错误 | 逐行 `JSON.parse`，坏行跳过并写入 `meta.warnings` |
| 指标历史 | `D:\OpenClaw\workspace\projects\agent-hq\metrics-history.jsonl` | `totalSessions`、`totalTokens`、每个 agent 的 sessions/tokens | 取 `ts` 最大的一条（不是简单取最后一行） |
| 8900 `/api/state` | `http://127.0.0.1:8900/api/state` | 与指标历史同源，可选实时 | 仅 `--live` 时尝试，2.5s 超时，失败回退文件 |
| 上游部门表 | `src/data/world.ts` 的 `DEPTS` | 校验脚本镜像的 12 个房间 id/kind | 只读正则校验；不一致只告警 |

> `metrics-history.jsonl` 由 8900 面板每 60s 追加；当前最新一条可能比“现在”晚几十秒到几分钟，
> 脚本会把 `meta.source.metrics.ageSeconds` 写出来，便于判断数据新鲜度。

---

## 4. Snapshot 字段 → 真实来源映射

状态说明：
**能接** = 真实字段直接可用；**派生** = 由真实字段计算/映射；**未接** = 无真实来源，按约定填占位；**待确认** = 语义可能不等价。

### 4.1 顶层

| Snapshot 字段 | 上游类型 | 真实来源 | 状态 |
|---|---|---|---|
| `kpis` | `Kpis` | 见 4.2 | 混合 |
| `agents` | `Agent[]` | `metrics.agents` + `tasks[].agent` 并集 | 混合 |
| `tasks` | `Task[]` | `tasks.jsonl`，按 `createdAt` 倒序，最多 60 条 | 能接 |
| `events` | `Ev[]` | 由任务生命周期时间戳派生，最多 40 条 | 派生 |
| `deptLoad` | `DeptLoad[]` | 由 `agents[]` 按 `deptId` 聚合；12 个房间全量输出（含 0） | 派生 |
| `meeting` | `Meeting \| null` | 无真实会议源 | **未接**，固定 `null` |
| `ts` | `number` | 脚本生成时刻 `Date.now()` | 能接 |
| `meta` | 上游无此字段 | 附加诊断信息：来源、计数、未安置 agent、TODO、警告 | 扩展字段，读取时忽略 |

> `meta` 是为了满足“拿不到就明确写未接、不要编造”的审计要求。`Snapshot` 类型没有它，
> 但 `JSON.parse` 后多一个键不会影响 TS 运行时；若要求严格贴合类型，第二阶段可以删掉再传入。

### 4.2 `kpis`

| 字段 | 真实来源 | 状态 | 说明 |
|---|---|---|---|
| `total` | `tasks.jsonl` 记录数 | 待确认 | 上游语义是“历史累计任务数”，这里只是**当前文件可见记录数**；文件裁剪后会变小 |
| `running` | `agents[].status === 'running'` 的数量 | 派生 | 由最近任务状态推导 |
| `blocked` | `agents[].status === 'error'` 的数量 | 派生 | 与上游 `world.kpis()` 语义一致（只数 error，不数 blocked） |
| `done` | `tasks[].status === 'done'` 的数量 | 能接 | 仅当前文件可见范围 |
| `avgMin` | `(finishedAt - startedAt) / 60000` 的均值 | 能接 | 只统计同时有起止时间的 done 任务 |
| `tokens` | `metrics.totalTokens` | 能接 | 工作区**累计** Token，不是本快照内任务消耗 |
| `progress` | `done / total * 100` | 派生 | 与 `total` 同口径；全部完成时是 100% |
| `inMeeting` | `0` | **未接** | `meeting` 未接，故恒为 0 |

### 4.3 `agents[]`

| Agent 字段 | 真实来源 | 状态 | 说明 |
|---|---|---|---|
| `id` | `metrics.agents[].agentId` 或 `tasks[].agent` | 能接 | 例：`worker2`、`security-audit` |
| `name` | 同 `id` | 能接 | 没有真实“角色名”，不用模拟层的“需求拆解”等假名 |
| `deptId` | 该 agent **最近一条任务**的 `deptId` / `room` 映射 | 派生 | 任务跨部门时取最近一条；无任务则不落位 |
| `status` | 最近一条任务 `state` | 派生 | `running→running`、`queued/split→standby`、`review/awaiting_approval→blocked`、`error/failed→error`、`done→standby`。**不是实时心跳** |
| `deskIndex` | 部门内排序后的序号 0..n-1 | 派生 | 与上游 `deskPositions(count)` 约定一致 |
| `taskId` | 最近一条 `running/blocked/error` 任务 id | 派生 | `standby` 时为 `null` |
| `tokens` | `metrics.agents[].tokens` | 能接 | 该 agent 累计 Token；metrics 缺失时为 0 并告警 |
| `startedAt` | 最近活动任务的 `createdAt` | 派生 | 无活动任务时 `null` |
| `heat` | 由 `status` 推导 | 派生 | `running=1`、`blocked/error=0.35`、`standby=0`；纯视觉值 |
| `seatIndex` | 无 | **未接** | 恒 `null`（无真实会议） |
| `role` | `deptId === 'director'` | 派生 | 其余一律 `member`；当前没有真实 director agent，总监室为空 |

**未落位 Agent**：有真实会话/Token、但 `tasks.jsonl` 里没有任务、无法确定部门的 agent
（`main`、`assistant2`、`assistant3`、`assistant4`、`knowledge-manager`、`data-analyst`、
`integration-communication`、`creative-planner`、`openclaw`），不塞进 `agents[]`，而是完整写入
`meta.unplacedAgents` 和 `meta.agentStats`。这样既不丢真实数据，也不编造工位。

### 4.4 `tasks[]`

| Task 字段 | 真实来源 | 状态 | 说明 |
|---|---|---|---|
| `id` | `tasks[].id` | 能接 | |
| `deptId` | `tasks[].deptId` 优先，否则 `room` 映射 | 能接/派生 | 见第 5 节房间映射 |
| `agentId` | `tasks[].agent` | 能接 | 缺 agent 的记录跳过并告警 |
| `title` | `tasks[].text`，截断 140 字 | 能接 | |
| `summary` | `tasks[].reply` 优先，否则 `text`，截断 220 字 | 能接 | |
| `status` | `tasks[].state` 映射 | 能接 | `queued/pending/split→queued`、`running→running`、`review/awaiting_approval→review`、`done→done`、`error/failed→failed` |
| `progress` | 仅 `done=100`，其余 `0` | **未接** | 没有实时进度字段 |
| `createdAt` | `tasks[].ts` | 能接 | |
| `finishedAt` | `tasks[].finishedAt` | 能接 | 仅 done/failed 保留 |
| `durationMs` | `finishedAt - startedAt` | 能接 | 缺任一时为 0 |
| `tool` | 无 | **未接** | 固定 `"未接（TODO）"` |
| `tokens` | 无 | **未接** | 固定 `0`；总 Token 在 `kpis.tokens` |
| `error` | `tasks[].error` | 能接（若有） | 失败但无 error 字段时写 `"未接（原始记录无错误字段）"` |

### 4.5 `events[]` / `deptLoad[]` / `meeting`

| 字段 | 真实来源 | 状态 |
|---|---|---|
| `events[].id` | `ev_<taskId>_<kind>` | 派生 |
| `events[].ts` | 任务 `createdAt` / `finishedAt` | 能接（时间戳真实） |
| `events[].kind` | 由任务状态派生：`start/done/error/queue` | 派生；`tool/retry/meeting` **未接** |
| `events[].deptId/agentId/taskId` | 任务字段 | 能接 |
| `events[].text` | 由任务标题+agent 拼接 | 派生（非真实工具日志） |
| `deptLoad[].id` | `DEPTS` 12 个 id | 能接 |
| `deptLoad[].running/total/error/meeting` | `agents[]` 按部门计数 | 派生 |
| `meeting.*` | 无 | **未接** |

---

## 5. 房间（部门）映射

上游 `DEPTS` 固定 12 个房间，真实 `room` 是自由文本；映射表在脚本 `ROOM_MAP`：

| 真实 room | 上游 deptId | 精度 |
|---|---|---|
| 产品 / 产品部 / product | `product` | 精确 |
| 设计 / 设计部 / design | `design` | 精确 |
| 技术 / 技术部 / 研发 / 研发部 / eng | `eng` | 精确 |
| 市场 / 市场部 / market | `market` | 精确 |
| 运营 / 运营部 / ops | `ops` | 精确 |
| 招聘 / 招聘部 / 人力 / hr | `hr` | 精确 |
| 财务 / 财务部 / fin | `fin` | 精确 |
| 客服 / 客服部 / cs | `cs` | 精确 |
| 数据 / 数据部 / data | `data` | 精确 |
| 战略 / 战略部 / strat | `strat` | 精确 |
| 总监 / 总监办 / 总监办公室 / director | `director` | 精确（最多保留 1 人，多出的进 `meta.unplacedAgents`） |
| **安全 / 安全部 / security** | `eng` | **近似**：上游没有安全部房间；JSON 的 `meta.roomMapping` 会标 `approximate: true` |
| 未知 room | `eng`（兜底） | **近似**；写入 `meta.warnings` |

任务自带合法 `deptId` 时优先用 `deptId`（例：`"deptId":"design"`）。

---

## 6. 脚本用法

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 默认：读 agent-hq 数据目录，写 public/snapshot.json
node scripts/real-snapshot.js

# 自定义数据目录 / 输出路径
node scripts/real-snapshot.js --data-dir "D:\OpenClaw\workspace\projects\agent-hq" --out public/snapshot.json

# 先尝试 8900 /api/state（失败自动回退 metrics-history.jsonl）
node scripts/real-snapshot.js --live

# 只输出错误，不打印警告
node scripts/real-snapshot.js --quiet

# 帮助
node scripts/real-snapshot.js --help
```

特性：

- **零依赖**，只用 `node:fs` / `node:path` 和内置 `fetch`；Node >= 20.11（用到 `import.meta.dirname`）。
- 每次写文件前跑**运行时结构校验**（`validateSnapshot`），校验失败直接非 0 退出，不产出坏 JSON。
- 启动时校验脚本里的 `DEPTS` 镜像与 `src/data/world.ts` 是否一致；不一致只告警。
- 坏 JSONL 行跳过并写入 `meta.warnings`；不修改任何输入文件。
- 输出稳定：Agent 按部门顺序、任务按时间倒序，便于 diff。

---

## 7. 第二阶段：让 `world.ts` 读 `snapshot.json`（建议，不实际改）

### 7.1 为什么不能只改 `useHQ`

`src/store/useHQ.ts` 只是把 `world.snapshot()` 放进 store；但以下位置**直接读 `world`**：

| 文件 | 读取内容 |
|---|---|
| `src/scene/HQScene.ts` | `world.agents`（每帧）、`world.deptLoad()`、`world.meeting` |
| `src/components/Drawer.tsx` | `world.agents`、`world.byId` |
| `src/components/Stage.tsx` | `world.deptLoad()`、`world.meeting`、`world.agents` |
| `src/components/TaskTable.tsx` | 模块加载时静态建 `AGENT_BY_ID = new Map(world.agents...)` |

所以必须把数据**写回同一个 `world` 单例**，且在 3D 场景构造之前完成。

### 7.2 `src/data/world.ts` 建议 diff

```diff
 class World {
   version = 0
   agents: Agent[] = []
   tasks: Task[] = []
   byId = new Map<string, Task>()
   events: Ev[] = []
   meeting: Meeting | null = null
+  /** true = 使用真实快照，暂停模拟 tick */
+  paused = false

+  /** 用真实 Snapshot 覆盖模拟世界；必须在 HQScene 构造前调用 */
+  applySnapshot(s: Snapshot) {
+    this.agents = s.agents.slice()
+    this.tasks = s.tasks.slice()
+    this.byId = new Map(this.tasks.map((t) => [t.id, t]))
+    this.events = s.events.slice()
+    this.meeting = s.meeting
+    this.doneCount = s.kpis.done
+    this.totalCount = s.kpis.total
+    this.tokens = s.kpis.tokens
+    this.durCnt = s.kpis.done
+    this.durSum = s.kpis.avgMin * s.kpis.done
+    this.paused = true
+    this.loadVersion = -1   // 让 deptLoad() 重算
+    this.touch()
+    this.subs.forEach((fn) => fn())
+  }

   tick() {
+    if (this.paused) return
     this.clock++
     const wall = now()
```

补充：

- `retryAgent()` 在 `paused` 时直接 `return`（否则按钮会在真实快照上“模拟”出一条假任务）。
- `forceMeeting()` / `forceError()` 在 `paused` 时禁用（或仅 `?demo` 时允许）。
- `start()` 仍可调用，`tick` 会空转，开销可忽略；也可以加 `if (this.paused) return`。

### 7.3 新增 `src/data/live.ts`

```ts
import type { Snapshot } from './types'

export async function fetchSnapshot(url = './snapshot.json'): Promise<Snapshot | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ct = res.headers.get('content-type') || ''
    // 关键：8901 静态服务器对不存在的文件会 SPA fallback 返回 index.html (text/html)
    if (!ct.includes('application/json')) throw new Error(`not json: ${ct}`)
    return (await res.json()) as Snapshot
  } catch (e) {
    console.warn('[live] snapshot 加载失败，回退模拟世界:', e)
    return null
  }
}
```

### 7.4 `src/main.tsx` 建议改法

用**动态 import App**，确保 `TaskTable` 的模块级 `AGENT_BY_ID` 在 `applySnapshot` 之后才构建：

```diff
-import React from 'react'
-import ReactDOM from 'react-dom/client'
-import App from './App'
-import './styles/ui.css'
-
-ReactDOM.createRoot(document.getElementById('root')!).render(
-  <React.StrictMode>
-    <App />
-  </React.StrictMode>
-)
+import React from 'react'
+import ReactDOM from 'react-dom/client'
+import { world } from './data/world'
+import { fetchSnapshot } from './data/live'
+import './styles/ui.css'
+
+async function boot() {
+  const snap = await fetchSnapshot()
+  if (snap) world.applySnapshot(snap)
+
+  // 动态 import：保证 App 内的 TaskTable/useHQ 在 world 被覆盖后才求值
+  const { default: App } = await import('./App')
+  ReactDOM.createRoot(document.getElementById('root')!).render(
+    <React.StrictMode>
+      <App />
+    </React.StrictMode>
+  )
+}
+
+boot()
```

### 7.5 备选：构建期内联（只适合静态快照）

如果部署时**只能发一个 `index.html`**，运行时 `fetch('./snapshot.json')` 必然失败。可改为：

```ts
// src/data/live.ts
import snapshot from '../../public/snapshot.json'
export const STATIC_SNAPSHOT = snapshot as unknown as Snapshot
```

- 优点：单文件构建产物自带数据，`vite-plugin-singlefile` 会把它打进 JS。
- 缺点：每次真实数据变化都要重新 `npm run build`；`public/` 同时被复制一份，产物里会有冗余。
- 这条路不适合“实时桥”，只适合“截图/演示快照”。

### 7.6 自动刷新（可选，第二阶段后期）

- 每 30–60s `fetchSnapshot()` + `world.applySnapshot()`。
- **前提：Agent 的 id 集合与顺序不变**。`HQScene` 在构造时按 `world.agents` 建实例网格和 `agentSlots`；
  数量/顺序变化会导致 `instanceToAgent` 与网格错位。
- Agent 集合变化时的正确做法：`scene.dispose()` 后重建 `HQScene`（需要给 `HQScene` 加公开 dispose），
  或给上游改成“固定工位池 + 动态占用”。这属于第二阶段之后的改造。

---

## 8. 已知风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | `kpis.total/done` 语义不等价 | 上游是累计总数，真实文件只有当前可见记录；数字会从 240/126 掉到 5/5 | 文档标注；若需要累计值，另建 `task-stats.json` 或在 8900 侧持久化计数 |
| 2 | `meeting` 恒 `null` | 会议室、seatIndex、会议 KPI 永远为空 | 明确标为未接；等有真实会议源再接 |
| 3 | `agents[].status` 非实时 | 任务结束后 agent 立即变 standby；无法反映“正在推理但没写回任务”的状态 | 用任务状态推导；后续可接 `/api/state` 或会话心跳 |
| 4 | 9 个真实 agent 不落位 | 场景只显示 3 个 agent，和真实 12 个不符 | `meta.unplacedAgents` 完整保留；后续给它们补真实部门映射 |
| 5 | `安全部→eng` 是近似映射 | 安全审计任务显示在研发部 | `meta.roomMapping.approximate=true` + 文档；需要精确就新增房间 |
| 6 | 所有任务已完成时 `progress=100%`、`running=0` | 画面看起来很“空”，容易被误判为没接上 | 报告里说明；这是真实状态，不是故障 |
| 7 | `tasks[].tool/progress/tokens` 为占位 | 任务表出现“未接（TODO）”、进度 0、token 0 | 明确 TODO；不要用随机值填充 |
| 8 | 单文件产物不会内联 `public/` | `dist/index.html` 单独部署时 `fetch('./snapshot.json')` 拿不到 JSON | `npm run build` 会把 `public/snapshot.json` 复制到 `dist/`；单文件部署改用 7.5 构建期内联 |
| 9 | 8901 静态服务器 SPA fallback | 请求缺失的 `/snapshot.json` 返回 `200 text/html`，`res.json()` 报错但可能被误吞 | `fetchSnapshot` 校验 `content-type`；缺失时回退模拟世界并 console.warn |
| 10 | 场景实例网格按 agent 数量构建 | 直接周期性 `applySnapshot` 且 agent 数变化会错位/崩溃 | 第二阶段只做启动时加载；刷新前比对 agent id 列表 |
| 11 | `TaskTable` 的 `AGENT_BY_ID` 是模块级常量 | 若 App 静态 import，快照覆盖后名字映射仍旧 | 用 7.4 的动态 import；或把映射改成组件内 `snap.agents` 查找 |
| 12 | 文件被并发写 | `tasks.jsonl` 由 consume-tasks 原子重命名写入，读取窗口极短；仍可能读到半行 | `readJsonl` 跳过坏行并告警；失败时保留上一次输出 |
| 13 | `metrics-history.jsonl` 可能过期 | `kpis.tokens`/agent tokens 不是“此刻” | 输出 `meta.source.metrics.ageSeconds`；需要新鲜数据用 `--live` |
| 14 | 部门表漂移 | 上游改 `DEPTS` 后脚本镜像过期 | 脚本启动时正则校验并告警；`validateSnapshot` 会拦住非法 deptId |
| 15 | `docs/index.html` 与 `dist/` 不同步 | 8901 实际服务 `dist/`（见 `.agent-hq-static-server.mjs` 的 `ROOT`） | 以 `dist/` 为准；构建后确认 `dist/snapshot.json` 存在 |

---

## 9. 第二阶段验收清单

- [ ] `node scripts/real-snapshot.js` 退出码 0，`public/snapshot.json` 通过结构校验
- [ ] `npm run build` 后 `dist/snapshot.json` 存在（Vite 复制 `public/`）
- [ ] `curl http://127.0.0.1:8901/snapshot.json` 的 `content-type` 是 `application/json`
- [ ] 页面打开后 `useHQ.getState().snap.tasks.length` 等于 JSON 里的任务数
- [ ] 3D 场景 agent 数量等于 `snap.agents.length`，无错位/空洞
- [ ] 点击 agent 能打开 Drawer，显示真实 token 与状态
- [ ] `snapshot.json` 缺失/损坏时页面仍能回退到模拟世界，不白屏
- [ ] `retryAgent` / `?meet` / `?err` 在真实模式下不会伪造数据
