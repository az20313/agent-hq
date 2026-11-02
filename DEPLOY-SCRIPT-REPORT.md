# AGENT HQ 一键部署脚本报告

> 脚本：`scripts/deploy-local.ps1`（新增，未修改 `src/`）
> 验证日期：2026-11-03（Asia/Shanghai）
> 验证环境：Windows 10.0.22631 x64 / PowerShell 7.6.5 / Node v24.22.1 / npm 11.19.1 / Git 2.53.0
> 最终验证目录：`D:\OpenClaw\workspace\projects\agent-hq-deploytest`（临时，已删除）
> 最终验证端口：8906（已停止并释放）
> 最终验证 HEAD：`3a88e2f docs: sync README with current state (12 agents, live polling, fork URL)`

---

## 1. 产出

| 文件 | 说明 |
| --- | --- |
| `scripts/deploy-local.ps1` | 一键部署脚本（新增，22,514 字节） |
| `DEPLOY-SCRIPT-REPORT.md` | 本报告 |

没有改动 `src/`、`package.json`、`DEPLOY.md` 或任何已有脚本。仓库中 `src/` 的改动与若干未跟踪报告来自并行工作，不是本任务产生；本任务只新增 `scripts/deploy-local.ps1` 与 `DEPLOY-SCRIPT-REPORT.md`。

---

## 2. 用法

```powershell
# 默认：部署到 ..\agent-hq-local，端口 8905
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
.\scripts\deploy-local.ps1

# 自定义目录 / 端口
.\scripts\deploy-local.ps1 -TargetDir D:\tmp\agent-hq -Port 8906

# 只打印将执行的命令（不检查端口、不写文件、不启动服务）
.\scripts\deploy-local.ps1 -TargetDir ..\agent-hq-local -Port 8905 -DryRun

# 复用已有依赖/快照/构建，仅更新代码、启动并冒烟
.\scripts\deploy-local.ps1 -SkipInstall -SkipSnapshot -SkipBuild

# 停止本脚本为该端口启动的服务
.\scripts\deploy-local.ps1 -Port 8906 -Stop
```

### 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-TargetDir` | `..\agent-hq-local` | 部署目录；相对路径以仓库根目录为基准 |
| `-Port` | `8905` | 静态服务端口，仅绑定 `127.0.0.1` |
| `-RepoUrl` | `https://github.com/az20313/agent-hq.git` | 克隆地址 |
| `-SkipInstall` | 关 | 跳过 `npm ci` |
| `-SkipSnapshot` | 关 | 跳过 `node scripts\real-snapshot.js` |
| `-SkipBuild` | 关 | 跳过 `npm run build` |
| `-DryRun` | 关 | 只打印命令，无任何副作用 |
| `-Stop` | 关 | 停止本脚本记录的该端口服务后退出 |

---

## 3. 流程实现

严格按 `DEPLOY.md` 的 6 步：

1. **克隆 / 更新**
   - 目录不存在：`git clone <RepoUrl> <TargetDir>`，再 `git checkout main`。
   - 目录已存在且是 git 仓库：`git fetch origin main` → `git checkout main`。
   - 工作区干净：`git merge --ff-only origin/main`。
   - 只有 `public/snapshot.json` 被修改（生成快照后的正常状态）且本次会生成快照：先 `git checkout -- public/snapshot.json` 再 fast-forward，随后第 3 步重新生成。
   - 使用 `-SkipSnapshot` 时不会重置该文件；若它仍是唯一改动，脚本打印警告并跳过 fast-forward，用当前 HEAD 继续。
   - 存在其他本地改动：打印警告，跳过 fast-forward，不覆盖用户改动。
2. `npm ci`（`-SkipInstall` 可跳过）。
3. `node scripts\real-snapshot.js`，工作目录为 `TargetDir`（`-SkipSnapshot` 可跳过）。
4. `npm run build`（`-SkipBuild` 可跳过）。
5. 生成临时静态服务 `%TEMP%\agent-hq-static-<Port>.mjs`，注入 `ROOT=<TargetDir>\dist`、`PORT=<Port>`；`Start-Process` 后台启动并等待端口就绪。
6. `node scripts\smoke-8901.js --url http://127.0.0.1:<Port>`，工作目录为 `TargetDir`。

额外内置校验：

- `/` 必须 `200` 且 `Content-Type: text/html`；
- `/snapshot.json` 必须 `200` 且 `Content-Type: application/json`，解析 JSON 并输出 agents/tasks 数量。

### 幂等与端口策略

- 启动前先做端口预检：端口被未知进程占用时**立即**报错退出（退出码 1），不会先 clone/install/build 再失败。
- 重复执行会复用本脚本之前启动、仍监听同一端口、且目标目录一致的服务（状态文件 `%LOCALAPPDATA%\agent-hq-deploy\state-<Port>.json` 校验 PID + 目录 + 端口）。
- 端口被本脚本服务占用但目标目录不同：报错，不抢占。
- 默认**不停止**服务；只有 `-Stop` 才会停止并删除状态文件。
- 冒烟或校验失败时保留服务便于排查，退出码 1。

### 状态与临时文件

| 文件 | 用途 |
| --- | --- |
| `%LOCALAPPDATA%\agent-hq-deploy\state-<Port>.json` | 服务 PID、端口、目标目录、启动时间 |
| `%TEMP%\agent-hq-static-<Port>.mjs` | 临时静态服务脚本 |
| `%TEMP%\agent-hq-static-<Port>.out.log` / `.err.log` | 服务日志 |

---

## 4. 真跑验证

### 4.1 命令

```powershell
cd D:\OpenClaw\workspace\projects\agent-hq-upstream
.\scripts\deploy-local.ps1 -TargetDir ..\agent-hq-deploytest -Port 8906
```

### 4.2 最终完整运行（最终脚本版本）

```text
== 1/6 clone/fetch repository ==
Cloning into 'D:\OpenClaw\workspace\projects\agent-hq-deploytest'...
== 1b/6 checkout main ==
Already on 'main'
== 2/6 npm ci ==
added 80 packages in 22s
== 3/6 generate snapshot ==
[real-snapshot] 输出: ...\public\snapshot.json
[real-snapshot] 大小: 27873 bytes (27.2 KiB)
[real-snapshot] agents=12/12 tasks=5 events=10 unassigned=3 tableMapped=9 sessions=206
[real-snapshot] 状态: idle=9 running=3 blocked=0 error=0
[real-snapshot] kpis: total=5 done=5 running=3 blocked=0 progress=100.0% tokens=15535235
[real-snapshot] 结构校验: OK
== 4/6 build ==
dist/index.html  762.26 kB │ gzip: 210.75 kB
✓ built in 5.90s
== 5/6 static server ==
[deploy] Static server started (PID 23736)
== 6/6 smoke test ==
Summary
  PASS: 7
  WARN: 0
  FAIL: 0
RESULT: PASS

== HTTP verification ==
  /              200  text/html; charset=utf-8  764460 B
  /snapshot.json 200  application/json; charset=utf-8  27873 B
[deploy] Snapshot: 12 agents / 5 tasks

==== deployment summary ====
  target : D:\OpenClaw\workspace\projects\agent-hq-deploytest
  port   : 8906 (http://127.0.0.1:8906)
  HEAD   : 3a88e2f docs: sync README with current state (12 agents, live polling, fork URL)
  steps  :
    1/6 clone/fetch repository   48.55 s
    1b/6 checkout main            0.09 s
    2/6 npm ci                   22.24 s
    3/6 generate snapshot         0.51 s
    4/6 build                    13.87 s
    5/6 start server              0.71 s
    6/6 smoke                     0.38 s
  artifacts :
    dist\index.html         764,460 B
    dist\snapshot.json       27,873 B
  service   : PID 23736  http://127.0.0.1:8906/  (started now)

[deploy] Deployment OK.
```

冒烟明细：

```text
[PASS] 1. Home page status, content-type, size
       HTTP 200, text/html, 764460 B (746.54 KB)
[PASS] 2. Page title contains AGENT HQ
[PASS] 3. HTML contains canvas and three keywords
[PASS] 4. No external resource references (http/https)
[PASS] 5. /snapshot.json content-type and size
       HTTP 200, application/json, 27873 B, valid JSON
[PASS] 6. dist/index.html exists and matches live bytes
[PASS] 7. Home response time
       147 ms (expected < 1500 ms)
```

### 4.3 幂等重跑

同一目录、同一端口、使用 `-SkipInstall -SkipSnapshot -SkipBuild`：

```text
[deploy] Port 8906 is already owned by this deployment (PID 23736); it will be reused
== 1/6 clone/fetch repository ==
 * branch            main       -> FETCH_HEAD
== 1b/6 checkout main ==
Already on 'main'
[deploy][WARN] Working tree has local changes; skipping fast-forward and deploying the current HEAD
[deploy][WARN] Changed paths:  M public/snapshot.json
[deploy] Skipping npm ci (-SkipInstall)
[deploy] Skipping snapshot generation (-SkipSnapshot)
[deploy] Skipping build (-SkipBuild)
== 5/6 static server ==
[deploy] Port 8906 already served by this deployment (PID 23736); reusing it
== 6/6 smoke test ==
RESULT: PASS
[deploy] Deployment OK.
```

另一次不带 Skip 的完整重跑（修复 `$HOME` 后）也通过，并正确复用 PID 19144、重新生成快照、重新构建。两次重跑均未报错。

### 4.4 运行时 `data-source=live` 验证

通过本机已有 Chrome CDP（9222）打开 `http://127.0.0.1:8906/`，等待 5 秒后读取 DOM：

```json
{"dataSource":"live","title":"AGENT HQ · 智能总部","canvases":1}
```

确认 `<html data-source="live">`，页面存在 canvas。该检查为本次人工验证，未写入脚本（脚本内置校验只覆盖 HTTP/JSON/冒烟，见风险 7）。

### 4.5 `-DryRun` 验证

```powershell
.\scripts\deploy-local.ps1 -Port 8905 -DryRun
```

即使 8905 已被其他进程占用，DryRun 仍正常打印全部命令并退出 0，不检查端口、不创建目录、不写文件、不启动服务。

### 4.6 端口占用预检

8905 当前被无关进程占用（`node serve-8905.mjs`，PID 39500）。不带 `-DryRun` 直接使用默认端口：

```text
[deploy][ERROR] Port 8905 is already in use (PID 39500). Use a different -Port or stop the process first.
exit=1
targetCreated=False
```

在 clone 之前即失败，未创建目标目录，未碰占用进程。

### 4.7 停止与清理

```powershell
.\scripts\deploy-local.ps1 -Port 8906 -Stop
# [deploy] Stopped PID 23736
# [deploy] Port 8906 is free

Remove-Item D:\OpenClaw\workspace\projects\agent-hq-deploytest -Recurse -Force
```

已确认：

- 8906 无监听；
- `agent-hq-deploytest` 已删除；
- 状态文件已删除；
- 临时服务脚本与日志已删除；
- 最终仓库只新增 `scripts/deploy-local.ps1` 与 `DEPLOY-SCRIPT-REPORT.md`。

---

## 5. 遇到的问题

1. **PowerShell 自动变量 `$HOME` 冲突**
   - 首次运行冒烟 7/7 通过，但 HTTP 校验处报：
     `Cannot overwrite variable HOME because it is read-only or constant.`
   - 原因：首页响应存到 `$home`，PowerShell 变量名不区分大小写，与只读自动变量 `$HOME` 冲突。
   - 修复：改为 `$homeResp` / `$snapResp`，重跑通过。

2. **DryRun 仍检查端口**
   - 早期版本在 `-DryRun` 下遇到已占用端口会报错退出，不符合“只打印命令”。
   - 修复：DryRun 跳过端口预检、状态清理和启动逻辑；已在 8905 被占用时验证通过。

3. **`-SkipSnapshot` 会把快照重置成提交版**
   - 早期逻辑在 fast-forward 前无条件恢复 `public/snapshot.json`。若随后跳过快照生成，`public/` 会退回提交版的 3-agent 快照，而 `dist/` 仍是旧的 12-agent 快照。
   - 修复：仅在本次会执行快照生成时才恢复该文件；`-SkipSnapshot` 时保留改动并跳过 fast-forward（打印警告）。

4. **默认端口 8905 在本机已被占用**
   - 占用者：`node serve-8905.mjs`（PID 39500），不是本脚本启动的服务。
   - 脚本按设计立即报错退出，未停止该进程。实际验证使用 8906。
   - 若要用默认端口，需先确认并停止占用进程，或改用 `-Port`。

5. **首次 clone 较慢**
   - 首次 `git clone` 105.58 秒，最终一次 48.55 秒，后续 fetch 1.11–2.12 秒；属于网络波动，不是脚本问题。脚本未设置 clone 超时。

6. **快照大小会随运行时状态漂移**
   - 本次不同运行生成过 27,873 与 27,891 字节（agents=12 / tasks=5，结构校验均 OK）。
   - 差异来自 `meta` / 状态计数等运行时字段，属正常数据变化，不是脚本改动。

7. **npm 11 的 esbuild allowScripts 警告**
   - `npm ci` 输出 `npm warn install-scripts ... esbuild@0.21.5`。
   - 安装退出码 0、80 个包、构建成功，与 DEPLOY.md 6.1 一致；未执行 `npm install-scripts approve`。

---

## 6. 风险与限制

1. **默认端口可能冲突**：本机 8905 已被 `serve-8905.mjs` 占用；脚本会快速失败而不是抢占。部署前需确认端口，或显式传 `-Port`。
2. **Node/npm 网络依赖**：`npm ci` 每次执行都需要可用的 npm 源/缓存；离线时会失败。`git fetch` 也需要能访问远端。
3. **生成快照依赖本机绝对路径**：`real-snapshot.js` 默认读取 `D:\OpenClaw\workspace\projects\agent-hq\*.jsonl`、`D:\OpenClaw\data\openclaw.json`、`D:\OpenClaw\data\agents`、`D:\OpenClaw\data\state\openclaw.sqlite`。换机器或目录后可能只得到降级快照（脚本仍会成功，但数据可能不完整）。
4. **会重置生成的 `public/snapshot.json`**：正常模式下，若该文件是唯一改动，脚本会恢复它以 fast-forward，然后重新生成。曾手工编辑该文件的内容会丢失；其他文件的本地改动不会被覆盖（脚本跳过 fast-forward 并警告）。使用 `-SkipSnapshot` 时不会重置，但会因此跳过 fast-forward。
5. **端口复用依赖状态文件**：状态文件位于 `%LOCALAPPDATA%\agent-hq-deploy\state-<Port>.json`。若手工删除状态文件而服务仍在监听，脚本会视为未知进程并报错退出。
6. **不自动停止服务**：冒烟失败也保留服务便于排查；需显式 `-Stop`。修改静态服务模板后必须 `-Stop` 再启动，否则会复用旧进程。
7. **脚本内置校验不含浏览器运行时**：脚本验证 HTTP 状态、content-type、JSON 结构和 `smoke-8901.js`；`data-source=live` 依赖前端 fetch + 校验成功，本次用 Chrome CDP 人工确认。无浏览器环境下无法由脚本单独证明该属性。
8. **冒烟阈值固定**：`smoke-8901.js` 要求首页 700–800 KB。若未来构建产物超过 800 KB，冒烟会失败，需要同步调整冒烟脚本（本任务未改）。
9. **Windows 专用**：使用 `Get-NetTCPConnection`、Windows 路径与 `Start-Process` 语义；未在 Linux/macOS 验证。
10. **临时静态服务非生产级**：仅用于本地验收，具备基本 Host 校验、路径穿越防护、MIME 与缺失资源 404；没有 TLS、认证、缓存策略或并发调优。
11. **首次运行失败会留下服务**：这是“默认不自动停止”的预期行为；失败输出会提示服务地址，需手动 `-Stop` 或换端口。
12. **上游 HEAD 会漂移**：本次验证期间远端从 `192e5ac` 前进到 `3a88e2f`。脚本每次 fetch + fast-forward 到 `origin/main`，结果可复现但不对应固定 commit；需要固定版本时应额外指定 commit（当前脚本未提供该参数）。

---

## 7. 验收结论

| 检查项 | 结果 |
| --- | --- |
| 脚本可执行、参数齐全 | 通过 |
| `-DryRun` 只打印命令、无副作用（含端口占用时） | 通过 |
| 全新目录 clone → install → snapshot → build → serve → smoke | 通过（HEAD `3a88e2f`） |
| 重复执行不报错、复用已有服务 | 通过 |
| `-SkipInstall/-SkipSnapshot/-SkipBuild` | 通过 |
| 端口占用时提示并退出（clone 前） | 通过（8905 / PID 39500） |
| `/` 返回 200 `text/html` | 通过（764,460 B） |
| `/snapshot.json` 返回 200 `application/json` | 通过（27,873 B） |
| `data-source=live` | 通过（Chrome CDP 人工验证） |
| 冒烟 7/7 PASS | 通过 |
| `-Stop` 停止服务并释放端口 | 通过 |
| 测试目录与临时文件清理 | 通过 |
| 未修改 `src/` | 通过 |
