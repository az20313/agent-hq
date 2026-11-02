# AGENT HQ 部署文档

> 适用目录：`D:\OpenClaw\workspace\projects\agent-hq-upstream`
> 文档日期：2026-11-02（Asia/Shanghai）
> 原则：以当前工作区的实际文件与实测结果为准；没有实际执行过的步骤标「未验证」，不把报告里的结论当成自己的复验结果。

---

## 0. 速览

| 项 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/zhaoxinfeng619-hub/agent-hq.git` |
| 上游 commit | `141ce621ce1cd1fffb9e854f5b2f59e151a4b2b6`（短 `141ce62`） |
| commit 时间 / 说明 | 2026-10-29 21:40:52 +0800 / `ci: 重新触发 Pages 部署` |
| 本地访问地址 | `http://127.0.0.1:8901/` |
| 静态服务脚本 | `D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs` |
| 构建命令 | `npm run build`（即 `tsc -b && vite build`） |
| 构建产物 | `dist/index.html`（单文件，当前 761,297 字节）+ `dist/snapshot.json`（当前 15,213 字节） |
| 真实数据桥状态 | 阶段一完成；阶段二进行中，**未验证**（详见第 4 节） |

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
git clone https://github.com/zhaoxinfeng619-hub/agent-hq.git agent-hq-upstream
cd agent-hq-upstream
git checkout 141ce621ce1cd1fffb9e854f5b2f59e151a4b2b6
```

上述 commit 是上游基线。**注意：当前工作区不是干净的上游。** `git status` 实测（节选，省略部分日志/报告）：

```text
 M src/components/TaskTable.tsx
 M src/data/world.ts
 M src/main.tsx
?? INTEGRATION.md
?? REAL-DATA-BRIDGE-REPORT.md
?? REAL-DATA-BRIDGE-PHASE2-REPORT.md
?? public/
?? scripts/
?? src/data/live.ts
?? start-8901.cmd
?? build.log / install.log / upstream-install-report.md
```

含义：

- 干净 clone 出来的 `141ce62` **只有模拟世界**，没有真实数据桥，也没有 `scripts/real-snapshot.js`、`public/snapshot.json`、`src/data/live.ts`。
- 真实模式所需的改动**尚未提交、未推送**，只存在于本机工作区。换机器部署时必须把这批文件一起带走（见 2.2），否则只能得到 Mock 模式。
- `dist/`、`node_modules/` 被 `.gitignore` 忽略，不会随仓库分发。

---

## 2. 从零部署步骤

以下命令均在 PowerShell 中执行。

### 2.1 取得上游代码

```powershell
cd D:\OpenClaw\workspace\projects
git clone https://github.com/zhaoxinfeng619-hub/agent-hq.git agent-hq-upstream
cd agent-hq-upstream
git checkout 141ce621ce1cd1fffb9e854f5b2f59e151a4b2b6
```

若目录已存在，`git clone` 会失败；不要覆盖现有工作区，先确认目标目录。

### 2.2 带入真实数据桥文件（需要真实模式时）

当前工作区中以下内容没有进入任何 commit（新文件未跟踪，`src/` 下三个文件是未提交修改），必须从现有机器复制或先提交到自己的仓库：

| 路径 | 作用 |
| --- | --- |
| `scripts/real-snapshot.js` | 生成 `snapshot.json` 的零依赖脚本 |
| `public/snapshot.json` | 已生成的真实快照（当前 15,213 字节） |
| `src/data/live.ts` | 浏览器端 fetch + 结构校验 |
| `src/main.tsx` | 启动时先加载快照，再动态挂载 App |
| `src/data/world.ts` | `applySnapshot()` / `paused` |
| `src/components/TaskTable.tsx` | 去掉模块级 `AGENT_BY_ID`，改为行内查找 |
| `start-8901.cmd`（可选） | 本机启动 8901 的快捷脚本 |

打包示例（未验证执行）：

```powershell
# 在现有工作区所在机器上
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
Compress-Archive -Force -DestinationPath ..\agent-hq-bridge.zip `
  scripts, public, src\data\live.ts, src\main.tsx, src\data\world.ts, src\components\TaskTable.tsx

# 在目标机器 clone 后解压覆盖
Expand-Archive -Force ..\agent-hq-bridge.zip .
```

不需要真实数据时跳过本步，页面会使用内置模拟世界。

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

默认输出 `public\snapshot.json`。常用参数：

```powershell
node scripts\real-snapshot.js --data-dir "D:\OpenClaw\workspace\projects\agent-hq" --out public\snapshot.json
node scripts\real-snapshot.js --live      # 先尝试 8900 /api/state，2.5s 超时后回退文件
node scripts\real-snapshot.js --help
```

脚本只读输入、只写输出文件；输出前执行 `validateSnapshot()`，结构不合法会非 0 退出且不写坏 JSON。
当前 `public/snapshot.json` 已存在（15,213 字节，生成时间 2026-11-02 22:42:19），本次文档编写**没有重跑**生成器。

### 2.5 构建

```powershell
npm run build
```

实际执行的是：

```text
tsc -b && vite build
```

- `vite.config.ts` 启用 `vite-plugin-singlefile`，JS/CSS 内联，`base: './'`。
- 当前阶段二构建结果：68 modules，`dist/index.html` 761,297 字节（gzip 约 209 KB），耗时约 1.92s。
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
200 761297 text/html; charset=utf-8
200 15213 application/json; charset=utf-8
{"kpis":{"total":5,"running":0,"blocked":0,"done":5,...
```

浏览器侧验收标记：

- 控制台出现 `[live] 已接入真实快照：3 agents / 5 tasks / ts=...`，或 `[live] 使用内置模拟世界`。
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
| `scripts/real-snapshot.js` | 零依赖生成器：读 `tasks.jsonl` + `metrics-history.jsonl`，写 `public/snapshot.json` |
| `public/snapshot.json` | 上游 `Snapshot` 结构 + 附加 `meta` 诊断字段 |
| `src/data/live.ts` | `fetchSnapshot()`：`cache: 'no-store'`，校验 `content-type` 与最小结构 |
| `src/main.tsx` | `boot()`：先 `fetchSnapshot()` → `world.applySnapshot()`，再动态 import App |
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
- 浏览器只在启动时加载一次；没有定时刷新。

### 4.3 当前进度

| 阶段 | 状态 | 实际依据 | 验证情况 |
| --- | --- | --- | --- |
| 阶段一：生成器 + 快照 | **完成** | `scripts/real-snapshot.js`、`public/snapshot.json`（15,213 字节）、`INTEGRATION.md`、`REAL-DATA-BRIDGE-REPORT.md` 均存在 | 结构校验由报告记录为 OK；本文档只核对了文件与大小，**未重跑生成器** |
| 阶段二：浏览器接入 | **进行中，未验证** | `src/main.tsx`、`src/data/live.ts`、`src/data/world.ts`、`src/components/TaskTable.tsx` 已有改动；`dist/index.html` 761,297 字节 | 改动未提交；阶段二报告自称已通过 Chrome headless 验收，但**本文档未独立复验浏览器交互，统一标记为未验证** |

阶段一当前快照的已知数字（来自 `REAL-DATA-BRIDGE-REPORT.md` 与 `dist/snapshot.json` 文件头）：

- 5 条任务、3 个可落位 Agent、9 个未落位 Agent、10 条派生事件、206 个会话；
- `kpis.total=5`、`done=5`、`running=0`、`blocked=0`、`tokens=15,535,235`；
- 所有任务均为 `done`，因此 `progress=100%`、画面偏空是真实状态，不是桥接故障。

### 4.4 字段支持情况（简要）

| 字段 | 来源 | 状态 |
| --- | --- | --- |
| `tasks` / 任务状态 / 起止时间 / 部门 | `tasks.jsonl` | 能接 |
| `agents[].tokens` / `kpis.tokens` / 会话数 | `metrics-history.jsonl` | 能接（累计值，非当前快照消耗） |
| `agents[].deptId/status/deskIndex/heat` | 该 Agent 最近一条任务 | 派生，不是实时心跳 |
| `events` | 任务生命周期时间戳 | 派生，不是真实工具调用流 |
| `deptLoad` | `agents[]` 按部门聚合，12 房间全量 | 派生 |
| `meeting` | 无真实来源 | **未接**，固定 `null` |
| `tasks[].tool` | 无来源 | **未接**，固定 `"未接（TODO）"` |
| `tasks[].progress` | 无实时进度 | **未接**，仅 `done=100`，其余 `0` |
| `tasks[].tokens` | 无逐任务 token | **未接**，固定 `0` |
| `agents[].seatIndex` | 无会议 | **未接**，固定 `null` |

`snapshot.json` 顶层还有一个 `meta` 字段（`Snapshot` 类型之外），包含 `source`、`counts`、`agentStats`、`unplacedAgents`、`roomMapping`、`derived`、`todo`、`warnings`。读取时可忽略，但排查数据问题时应先看它。

### 4.5 更新快照

```powershell
node scripts\real-snapshot.js
npm run build
# 刷新浏览器（Ctrl+F5）
```

原因：构建会把 `public/snapshot.json` 复制到 `dist/`，只重新生成 `public/` 不会影响 8901 正在服务的 `dist/`。
当前没有自动刷新；页面不重启不会重新 fetch。

---

## 5. 回滚

### 5.1 回滚真实数据桥代码

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 1) 丢弃 3 个已跟踪文件的改动（world.ts / main.tsx / TaskTable.tsx）
git checkout -- src/

# 2) 删除未跟踪的新文件（git checkout 不会删除它）
Remove-Item src\data\live.ts

# 3) 重建 dist
npm run build
```

说明：

- `git checkout -- src/` 会**丢弃 `src/` 下所有未提交改动**，不只是数据桥。执行前先 `git status --short` 确认没有其他在写的工作。
- `src/data/live.ts` 是未跟踪文件，必须单独删除；保留它不会报错（回滚后的 `main.tsx` 不再 import），但会留下死代码。
- `public/snapshot.json` 与 `scripts/real-snapshot.js` 不受 `git checkout -- src/` 影响；重新构建时仍会被复制到 `dist/`。此时页面会回到模拟世界，但 `dist/snapshot.json` 仍可通过 HTTP 访问。
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

回滚后页面直接使用内置模拟世界（39 条模拟任务）。注意：此时 `main.tsx` 已恢复原版，**不会请求 snapshot，也不会写 `data-source` 或打印 `[live]` 日志**。阶段二报告里的 `mock` 回退验证是“保留新代码、只删 `dist/snapshot.json`”的场景，和这里的整段回滚不是一回事；该结果本文档未复验。

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
200  text/html; charset=utf-8  <约 0.76 MB（当前 index.html 761,297 字节）>
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

不要通过修改静态服务器的 404 行为来“修复”数据问题；根因是构建产物缺文件。当前实测已恢复为 `200 application/json`、15,213 字节。

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

当前真实快照 5 条任务全部 `done`，所以 `running=0`、`progress=100%`、没有告警、没有会议。这是真实数据状态，不是桥接失败。需要演示效果时，删除 `dist/snapshot.json` 或使用无快照的构建，页面会回退模拟世界。

---

## 7. 已知限制

1. **数据仍是“半真实”**：Agent 列表来自 `metrics-history.jsonl`（会话/Token）与 `tasks.jsonl` 的并集；任务来自 `tasks.jsonl`；`tool`、逐任务 `progress`、逐任务 `tokens`、真实工具事件流均未接。
2. **Agent 状态是推导值**：按“最近一条任务”的 state 推导，不是实时心跳。任务一结束就变 `standby`，无法反映“正在推理但尚未写回任务”的状态。
3. **只有 3 个 Agent 落位**：当前 12 个真实 Agent 中 9 个没有任务、无法确定部门，只保留在 `meta.unplacedAgents` / `meta.agentStats`，场景里看不到。
4. **会议完全未接**：`meeting=null`、`inMeeting=0`、`seatIndex=null`，会议室永远空闲。
5. **KPI 口径不完全等价**：`kpis.total/done` 只是 `tasks.jsonl` 当前可见记录数，不是历史累计；文件被裁剪时数字会变小。
6. **`kpis.tokens` 是工作区累计 Token**，不是本快照内任务消耗；`tasks[].tokens` 恒为 0。
7. **部门映射有近似**：`安全部 → eng`（上游没有安全部房间），未知 room 兜底到 `eng`，两者都会在 `meta.roomMapping` / `meta.warnings` 标注。
8. **没有自动刷新**：只在页面启动时加载一次；更新数据必须重新生成快照、重新构建、刷新页面。
9. **场景不能热更新 Agent 集合**：`HQScene` 在构造时按 `world.agents` 建实例网格，数量/顺序变化会错位；当前只做启动时加载。
10. **阶段二改动未提交**：`src/` 的 3 个修改和 `live.ts` 等都是工作区文件，干净 clone 无法复现真实模式。
11. **构建与浏览器验收未由本文档复验**：构建数字来自现有日志/产物；浏览器真实模式、回退行为来自阶段二报告，统一视为未验证。
12. **NAS / 8902 未落地**：仓库内没有相关实现；当前服务只监听 `127.0.0.1:8901`。
13. **静态服务器无缓存控制/无 404 语义**：所有缺失路径都回退 `index.html`，排查时不能只看 HTTP 200。

---

## 8. 本次文档的验证记录

| 检查项 | 结果 | 方式 |
| --- | --- | --- |
| 上游 commit / 时间 / 说明 | `141ce62` / 2026-10-29 21:40:52 +0800 / `ci: 重新触发 Pages 部署` | `git log -1` |
| 工作区改动 | 3 个 `src/` 文件修改，桥接文件未跟踪 | `git status --porcelain` |
| Node / npm | v24.22.1 / 11.19.1 | `node -v`、`npm -v` |
| 构建产物 | `dist/index.html` 761,297；`dist/snapshot.json` 15,213 | 文件属性 |
| 8901 首页 | 200，`text/html; charset=utf-8`，761,297 字节 | `Invoke-WebRequest` |
| 8901 快照 | 200，`application/json; charset=utf-8`，15,213 字节 | `Invoke-WebRequest` |
| 端口监听 | 仅 8901；8900 / 8902 无监听 | `Get-NetTCPConnection` |
| 备份文件 | `.agent-hq-backup\dist-index-1926.html` 存在，757,706 字节 | `Test-Path` / 文件属性 |
| esbuild 二进制 | `node_modules\@esbuild\win32-x64\esbuild.exe` 存在 | `Test-Path` |
| `npm ci` | **未验证**（本次用 `npm install` 验证） | — |
| `npm run build`（本次重跑） | **未验证**（引用现有日志与产物） | — |
| 浏览器真实模式 / 回退 | **未验证**（引用阶段二报告） | — |
| 5273 dev / 5274 preview | **未验证** | — |
| 8902 NAS 部署 | **未验证**，仓库无实现 | — |

---

## 9. 相关文档

- `README.md`：上游功能、交互、场景结构与性能说明。
- `INTEGRATION.md`：真实数据桥第一阶段字段映射、第二阶段建议 diff、风险与验收清单。
- `REAL-DATA-BRIDGE-REPORT.md`：第一阶段实跑结果与数据统计。
- `REAL-DATA-BRIDGE-PHASE2-REPORT.md`：第二阶段改动、构建与浏览器验收记录（本文档未复验）。
- `upstream-install-report.md`：首次安装、构建、8901 启动与 HTTP 验证记录。
