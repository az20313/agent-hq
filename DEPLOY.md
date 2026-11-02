# AGENT HQ 部署文档

> 适用目录：`D:\OpenClaw\workspace\projects\agent-hq-upstream`
> 文档日期：2026-11-02（Asia/Shanghai）
> 原则：以当前工作区的实际文件与实测结果为准；没有实际执行过的步骤标「未验证」，不把报告里的结论当成自己的复验结果。

---

## 0. 速览

| 项 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/az20313/agent-hq.git` |
| 上游基线 commit | `141ce621ce1cd1fffb9e854f5b2f59e151a4b2b6`（短 `141ce62`） |
| 基线时间 / 说明 | 2026-10-29 21:40:52 +0800 / `ci: 重新触发 Pages 部署` |
| 真实数据桥 commit | `d1ce0ad59064616cf10817faaf1fac378572b5b6`（短 `d1ce0ad`） |
| 桥接时间 / 说明 | 2026-11-02 23:06:54 +0800 / `feat: real-data bridge (snapshot.json) + deploy docs` |
| 实时轮询 commit | `6652fb71298e9a004814190749eae2d013165801`（短 `6652fb7`） |
| 轮询时间 / 说明 | 2026-11-02 23:25:28 +0800 / `feat: live snapshot polling (30s, hash-diff, visibility pause)` |
| 快照脱敏 commit | `4909045dcbe27cf1cbff707ce66dfc97565e996c`（短 `4909045`） |
| 脱敏时间 / 说明 | 2026-11-02 23:32:39 +0800 / `fix: sanitize snapshot (strip paths, session keys, summaries)` |
| 推荐部署 commit | `4909045`（已包含桥接 + 轮询 + 快照脱敏） |
| 本地访问地址 | `http://127.0.0.1:8901/` |
| 静态服务脚本 | `D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs` |
| 构建命令 | `npm run build`（即 `tsc -b && vite build`） |
| 构建产物 | `dist/index.html`（单文件，当前 764,442 字节）+ `dist/snapshot.json`（当前 27,873 字节） |
| 当前快照 | 12 agents / 5 tasks / 27,873 字节（脱敏后；脱敏前 31,029 字节）；`/snapshot.json` 返回 `application/json` |
| 真实数据桥状态 | 桥接与实时轮询均已提交；当前工作区快照已更新；浏览器交互本文档未独立复验（详见第 4 节） |

提交顺序：`141ce62`（上游基线，仅模拟世界）→ `d1ce0ad`（真实数据桥）→ `6652fb7`（30s 实时轮询）→ `4909045`（快照脱敏）。

> 注意：`d1ce0ad` / `6652fb7` / `4909045` 是当前本机 `main` 上的提交，`origin/main` 仍指向 `141ce62`，尚未推送。从公开 GitHub clone 时需先推送这三个 commit；从本机仓库 clone 则可直接 checkout `4909045`。

最短路径（本机现状，产物已存在）：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
node D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs
# 浏览器打开 http://127.0.0.1:8901/
```

---

## 1. 环境要求与项目来源

### 1.1 环境要求

| 项 | 要求 | 本机实测 | 说明 |
| --- | --- | --- | --- |
| Node.js | **>= 20.11** | v24.22.1 | 下限来自 `scripts/real-snapshot.js` 使用 `import.meta.dirname`；Vite 5 本身要求 Node 18+ |
| npm | 随 Node 安装（实测 11.19.1） | 11.19.1 | `package-lock.json` 为 `lockfileVersion: 3` |
| Git | 任意较新版本 | 2.53.0.windows.1 | 用于 clone / 回滚 |
| 操作系统 | Windows（当前部署环境） | Windows 10.0.22631 x64 | 静态服务器 `ROOT` 是 Windows 绝对路径；换机器/换目录需改脚本 |
| 浏览器 | 支持 WebGL 的现代浏览器 | 未验证 | 项目是 three.js 3D 大屏，无外部资源；具体最低浏览器版本未测试 |

项目依赖（`package.json`，已核对）：`react 18.3.1`、`react-dom 18.3.1`、`three 0.169.0`、`zustand 4.5.5`；
构建依赖含 `vite 5.4.9`、`typescript 5.6.3`、`vite-plugin-singlefile 2.3.4`。实际安装解析到 vite 5.4.21、typescript 5.9.3（见 `upstream-install-report.md`）。

### 1.2 项目来源

```powershell
git clone https://github.com/az20313/agent-hq.git agent-hq-upstream
cd agent-hq-upstream
git checkout 4909045dcbe27cf1cbff707ce66dfc97565e996c
```

提交顺序（本地 `main`）：

| 顺序 | commit | 内容 |
| --- | --- | --- |
| 1 | `141ce62` | 上游基线：只有模拟世界，没有真实数据桥 |
| 2 | `d1ce0ad` | 真实数据桥：`scripts/real-snapshot.js`、`public/snapshot.json`、`src/data/live.ts`，以及 `main.tsx` / `world.ts` / `TaskTable.tsx` 的接入改动 |
| 3 | `6652fb7` | 实时轮询：30s 轮询、快照指纹去重、页面隐藏暂停（在 `d1ce0ad` 之上） |
| 4 | `4909045` | 快照脱敏：生成器集成 `sanitize-snapshot.js`，移除内部路径、session key、runId、任务摘要 |

`6652fb7` 已包含 `d1ce0ad` 的全部桥接代码；`4909045` 只在其上增加生成器脱敏，不改变前端接入。clone 后 checkout 到 `4909045`（或至少 `6652fb7`）即可得到真实数据能力，**不需要再手工复制 `src/` 文件**。

注意：

- `origin/main` 目前仍指向 `141ce62`，`d1ce0ad` / `6652fb7` / `4909045` 尚未推送。从公开 GitHub clone 只能拿到基线；需要先从本机推送这三个 commit，或直接从本机仓库 clone。
- 当前工作区在 `4909045` 之上还有一处未提交改动：`public/snapshot.json`（最新 12-agent 脱敏快照，27,873 字节）。提交版 `6652fb7` / `4909045` 自带快照仍为 15,213 字节 / 3 个落位 Agent；当前工作区快照为 27,873 字节 / 12 个 Agent（脱敏前 31,029 字节）。
- `dist/`、`node_modules/` 被 `.gitignore` 忽略，不会随仓库分发。

---

## 2. 从零部署步骤

以下命令均在 PowerShell 中执行。

### 2.1 取得上游代码

```powershell
cd D:\OpenClaw\workspace\projects
git clone https://github.com/az20313/agent-hq.git agent-hq-upstream
cd agent-hq-upstream
git checkout 4909045dcbe27cf1cbff707ce66dfc97565e996c
```

若目录已存在，`git clone` 会失败；不要覆盖现有工作区，先确认目标目录。

若从公开 GitHub clone，先确认远端已包含 `4909045`（当前 `origin/main` 仍是 `141ce62`，需要先把本机这三个 commit 推送上去）；从本机仓库 clone 则不受影响。

### 2.2 真实数据桥文件（已包含在 commit 中）

`d1ce0ad` 已提交桥接文件，`6652fb7` 已提交实时轮询，`4909045` 已提交生成器脱敏。按 2.1 checkout 到 `4909045` 后，以下文件都在仓库里，**不需要再手工复制**：

| 路径 | 作用 | 引入 commit |
| --- | --- | --- |
| `scripts/real-snapshot.js` | 生成 `snapshot.json` 的零依赖脚本（含脱敏） | `d1ce0ad` / `4909045` |
| `scripts/sanitize-snapshot.js` | 移除内部路径、session key、runId、任务摘要 | `4909045` |
| `public/snapshot.json` | 已生成的真实快照（提交版 15,213 字节） | `d1ce0ad` |
| `src/data/live.ts` | 浏览器端 fetch、结构校验与 30s 轮询 | `d1ce0ad` / `6652fb7` |
| `src/main.tsx` | 启动时加载快照，再动态挂载 App，并启动轮询 | `d1ce0ad` / `6652fb7` |
| `src/data/world.ts` | `applySnapshot()` / `paused` | `d1ce0ad` |
| `src/components/TaskTable.tsx` | 去掉模块级 `AGENT_BY_ID`，改为行内查找 | `d1ce0ad` |

如需当前工作区的 **12-agent 快照**（27,873 字节，脱敏后），只需同步一处未提交改动：

| 路径 | 说明 |
| --- | --- |
| `public/snapshot.json` | 当前 12 agents / 5 tasks 的脱敏快照（脱敏前 31,029 字节） |

从现有机器复制 `public/snapshot.json` 即可；若已提交并推送，则直接 checkout 最新 commit。

按 2.1 checkout 到 `4909045` 后，桥接代码已经就绪；不需要真实数据时跳过 2.4 的快照生成，页面会使用内置模拟世界。

### 2.3 安装依赖

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
npm ci
```

- `npm ci` 依据 `package-lock.json` 安装，会先删除现有 `node_modules`。
- **未验证**：本次环境实际执行的是 `npm install`（退出码 0，80 个包，32.1 秒，见 `install.log`）；`npm ci` 未单独跑过。
- 安装报告核对过 `package.json` 与 lockfile 根条目一致（dependencies / devDependencies 均为 `true`），但这不代表 `npm ci` 已实测。

### 2.4 生成真实快照（需要真实模式时）

```powershell
node scripts\real-snapshot.js
```

默认读取：

- `D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl`
- `D:\OpenClaw\workspace\projects\agent-hq\metrics-history.jsonl`
- `D:\OpenClaw\data\openclaw.json`、`D:\OpenClaw\data\agents\`、`D:\OpenClaw\data\state\openclaw.sqlite`（`4909045` 的生成器；只读，用于 12-agent 名单与会话运行状态）

默认输出 `public\snapshot.json`。常用参数：

```powershell
node scripts\real-snapshot.js --data-dir "D:\OpenClaw\workspace\projects\agent-hq" --out public\snapshot.json
node scripts\real-snapshot.js --live      # 先尝试 8900 /api/state，2.5s 超时后回退文件
node scripts\real-snapshot.js --help
```

脚本只读输入、只写输出文件；输出前执行 `validateSnapshot()`，结构不合法会非 0 退出且不写坏 JSON。
当前 `public/snapshot.json` 已存在（27,873 字节，文件时间 2026-11-02 23:31:13；快照 `meta.generatedAt` 为 2026-11-02 23:27:31），本次文档编写**没有重跑**生成器。脱敏前同一份数据为 31,029 字节。

注意：`6652fb7` / `4909045` 提交版自带的 `public/snapshot.json` 仍是 15,213 字节、3 个落位 Agent；要复现当前 12-agent 快照，需在 `4909045` 的生成器上重新执行，或直接使用 2.2 中列出的当前工作区快照。

### 2.5 构建

```powershell
npm run build
```

实际执行的是：

```text
tsc -b && vite build
```

- `vite.config.ts` 启用 `vite-plugin-singlefile`，JS/CSS 内联，`base: './'`。
- 当前构建产物：`dist/index.html` 764,442 字节（文件时间 2026-11-02 23:25:41）；本次文档未重跑构建，模块数与 gzip 大小未复验。
- 上游基线构建结果：66 modules，`dist/index.html` 757,706 字节，耗时约 2.73s。
- `public/` 会被原样复制到 `dist/`，所以 `public/snapshot.json` → `dist/snapshot.json`。
- **未验证**：本文档没有重新执行构建；以上来自现有 `build.log`、`REAL-DATA-BRIDGE-PHASE2-REPORT.md` 和 `dist/` 产物时间戳。

### 2.6 启动 8901 静态服务

方式一（快捷脚本）：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
.\start-8901.cmd
```

方式二（直接启动）：

```powershell
node D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs
```

服务行为（以 `.agent-hq-static-server.mjs` 为准）：

- `HOST = 127.0.0.1`，`PORT = 8901`，只监听本机回环，不对局域网开放。
- `ROOT = D:\OpenClaw\workspace\projects\agent-hq-upstream\dist`，是**硬编码绝对路径**。
- `MIME` 已包含 `.json -> application/json; charset=utf-8`。
- 文件不存在时执行 SPA fallback：返回 `200 text/html` + `dist/index.html`（这是第 6.3 节故障的根因）。
- 关闭启动窗口即停止服务；当前实测监听进程 PID 1968（会随重启变化）。

### 2.7 部署后验证

```powershell
# 首页
$r = Invoke-WebRequest http://127.0.0.1:8901/ -UseBasicParsing
"$($r.StatusCode) $($r.RawContentLength) $($r.Headers['Content-Type'])"

# 快照
$s = Invoke-WebRequest http://127.0.0.1:8901/snapshot.json -UseBasicParsing
"$($s.StatusCode) $($s.RawContentLength) $($s.Headers['Content-Type'])"
$s.Content.Substring(0, 40)
```

当前实测结果：

```text
200 764442 text/html; charset=utf-8
200 27873 application/json; charset=utf-8
{"kpis":{"total":5,"running":3,"blocked":0,"done":5,...
```

浏览器侧验收标记：

- 控制台出现 `[live] 已接入真实快照：12 agents / 5 tasks / ts=...`，或 `[live] 使用内置模拟世界`。
- 控制台出现 `[live] 轮询已启动：每 30s 检查 ./snapshot.json`；快照变化时出现 `[live] 快照更新：12 agents / 5 tasks / ts=...`。
- `<html data-source="live">` 表示真实快照生效；`data-source="mock"` 表示回退模拟世界。
- 以上浏览器行为来自阶段二报告，**本文档未独立复验（未验证）**。

### 2.8 可选：开发服务器

```powershell
npm run dev     # package.json 配置为 127.0.0.1:5273
npm run preview # 127.0.0.1:5274
```

**未验证**：本次部署没有启动 dev/preview。它们不是生产入口，部署验收以 8901 + `dist/` 为准。

---

## 3. 端口约定

| 端口 | 用途 | 状态 | 依据 |
| --- | --- | --- | --- |
| **8901** | 本地预览 / 部署验收入口，静态服务指向 `dist/` | **使用中** | `.agent-hq-static-server.mjs`；实测 `/` 与 `/snapshot.json` 均 200 |
| **8900** | 旧面板 / 历史 `/api/state` 数据源，已废弃 | **不要用于新部署** | `INTEGRATION.md` 与 `scripts/real-snapshot.js --live` 仍引用；实测当前无监听 |
| **8902** | 预留给 NAS 部署 | **仅约定，未实现** | 仓库内无 8902 相关代码或配置；未验证 |
| 5273 | Vite dev server | 可选，仅开发 | `package.json` / `vite.config.ts`；未实测 |
| 5274 | Vite preview | 可选，仅本地预览 | `package.json`；未实测 |

补充：

- 静态服务绑定 `127.0.0.1`，不是 `0.0.0.0`。需要局域网/NAS 访问时必须另行改 `HOST` 或加反向代理，属于未完成工作。
- 8900 的 `--live` 只是可选加速路径，失败会自动回退 `metrics-history.jsonl`，不影响默认部署。
- 实测：`Get-NetTCPConnection -State Listen -LocalPort 8900,8902` 返回 0 条；8901 返回 1 条。

---

## 4. 真实数据桥

### 4.1 组成

| 文件 | 角色 |
| --- | --- |
| `scripts/real-snapshot.js` | 零依赖生成器：读 `tasks.jsonl` + `metrics-history.jsonl`（当前增强版还读 `openclaw.json` / `data/agents` / `openclaw.sqlite`），写 `public/snapshot.json` |
| `public/snapshot.json` | 上游 `Snapshot` 结构 + 附加 `meta` 诊断字段 |
| `src/data/live.ts` | `fetchSnapshot()`：`cache: 'no-store'`，校验 `content-type` 与最小结构；`startLivePolling()`：30s 轮询、指纹去重、页面隐藏暂停 |
| `src/main.tsx` | `boot()`：先 `fetchSnapshot()` → `world.applySnapshot()`，再动态 import App，最后启动轮询 |
| `src/data/world.ts` | `paused` 标志、`applySnapshot()`、`tick()` 早退、演示入口禁用、`deptLoad` 覆盖 |
| `src/components/TaskTable.tsx` | 任务行改为在 `snap.agents` 中查找 agent，避免单文件构建下模块级 Map 提前求值 |

### 4.2 数据流

```text
agent-hq\tasks.jsonl ─────────────┐
                                  ├─> scripts/real-snapshot.js ─> public/snapshot.json
agent-hq\metrics-history.jsonl ───┘         （映射 / 派生 / 校验）              │
                                                                                │ npm run build 复制
                                                                                ▼
                                                                        dist/snapshot.json
                                                                                │
                                                                                │ 浏览器启动
                                                                                ▼
                                             src/main.tsx boot ─> fetchSnapshot() ─> world.applySnapshot()
                                                                                │
                                                        ┌───────────────────────┼───────────────────────┐
                                                        ▼                       ▼                       ▼
                                                    useHQ.snap             HQScene 每帧读 world     Drawer / TaskTable
```

- 真实数据只读：生成器不写 `tasks.jsonl` / `metrics-history.jsonl`，不调用 agent，不触碰 NAS。
- 浏览器启动时加载一次，之后每 30s 重新拉取 `./snapshot.json`；快照指纹不变时不重复 `applySnapshot`，页面隐藏时暂停轮询，恢复可见时立即补拉一次。

### 4.3 当前进度

| 阶段 | 状态 | 实际依据 | 验证情况 |
| --- | --- | --- | --- |
| 阶段一：生成器 + 快照 | **完成，已提交** | `scripts/real-snapshot.js`、`public/snapshot.json` 由 `d1ce0ad` 引入（提交版 15,213 字节）；当前工作区快照 27,873 字节；`INTEGRATION.md`、`REAL-DATA-BRIDGE-REPORT.md` 均存在 | 结构校验由报告记录为 OK；本文档只核对了文件与大小，**未重跑生成器** |
| 阶段二：浏览器接入 | **完成，已提交** | `src/main.tsx`、`src/data/live.ts`、`src/data/world.ts`、`src/components/TaskTable.tsx` 的接入改动在 `d1ce0ad`；`dist/index.html` 764,442 字节 | 阶段二报告自称已通过 Chrome headless 验收，但**本文档未独立复验浏览器交互，统一标记为未验证** |
| 实时轮询 | **完成，已提交** | `6652fb7` 修改 `src/data/live.ts` / `src/main.tsx`，30s 轮询、指纹去重、可见性暂停；`LIVE-REFRESH-REPORT.md` | 报告记录已验收；本文档未独立复验浏览器轮询 |
| 快照脱敏 | **完成，已提交** | `4909045` 增加 `scripts/sanitize-snapshot.js` 并接入生成器；快照从 31,029 字节降到 27,873 字节 | 本文档只核对输出大小，**未逐字段复验脱敏规则** |

当前快照的已知数字（来自 `public/snapshot.json` / `dist/snapshot.json`）：

- 5 条任务、12 个落位 Agent（9 个按部门表映射，3 个走兜底映射）、10 条派生事件、206 个会话；
- `kpis.total=5`、`done=5`、`running=3`、`blocked=0`、`tokens=15,535,235`；
- 5 条任务均为 `done`，`progress=100%`；`running=3` 来自最近仍有未完成会话运行的 Agent，不是任务未完成。

### 4.4 字段支持情况（简要）

| 字段 | 来源 | 状态 |
| --- | --- | --- |
| `tasks` / 任务状态 / 起止时间 / 部门 | `tasks.jsonl` | 能接 |
| `agents[].tokens` / `kpis.tokens` / 会话数 | `metrics-history.jsonl` | 能接（累计值，非当前快照消耗） |
| `agents[].deptId/deskIndex/heat` | 部门表 + 最近任务 | 派生，不是实时心跳 |
| `agents[].status` | 最近任务状态 + 2h 内未完成会话运行证据 | 派生；无证据回落 `idle` |
| `events` | 任务生命周期时间戳 | 派生，不是真实工具调用流 |
| `deptLoad` | `agents[]` 按部门聚合，12 房间全量（含兜底映射） | 派生 |
| `meeting` | 无真实来源 | **未接**，固定 `null` |
| `tasks[].tool` | 无来源 | **未接**，固定 `"未接（TODO）"` |
| `tasks[].progress` | 无实时进度 | **未接**，仅 `done=100`，其余 `0` |
| `tasks[].tokens` | 无逐任务 token | **未接**，固定 `0` |
| `agents[].seatIndex` | 无会议 | **未接**，固定 `null` |

`snapshot.json` 顶层还有一个 `meta` 字段（`Snapshot` 类型之外），当前包含 `source`、`counts`、`statusCounts`、`agentStats`、`deptMapping`、`unassignedAgents`、`roster`、`roomMapping`、`statusRules`、`derived`、`todo`、`warnings`。读取时可忽略，但排查数据问题时应先看它。

### 4.5 更新快照

```powershell
node scripts\real-snapshot.js
npm run build
# 刷新浏览器（Ctrl+F5）
```

原因：构建会把 `public/snapshot.json` 复制到 `dist/`，只重新生成 `public/` 不会影响 8901 正在服务的 `dist/`。

页面已启用 30s 轮询：重新构建后无需手动刷新，正常在 30s 内自动应用新快照（控制台出现 `[live] 快照更新`）。生成器本身不会自动运行；仍需要先执行 `node scripts\real-snapshot.js`（或外部定时任务），再执行 `npm run build`。

---

## 5. 回滚

### 5.1 回滚真实数据桥代码

只回滚实时轮询、保留真实数据桥：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
git revert --no-edit 6652fb7
npm run build
```

完全回滚到上游基线（撤销桥接 + 轮询）：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 1) 先备份当前工作区的快照（有未提交改动）
Copy-Item public\snapshot.json ..\snapshot-backup.json -Force

# 2) 恢复基线 src/
git checkout 141ce62 -- src

# 3) 删除桥接引入、基线中不存在的文件
Remove-Item src\data\live.ts
Remove-Item public\snapshot.json
Remove-Item scripts\real-snapshot.js
Remove-Item scripts\sanitize-snapshot.js

# 4) 重建 dist
npm run build
```

说明：

- `git revert 6652fb7` 会生成一个反向提交，保留历史，只撤销轮询；桥接代码仍在。
- `git checkout 141ce62 -- src` 会**丢弃 `src/` 下所有未提交改动**，不只是数据桥。执行前先 `git status --short` 确认没有其他在写的工作。
- 完全回滚会删除 `public/snapshot.json`、`scripts/real-snapshot.js`、`scripts/sanitize-snapshot.js`；当前工作区 `public/snapshot.json` 有未提交改动，务必先备份。
- 此时页面会回到模拟世界，`dist/snapshot.json` 在重新构建后不再存在。
- 8901 服务每次请求都从磁盘读文件，回滚后**不需要重启服务**，浏览器强制刷新即可。若服务进程本身异常，再重启。
- 构建后 `dist/index.html` 预期回到约 **757,706 字节**（基线备份值），实际大小以构建输出为准；此预期未在本文档中重新构建验证。

### 5.2 只回滚构建产物（应急）

若 `src/` 不想动，只想恢复旧页面：

```powershell
Copy-Item "D:\OpenClaw\workspace\projects\.agent-hq-backup\dist-index-1926.html" `
  "D:\OpenClaw\workspace\projects\agent-hq-upstream\dist\index.html" -Force
```

- 备份文件已确认存在，757,706 字节。
- 这会覆盖当前阶段二产物；下次 `npm run build` 会再次生成新文件。
- **不要**在未确认备份内容的情况下覆盖，属于破坏性操作，执行前需人工确认。

### 5.3 回滚后检查

```powershell
Invoke-WebRequest http://127.0.0.1:8901/ -UseBasicParsing | Select-Object StatusCode, RawContentLength
Select-String -Path dist\index.html -Pattern "AGENT HQ" -SimpleMatch
```

完全回滚后页面直接使用内置模拟世界（39 条模拟任务）。注意：此时 `main.tsx` 已恢复原版，**不会请求 snapshot，也不会写 `data-source` 或打印 `[live]` 日志**。只回滚 `6652fb7`（保留桥接）时仍会请求 snapshot，但没有 30s 轮询。阶段二报告里的 `mock` 回退验证是“保留新代码、只删 `dist/snapshot.json`”的场景，和这里的整段回滚不是一回事；该结果本文档未复验。

---

## 6. 常见故障

### 6.1 npm 安装出现 esbuild postinstall 警告

现象：

```text
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   esbuild@0.21.5 (postinstall: node install.js)
```

判断与处理：

- 这是 npm 11 的 allowScripts 策略警告，不是安装失败。`install.log` 显示 `added 80 packages`，退出码 0。
- 本机已确认 `node_modules\@esbuild\win32-x64\esbuild.exe` 存在，所以构建不受影响（`npm run build` 成功）。
- 若构建报 esbuild 相关 ENOENT / 无法启动，再执行（**未验证**）：

```powershell
npm install-scripts approve esbuild
npm rebuild esbuild
```

- 不要因为这条警告反复删除 `node_modules` 重装；先确认上面的 exe 是否存在。

### 6.2 单文件构建的边界

- `npm run build` 产出的是**单个 `dist/index.html`**（JS/CSS 全部内联），但 `public/` 下的文件（含 `snapshot.json`）是**单独复制**到 `dist/` 的，不会内联进 HTML。
- 只把 `dist/index.html` 拷到别处双击打开：页面能显示，但 `fetch('./snapshot.json')` 拿不到文件，会回退模拟世界。这是当前设计的预期行为。
- 需要真正“单文件且带真实数据”时，只能改成构建期 `import snapshot.json`（`INTEGRATION.md` 7.5 的备选方案），代价是每次数据变化都要重新构建。当前未采用该方案。
- `docs/index.html` 是 GitHub Pages 的旧单文件产物，**不是** 8901 服务的内容；不要用它判断当前部署状态。

### 6.3 `/snapshot.json` 返回 `text/html`

现象：

```text
GET http://127.0.0.1:8901/snapshot.json
200  text/html; charset=utf-8  <约 0.76 MB（当前 index.html 764,442 字节）>
```

原因：`dist/snapshot.json` 不存在，静态服务器的 SPA fallback 把 `dist/index.html` 以 200 返回。服务器对**任何**缺失路径都这样处理，不一定代表路由错误。

排查：

```powershell
Test-Path .\dist\snapshot.json
(Get-Item .\dist\snapshot.json).Length
(Invoke-WebRequest http://127.0.0.1:8901/snapshot.json -UseBasicParsing).Headers['Content-Type']
```

修复：

```powershell
node scripts\real-snapshot.js
npm run build          # 把 public\snapshot.json 复制到 dist\
# 再验证 content-type
```

不要通过修改静态服务器的 404 行为来“修复”数据问题；根因是构建产物缺文件。当前实测已恢复为 `200 application/json`、27,873 字节。

补充：`src/data/live.ts` 已校验 `content-type`，非 JSON 会 `console.warn` 并回退模拟世界，不会白屏；如果页面仍是真实模式但数据为空，优先检查 `snapshot.json` 的 `meta.warnings` 与结构校验。

### 6.4 页面显示模拟数据（Mock）

按顺序检查：

1. 控制台是否有 `[live] 真实快照加载失败，回退内置模拟世界：...`；
2. `<html>` 的 `data-source` 是否为 `mock`；
3. `dist/snapshot.json` 是否存在、是否 `application/json`；
4. `snapshot.json` 是否通过 `isSnapshot()` 最小校验（`kpis` 对象、`agents/tasks/events/deptLoad` 数组、`meeting` 为 null 或对象、`ts` 数字）；
5. 是否只重新生成了 `public/snapshot.json` 而没有 `npm run build`。

### 6.5 8901 启动失败 / 页面 404

- 端口被占用：`Get-NetTCPConnection -State Listen -LocalPort 8901`，必要时结束旧进程后重启。
- `ROOT` 是硬编码路径。项目目录被移动或换机器后，服务仍指向旧路径，表现为 404 或旧页面；需要修改 `.agent-hq-static-server.mjs` 的 `ROOT`（该文件在仓库外，修改前需人工确认）。
- 用 `Start-Process` 启动的后台进程可能随父会话被回收；本机曾改用 WMI `Win32_Process.Create` 才常驻。日常部署用 `start-8901.cmd` 前台窗口最简单。
- 服务只绑定 `127.0.0.1`，从其他机器访问会失败，这是预期行为，不是防火墙问题。

### 6.6 页面很空、没有运行中任务

当前真实快照 5 条任务全部 `done`，`progress=100%`；`running=3` 来自最近仍有未完成会话运行的 Agent，并不表示任务未完成。没有告警、没有会议仍是真实数据状态，不是桥接失败。需要演示更多任务流转时，删除 `dist/snapshot.json` 或使用无快照的构建，页面会回退模拟世界。

---

## 7. 已知限制

1. **数据仍是“半真实”**：Agent 列表来自 `openclaw.json` / `data/agents` / `metrics-history.jsonl` 与 `tasks.jsonl` 的并集；任务来自 `tasks.jsonl`；`tool`、逐任务 `progress`、逐任务 `tokens`、真实工具事件流均未接。
2. **Agent 状态是推导值**：按最近任务状态与 2h 内未完成会话运行证据推导，不是实时心跳；无证据时回落 `idle`。
3. **12 个 Agent 全部落位，但部分部门是兜底映射**：9 个按部门表直接映射，3 个（`creative-planner`、`integration-communication`、`openclaw`）落到 `ops`，部门归属可能不准确；明细在 `meta.unassignedAgents` / `meta.agentStats`。
4. **会议完全未接**：`meeting=null`、`inMeeting=0`、`seatIndex=null`，会议室永远空闲。
5. **KPI 口径不完全等价**：`kpis.total/done` 只是 `tasks.jsonl` 当前可见记录数，不是历史累计；文件被裁剪时数字会变小。
6. **`kpis.tokens` 是工作区累计 Token**，不是本快照内任务消耗；`tasks[].tokens` 恒为 0。
7. **部门映射有近似**：`安全部 → eng`（上游没有安全部房间），未知 room 兜底到 `eng`，3 个无部门 Agent 兜底到 `ops`，都会在 `meta.roomMapping` / `meta.warnings` 标注。
8. **前端会轮询，但数据生成不会自动刷新**：页面每 30s 拉一次 `snapshot.json`；生成器本身仍需手动执行或外部定时任务，生成后还要 `npm run build`（或直接写 `dist/snapshot.json`）。
9. **场景不能热更新 Agent 集合**：轮询会更新数据，但 `HQScene` 在构造时按 `world.agents` 建实例网格，Agent 数量/顺序变化仍可能错位。
10. **提交版本与当前工作区快照不一致**：`6652fb7` / `4909045` 自带 15,213 字节 / 3 个落位 Agent；当前 27,873 字节 / 12 个 Agent 的快照文件尚未提交（生成器与脱敏脚本已在 `4909045`）。
11. **构建与浏览器验收未由本文档复验**：构建数字来自现有日志/产物；浏览器真实模式、回退行为来自阶段二报告，统一视为未验证。
12. **NAS / 8902 未落地**：仓库内没有相关实现；当前服务只监听 `127.0.0.1:8901`。
13. **静态服务器无缓存控制/无 404 语义**：所有缺失路径都回退 `index.html`，排查时不能只看 HTTP 200。

---

## 8. 本次文档的验证记录

| 检查项 | 结果 | 方式 |
| --- | --- | --- |
| 提交顺序 | `141ce62`（基线）→ `d1ce0ad`（桥接）→ `6652fb7`（轮询）→ `4909045`（脱敏） | `git log --oneline` |
| 远端状态 | `origin/main` 仍为 `141ce62`；本地 `d1ce0ad` / `6652fb7` / `4909045` 未推送 | `git ls-remote origin refs/heads/main` |
| 工作区改动 | HEAD 为 `4909045`；仅 `public/snapshot.json` 有未提交改动 | `git status --porcelain` |
| 当前快照结构 | 12 agents / 5 tasks / 27,873 字节 | `node` 读取 `public/snapshot.json` |
| Node / npm | v24.22.1 / 11.19.1 | `node -v`、`npm -v` |
| 构建产物 | `dist/index.html` 764,442；`dist/snapshot.json` 27,873 | 文件属性 |
| 8901 首页 | 200，`text/html; charset=utf-8`，764,442 字节 | `Invoke-WebRequest` |
| 8901 快照 | 200，`application/json; charset=utf-8`，27,873 字节 | `Invoke-WebRequest` |
| 端口监听 | 仅 8901；8900 / 8902 无监听 | `Get-NetTCPConnection` |
| 备份文件 | `.agent-hq-backup\dist-index-1926.html` 存在，757,706 字节 | `Test-Path` / 文件属性 |
| esbuild 二进制 | `node_modules\@esbuild\win32-x64\esbuild.exe` 存在 | `Test-Path` |
| `npm ci` | **未验证**（本次用 `npm install` 验证） | — |
| `npm run build`（本次重跑） | **未验证**（引用现有日志与产物） | — |
| 浏览器真实模式 / 回退 | **未验证**（引用阶段二报告） | — |
| 浏览器 30s 轮询 | **未验证**（引用 `LIVE-REFRESH-REPORT.md`） | — |
| 5273 dev / 5274 preview | **未验证** | — |
| 8902 NAS 部署 | **未验证**，仓库无实现 | — |

---

## 9. 相关文档

- `README.md`：上游功能、交互、场景结构与性能说明。
- `INTEGRATION.md`：真实数据桥第一阶段字段映射、第二阶段建议 diff、风险与验收清单。
- `REAL-DATA-BRIDGE-REPORT.md`：第一阶段实跑结果与数据统计。
- `REAL-DATA-BRIDGE-PHASE2-REPORT.md`：第二阶段改动、构建与浏览器验收记录（本文档未复验）。
- `LIVE-REFRESH-REPORT.md`：30s 实时轮询、指纹去重与可见性暂停的验收记录（本文档未复验）。
- `upstream-install-report.md`：首次安装、构建、8901 启动与 HTTP 验证记录。
