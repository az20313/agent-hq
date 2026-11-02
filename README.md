# AGENT HQ · 智能总部

等距 3D 办公楼形态的本机 Agent 监控大屏。房间 = 部门，工位 = Agent，地板光晕 / 屏幕亮灭 / 房间红灯对应实时任务状态。

**本机入口**：<http://127.0.0.1:8901/>（静态服务指向 `agent-hq-upstream/dist`）
**代码仓库**：<https://github.com/az20313/agent-hq>（`main` 当前为 `192e5ac`）

当前部署接本机真实快照（12 agents / 5 tasks）；没有快照或快照加载失败时，回退到内置模拟世界（48 agents，任务数随模拟推进变化）。

> 旧在线预览 <https://zhaoxinfeng619-hub.github.io/agent-hq/> 是早期单文件产物，未接入当前快照，不代表当前部署状态。

![preview](preview.png)

## 当前状态

截至 2026-11-03，按 `main`（`192e5ac`）与本机 8901 实跑结果：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 真实快照 | **已实现** | `public/snapshot.json` 当前 27,873 字节 / 12 agents / 5 tasks；`dist/snapshot.json` 为同一份内容。 |
| 浏览器接入 | **已实现** | 启动时 `fetch('./snapshot.json')`，成功后写入 `world`；`<html data-source="live">` 表示真实模式，`mock` 表示回退模拟世界。8901 已实测为 `live`；8904 指向同一构建产物，未单独复验。 |
| 30s 轮询 | **已实现** | 默认每 30,000 ms 拉一次快照；按快照指纹去重，数据没变不重复应用；页面隐藏时暂停，恢复可见时立即补拉。间隔可用 `window.__HQ_POLL_MS` 覆盖。 |
| 快照脱敏 | **已实现** | `scripts/sanitize-snapshot.js` 移除 `path` / `workspace` / `runId` / `sessionKey` / `sourcePath` / `dataDir` 等字段，并把 `tasks[].summary` 清空；当前快照不含盘符路径或会话键。 |
| 任务 `tool` / `progress` / `tokens` | **未接** | `tool` 固定 `"未接（TODO）"`；`progress` 只有 `done=100`，其余为 0；`tokens` 固定 0。 |
| 真实工具事件流 | **未接** | `events` 由任务生命周期时间戳合成，不是真实工具调用流。 |
| `meeting` 数据 | **未接** | 快照中 `meeting=null`、`kpis.inMeeting=0`、`agents[].seatIndex=null`，会议室不会出现真实会议。 |
| 会议编排 | **仅模拟世界** | 真实快照模式下 `world.paused=true`，模拟的会议、故障注入、自动派单全部停止；`?meet=1` / `?err=1` 不再生效。 |
| 端口 | 8901 使用中；8904 克隆产物；8900 已废弃；8902 预留 NAS | 8900 仅作为 `--live` 的可选旧数据源，不可用于新部署；8902 尚无实现。 |

当前快照的已知数字（来自 `public/snapshot.json` / `dist/snapshot.json`，生成时间 2026-11-02 23:27）：

- 12 个 Agent 全部落位：9 个按部门表映射，3 个（`creative-planner`、`integration-communication`、`openclaw`）走 `ops` 兜底；
- 5 条任务，全部 `done`、`progress=100%`；10 条派生事件；206 个会话；
- `kpis.running=3` 来自最近仍有未完成会话运行的 Agent，不是 3 条任务在跑；
- `kpis.tokens=15,535,235` 是 OpenClaw 工作区累计 Token，不是本快照内任务消耗。

## 快速开始

完整部署、回滚与故障排查见 [`DEPLOY.md`](DEPLOY.md)；本节只给最短路径。

```powershell
git clone https://github.com/az20313/agent-hq.git
cd agent-hq
npm ci
node scripts\real-snapshot.js
npm run build
# 静态服务脚本不在仓库内（本机路径见下），启动后访问 http://127.0.0.1:8901/
node D:\OpenClaw\workspace\projects\.agent-hq-static-server.mjs
```

验证：

```powershell
$page = Invoke-WebRequest http://127.0.0.1:8901/ -UseBasicParsing
$page.StatusCode
$snap = Invoke-WebRequest http://127.0.0.1:8901/snapshot.json -UseBasicParsing
$snap.StatusCode
$snap.Headers['Content-Type']
$snap.RawContentLength
```

预期：首页 `200 text/html`；快照 `200 application/json; charset=utf-8`，约 27.8 KB；浏览器 `<html>` 上出现 `data-source="live"`。

注意：

- Node.js 需 **>= 20.11**（`scripts/real-snapshot.js` 使用 `import.meta.dirname`）；读取会话运行证据还需 `node:sqlite`（Node >= 22.5），低版本会告警并跳过该证据，任务数据仍可生成。
- `real-snapshot.js` 默认读取本机 `D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl`、`metrics-history.jsonl`、`D:\OpenClaw\data\openclaw.json`、`D:\OpenClaw\data\agents` 与 `D:\OpenClaw\data\state\openclaw.sqlite`。换机器或换目录时用 `--data-dir` / `--openclaw-config` / `--agents-dir` / `--session-db` 指定；没有这些数据时可跳过生成，页面会回退模拟世界。
- `npm run build` 会把 `public/snapshot.json` 复制到 `dist/`；只重新生成 `public/` 不会影响正在服务的 `dist/`。
- 本机此前用 `npm install` 验证过安装，`npm ci` 未单独实测；构建与浏览器交互也没有在本次文档同步中重跑（详见 `DEPLOY.md` 第 8 节）。
- 静态服务器的 `ROOT` 是硬编码绝对路径，换目录/换机器需改脚本；8901 只监听 `127.0.0.1`，不对局域网开放。

## 交互

| 操作 | 效果 |
| --- | --- |
| 拖拽 | 旋转视角（方位角/俯仰角有限位） |
| 滚轮 | 缩放 |
| 点击房间 | 相机推近该房间，其他房间变暗，右侧任务流按部门过滤 |
| 点击工位 | 相机飞到该 Agent，弹出详情抽屉（任务进度、Token、会话流、重试） |
| 点击空白 | 回到全景 |
| 顶栏「巡游」 | 空闲时自动巡游到最活跃的房间 |
| 顶栏「全景」 | 复位视角并清除选中 |
| 左栏 chips / 房间条 | 按房间聚焦，再点一次取消 |

真实快照模式下，详情抽屉的「重试」、会议召集、异常注入等演示入口被禁用，避免伪造本机不存在的任务或会议。

## 调试用 URL 参数

| 参数 | 作用 |
| --- | --- |
| `?noboot=1` | 跳过开场 |
| `?noroam=1` | 不自动巡游 |
| `?focus=eng` | 聚焦某房间 |
| `?agent=eng-2` | 打开某 Agent 抽屉 |
| `?meet=1` | 立刻召集一场会议（仅模拟模式） |
| `?err=1` | 立刻注入一次异常（仅模拟模式） |
| `?noanim=1` | 跳过入场动画（截图用） |
| `?debug=1` | 左上角显示画质档位 / 帧时 / draw call / 三角面 / 会议状态 |
| `?pose=1` | 允许把参会人瞬移到座位（无头截图用，见下） |
| `?q=0\|1\|2` | 锁死画质档位（0 无泛光无阴影 / 1 无泛光 / 2 全开），验收截图用 |
| `?noshadow=1` | 只关阴影、保留泛光，排查阴影瑕疵用 |
| `?cam=theta,phi,radius,tx,ty,tz` | 直接落到指定机位（跳过缓动），无头截图取特写用 |

## 结构

```
src/
├─ scene/
│  ├─ HQScene.ts        # three.js 场景：灯光/墙体/家具/人形/光晕/行走/相机/拾取（不含业务逻辑）
│  ├─ geom.ts           # 自研几何合并器 mergeParts() + 家具搭建 DSL(Kit)
│  └─ textures.ts       # 全部程序化 Canvas 贴图 + 环境探针（带缓存）
├─ data/
│  ├─ types.ts          # 数据契约（Agent / Task / Ev / Meeting）
│  ├─ layout.ts         # 楼层几何、工位排布、会议席位（纯函数）
│  ├─ world.ts          # Mock 世界引擎 + applySnapshot()/paused；任务推进、会议编排、统计
│  └─ live.ts           # 快照 fetch、结构校验、30s 轮询、指纹去重、可见性暂停
├─ store/useHQ.ts       # zustand：世界 → UI 的节流快照 + 交互状态
├─ components/          # Stage / TopBar / LeftPanel / TaskTable / Ticker / Drawer
└─ styles/ui.css        # 设计 token + 全部样式

scripts/
├─ real-snapshot.js     # 真实快照生成器（只读输入，写 public/snapshot.json）
└─ sanitize-snapshot.js # 快照脱敏（路径、会话键、runId、任务摘要）
```

关键约定：**3D 场景只读 `world` 的可变对象，每帧渲染；React 只以 ~2.4fps 拿快照**。所以数据刷新频率不影响画面帧率。接真实数据时，启动阶段先 `world.applySnapshot()` 再挂载场景；之后 `world.paused=true`，模拟推进停止。

## 三个机制（仅模拟世界）

以下行为属于内置模拟世界；真实快照模式下 `world.paused=true`，这些机制不会运行。

**故障模型（不是每帧掷骰子）**：`nextChaosAt` 每 36–68 秒调度一次故障注入，同时异常 Agent 上限 2 个，8–14 秒后自动恢复重试。这样大屏上永远能看到告警，但不会被红色淹没。

**会议编排**：每 42–72 秒召集一场，跨部门挑 3–4 人（总监六成概率到场主持），持续 15–21 秒。参会人 `status = 'meeting'`，任务进度冻结；散会时若原任务仍在跑就恢复，否则重新排队。

**行走路径**：`buildRoute()` 把人从工位引到所在排的前廊 → 中央通廊（x=0）→ 会议室。总监室右侧、会议室左侧刻意不建墙，通廊两侧连通，人是从开口走进去的，不是穿墙。

## 真实数据桥

真实数据只读，生成器不写 `tasks.jsonl` / `metrics-history.jsonl`，不调用 Agent，不触碰 NAS。

```text
tasks.jsonl ───────────────┐
metrics-history.jsonl ─────┤
openclaw.json / agents /   ├─> scripts/real-snapshot.js ─> public/snapshot.json
openclaw.sqlite ───────────┘        （映射 / 派生 / 校验 / 脱敏）
                                                              │ npm run build 复制
                                                              ▼
                                                        dist/snapshot.json
                                                              │ 浏览器启动 + 30s 轮询
                                                              ▼
                                              fetchSnapshot() -> world.applySnapshot()
```

字段支持情况：

| 字段 | 来源 | 状态 |
| --- | --- | --- |
| `tasks` / 任务状态 / 起止时间 / 部门 | `tasks.jsonl` | 能接 |
| `agents[].tokens` / `kpis.tokens` / 会话数 | `metrics-history.jsonl` | 能接（累计值，非本快照消耗） |
| `agents[].status` | 最近任务 + 2h 内未完成会话运行证据 | 派生；无证据回落 `idle` |
| `agents[].deptId/deskIndex/heat` | 部门表 + 最近任务 | 派生，不是实时心跳 |
| `events` | 任务生命周期时间戳 | 派生，不是真实工具调用流 |
| `meeting` | 无真实来源 | **未接**，固定 `null` |
| `tasks[].tool` | 无来源 | **未接**，固定 `"未接（TODO）"` |
| `tasks[].progress` | 无实时进度 | **未接**，仅 `done=100`，其余 `0` |
| `tasks[].tokens` | 无逐任务 Token | **未接**，固定 `0` |
| `agents[].seatIndex` | 无会议 | **未接**，固定 `null` |

更新快照：

```powershell
node scripts\real-snapshot.js
npm run build
```

页面会在 30 秒内自动应用新快照，不需要手动刷新；但生成器本身不会自动运行，仍需手动执行或外部定时任务。更细的字段映射与验收记录见 [`DEPLOY.md`](DEPLOY.md)、`INTEGRATION.md`、`REAL-DATA-BRIDGE-REPORT.md`。

## 材质与建模

没有美术资源，全部由代码生成，靠这三件事把低模做出“精模感”。

**贴图（`textures.ts`）**——都是离屏 Canvas 画完 `CanvasTexture` 出来，按 key 缓存只生成一次，随机数用 `mulberry32` 固定种子保证每次打开一样：

| 贴图 | 用途 |
| --- | --- |
| `carpetTexture` / `noiseTexture` | 部门地毯：方块拼缝 + 纤维噪声，同时当 `bumpMap` 与 `roughnessMap` |
| `laminateTexture` / `darkWoodTexture` | 工位台面 / 总监大班台与书墙 |
| `monitorTexture` | 工位屏：代码行 + 行号 + 光标，随机 8 种版面 |
| `bigScreenTexture` / `whiteboardTexture` | 总监指挥屏 / 会议室白板与墙面大屏 |
| `booksTexture` / `artTexture` | 书脊阵列 / 挂画 |
| `rugTexture` / `conferenceTexture` | 中庭地毯纹样 / 会议桌内嵌皮革 |
| `radialTexture` / `spriteTexture` / `bandTexture` / `gridTexture` | 地面光晕 / 呼吸光点 / 窗光带 / 底网格 |
| `makeEnvironment` | 程序化等距柱状环境图经 `PMREMGenerator` 烘成 `scene.environment`，金属与木作才有反射层次 |

**几何（`geom.ts`）**——`mergeParts()` 把几十个小体块烘成单个 `BufferGeometry`（自己拼 position/normal/uv，不引 `BufferGeometryUtils`，避免 Vite 依赖重优化把 dev server 搞崩）；`Kit` 提供 `box/cyl/ball/torus/slab/legs`，其中 `slab()` 生成带凸沿的台面——凸沿是“这不是盒子”的关键。`scaleUV()` 按世界尺寸缩放 UV，避免贴图被拉伸。

**光照与阴影**——ACES 色调映射 + 曝光 1.2；一盏主平行光 `(-16, 20, 12)` 开 2048 阴影（`PCFSoftShadowMap`，`normalBias 0.02` / `radius 2.4`）负责椅子桌子的落地投影，一盏补光 + 一盏轮廓光 + 半球光；墙体烘了顶点色垂直渐变（`0.74 + y·0.3`）近似 AO，顶部一条部门色亮边把 12 个房间读成整体而不是网格。

家具清单：工位每席 9 件配件（键盘/鼠标/屏框/支架/杯/纸/气压杆/五星脚/扶手），中庭是沙发休息区（三人沙发+抱枕+茶几+单人椅+落地灯+书架），总监办公室 20+ 件（大班台+皮革挡板+老板椅+三块弧形指挥屏+会客区+书墙+挂画），会议室是 8 席长桌+两条吊灯轨道+茶水柜。

> 人物仍是程序化胶囊体，等 Blender 模型接入后替换 `bodyMesh` / `headMesh`。

## 性能

以下数字来自模拟世界（48 agents）的实测；真实快照当前只有 12 agents，draw call / 三角面会不同，未重新测量。

| 项 | 做法 |
| --- | --- |
| Draw call | 实测 **172**（≈117k 三角面）。48 面墙 + 48 条亮边按材质合并成 InstancedMesh，矮柜/绿植/垃圾桶/会议桌腿等同类件各 1 个 InstancedMesh；原来 130+ 独立 mesh |
| 光源 | 1 主平行光（唯一投影源）+ 1 补光 + 1 轮廓光 + 环境/半球光；早先每个房间一盏点光会拖垮前向渲染 |
| 静态实例 | 桌/底座/屏/椅/椅背/全部家具矩阵只在初始化写一次（StaticDrawUsage），每帧只更新人形与头部 |
| 小件合并 | 桌面配件、办公椅底盘把手等用 `mergeParts()` 烘成单体几何，避免每件一个 draw call |
| 动态数据 | `world.deptLoad()` 带版本号缓存，3D 每帧读它不再产生任何数组分配（原先是每帧 2 次 × 30 个数组） |
| 后处理 | UnrealBloom 跑在 0.7 分辨率上 |
| 分辨率 | dpr 上限 1.5，按帧时自动降档：>26ms → dpr 1.1，>33ms → 关泛光并关阴影、dpr 1 |
| 统计 | `renderer.info.autoReset = false` + 每帧 `reset()`，`?debug=1` 面板里的 draw/tri 是真实值而不是 1 |
| 标签 | 房间悬浮标签每 2 帧更新一次（省一半 DOM 写入） |

降档逻辑在 `checkPerf() / applyQuality()`，跳过前 2 个采样窗口避免着色器编译误判。

## 无头截图注意

本机 Chrome `--headless=new` + `--virtual-time-budget` 下 **requestAnimationFrame 几乎不推进**，`clock.getDelta()` 返回 0，所以行走/脉冲这类逐帧动画截不到。为此：

- `tick` 里给 dt 加了 4ms 下限，避免真实低帧率设备上动画卡死；
- `?pose=1` 可把参会人直接瞬移到座位，用来验证入座姿态；
- `?noanim=1` 跳过 CSS 入场动画，否则面板可能截成 opacity 0。

## 已知限制

1. **数据仍是“半真实”**：Agent 列表来自 `openclaw.json` / `data/agents` / `metrics-history.jsonl` 与 `tasks.jsonl` 的并集；任务来自 `tasks.jsonl`；`tool`、逐任务 `progress`、逐任务 `tokens`、真实工具事件流均未接。
2. **Agent 状态是推导值**：按最近任务状态与 2h 内未完成会话运行证据推导，不是实时心跳；无证据时回落 `idle`。当前 `running=3` 也是会话证据，不代表 3 条任务在跑。
3. **12 个 Agent 全部落位，但部分部门是兜底映射**：9 个按部门表直接映射，3 个（`creative-planner`、`integration-communication`、`openclaw`）落到 `ops`，部门归属可能不准确；明细在 `meta.unassignedAgents` / `meta.agentStats`。
4. **会议完全未接**：`meeting=null`、`inMeeting=0`、`seatIndex=null`，会议室永远空闲；真实模式下会议编排、故障注入、自动派单都被 `paused` 禁用。
5. **KPI 口径不完全等价**：`kpis.total/done` 只是 `tasks.jsonl` 当前可见记录数，不是历史累计；文件被裁剪时数字会变小。
6. **`kpis.tokens` 是工作区累计 Token**，不是本快照内任务消耗；`tasks[].tokens` 恒为 0。
7. **部门映射有近似**：`安全部 → eng`（上游没有安全部房间），未知 room 兜底到 `eng`，3 个无部门 Agent 兜底到 `ops`，都会在 `meta.roomMapping` / `meta.warnings` 标注。
8. **前端会轮询，但数据生成不会自动刷新**：页面每 30s 拉一次 `snapshot.json`；生成器仍需手动执行或外部定时任务，生成后还要 `npm run build`（或直接写 `dist/snapshot.json`）。
9. **场景不能热更新 Agent 集合**：轮询会更新数据，但 `HQScene` 在构造时按 `world.agents` 建实例网格，Agent 数量/顺序变化仍可能错位。
10. **代码已推送，快照数据仍可能与提交版不同**：桥接、轮询、脱敏、`data-source` 修复均已提交并推送到 `192e5ac`；但 `HEAD` 里的 `public/snapshot.json` 是 15,213 字节 / 3 个落位 Agent，当前工作区的 27,873 字节 / 12 个 Agent 快照尚未包含在该提交中。clone 后请按「快速开始」重新生成。
11. **构建与浏览器验收未由本次文档同步重跑**：8901 已实测 `<html data-source="live">`；8904 指向同一构建产物但未单独复验；`npm ci`、`npm run build` 的实际输出引用 `DEPLOY.md` 的记录。
12. **NAS / 8902 未落地**：仓库内没有相关实现；当前服务只监听 `127.0.0.1:8901`。8900 已废弃，仅作为 `real-snapshot.js --live` 的可选旧数据源，失败会自动回退文件。
13. **静态服务器无缓存控制/无 404 语义**：所有缺失路径都回退 `index.html`，排查时不能只看 HTTP 200；`ROOT` 是硬编码绝对路径。
14. **单文件边界**：`dist/index.html` 是单文件，但 `snapshot.json` 是单独复制到 `dist/` 的；只拷 `index.html` 到别处双击会因拿不到快照而回退模拟世界。
15. **浏览器最低版本未验证**：项目依赖 WebGL，具体最低 Chrome/Firefox/Safari 版本未测试；`?pose=1` / 无头截图行为也受 Chrome 版本影响。
