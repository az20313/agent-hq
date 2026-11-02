# E2E Live 验证报告（8904 真实数据）

- **执行时间**：2026-11-03 00:52–01:00（Asia/Shanghai）
- **脚本**：`D:\OpenClaw\workspace\projects\agent-hq-upstream\scripts\e2e-live.js`（新增，28,707 bytes，SHA256 `FE3DF263…40F1C9`）
- **Node**：v24.22.1（Windows 10.0.22631 x64）
- **浏览器**：Chrome 156.0.8078.80，无头模式（临时 profile + 独立调试端口，跑完自动清理）
- **被测页面**：http://127.0.0.1:8904/
- **服务**：`node .agent-hq-static-server-8904.mjs`（PID 34360），其静态根为 `D:\OpenClaw\workspace\projects\agent-hq-ghverify\dist`
- **快照文件**：`D:\OpenClaw\workspace\projects\agent-hq-ghverify\dist\snapshot.json`

> 说明：8904 实际服务的 dist 与 `agent-hq-upstream\dist` 不是同一目录。因此真实运行时用
> `--snapshot` 显式指向 ghverify 的 dist，避免改错文件。脚本业务边界未变：只在 `--poll-test`
> 开启时改写 `--snapshot` 指向的这一个文件。

## 执行命令

```powershell
node scripts/e2e-live.js --url http://127.0.0.1:8904/ --poll-test `
  --snapshot D:\OpenClaw\workspace\projects\agent-hq-ghverify\dist\snapshot.json
```

## 结果汇总

| # | 检查项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | 页面可访问（HTTP 200 + DOM 就绪） | **PASS** | HTTP 200；`readyState=complete`；`visibility=visible`；等待 7000ms |
| 2 | `<html data-source>` === `live` | **PASS** | `data-source="live"` |
| 3 | 页面包含真实任务标题 | **PASS** | 已找到 `[设计] 首页改版视觉稿`（取自 `/snapshot.json` 第一条） |
| 4 | canvas 存在且无 JS 异常 | **PASS** | `canvas=1`，尺寸 `1584×905`；`Runtime.exceptionThrown` 捕获数 = 0 |
| 5 | 轮询验证（KPI 跟随 snapshot 更新） | **PASS** | `kpis.done 5→6` 后 **23.6s** 上屏，页面 `DONE=6` |
| 6 | 快照恢复 + SHA256 校验 | **PASS** | 恢复后 SHA256 与备份完全一致 |

```
SUMMARY: 6 passed, 0 failed, 0 skipped  (34.2s)
RESULT: PASS
退出码: 0
```

执行后的独立复核：`dist/snapshot.json` SHA256 = `AA842E025C0A18C82A97E5218EEED18B7272FA5BF4F232EF456042C508B7E4F7`，
与运行前一致；HTTP 返回的 `kpis.done` 已回到 `5`，`tasks[0].title` 仍为 `[设计] 首页改版视觉稿`；
目录内无 `.e2e-tmp-*` 残留，无遗留无头 Chrome 进程。

## 轮询验证时序

1. 脚本读取并备份快照，记录原始 SHA256（`aa842e025c0a…08b7e4f7`）。
2. 将 `kpis.done` 从 `5` 改为 `6`，通过“同目录临时文件 + rename”原子替换，避免服务读到半个 JSON。
3. 页面侧 `startLivePolling` 默认每 30s 拉取一次 `/snapshot.json`（`src/data/live.ts`），
   快照签名不含 `ts`，`kpis.done` 变化会触发 `onSnapshot` → `world.applySnapshot` → store 同步。
4. 实测在改写后 **23.6 秒**观察到 KPI 文本变化，`DONE` 显示为 `6`。
5. `finally` 中无条件用备份原子写回，并重新计算 SHA256；校验通过后才判定第 6 项 PASS。
6. 若中途 Ctrl+C / 异常退出，`SIGINT`/`SIGTERM` 处理器同样会同步恢复文件后再退出。

## 可重跑性复核

不带 `--poll-test` 再跑一次（不触碰任何文件）：

```
[1] 页面可访问                    PASS
[2] data-source === live          PASS
[3] 页面包含真实任务标题           PASS
[4] canvas 存在且无 JS 异常        PASS
[5] 轮询验证                      SKIP  未指定 --poll-test
[6] 快照恢复                      SKIP  未发生改写
SUMMARY: 4 passed, 0 failed, 2 skipped  (13.7s)
RESULT: PASS    退出码: 0
```

脚本自包含：自动探测 Chrome/Edge、分配空闲调试端口、启动临时无头实例、创建独立标签页，
结束后关闭标签页并杀掉整棵进程树、删除临时 profile。也可用 `--cdp http://127.0.0.1:9222`
复用已有调试实例。

## 实现要点

- **零 npm 依赖**：只使用 `node:fs/path/os/net/crypto/child_process` 与 Node 内置
  `fetch`、`WebSocket`、`AbortSignal.timeout`；CDP 的请求/响应、事件分发、超时与清理均为自实现。
- **异常采集**：导航前启用 `Runtime.enable`，全程收集 `Runtime.exceptionThrown`，
  在轮询结束后统一统计，避免漏掉运行期异常。
- **等待策略**：`--settle` 默认 7000ms，并强制收敛到 6000–8000ms 约定区间；
  `Page.loadEventFired` 25s 超时兜底，不会无限挂起。
- **失败也恢复**：备份在任何改写之前完成；恢复与 SHA256 校验位于 `finally`，
  信号退出同样覆盖；恢复失败会明确判为 FAIL，而不是静默通过。
- **边界**：未重启服务、未改 `src/`、未改业务数据；除新增脚本与本报告外无其他产物。

## 结论

**PASS**。8904 页面确认使用真实快照（`data-source=live`），真实任务标题上屏，WebGL canvas
正常创建，无 JS 异常；快照轮询链路（文件 → 30s 轮询 → KPI 上屏）端到端生效；
测试对快照的临时改写已字节级恢复并通过 SHA256 校验。脚本可直接重复执行。
