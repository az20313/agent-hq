# AGENT HQ 运维手册（OPERATIONS）

> 适用目录：`D:\OpenClaw\workspace\projects\agent-hq-upstream`
> 文档日期：2026-11-02（Asia/Shanghai）
> 口径：以当前目录的实际文件、实际进程和实测结果为准。没执行过的操作标“未验证”；代码里没有的功能不写成已实现。

---

## 0. 环境与入口

> 这个仓库正被多个任务同时改动，**不要依赖文档里的文件大小、时间、PID**；每次操作前用本节命令现查。下面只列稳定信息。

| 项 | 值 |
| --- | --- |
| Git HEAD | `d1ce0ad feat: real-data bridge (snapshot.json) + deploy docs`（2026-11-02 23:06:54 +0800） |
| 工作树 | `src/data/live.ts`、`src/main.tsx` 有**未提交的轮询改动**；`public/snapshot.json`、`scripts/real-snapshot.js` 也有未提交修改 |
| 访问地址 | `http://127.0.0.1:8901/`（仅本机回环） |
| 静态服务脚本 | `D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs`，`ROOT` 硬编码为 `D:\OpenClaw\workspace\projects\agent-hq-upstream\dist` |
| 端口 | 8901 使用中；8900 已废弃；8902 预留给 NAS，当前未起来 |
| NAS 总线 | `\\192.168.1.55\docker\pc-link\`（`pc-outbox.jsonl` / `nas-outbox.jsonl`） |

现查当前状态：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

Get-Item dist\index.html,dist\snapshot.json,public\snapshot.json |
  Select-Object Name,Length,LastWriteTime

$s = Invoke-RestMethod http://127.0.0.1:8901/snapshot.json
"ts=$($s.ts) agents=$($s.agents.Count) tasks=$($s.tasks.Count) generatedAt=$($s.meta.generatedAt)"

# 当前构建是否包含轮询（True 才是新 bundle）
(Get-Content dist\index.html -Raw).Contains('__HQ_POLL_MS')

# 服务 PID
Get-NetTCPConnection -State Listen -LocalPort 8901 |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

**最需要注意的一条：页面轮询只读 `dist/snapshot.json`。如果只更新了 `public/` 而没有构建/复制，页面会一直停在旧快照。**

---

## 1. 日常操作

### 1.1 标准刷新流程（推荐）

在 PowerShell 中执行：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 1) 读取 tasks.jsonl / metrics-history.jsonl，生成 public/snapshot.json
node scripts\real-snapshot.js
if ($LASTEXITCODE -ne 0) { throw "快照生成失败，先看上面的校验/警告输出" }

# 2) 构建：tsc + vite，并把 public/snapshot.json 复制到 dist/
npm run build
if ($LASTEXITCODE -ne 0) { throw "构建失败，dist 不会被更新" }

# 3) 刷新页面加载新 bundle；之后数据变化由 30 秒轮询自动接管
```

预期输出（样例；字节数/任务数随数据变化）：

```text
[real-snapshot] 输出: D:\OpenClaw\workspace\projects\agent-hq-upstream\public\snapshot.json
[real-snapshot] 大小: <本次字节数> bytes
[real-snapshot] agents=12/12 tasks=5 events=10 unassigned=3 tableMapped=9 sessions=206
[real-snapshot] 状态: idle=7 running=5 blocked=0 error=0
[real-snapshot] kpis: total=5 done=5 running=5 blocked=0 progress=100.0% tokens=<累计值>
[real-snapshot] metrics 来源=metrics-history.jsonl 数据年龄=<秒>
[real-snapshot] 结构校验: OK
```

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 生成并通过 `validateSnapshot` 结构校验（允许有 warning） |
| `1` | 运行失败或结构校验不通过（不会写出坏 JSON） |
| `2` | 参数错误（如 `--watch` 非数字） |

### 1.2 只更新数据、不重新构建（快速路径）

如果只改了数据源，没有改 `src/`，可以绕过 `npm run build`，直接把快照写到服务目录：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
node scripts\real-snapshot.js --out dist\snapshot.json
```

- 生成器用“同目录 tmp + rename”原子替换，页面不会读到半个 JSON；这是本机 NTFS 路径下的行为（见 4.5，SMB 上不成立）。
- `--out` 参数已实测可用（本文用临时文件验证，exit 0；当时输出 30,190 B，字节数随数据变化）；**直接写 `dist\snapshot.json` 这一条没有在本文执行**，机制相同。
- 写完后页面轮询会在最多 30 秒内发现文件变化并自动应用（按代码逻辑；浏览器端未独立实测）；不需要重启服务，也不需要手动刷新（前提是当前 bundle 含轮询）。
- **坑**：这条路径只更新 `dist/`，不会更新 `public/`。之后再跑 `npm run build`，Vite 会用较旧的 `public/snapshot.json` 覆盖 `dist/snapshot.json`，数据会“倒退”。所以要么同时更新 `public/`，要么以后只走 1.1。

### 1.3 是否需要重建 / 重启

| 变更内容 | 需要 `npm run build` | 需要重启 8901 | 页面操作 |
| --- | --- | --- | --- |
| 只更新 `tasks.jsonl` / `metrics-history.jsonl` | 否（用 1.2 直接写 `dist`）或 是（走 1.1） | **否** | 已打开页面在下一个 30 秒轮询自动更新；也可 F5 |
| 改了 `src/**`（含 `live.ts`、`world.ts`） | **是** | 否 | 先 Ctrl+F5 加载新 bundle；之后数据变化由 30 秒轮询接管 |
| 改了 `scripts/real-snapshot.js` | 否（只影响下一次生成） | 否 | 下次生成 + 最多 30 秒自动更新 |
| 改了 `.agent-hq-static-server.mjs` | 否 | **是** | F5 |
| 改了 `HOST` / `PORT` / `ROOT` | 否 | **是** | 换地址访问 |
| `dist/` 被删除或损坏 | **是** | 否 | Ctrl+F5 |

原因：

- 静态服务器对每个请求执行 `fs.readFile`，不会把文件缓存进内存。替换 `dist/index.html` 或 `dist/snapshot.json` 后，下一次请求就会读到新内容，**不需要重启服务**（本次未改 `dist` 做重启对照实验，结论来自代码）。
- 当前 `dist/index.html` 已包含轮询（可用第 0 节的 `__HQ_POLL_MS` 检查）：页面启动后每 30 秒请求一次 `./snapshot.json`，内容指纹变化才应用。**数据文件更新后最多 30 秒自动生效**；没有轮询的旧 bundle 仍需手动刷新。
- 轮询的浏览器运行行为（30 秒网络请求、隐藏暂停、恢复补拉）**未独立实测**；依据是代码、`LIVE-REFRESH-REPORT.md` 的 Node 侧测试和构建产物。

### 1.4 刷新后确认是否真的生效

轮询读的是 **`dist/snapshot.json`**，不是 `public/snapshot.json`，也不是 `tasks.jsonl`。只重新生成 `public/` 而不构建/复制，在下一次构建/复制前页面看不到新数据。

本次巡检期间就出现过这种情况：23:24 时 `public/snapshot.json` 已是 31,029 B，而 `dist/snapshot.json` 还是 30,190 B；页面轮询一直拿到旧文件，不会自动变。后来后台任务在 23:30 把两者重建为同一版（18,554 B）才同步。

检查命令：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
Get-Item public\snapshot.json,dist\snapshot.json | Select Name,Length,LastWriteTime

$s = Invoke-RestMethod http://127.0.0.1:8901/snapshot.json
"served ts=$($s.ts) agents=$($s.agents.Count) tasks=$($s.tasks.Count)"
```

判断与处理：

| 发现 | 含义 | 处理 |
| --- | --- | --- |
| `public` 比 `dist` 新 | 只生成了快照，没有构建/复制 | `npm run build`，或 `--out dist\snapshot.json` |
| `dist` 已更新，30 秒后页面仍旧 | 页面 bundle 不含轮询，或浏览器标签页被隐藏（轮询暂停） | 看控制台是否有 `[live] 轮询已启动`；没有就重建并 Ctrl+F5；隐藏页恢复可见会立即补拉 |
| `dist` 和 `public` 一样、`ts` 也新 | 数据已生效 | 看控制台 `[live] 快照更新：...` |
| `dist` 文件很久没变、`metrics` 也停在旧时间 | 源头停了 | 修采集器，不是重启 8901 |

`smoke-8901.js` 只检查 content-type/大小/结构，**不检查数据新旧**；旧快照同样会 7/7 PASS，不能拿它证明数据已刷新。

### 1.5 文件级定时刷新（`--watch`）

```powershell
node scripts\real-snapshot.js --watch 60 --out dist\snapshot.json
```

- 每 60 秒重新生成一次；Ctrl+C 停止。
- 已由 `scripts/test-real-snapshot.js` 实测：12 秒 / 5 秒间隔内生成 3 次，`parseErrors=0`、`missingReads=0`，最终 `agents=12`。
- 配合当前页面轮询：`--out dist\snapshot.json` 时，文件更新后最多 30 秒自动上屏，无需手动刷新（前提是浏览器加载的是含轮询的 bundle）。
- 如果 `--watch` 只写 `public/`，页面不会更新；必须写到 `dist/` 或另行构建。
- 不要同时开两个 `--watch` 或一个 `--watch` 加一次手工生成写同一个文件：没有跨进程锁，虽然原子 rename 能避免半文件，但写入顺序不可控。

---

## 2. 端口与服务

### 2.1 端口约定

| 端口 | 用途 | 状态（实测） | 说明 |
| --- | --- | --- | --- |
| **8901** | 本地部署 / 验收入口，静态服务指向 `dist/` | **使用中**，`127.0.0.1:8901` LISTENING | 只绑回环，局域网不可访问 |
| **8900** | 旧面板 / `--live` 可选数据源 | **已废弃**，当前无监听 | 不要用于新部署；`--live` 失败会自动回退文件 |
| **8902** | 预留 NAS 部署 | **未起来**，连接被拒绝 | NAS 在线、SMB 正常，但端口无监听 |
| 5273 | Vite dev server | 未启动 | 仅开发用，不是生产入口 |
| 5274 | Vite preview | 未启动 | 仅本地预览 |

补充：

- 8900 只作为 `node scripts\real-snapshot.js --live` 的加速路径：先请求 `http://127.0.0.1:8900/api/state`，2.5 秒超时，失败回退 `metrics-history.jsonl`。不要为了 `--live` 去启动 8900。
- 8902 在本仓库里没有任何启动代码或配置；仓库内也没有 NAS 部署脚本。NAS 侧目录、构建、静态服务都是独立工作，**未验证**。

### 2.2 8901 启动

前台（最简单，关窗口即停）：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
.\start-8901.cmd
```

等价于：

```powershell
node D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs
```

后台（带日志）：

```powershell
Start-Process -FilePath "node" `
  -ArgumentList "D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs" `
  -WorkingDirectory "D:\OpenClaw\workspace\projects\agent-hq-upstream" `
  -RedirectStandardOutput "D:\OpenClaw\workspace\projects\agent-hq-static-server.log" `
  -RedirectStandardError  "D:\OpenClaw\workspace\projects\agent-hq-static-server.log.err"
```

注意：

- `Start-Process` 启动的子进程可能随父 PowerShell 会话结束被回收（DEPLOY.md 有记录）。当前实例的父进程是 `WmiPrvSE.exe`，符合用 WMI `Win32_Process.Create` 拉起的特征（推断，未查启动脚本）；这种方式不依赖当前终端，但本次没有复验。
- 重定向会覆盖同名日志文件，历史日志先自行备份。
- 不要用 `npm run dev` 代替 8901 做验收：dev server 不服务 `dist/`，端口也不同。

### 2.3 查看状态

```powershell
# 谁在监听
Get-NetTCPConnection -State Listen -LocalPort 8901 |
  Select-Object LocalAddress,LocalPort,OwningProcess

# 确认 PID 对应的确实是静态服务，避免 PID 复用误杀
$p = (Get-NetTCPConnection -State Listen -LocalPort 8901).OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$p" |
  Select-Object ProcessId,CreationDate,CommandLine

# HTTP 健康检查
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" http://127.0.0.1:8901/
curl.exe -s -o NUL -w "%{http_code} %{content_type}`n" http://127.0.0.1:8901/snapshot.json
```

期望：

```text
127.0.0.1  8901  <PID>
200 text/html; charset=utf-8
200 application/json; charset=utf-8
```

### 2.4 停止 / 重启

```powershell
# 停止（先确认 PID 命令行，见 2.3）
$p = (Get-NetTCPConnection -State Listen -LocalPort 8901 -ErrorAction SilentlyContinue).OwningProcess
if ($p) { Stop-Process -Id $p -Force }

# 等端口释放
Start-Sleep -Milliseconds 500
Get-NetTCPConnection -State Listen -LocalPort 8901 -ErrorAction SilentlyContinue

# 重新启动（前台）
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
.\start-8901.cmd
```

本次文档没有执行停止/重启，避免中断正在使用的 8901；命令按当前脚本与进程行为编写。

### 2.5 8902（NAS）

现状：

```text
http://192.168.1.55:8902/  -> 连接被拒绝（connection refused）
Test-NetConnection 192.168.1.55 -Port 8902 -> False
\\192.168.1.55\docker\pc-link -> 可访问（SMB 正常）
nas-outbox.jsonl -> 无【部署】回执，最后一条 16:39:39
```

探测命令：

```powershell
Test-NetConnection 192.168.1.55 -Port 8902 -InformationLevel Quiet
curl.exe -s -o NUL -w "%{http_code}`n" http://192.168.1.55:8902/
Test-Path "\\192.168.1.55\docker\pc-link"
```

判断顺序：SMB 可访问但 8902 refused，说明 NAS 在线、共享正常、**静态服务未启动或构建未完成**，不是本机网络问题。NAS 侧建议目录 `/volume1/docker/agent-hq` 只是任务书建议，**未创建、未验证**。

---

## 3. 数据链

### 3.1 全链路

```text
D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl ─────────┐
                                                              ├─> scripts\real-snapshot.js
D:\OpenClaw\workspace\projects\agent-hq\metrics-history.jsonl ┘        │
                                                                        ├─ 结构校验
                                                                        ▼
                                                          public\snapshot.json
                                                                        │
                                                     npm run build（Vite 复制 public）
                                                                        ▼
                                                             dist\snapshot.json
                                                                        │
                                          浏览器 boot：fetch('./snapshot.json')
                                                                        │
                                              world.applySnapshot() → 3D 场景 / 表格 / Drawer
```

渲染完成后 `startLivePolling()` 每 30 秒重复 `fetch('./snapshot.json')`；只有内容指纹变化时才再次 `applySnapshot()`（详见 3.5）。

生成器还只读两个来源（失败不影响主链路）：

| 来源 | 用途 |
| --- | --- |
| `D:\OpenClaw\data\openclaw.json` | agent 名单 / 显示名（`agents.entries`） |
| `D:\OpenClaw\data\state\openclaw.sqlite` | 未完成 run 的会话证据（只读） |

### 3.2 输入文件

| 文件 | 当前状态 | 作用 |
| --- | --- | --- |
| `agent-hq\tasks.jsonl` | 5 条，2,237 B，22:15:39 | 任务正文、状态、agent、部门、起止时间、回复 |
| `agent-hq\metrics-history.jsonl` | 145 条，113,647 B，22:32:27 | `totalSessions` / `totalTokens` / 每 agent 的 sessions+tokens；生成器取 `ts` 最大的一条 |

`tasks.jsonl` 单行示例（真实记录）：

```json
{"id":"mvz36jnrqfu1","room":"技术部","agent":"worker2","priority":"high","deadline":"今天 20:00","text":"验证派活链路：把面板上的任务接到实际执行","ts":1793613522951,"state":"done","startedAt":1793614082434,"finishedAt":1793614160084,"reply":"链路通了：..."}
```

注意：`tasks.jsonl` 里没有 `tool`、逐任务 `progress`、逐任务 `tokens`；这些字段在快照里固定为“未接（TODO）/0”，`meta.todo` 有完整清单。不要用随机值填充。

### 3.3 生成器行为

- 零依赖，只用 Node 内置模块；要求 Node >= 20.11（`import.meta.dirname`）。
- 默认读 `D:\OpenClaw\workspace\projects\agent-hq`，默认写 `<repo>\public\snapshot.json`。
- 坏 JSONL 行跳过并记入 `meta.warnings`；输入文件只读，不修改。
- 写文件前跑 `validateSnapshot`；失败直接非 0 退出，不产生坏文件。
- 本地写入是“同目录 `.snapshot.json.tmp-<pid>` + rename”，带 Windows 占用重试；最后退化为“先删再改名”。
- `meta.generatedAt` 取 `metrics/tasks/会话事件` 的最大时间（数据截止时间），不是脚本运行墙钟；`meta.source.metrics.ageSeconds` 已从输出中移除。这两个选择都是为了让页面轮询的指纹稳定，重复生成同一批数据不会触发重绘。
- 输出前经 `scripts/sanitize-snapshot.js` 脱敏：递归删除 `path` / `workspace` / `runId` / `sessionKey` / `statusReason` / `sourcePath` / `dataDir`，并把 `tasks[].summary` 清空。排查内部路径/runId 要看源文件或生成器输出，快照里没有。
- 启动时用正则对比脚本内镜像的 `DEPTS` 与 `src/data/world.ts`，不一致只告警，不阻断。

常用参数：

```powershell
node scripts\real-snapshot.js --help
node scripts\real-snapshot.js --data-dir "D:\OpenClaw\workspace\projects\agent-hq"
node scripts\real-snapshot.js --out dist\snapshot.json
node scripts\real-snapshot.js --live          # 先试 8900，2.5s 超时后回退
node scripts\real-snapshot.js --quiet
node scripts\real-snapshot.js --watch 60
```

### 3.4 服务路径

- 静态服务器 `ROOT` 硬编码为 `D:\OpenClaw\workspace\projects\agent-hq-upstream\dist`。
- `/snapshot.json` 由 `MIME[".json"]` 返回 `application/json; charset=utf-8`；所有响应带 `Cache-Control: no-store`。
- `public/snapshot.json` **不会**被内联进 `dist/index.html`。单文件 HTML 是 JS/CSS 内联，JSON 仍是旁边的独立文件；只拷 `index.html` 到别处会回退模拟世界。

### 3.5 轮询 / 自动刷新（已实现，改动未提交）

当前工作树的 `src/data/live.ts` + `src/main.tsx` 已加入轮询；当前 `dist/index.html` 实测包含轮询代码（HTML 内有 `__HQ_POLL_MS` 和“轮询已启动”，检查命令见第 0 节）。**注意：这批改动尚未 commit，换机器或 `git checkout` 后会丢失。**

机制（以当前代码为准）：

| 环节 | 行为 |
| --- | --- |
| 启动 | `boot()` 先 `fetchSnapshot()` → `applySnapshot()` → 渲染 App |
| 启动轮询 | 渲染后 `startLivePolling({ initialSnapshot, immediate: false, onSnapshot })`，避免立刻重复请求 |
| 间隔 | 默认 30,000 ms；递归 `setTimeout`，请求结束才排下一次，不会重叠 |
| 单次请求 | `fetchSnapshot(url, { quiet: true })`：检查 `res.ok`、`content-type` 含 `application/json`、`isSnapshot` 结构 |
| 变化判定 | `snapshotSignature()`：对象键排序后稳定序列化，再用 cyrb53 哈希；**顶层 `ts` 不参与** |
| 无变化 | 只累加 `unchanged`，不调用 `onSnapshot`，不重绘 |
| 有变化 | `world.applySnapshot()` + `useHQ.setState({ snap })` + `dataSource='live'`，控制台打印 `[live] 快照更新：...` |
| 页面隐藏 | `document.hidden` 时清掉定时器，不发请求 |
| 恢复可见 | `visibilitychange` 立即补拉一次，然后重新按 30 秒排程 |
| 请求失败 | 保留旧数据，继续下一轮；`console.warn` 全局 5 分钟限流一次 |
| 调试配置 | `window.__HQ_POLL_MS`（毫秒，>=1000）覆盖间隔；导出 `startLivePolling` / `stopLivePolling` / `getLiveStats` |

启动首拉失败时页面先回退 mock，但轮询仍会每 30 秒重试；`/snapshot.json` 恢复后会自动切回 `data-source=live`。

因此：

| 场景 | 结果 |
| --- | --- |
| 更新 `dist/snapshot.json` | 已打开页面在**最多 30 秒**内自动更新（页面可见时） |
| 只更新 `public/snapshot.json` | **永远不会自动更新**，因为页面只请求 `dist/` |
| 页面标签隐藏 | 轮询暂停；切回前台立即补拉一次 |
| 浏览器加载的是旧 bundle（无轮询） | 不会自动更新，必须 Ctrl+F5；判断方法见 6.4 |
| `--watch` 持续写 `dist/snapshot.json` | 每轮生成后最多 30 秒上屏；数据没变时指纹相同，不会重复 apply |

限制与风险：

- **轮询 apply 的是整份快照**。`HQScene` 在构造时按 `world.agents` 建实例网格；如果新快照的 agent 数量/顺序变化，可能出现错位或空洞。`INTEGRATION.md` 风险 #10 已记录，当前代码**没有** agent 集合变化保护，本次也未复验。需要改数据源 agent 数量时，先刷新页面而不是依赖热更新。
- 指纹只排除顶层 `ts`。当前 `real-snapshot.js` 特意把 `meta.generatedAt` 设为“数据截止时间”，并不把墙钟 `ageSeconds` 放进快照，所以同一批数据重复生成时指纹稳定（实测两次生成间隔 2 秒，去掉 `ts` 后完全相等）。如果以后往快照里加墙钟字段，会退化成每 30 秒 apply 一次。
- 浏览器运行时未独立实测：`LIVE-REFRESH-REPORT.md` 记录 Node 侧 22 项行为测试全部通过、`npm run build` 通过；本文只确认了构建产物包含轮询代码。首次上线后建议观察控制台 2–3 个轮询周期。

`README-bridge.md` 里“面板每 3 秒轮询一次”指的是 **8900 旧面板**，与本页面的 30 秒轮询是两套机制。

### 3.6 数据新鲜度看哪里

```powershell
$s = Invoke-RestMethod http://127.0.0.1:8901/snapshot.json
$s.ts                                   # 快照生成时间（ms）
$s.meta.generatedAt                     # 数据截止时间（不是脚本运行时间）
$s.meta.source.tasks.mtime              # tasks.jsonl 最后修改
$s.meta.source.metrics.latestAt         # metrics 最新一条时间
$s.meta.counts                          # agents/tasks/done/events 计数
$s.meta.warnings                        # 坏行、近似部门映射等
```

判断：

- **`ageSeconds` 已从快照里移除**（当前生成器把它设为 `undefined`，避免轮询误判）。数据年龄看生成器 stdout 的 `[real-snapshot] metrics 来源=... 数据年龄=<秒>s`，或用 `latestAt` 与当前时间相减。
- 数据年龄 < 120 秒：metrics 基本新鲜（采集器按 60 秒追加时）。
- 数据年龄上千秒：**源头停了**，不是桥接坏了；页面上的 token/会话数会停在旧值。
- `generatedAt` 是“数据截止时间”，不是脚本运行时间；不要拿它判断本次是否执行过生成。
- `meta.source.metrics.source` 为 `live-api` 或 `metrics-history.jsonl`，可确认 `--live` 是否生效。

---

## 4. NAS 总线（SMB 消息队列）

### 4.1 位置

| 侧 | 路径 |
| --- | --- |
| Windows 主机 | `\\192.168.1.55\docker\pc-link\` |
| NAS | `/volume1/docker/pc-link/` |

两个 JSONL 文件，**只追加，不覆盖**：

| 文件 | 写入方 | 读取方 | 用途 |
| --- | --- | --- | --- |
| `pc-outbox.jsonl` | 主机面板 / 本机 agent | NAS 龙虾 | 主机 → NAS 的消息、任务、催办 |
| `nas-outbox.jsonl` | NAS 龙虾 | 主机面板 | NAS → 主机的回执、进度、告警 |

### 4.2 单行格式

```json
{"channel":"pm-nas","from":"NAS-项目经理","text":"通道测试：NAS 侧已接入总线","ts":1793606491643}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `channel` | 是 | `bridge.sh send` 只接受 `pm-nas` / `local-team` / `nas-team` / `all`；实际 `pc-outbox.jsonl` 里也出现过 `master`（面板内部频道），不要用 `bridge.sh` 发 `master` |
| `from` | 是 | 显示名，如 `项目经理（本机）`、`NAS-项目经理` |
| `text` | 是 | 单行正文；不要含裸换行（会被压成空格或转义） |
| `ts` | 是 | 毫秒时间戳，如 `1793631965823` |
| `id` | 否 | 不填时按 `channel` + `ts` + `text 前 24 字符` 去重；填了必须唯一 |

### 4.3 追加消息（Windows 侧）

```powershell
$bus = '\\192.168.1.55\docker\pc-link\pc-outbox.jsonl'

# 1) 前置检查：文件存在、非空、最后一行以 LF 结尾，避免拼到半行
if (-not (Test-Path -LiteralPath $bus)) { throw "总线文件不存在：$bus" }
$bytes = [System.IO.File]::ReadAllBytes($bus)
if ($bytes.Length -gt 0 -and $bytes[-1] -ne 10) {
  throw "最后一行没有换行符，先人工检查，禁止直接追加"
}

# 2) 构造单行 JSON（中文按 UTF-8 写入）
$msg = [ordered]@{
  channel = 'pm-nas'
  from    = '项目经理（本机）'
  text    = '【跟进】请回报 8902 部署进度'
  ts      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
$line = ($msg | ConvertTo-Json -Compress)

# 3) 追加
Add-Content -LiteralPath $bus -Value $line -Encoding utf8

# 4) 回读校验
$last = Get-Content -LiteralPath $bus -Tail 1
$last | ConvertFrom-Json | Format-List
```

规则：

1. **只用追加**（`Add-Content` / `>>`），绝不用 `Set-Content` 覆盖。
2. 追加前确认最后字节是 `0x0A`；现有两个文件都满足（最后字节实测 10）。
3. 一条消息必须是一行；正文不要手工拼 `"` 和换行，交给 `ConvertTo-Json`。
4. 写入后必须回读最后一行并 `ConvertFrom-Json` 校验；写坏了只能人工修，没有事务。
5. 同一文件只允许一个写入方。主机写 `pc-outbox`，NAS 写 `nas-outbox`，不要交叉写；没有文件锁，多进程同时追加有交错风险。
6. 不要把密钥、token、隐私内容写进总线；共享目录只有 SMB 权限，没有消息级鉴权。

### 4.4 NAS 侧发送

```bash
sh /volume1/docker/pc-link/bridge.sh send pm-nas "NAS-项目经理" "收到，通道正常"
sh /volume1/docker/pc-link/bridge.sh watch      # 增量读取 pc-outbox
sh /volume1/docker/pc-link/bridge.sh tail 20    # 最近 20 条 pc-outbox
```

`watch` 用 `.bridge-state` 记录已读行号（当前值 43，与 `pc-outbox.jsonl` 43 行一致）。如果归档/重建了 `pc-outbox.jsonl`，必须把 `.bridge-state` 重置为 `0`，否则会漏读或错位。

### 4.5 SMB 的 rename / unlink 限制（重要）

实测证据（`D:\OpenClaw\workspace\projects\agent-hq\nas-api-report.md`）：

- 对共享上已存在的文件执行 `fs.renameSync`、`unlinkSync`、`Copy-Item` 覆盖，返回 **`EINVAL`**；
- **新建文件、追加写入正常**。

因此：

- **不要**在 SMB 共享上使用“tmp + rename”原子替换，也不要“先删后改名”。`real-snapshot.js` 的 `writeAtomic` 只适用于本机 `public/`；把 `--out` 指到 `\\192.168.1.55\...` 可能直接失败。
- 总线只能追加；不要试图重写整个 `pc-outbox.jsonl` / `nas-outbox.jsonl`。
- `README-bridge.md` 建议“每月 `mv` 归档”，但本次只验证了 `nas-metrics.json` 的 rename/unlink 会 `EINVAL`，**没有单独验证 jsonl 的 `mv`**。安全做法：先复制到新文件名并核对行数/JSON，再尝试改名；若报 `EINVAL`，不要删除原文件，保持追加并在报告里记录体积。
- 任何“归档后重建空文件”的方案都要先确认 NAS 侧 `bridge.sh watch` 的状态文件同步重置。

### 4.6 当前总线状态

- `pc-outbox.jsonl`：10,733 B，43 行，最后一条 23:06:05（部署跟进）。
- `nas-outbox.jsonl`：732 B，3 行，最后一条 16:39:39；**没有【部署】/8902 回执**。
- `nas-metrics.json`：实测 `ts=1793632454000`（约 23:14:14）仍在更新（cpu/mem/temp 正常），说明采集器活着；这与 8902 未启动是两件事。

---

## 5. 自检

### 5.1 脚本清单

| 脚本 | 作用 | 依赖 |
| --- | --- | --- |
| `scripts\test-real-snapshot.js` | 生成器验收：字段、覆盖率、状态映射、`--watch` 原子写 | Node 内置，无需服务 |
| `scripts\smoke-8901.js` | 部署冒烟：HTTP、标题、单文件、无外链、`/snapshot.json`、字节一致、响应时间 | 8901 已启动 |
| `scripts\visual-8901.js` | 1920×1080 像素回归：基线/对比/差异图 | Chrome 已开 CDP 9222 |
| `scripts\sanitize-snapshot.js` | 快照脱敏库（被 `real-snapshot.js` import）；也可 CLI 清洗指定文件 | 无 |
| `scripts\real-snapshot.js --help` | 生成器参数与数据源说明 | 无 |

### 5.2 `test-real-snapshot.js`

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
node scripts\test-real-snapshot.js
```

覆盖 4 项：

1. Snapshot 必填字段（对照 `src/data/types.ts`）；
2. 真实数据覆盖率（至少 12 个 agent，未分配 agent 有记录）；
3. 状态映射（`running` / `blocked` / `error` / `idle`，过期 `running` 不误报）；
4. `--watch` 原子写（12 秒内至少 2 次生成，读取无 JSON 解析错误）。

本次实测：

```text
PASS 1/4 PASS 2/4 PASS 3/4 PASS 4/4
watch: generations=3, parseErrors=0, missingReads=0, agents=12
结果：4/4 PASS
```

### 5.3 `smoke-8901.js`

```powershell
node scripts\smoke-8901.js
node scripts\smoke-8901.js --url http://127.0.0.1:8901 --timeout 10000
```

7 项检查与阈值：

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | 首页状态 / Content-Type / 大小 | 200、`text/html`、700–800 KB |
| 2 | `<title>` 含 `AGENT HQ` | `AGENT HQ · 智能总部` |
| 3 | HTML 含 `canvas` 与 `three` | 均 > 0 |
| 4 | 无外部 http(s) 资源 | 0 |
| 5 | `/snapshot.json` | 200、`application/json`；返回 HTML 记 **WARN** 不记 FAIL |
| 6 | `dist/index.html` 与线上字节一致 | 完全相等 |
| 7 | 首页响应时间 | < 1500 ms |

退出码：`0` 全部 PASS（允许 WARN）/ `1` 有 FAIL / `2` 参数或运行错误。

本次实测：7/7 PASS，首页 41 ms（23:30 运行），`/snapshot.json` 为 `application/json`（字节数随快照变化）。**注意它不检查快照新旧**，旧快照也会 PASS。

### 5.4 `visual-8901.js`

前置：Node >= 22（用内置 `WebSocket`），Chrome 以远程调试端口启动（脚本不会自己拉起 Chrome）：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\hq-visual-profile" `
  --no-first-run --no-default-browser-check about:blank
```

运行：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
node scripts\visual-8901.js                 # 无基线时建基线；有基线时对比
node scripts\visual-8901.js --update        # 强制重建基线
node scripts\visual-8901.js --clip          # 只比顶部 HUD（0,0,1920,58）
node scripts\visual-8901.js --clip=left-panel   # 只比左侧 KPI 面板（推荐）
node scripts\visual-8901.js --clip=right-panel  # 只比右侧任务面板
node scripts\visual-8901.js --threshold=3 --tolerance=12
```

退出码：`0` 通过或已建基线 / `1` 差异超阈值 / `2` 运行错误。

当前报告（`visual-8901-report.md`，最近运行 23:26:50，**结论：通过**）：

| 比较 | 差异占比 | 结论 |
| --- | --- | --- |
| 整屏 1920×1080 | 48.6381% | 参考值，不适合当阈值 |
| 顶部 HUD | 0.1051% | 通过 |
| 左侧 KPI 面板（判定区） | **0.1525%** | **通过**（阈值 3%） |
| 右侧任务面板 | 0.0231% | 稳定 |
| 底部跑马灯 | 6.3261% | 滚动导致，不能当门禁 |
| 当前 vs 1 秒后（纯动画）整屏 | 34.8393% | 巡游相机跳切会造成大幅漂移 |

解读：

- 整屏差异**主要来自 3D 场景**：巡游相机在两次独立加载之间位置不同，1 秒纯动画漂移就能到 34.8%，整屏 48.6% 不能说明 UI 回归。
- 左右两个 DOM 面板合计只有 502 个差异像素，占整屏差异像素的 0.05%，可视为 UI 未变。
- **日常门禁用 `--clip=left-panel`（或 `right-panel`）**，阈值 3%；顶部 HUD 是半透明区域，3D 标签穿透时偶尔会升高；跑马灯在滚动，不能当门禁。
- 基线生成于 23:22:30，早于当前构建；本次判定虽通过，严格来说应 `--update` 重建基线后再作为门禁。
- 已知局限：字体抗锯齿、DPR、GPU、窗口缩放都会影响结果；换机器/换 Chrome 后基线作废。

### 5.5 浏览器 DOM 验收（可选）

`D:\OpenClaw\workspace\projects\.agent-hq-backup\cdp-verify.mjs` 是早期的一次性 CDP 检查脚本（不在仓库内，硬编码 Chrome 路径和 9333 端口），会输出 `verify-result.json`：

- 检查 `document.documentElement.dataset.dataSource` 是 `live` 还是 `mock`；
- `.task-row` 行数、`.t-title` / `.t-meta` / `.badge` 文本；
- 点击第一行后 Drawer 的文本；
- 控制台 `console` 与 `exceptions`。

23:01 的结果：`dataSource=live`、5 行任务、无异常、Drawer 显示 `worker3` 与 token。它只做 DOM 文本检查，不截图；不要把它当视觉回归。

### 5.6 建议的日常自检顺序

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

node scripts\test-real-snapshot.js     # 生成器逻辑
node scripts\real-snapshot.js          # 真实数据
npm run build
node scripts\smoke-8901.js             # HTTP 冒烟
# 浏览器 Ctrl+F5 后看 data-source / 控制台
node scripts\visual-8901.js --clip=left-panel   # 需要 Chrome CDP 9222
```

看什么指标：

- `test-real-snapshot`：4/4 PASS，`agents>=12`，`parseErrors=0`；
- `smoke`：7/7 PASS，`/snapshot.json` 必须是 `application/json`；
- `snapshot`：`ts` 是本次生成时间，`meta.counts` 与任务数一致，`meta.warnings` 无新增坏行；
- 页面：`data-source=live`、任务行数等于 `tasks.length`、控制台无 `[live] 真实快照加载失败`；
- 轮询：控制台有 `[live] 轮询已启动：每 30s 检查 ./snapshot.json`；数据变化后出现 `[live] 快照更新：...`；页面隐藏时不再发请求（Network 面板可观察）；
- 视觉：`--clip=left-panel` 差异 < 3%；整屏差异只作参考，不能作为门禁。

---

## 6. 故障排查

### 6.1 速查表

| 现象 | 最可能原因 | 检查 | 处理 |
| --- | --- | --- | --- |
| 页面白屏 | `dist/index.html` 缺失/0 B、`ROOT` 指错、JS 异常、WebGL 不可用 | `Test-Path dist\index.html`、`curl -I`、CDP console | 重新构建；修 `ROOT`；看异常栈；换支持 WebGL 的浏览器 |
| `/snapshot.json` 返回 HTML | `dist/snapshot.json` 不存在，SPA fallback 返回 `index.html` | `curl -D-` 看 `Content-Type`；`Test-Path dist\snapshot.json` | `node scripts\real-snapshot.js` + `npm run build`，或 `--out dist\snapshot.json` |
| 数据不更新 | 只生成了 `public/` 没构建；`dist` 没变；页面是旧 bundle；源头 `metrics` 停了 | 比对 `public`/`dist` 的 mtime；等 30 秒看轮询；看生成器输出的数据年龄 | 见 6.4 |
| 端口占用 / 启动失败 | 旧 node 进程仍在监听 | `Get-NetTCPConnection -LocalPort 8901` | 确认命令行后 `Stop-Process`，再启动 |
| 安全响应头缺失 | 跑的是旧脚本/旧进程（中间版本曾在请求时抛 `SEC_HEADERS is not defined`） | `curl.exe -D-` 看 4 个头；`Get-CimInstance` 看命令行 | 用当前 `.agent-hq-static-server.mjs` 重启 |
| 8902 连接被拒绝 | NAS 静态服务没起来/构建没完成 | `Test-NetConnection`、SMB 共享、`nas-outbox` 回执 | 让 NAS 侧回报卡点；本机无需改 |
| 访问 `..%2f...` 返回 403 或首页 HTML | 路径穿越保护 / SPA 兜底 | 正常现象 | 用根相对路径访问；不要依赖 404 判断文件是否存在 |
| `/%zz` 返回 500 | `decodeURIComponent` 未单独捕获（已知限制） | 正常现象 | 不要发畸形 URL；后续版本修 |
| 页面“很空”、没有运行中任务 | 所有任务都 `done`，`running=0` 是真实状态 | 看 `kpis`/`statusCounts` | 不是故障；需要演示再切 mock |
| 控制台中文乱码 | PowerShell 代码页显示问题，文件本身是 UTF-8 | `Format-Hex` 看字节；浏览器显示正常 | 设置终端 UTF-8，勿转码文件 |

### 6.2 页面白屏

按顺序：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 1) 产物是否存在、是否为空
Get-Item dist\index.html | Select Length,LastWriteTime
# 2) 服务是否返回 200 和 HTML
curl.exe -s -D- -o NUL http://127.0.0.1:8901/
# 3) 本地文件与线上字节是否一致（smoke 的第 6 项）
node scripts\smoke-8901.js
```

- 若 `dist\index.html` 不存在或明显偏小：`npm run build`。
- 若服务返回 404 `Not Found`：`ROOT` 硬编码路径不对（目录被移动/换机器），改 `.agent-hq-static-server.mjs` 的 `ROOT` 后重启。
- 若 HTTP 正常但白屏：用 CDP 看 `Runtime.exceptionThrown`；常见是浏览器不支持 WebGL、GPU 被禁用、或构建产物与源码不匹配。数据加载失败**不会**白屏，只会回退 mock。
- 应急可用旧产物：把 `.agent-hq-backup\dist-index-1926.html`（757,706 B，桥接前版本）复制为 `dist/index.html`，页面会以 mock 模式启动；详见第 7 节。

### 6.3 `/snapshot.json` 返回 `text/html`

这是最常见的“数据没接上”原因：静态服务器对任何缺失路径都返回 `200 text/html` + `dist/index.html`，不是 404。

```powershell
curl.exe -s -D- -o NUL http://127.0.0.1:8901/snapshot.json
# 期望：Content-Type: application/json; charset=utf-8
# 实际若为 text/html 且长度约 761 KB -> dist 里没有 snapshot.json
```

修复：

```powershell
node scripts\real-snapshot.js
npm run build
# 或（只更新数据）
node scripts\real-snapshot.js --out dist\snapshot.json
```

不要通过改静态服务器的 404 行为来“修”数据问题；根因是 `dist/` 缺文件。`src/data/live.ts` 会校验 `content-type`，非 JSON 时 `console.warn` 并回退 mock，所以这种情况下页面通常还能显示，只是数据是模拟的。

### 6.4 数据不更新

按这四层查，不要一上来重启服务：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 第 1 层：public 与 dist 谁新？
Get-Item public\snapshot.json,dist\snapshot.json | Select Name,Length,LastWriteTime

# 第 2 层：服务实际返回哪一版？
$s = Invoke-RestMethod http://127.0.0.1:8901/snapshot.json
$s.ts; $s.agents.Count; $s.tasks.Count; $s.meta.generatedAt

# 第 3 层：页面有没有在轮询？（浏览器控制台）
#   应有：[live] 轮询已启动：每 30s 检查 ./snapshot.json
#   数据变化后应有：[live] 快照更新：N agents / M tasks / ts=...
#   失败时限流提示：[live] 快照轮询失败（N 次）...

# 第 4 层：源头有没有在写？
Get-Item D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl,`
        D:\OpenClaw\workspace\projects\agent-hq\metrics-history.jsonl |
  Select Name,Length,LastWriteTime
```

对应处理：

| 发现 | 处理 |
| --- | --- |
| `public` 新、`dist` 旧 | 走 1.1 构建，或 `--out dist\snapshot.json` |
| `dist` 新、30 秒后页面仍旧 | 页面 bundle 不含轮询（旧构建）→ Ctrl+F5；或标签页隐藏 → 切回前台；看控制台有无 `[live] 轮询已启动` |
| 控制台出现失败提示（5 分钟限流，不会每 30 秒刷） | `/snapshot.json` 不是 JSON 或服务不可达；按 6.3 查 content-type |
| `dist` 新、页面也有 `[live] 快照更新`，但数字仍旧 | 指纹相同：新快照除了 `ts` 之外内容一致；这是去重，不是故障 |
| 生成器输出数据年龄很大 / `latestAt` 很旧 | 源头采集停了；修 `metrics-history.jsonl` 的写入方，不是重启 8901 |
| `meta.warnings` 有坏行 | 修 JSONL 对应行；生成器会跳过，不会中断 |
| `agents` 数量与场景不符 | 3D 网格只在启动时构建；刷新页面；不要热改 agent 集合 |

当前就是“`public` 新、`dist` 旧”的实例，见 1.4。

### 6.5 端口占用 / 服务起不来

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8901 |
  Select LocalAddress,LocalPort,OwningProcess
$p = (Get-NetTCPConnection -State Listen -LocalPort 8901).OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$p" | Select CommandLine
```

- 命令行是 `.agent-hq-static-server.mjs`：旧实例，`Stop-Process -Id $p -Force` 后重启。
- 命令行是别的程序：不要杀，换端口或让占用方释放。
- 启动即退出：前台运行看报错；常见是 `EADDRINUSE`、`ROOT` 不存在、Node 版本过低（< 20.11）。
- 日志：`D:\OpenClaw\workspace\projects\.agent-hq-static-server.log`（stdout）与 `.log.err`（stderr）。`.err` 里有一条历史崩溃 `ReferenceError: SEC_HEADERS is not defined`，来自中间版本；当前实例（23:06:23 启动）已正常，不要把它当成现在的错误。

### 6.6 安全响应头缺失

当前代码与线上都应有这 4 个头：

```text
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cache-Control: no-store
```

检查：

```powershell
curl.exe -s -D- -o NUL http://127.0.0.1:8901/snapshot.json
```

若缺失：

1. `Get-CimInstance Win32_Process` 确认跑的是 `D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs`；
2. 打开脚本确认 `const SEC_HEADERS = {...}` 在 `createServer` 之前定义；
3. 重启服务；
4. 复测 4 个头。

`security-8901.md` 的 R2 写“安全头全缺”，那是 23:02 的旧审计，早于 23:06:15 的脚本更新；**当前实测 4 个头都存在**，不要拿旧报告当现状。该报告里的 R3（`startsWith(ROOT)` 未加分隔符）、R4（缺失路径 200 fallback）、R5（畸形编码 500）仍与当前代码一致，属于已知限制。

---

## 7. 回滚

### 7.1 可用版本

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
git log --oneline -5
```

| commit | 内容 | 能否直接服务真实数据 |
| --- | --- | --- |
| `d1ce0ad` | 当前 HEAD：真实数据桥 + 部署文档 + smoke | 能（配合 `dist/snapshot.json`） |
| `141ce62` | 上游基线：只有模拟世界 | **不能**，无 `live.ts` / `real-snapshot.js` / `public/snapshot.json` |
| `0aee53e` | GitHub Pages 单文件产物 | 不能，旧产物 |

**“上一版”就是 `141ce62`，回滚到它就是回到纯 Mock 模式。** 这是预期结果，不是故障。

### 7.2 回滚整个桥接提交（保留历史，推荐）

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 先保存未提交的改动（当前有 public/snapshot.json、scripts/real-snapshot.js、
# src/data/live.ts、src/main.tsx 的修改；轮询实现也在其中）
git status --short
git stash push -u -m "before-rollback-20261102"

# 生成一个反向提交
git revert --no-edit d1ce0ad

# 重新构建（源码已回到上游）
npm run build

# 验证：页面应为 mock，无真实快照请求
node scripts\smoke-8901.js
```

注意：`revert` 后 `scripts/`、`public/snapshot.json`、`src/data/live.ts` 等会从工作树移除；`dist/` 不会自动变，必须 `npm run build`。`git stash` 里的改动可用 `git stash pop` 恢复（可能冲突）。

### 7.3 回滚到指定 commit（分离 HEAD）

```powershell
git checkout 141ce62
npm run build
```

- 这是 detached HEAD，不在任何分支上；要回到最新版：`git checkout d1ce0ad`（或 `git switch -`）。
- `141ce62` 不含 `public/snapshot.json`，checkout 会把它从工作树删掉；如果还要保留真实快照，先复制到仓库外。
- 构建后 8901 会自动服务新的 `dist/index.html`，**不需要重启**；浏览器 Ctrl+F5。

### 7.4 只回滚轮询（保留真实数据桥）

如果轮询出现异常，但真实数据桥要保留：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream

# 丢弃未提交的轮询改动，恢复 HEAD 的 boot-only 版本
git checkout -- src/data/live.ts src/main.tsx

npm run build
# 浏览器 Ctrl+F5
```

- 回滚后页面只在启动时 `fetch` 一次，不再自动更新；数据更新需要手动刷新。
- 这会同时丢弃 `src/data/live.ts` 里的 `quiet` 选项、指纹与轮询代码；如果这些改动已经提交，改用 `git revert <commit>`，不要 `checkout --`。
- `dist/` 不会自动回退，必须重新构建。

### 7.5 只回滚构建产物（应急，不碰 Git）

如果只是页面坏了、需要立刻恢复一个能打开的版本：

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
Copy-Item ..\.agent-hq-backup\dist-index-1926.html dist\index.html -Force
# 浏览器 Ctrl+F5
```

- 该文件 757,706 B，是桥接前的单文件产物；页面会以 **mock** 模式启动（它不 fetch `snapshot.json`）。
- 不需要重启服务；`dist/snapshot.json` 留着也不影响旧页面。
- 恢复新版：`npm run build`（会重新生成 `dist/index.html` 并复制当前 `public/snapshot.json`）。

### 7.6 回滚后检查

```powershell
node scripts\smoke-8901.js
$r = Invoke-WebRequest http://127.0.0.1:8901/ -UseBasicParsing
$r.StatusCode; $r.RawContentLength
```

预期：

- 页面 200、标题 `AGENT HQ · 智能总部`、大小在 700–800 KB；
- 若 `dist/snapshot.json` 已随回滚删除，smoke 第 5 项是 **WARN**（返回 HTML），不是 FAIL；
- 浏览器 `data-source=mock`，任务为内置模拟数据（约 39 条），无 JS 异常。

---

## 8. 相关文档

| 文档 | 内容 |
| --- | --- |
| `DEPLOY.md` | 从零部署、环境要求、端口、回滚、常见故障（部分数字早于本手册，以本手册第 0 节为准） |
| `INTEGRATION.md` | 数据桥字段映射、已知风险、第二阶段验收清单 |
| `REAL-DATA-BRIDGE-PHASE2-REPORT.md` | 浏览器接入实现与 23:00 验收记录 |
| `NAS-FOLLOWUP.md` | 8902 未启动、总线回执、采集器恢复的现场记录 |
| `NAS-FOLLOWUP-2.md` | 23:21 二次跟进：8902 仍拒绝、采集器正常、未重复催办 |
| `LIVE-REFRESH-REPORT.md` | 30 秒轮询的实现、指纹去重、Node 侧行为验证记录 |
| `security-8901.md` | 23:02 暴露面审计（R2 安全头已被后续版本补齐；R1 的路径/runId 暴露已由 snapshot 脱敏缓解）；另有 `security-8901-recheck.md` |
| `smoke-report.md` | 历史冒烟报告（15,213 B 旧快照时期的 7/7 PASS） |
| `visual-8901-report.md` | 视觉回归自动报告（每次运行重写） |

---

## 9. 本文验证记录

已实际执行（2026-11-02 23:11–23:35）：

- 读取 `DEPLOY.md`、`INTEGRATION.md`、`NAS-FOLLOWUP.md`、`security-8901.md`、`smoke-report.md`、`REAL-DATA-BRIDGE-PHASE2-REPORT.md`；
- 读取 `.agent-hq-static-server.mjs`、`src/data/live.ts`、`src/main.tsx`（含 23:14 后加入的轮询实现）、`scripts/real-snapshot.js`（关键段）、`scripts/smoke-8901.js`、`scripts/test-real-snapshot.js`、`scripts/visual-8901.js`（头部与流程）、`LIVE-REFRESH-REPORT.md`、`NAS-FOLLOWUP-2.md`；
- `node scripts\real-snapshot.js --out <临时文件>`：exit 0，30,190 B，12 agents / 5 tasks，结构校验 OK；临时文件已删除；
- `node scripts\test-real-snapshot.js`：4/4 PASS，watch 3 次生成、0 解析错误；
- `node scripts\smoke-8901.js`：7/7 PASS，41 ms（23:30 运行）；`/snapshot.json` 为 `application/json`；
- 确认当前 `dist/index.html` 内含轮询代码：HTML 包含 `__HQ_POLL_MS` 与“轮询已启动”；
- 连续两次 `real-snapshot.js --out` 到临时文件，去掉顶层 `ts` 后内容完全相等，验证指纹去重前提成立；
- `curl.exe -D-` 实测 8901 首页与 snapshot 的 4 个安全头均存在；
- `Get-NetTCPConnection`：8901 监听 `127.0.0.1`（当时 PID 3368，之后已重启过，PID 会变）；8900/8902 无监听；
- `192.168.1.55:8902` 多次探测均连接被拒绝；SMB `pc-link` 可访问；
- 读取 `pc-outbox.jsonl` / `nas-outbox.jsonl` 的尾部、字节数与 `.bridge-state`。

未验证 / 未执行：

- 没有停止或重启 8901；
- 没有直接写 `dist\snapshot.json`（只用临时文件验证 `--out` 机制）；
- 没有重跑浏览器视觉/CDP（引用 23:01 的 `verify-result.json` 和 23:26 的视觉报告）；
- 没有做浏览器端轮询实测（30 秒网络请求、隐藏暂停、恢复补拉）；只确认代码、Node 侧测试报告与构建产物；
- `visual-8901.js` 未重新运行，报告中的差异值来自现有运行记录；
- 8902 的 NAS 构建、静态服务、目录创建均未验证；
- SMB 上对 `.jsonl` 执行 `mv` 的行为未单独验证（只有 `nas-metrics.json` 的 EINVAL 证据）；
- `Start-Process` 后台进程的长期存活未复验（当前实例父进程是 `WmiPrvSE.exe`，推断由 WMI 启动）。
