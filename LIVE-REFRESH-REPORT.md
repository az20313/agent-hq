# Agent HQ 实时刷新（Live Polling）报告

日期：2026-11-02
范围：`agent-hq-upstream`，只改 `src/data/live.ts`、`src/main.tsx`，未触碰 `scripts/real-snapshot.js`。

## 结论

页面启动后每 30 秒检查一次 `/snapshot.json`；**内容有变化才 `world.applySnapshot()`**，无变化不触发，避免整屏每 30 秒闪一下。页面隐藏时暂停请求，恢复可见时立即补拉一次。`npm run build`（含 `tsc -b`）通过，Node 侧行为验证全部通过，`public/snapshot.json` 已按 SHA-256 校验恢复原样。

## 改动点

### 1. `src/data/live.ts`（主要改动）

| 能力 | 实现 |
| --- | --- |
| 轮询 | `startLivePolling({ onSnapshot, initialSnapshot, immediate })`，默认 30s 一次；递归 `setTimeout` 而非 `setInterval`，天然避免请求重叠 |
| 内容校验 | 复用原 `fetchSnapshot`：`res.ok` + `content-type` 含 `application/json` + `isSnapshot` 结构校验 |
| 轻量 diff | `snapshotSignature(snapshot)`：键排序后的稳定序列化 → cyrb53 53 位哈希；**顶层 `ts` 不参与指纹** |
| 仅在变化时应用 | 指纹与上次相同 → 只累加 `unchanged`，不调用 `onSnapshot`；不同 → 调用后记录新指纹 |
| 页面可见性 | `document.hidden` 时清掉定时器；`visibilitychange` 恢复可见时立即 `pollNow()`，再重新排下一轮 |
| 失败处理 | 静默重试；`console.warn` 全局 5 分钟限流，不随 30 秒轮询刷屏 |
| 可配置 | `window.__HQ_POLL_MS`（毫秒），优先级：显式 `intervalMs` > `window.__HQ_POLL_MS` > 30000；低于 1000ms 或非有限值忽略 |
| 可观测 | `controller.getStats()` / `getLiveStats()`：`polls/applied/unchanged/failures/consecutiveFailures/lastSignature/lastError` |
| 生命周期 | `controller.stop()` 清定时器、移除监听；重复 `start` 返回同一实例；通过 `window.__HQ_LIVE_STOP` 回收 HMR 旧实例，降低定时器泄漏风险 |

`fetchSnapshot` 增加可选第二参数 `{ quiet?: boolean }`，轮询内部传 `quiet: true`，避免每次失败都直接打日志。

指纹刻意排除顶层 `ts`：`scripts/real-snapshot.js` 每次重跑都会刷新生成时间，但数据可能完全没变；若把 `ts` 算进去，会导致每轮都 `applySnapshot`，即“每 30 秒闪一下”。

### 2. `src/main.tsx`（最小接线）

启动逻辑仍是“先 fetch 一次 → applySnapshot → 动态 import App”，渲染后启动轮询：

```ts
startLivePolling({
  initialSnapshot: snap,
  immediate: false, // 启动流程已经拉过一次，避免重复请求
  onSnapshot: (next) => {
    world.applySnapshot(next)
    useHQ.setState({ snap: world.snapshot() })
    document.documentElement.dataset.dataSource = 'live'
  },
})
```

`onSnapshot` 里显式同步 `useHQ` 的原因：`world.subscribe` 在 store 侧有 420ms 节流，而真实模式下 `world.paused = true`，`tick()` 不再产生后续通知；若轮询 apply 恰好落在节流窗口内，唯一一次 UI 通知会被吞掉。3D 场景本身每帧直接读 `world`，不依赖该通知。

## 轮询策略

- 正常可见：`fetch → 校验 → 指纹比较 → （变化才 apply）→ 排下一次 30s`。
- 请求失败：保留上一次指纹和旧数据，不 apply，继续下一轮；首次失败会 warn 一次，之后 5 分钟内不再提示。
- 页面隐藏：清掉定时器，不发请求。
- 恢复可见：先立即拉一次，成功后按 30s 继续。
- 并发保护：`pollNow()` 复用在途 Promise；可见性事件与定时器同一时刻触发也不会并发请求。
- 启动：`immediate: false`，因为 `main.tsx` 启动时已完成首拉；若首拉失败，30s 后自动重试（也可通过控制台手动调 `pollNow`，若拿到 controller）。

## 验证

### 构建 / 类型

```text
npm run build
> tsc -b && vite build
✓ 68 modules transformed
dist/index.html 762.24 kB │ gzip: 210.75 kB
✓ built in 2.12s
BUILD_EXIT=0
```

`npm run build` 内含 `tsc -b`，类型检查通过；`dist/` 在 `.gitignore` 中，不产生待提交产物。

### 行为验证（Node 24 `--experimental-strip-types`，直接 import `live.ts`）

临时脚本放在工作区 `.tmp`（未写入仓库），用真实 `public/snapshot.json` 作为数据源：

```text
PASS  同内容 → 指纹相同
PASS  仅顶层 ts 变化 → 指纹相同（避免脚本每次重跑都闪）
PASS  kpis.done 变化 → 指纹变化
PASS  task.title 变化 → 指纹变化
PASS  轮询启动，间隔可配置（5000ms）
PASS  内容未变 → 不调用 onSnapshot
PASS  统计：polls=1 applied=0 unchanged=1
PASS  kpis.done 变化 → 调用 onSnapshot 一次
PASS  应用后记录新指纹
PASS  再次轮询同内容 → 不重复 apply
PASS  content-type 非 JSON → fetchSnapshot 返回 null
PASS  轮询失败计数 +1，不抛异常
PASS  失败后恢复且内容未变 → 补拉成功但不重复 apply
PASS  成功后连续失败计数归零
PASS  document.hidden → 跳过轮询
PASS  已注册 visibilitychange 监听
PASS  恢复可见 → 立即补拉并 apply 变化后的快照
PASS  stop() 后 running=false
PASS  stop() 移除 visibilitychange 监听
PASS  stop() 清理 window 钩子
PASS  未显式传 intervalMs → 读取 window.__HQ_POLL_MS=5000
PASS  无配置 → 默认 30000ms

ALL PASS (fetch calls=7)
```

### 真实文件改动验证

按要求备份后把 `public/snapshot.json` 的 `kpis.done` 从 5 改成 6：

```text
baseline sig=dtz-1nmt7pf194c done=5
modified sig=dtz-2enkg10727h done=6
SIGNATURE CHANGED - PASS
...
restored hash match=True
sha=77EDB758B31E0B2959A828E5B9507F1491D3E4FBFDD94362297D1763E08474CD
TEST_EXIT=0
```

`public/snapshot.json` 已用备份覆盖恢复，恢复前后 SHA-256 一致，未留下脏数据。验证脚本不进入仓库。

未做浏览器实测：本次验证覆盖构建、指纹、轮询分支、content-type 拒绝、可见性暂停/恢复、配置优先级与清理逻辑；浏览器中的网络时序和视觉效果需在部署后人工确认。

## 风险与边界

1. **快照半写**：若服务端正在写 `snapshot.json`，浏览器可能读到截断 JSON → `res.json()` 抛错 → 保留旧快照并重试，不会污染世界。但若读到“结构合法但字段互相矛盾”的中间态，仍会应用。建议 `real-snapshot.js` 侧用临时文件 + rename 原子替换（该文件由另一位同事负责，本次未改）。
2. **Agent 集合/数量变化**：`HQScene` 在构造时按 `world.agents` 一次性建工位/实例，轮询会更新状态、任务、事件和部门负载，但**不会重建工位**；若快照里 agent 数量或顺序变化，3D 场景可能出现错位。按“不改渲染逻辑”的约束本次未处理，属于既有架构限制。
3. **定时器泄漏**：单实例 + 单个递归 `setTimeout`，`stop()`、页面隐藏、重复 `start()` 都会清理；HMR 通过 `window.__HQ_LIVE_STOP` 回收旧实例。未注册 `pagehide`，进入 bfcache 时由浏览器冻结定时器，返回时通常由 `visibilitychange` 恢复。
4. **隐藏期间的在途请求**：若请求发出后页面才隐藏，该请求仍可能完成并应用一次快照；之后不会继续轮询。影响仅限于一次更新。
5. **`ts` 不参与 diff**：只有 `ts` 变化时不会 apply，这是有意为之。若未来 UI 要做“最后更新时间”指示器，需要单独从快照或响应头读取。
6. **配置读取时机**：`window.__HQ_POLL_MS` 在启动时读取一次，运行中修改需重新加载页面（或重建轮询实例）。
7. **失败提示限流**：warn 每 5 分钟最多一次；成功恢复不会重置限流窗口，因此快速抖动也不会刷屏。排障时可看 `getLiveStats()` 的 `lastError` / `lastPollAt`。
