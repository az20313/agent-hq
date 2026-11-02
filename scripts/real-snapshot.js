#!/usr/bin/env node
import { sanitize } from './sanitize-snapshot.js'
'use strict'
/**
 * real-snapshot.js — 把真实智能体数据桥接成 agent-hq-upstream 的 Snapshot JSON
 *
 * 零依赖（只用 Node 内置模块），只读数据源，只写一个输出文件。
 *
 * 数据源（默认）：
 *   D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl
 *   D:\OpenClaw\workspace\projects\agent-hq\metrics-history.jsonl
 *   D:\OpenClaw\data\openclaw.json                    （agent 名单 / 显示名）
 *   D:\OpenClaw\data\state\openclaw.sqlite            （会话运行状态，只读）
 *
 * 输出：
 *   <repo>/public/snapshot.json   （可用 --out 改路径）
 *
 * 用法：
 *   node scripts/real-snapshot.js
 *   node scripts/real-snapshot.js --data-dir "D:\path\to\agent-hq" --out public/snapshot.json
 *   node scripts/real-snapshot.js --live        # 额外尝试 http://127.0.0.1:8900/api/state
 *   node scripts/real-snapshot.js --watch 5     # 每 5 秒重新生成（原子写，默认关闭）
 *   node scripts/real-snapshot.js --help
 *
 * 设计原则：
 *   - 真实字段直接用；推导字段在 meta 里写明
 *   - 拿不到的字段写 "未接"，不编造
 *   - 状态只根据“最近任务 / 最近会话”推断，证据超时一律 idle，不伪造 running
 *   - 不改 src/，不依赖 ts 源码
 *
 * 关键约束：上游 3D 场景用 `DEPTS.find(d => d.id === a.deptId)!` 直接取房间，
 * 未知 deptId 会让场景在初始化时抛错。因此“未分配”agent 不能写 deptId='unassigned'，
 * 必须落到一个真实房间渲染；真实未分配状态写在 meta.unassignedAgents。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* package.json 是 type:module，脚本用 ESM。Node >= 20.11 提供 import.meta.dirname */
const __dirname = import.meta.dirname

/* ------------------------------------------------------------------ 常量 */

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_DATA_DIR = 'D:\\OpenClaw\\workspace\\projects\\agent-hq'
const DEFAULT_SESSION_DB = 'D:\\OpenClaw\\data\\state\\openclaw.sqlite'
const DEFAULT_AGENTS_DIR = 'D:\\OpenClaw\\data\\agents'
const DEFAULT_OPENCLAW_CONFIGS = [
  'D:\\OpenClaw\\data\\openclaw.json',
  process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.openclaw', 'openclaw.json') : null,
].filter(Boolean)
const SNAPSHOT_VERSION = 2

/** 状态推断时间窗（可用 --running-window 等覆盖，单位分钟） */
const DEFAULT_WINDOWS = {
  runningMs: 120 * 60_000, // 任务/会话超过 2 小时没有新证据，不再算 running
  reviewMs: 24 * 60 * 60_000, // 待审批任务 24 小时内算 blocked
  errorMs: 60 * 60_000, // 失败 1 小时内算 error
}

/**
 * 上游 src/data/world.ts 的 DEPTS 镜像（顺序一致）。
 * 脚本启动时会读 world.ts 做一次一致性校验；不一致只告警，不阻断。
 */
const DEPTS = [
  { id: 'product', kind: 'dept' },
  { id: 'design', kind: 'dept' },
  { id: 'eng', kind: 'dept' },
  { id: 'market', kind: 'dept' },
  { id: 'ops', kind: 'dept' },
  { id: 'hr', kind: 'dept' },
  { id: 'fin', kind: 'dept' },
  { id: 'cs', kind: 'dept' },
  { id: 'data', kind: 'dept' },
  { id: 'strat', kind: 'dept' },
  { id: 'director', kind: 'director' },
  { id: 'meeting', kind: 'meeting' },
]
const DEPT_IDS = new Map(DEPTS.map((d, i) => [d.id, i]))
const BIZ_DEPTS = DEPTS.filter((d) => d.kind === 'dept')

/**
 * 现有 agent-hq 的“部门 → agent”表（index.html 的 DEPT_AGENT）。
 * 上游部门 id 与旧表不同，这里做一次显式别名，绝不静默猜测：
 *   dev → eng，finance → fin，chief → director，legal 在上游没有对应房间。
 */
const LEGACY_AGENT_DEPT = {
  worker2: 'product',
  worker3: 'design',
  assistant2: 'market',
  assistant3: 'ops',
  assistant4: 'dev',
  'knowledge-manager': 'hr',
  'data-analyst': 'finance',
  'security-audit': 'legal',
  main: 'chief',
}
const LEGACY_DEPT_TO_UPSTREAM = {
  product: 'product',
  design: 'design',
  market: 'market',
  ops: 'ops',
  dev: 'eng',
  hr: 'hr',
  finance: 'fin',
  legal: null, // 上游 DEPTS 没有“法务/安全”房间
  chief: 'director',
}

/** 任务里的中文 room → 上游部门 id。approx=true 表示上游没有严格对应部门。 */
const ROOM_MAP = {
  产品: { deptId: 'product', approx: false },
  产品部: { deptId: 'product', approx: false },
  product: { deptId: 'product', approx: false },
  设计: { deptId: 'design', approx: false },
  设计部: { deptId: 'design', approx: false },
  design: { deptId: 'design', approx: false },
  技术: { deptId: 'eng', approx: false },
  技术部: { deptId: 'eng', approx: false },
  研发: { deptId: 'eng', approx: false },
  研发部: { deptId: 'eng', approx: false },
  eng: { deptId: 'eng', approx: false },
  市场: { deptId: 'market', approx: false },
  市场部: { deptId: 'market', approx: false },
  market: { deptId: 'market', approx: false },
  运营: { deptId: 'ops', approx: false },
  运营部: { deptId: 'ops', approx: false },
  ops: { deptId: 'ops', approx: false },
  招聘: { deptId: 'hr', approx: false },
  招聘部: { deptId: 'hr', approx: false },
  人力: { deptId: 'hr', approx: false },
  hr: { deptId: 'hr', approx: false },
  财务: { deptId: 'fin', approx: false },
  财务部: { deptId: 'fin', approx: false },
  fin: { deptId: 'fin', approx: false },
  客服: { deptId: 'cs', approx: false },
  客服部: { deptId: 'cs', approx: false },
  cs: { deptId: 'cs', approx: false },
  数据: { deptId: 'data', approx: false },
  数据部: { deptId: 'data', approx: false },
  data: { deptId: 'data', approx: false },
  战略: { deptId: 'strat', approx: false },
  战略部: { deptId: 'strat', approx: false },
  strat: { deptId: 'strat', approx: false },
  总监: { deptId: 'director', approx: false },
  总监办: { deptId: 'director', approx: false },
  总监办公室: { deptId: 'director', approx: false },
  director: { deptId: 'director', approx: false },
  /* 安全部在上游 DEPTS 里没有对应房间；近似映射到研发部，meta 里会标记 */
  安全: { deptId: 'eng', approx: true },
  安全部: { deptId: 'eng', approx: true },
  security: { deptId: 'eng', approx: true },
}

/** 真实任务 state → 上游 TaskStatus */
const TASK_STATE_MAP = {
  queued: 'queued',
  pending: 'queued',
  scheduled: 'queued',
  split: 'queued',
  running: 'running',
  executing: 'running',
  review: 'review',
  awaiting_approval: 'review',
  done: 'done',
  completed: 'done',
  success: 'done',
  error: 'failed',
  failed: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
}

/* ------------------------------------------------------------------ 参数 */

function parseWatchValue(raw) {
  if (raw == null || raw === '') return { error: '--watch 需要一个秒数，例如 --watch 5' }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return { error: `--watch 必须是正整数秒，收到：${raw}` }
  return { value: n }
}

function parseArgs(argv) {
  const opts = {
    dataDir: DEFAULT_DATA_DIR,
    out: path.join(REPO_ROOT, 'public', 'snapshot.json'),
    live: false,
    quiet: false,
    watch: null,
    openclawConfig: null,
    agentsDir: DEFAULT_AGENTS_DIR,
    sessionDb: DEFAULT_SESSION_DB,
    fallbackDept: 'ops',
    windows: { ...DEFAULT_WINDOWS },
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--live') opts.live = true
    else if (a === '--quiet') opts.quiet = true
    else if (a === '--data-dir') opts.dataDir = argv[++i]
    else if (a.startsWith('--data-dir=')) opts.dataDir = a.slice('--data-dir='.length)
    else if (a === '--out') opts.out = argv[++i]
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length)
    else if (a === '--watch') {
      const r = parseWatchValue(argv[++i])
      if (r.error) {
        console.error('[real-snapshot] ' + r.error)
        opts.badArgs = true
      } else opts.watch = r.value
    } else if (a.startsWith('--watch=')) {
      const r = parseWatchValue(a.slice('--watch='.length))
      if (r.error) {
        console.error('[real-snapshot] ' + r.error)
        opts.badArgs = true
      } else opts.watch = r.value
    } else if (a === '--openclaw-config') opts.openclawConfig = argv[++i]
    else if (a.startsWith('--openclaw-config=')) opts.openclawConfig = a.slice('--openclaw-config='.length)
    else if (a === '--session-db') opts.sessionDb = argv[++i]
    else if (a.startsWith('--session-db=')) opts.sessionDb = a.slice('--session-db='.length)
    else if (a === '--no-session-db') opts.sessionDb = null
    else if (a === '--agents-dir') opts.agentsDir = argv[++i]
    else if (a.startsWith('--agents-dir=')) opts.agentsDir = a.slice('--agents-dir='.length)
    else if (a === '--no-agents-dir') opts.agentsDir = null
    else if (a === '--fallback-dept') opts.fallbackDept = argv[++i]
    else if (a.startsWith('--fallback-dept=')) opts.fallbackDept = a.slice('--fallback-dept='.length)
    else if (a === '--running-window') opts.windows.runningMs = Number(argv[++i]) * 60_000
    else if (a === '--review-window') opts.windows.reviewMs = Number(argv[++i]) * 60_000
    else if (a === '--error-window') opts.windows.errorMs = Number(argv[++i]) * 60_000
    else {
      console.error(`[real-snapshot] 未知参数: ${a}`)
      opts.badArgs = true
    }
  }
  if (!opts.dataDir) opts.dataDir = DEFAULT_DATA_DIR
  if (!opts.out) opts.out = path.join(REPO_ROOT, 'public', 'snapshot.json')
  if (!DEPT_IDS.has(opts.fallbackDept) || opts.fallbackDept === 'meeting') {
    console.error(`[real-snapshot] --fallback-dept 必须是 DEPTS 里的业务部门，收到：${opts.fallbackDept}`)
    opts.badArgs = true
  }
  for (const [k, v] of Object.entries(opts.windows)) {
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`[real-snapshot] 时间窗 ${k} 必须是正数`)
      opts.badArgs = true
    }
  }
  return opts
}

/* ------------------------------------------------------------------ 工具 */

function createContext(opts) {
  const ctx = {
    now: Date.now(),
    warnings: [],
    quiet: !!opts.quiet,
    roomWarned: new Set(),
    warn(msg) {
      ctx.warnings.push(msg)
      if (!ctx.quiet) console.error('[real-snapshot][warn] ' + msg)
    },
  }
  return ctx
}

function safeStat(p) {
  try {
    const s = fs.statSync(p)
    return { exists: true, mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return { exists: false }
  }
}

function readJsonl(file) {
  const stat = safeStat(file)
  if (!stat.exists) return { records: [], stat, badLines: [], totalLines: 0 }
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (e) {
    return { records: [], stat, badLines: [], totalLines: 0, error: String(e.message || e) }
  }
  const lines = raw.split(/\r?\n/)
  const records = []
  const badLines = []
  let totalLines = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    totalLines++
    try {
      const r = JSON.parse(line)
      if (r && typeof r === 'object') records.push({ ...r, __line: i + 1 })
      else badLines.push(i + 1)
    } catch {
      badLines.push(i + 1)
    }
  }
  return { records, stat, badLines, totalLines }
}

function clip(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

function uniq(arr) {
  return Array.from(new Set(arr))
}

/** 同步 sleep（只用于 Windows 文件占用重试，零依赖） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持时直接返回 */
  }
}

/** 原子写：同目录 tmp + rename，读者永远看到完整旧文件或完整新文件 */
function writeAtomic(outPath, body) {
  const dir = path.dirname(outPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(outPath)}.tmp-${process.pid}`)
  fs.writeFileSync(tmp, body, 'utf8')
  let lastErr = null
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, outPath)
      return
    } catch (e) {
      lastErr = e
      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(e.code)) break
      sleepSync(30)
    }
  }
  // Windows 上目标偶尔被扫描器短暂占用；最后退化为“先删再改名”（仍有完整 tmp 兜底）
  try {
    fs.unlinkSync(outPath)
  } catch {
    /* 目标不存在也没关系 */
  }
  try {
    fs.renameSync(tmp, outPath)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw lastErr || e
  }
}

/** 校验脚本里镜像的 DEPTS 与 world.ts 是否一致（只读、失败不阻断） */
function checkDeptsAgainstWorldTs(ctx) {
  const file = path.join(REPO_ROOT, 'src', 'data', 'world.ts')
  const stat = safeStat(file)
  if (!stat.exists) return { checked: false, reason: 'src/data/world.ts 不存在（仅运行脚本时正常）' }
  try {
    const src = fs.readFileSync(file, 'utf8')
    const m = src.match(/export const DEPTS[^=]*=\s*\[([\s\S]*?)\n\]/)
    if (!m) return { checked: false, reason: '未匹配到 DEPTS 数组' }
    const found = []
    const re = /\{\s*id:\s*'([^']+)'[\s\S]*?kind:\s*'([^']+)'/g
    let x
    while ((x = re.exec(m[1]))) found.push({ id: x[1], kind: x[2] })
    const expected = DEPTS.map((d) => `${d.id}:${d.kind}`).join(',')
    const actual = found.map((d) => `${d.id}:${d.kind}`).join(',')
    if (actual !== expected) {
      ctx.warn(`脚本镜像的 DEPTS 与 src/data/world.ts 不一致（脚本=${expected} 实际=${actual}）；请同步 real-snapshot.js`)
      return { checked: true, consistent: false, actual }
    }
    return { checked: true, consistent: true, count: found.length }
  } catch (e) {
    return { checked: false, reason: String(e.message || e) }
  }
}

/* ------------------------------------------------------------------ 真实数据读取 */

/** 优先文件；--live 时尝试 8900 /api/state（失败则回退文件） */
async function loadMetrics(dataDir, live, ctx) {
  const file = path.join(dataDir, 'metrics-history.jsonl')
  const parsed = readJsonl(file)
  let liveData = null
  let liveError = null
  if (live) {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 2500)
      const res = await fetch('http://127.0.0.1:8900/api/state', { signal: ac.signal })
      clearTimeout(timer)
      if (res.ok) {
        const j = await res.json()
        if (j && j.sessions) {
          liveData = {
            ts: Number(j.ts) || ctx.now,
            totalSessions: j.sessions.totalSessions,
            totalTokens: j.sessions.totalTokens,
            agents: j.sessions.agents,
          }
        }
      } else {
        liveError = `HTTP ${res.status}`
      }
    } catch (e) {
      liveError = String(e.message || e)
    }
  }

  const records = parsed.records.filter((r) => Number.isFinite(Number(r.ts)))
  const latest = records.length ? records.reduce((a, b) => (Number(a.ts) >= Number(b.ts) ? a : b)) : null

  if (liveData && liveData.agents && liveData.agents.length) {
    return {
      source: 'live-api',
      ts: liveData.ts,
      totalSessions: Number(liveData.totalSessions) || 0,
      totalTokens: Number(liveData.totalTokens) || 0,
      agents: liveData.agents.map((a) => ({
        agentId: String(a.agentId),
        sessions: Number(a.sessions) || 0,
        tokens: Number(a.tokens) || 0,
      })),
      file: { path: file, ...safeStat(file), records: records.length },
      liveError,
    }
  }

  if (!latest) {
    ctx.warn(`metrics-history.jsonl 无可用记录（${file}）`)
    return {
      source: 'none',
      ts: null,
      totalSessions: 0,
      totalTokens: 0,
      agents: [],
      file: { path: file, ...safeStat(file), records: 0 },
      liveError,
    }
  }

  return {
    source: 'metrics-history.jsonl',
    ts: Number(latest.ts),
    totalSessions: Number(latest.totalSessions) || 0,
    totalTokens: Number(latest.totalTokens) || 0,
    agents: Array.isArray(latest.agents)
      ? latest.agents.map((a) => ({
          agentId: String(a.agentId),
          sessions: Number(a.sessions) || 0,
          tokens: Number(a.tokens) || 0,
        }))
      : [],
    file: { path: file, ...safeStat(file), records: records.length },
    liveError,
  }
}

/** 读 openclaw 配置里的 agents.entries（只取 id / 显示名 / workspace） */
function loadOpenclawConfig(explicitPath, ctx) {
  const candidates = explicitPath ? [explicitPath] : DEFAULT_OPENCLAW_CONFIGS
  let lastError = null
  for (const p of candidates) {
    const stat = safeStat(p)
    if (!stat.exists) continue
    try {
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
      const j = JSON.parse(raw)
      const entries = j && j.agents && j.agents.entries
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        lastError = 'agents.entries 缺失或不是对象'
        ctx.warn(`openclaw 配置没有 agents.entries：${p}`)
        continue
      }
      const agents = Object.entries(entries).map(([id, v]) => ({
        id: String(id),
        name: String((v && v.identity && v.identity.name) || (v && v.name) || id),
        workspace: v && v.workspace ? String(v.workspace) : null,
      }))
      return { path: p, exists: true, mtimeMs: stat.mtimeMs, count: agents.length, agents }
    } catch (e) {
      lastError = String(e.message || e)
      ctx.warn(`openclaw 配置读取/解析失败：${p} ${lastError}`)
    }
  }
  if (explicitPath) ctx.warn(`指定的 openclaw 配置不存在或不可读：${explicitPath}`)
  else ctx.warn('未找到 openclaw 配置，agent 名单仅来自 metrics / 会话库 / tasks')
  return { path: explicitPath || candidates[0] || null, exists: false, agents: [], error: lastError }
}

/** 扫 D:\OpenClaw\data\agents\* 目录，作为配置/指标之外的最后一道名单兜底 */
function loadAgentDirs(agentsDir, ctx) {
  if (!agentsDir) return { path: null, exists: false, mtimeMs: null, agents: [], error: null }
  const stat = safeStat(agentsDir)
  if (!stat.exists) {
    ctx.warn(`agent 目录不存在：${agentsDir}（名单仅来自配置/metrics/会话库/tasks）`)
    return { path: agentsDir, exists: false, mtimeMs: null, agents: [], error: 'not found' }
  }
  try {
    const agents = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => {
        const s = safeStat(path.join(agentsDir, d.name))
        return { id: d.name, mtimeMs: s.mtimeMs || null }
      })
    return { path: agentsDir, exists: true, mtimeMs: stat.mtimeMs, agents, error: null }
  } catch (e) {
    ctx.warn(`agent 目录读取失败（${agentsDir}）：${e.message || e}`)
    return {
      path: agentsDir,
      exists: true,
      mtimeMs: stat.mtimeMs,
      agents: [],
      error: String(e.message || e),
    }
  }
}

/**
 * 只读打开 openclaw 会话状态库，取每个 agent / 每个 session 的最新事件。
 * 用 Node 内置 node:sqlite（>=22.5），不是第三方依赖；失败只告警，不影响快照生成。
 *
 * 事件 kind 只有 created / child_spawned / run_completed / run_failed：
 *   created / child_spawned 是“run 已开始但还没有结束事件” → 可作为 running 证据
 *   run_completed / run_failed 是结束事件
 */
async function loadSessionState(dbPath, ctx) {
  const empty = {
    source: 'disabled',
    path: dbPath,
    exists: false,
    sessions: 0,
    agents: new Map(),
    error: null,
  }
  if (!dbPath) return empty
  const stat = safeStat(dbPath)
  if (!stat.exists) {
    ctx.warn(`会话状态库不存在：${dbPath}（agent 状态只能按任务推断）`)
    return { ...empty, path: dbPath }
  }

  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (e) {
    ctx.warn(`当前 Node 不支持 node:sqlite（${e.message || e}），跳过会话状态`)
    return { ...empty, path: dbPath, error: String(e.message || e) }
  }

  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const latestRows = db
      .prepare(
        `select e.session_key, e.agent_id, e.kind, e.occurred_at
           from session_state_events e
           join (select session_key, max(sequence) as seq
                   from session_state_events
                  group by session_key) m
             on e.sequence = m.seq`
      )
      .all()
    const createdRows = db
      .prepare(`select session_key, min(occurred_at) as created_at from session_state_events group by session_key`)
      .all()
    const createdAt = new Map(createdRows.map((r) => [String(r.session_key), Number(r.created_at) || 0]))

    const agents = new Map()
    for (const r of latestRows) {
      const agentId = String(r.agent_id || '').trim()
      if (!agentId) continue
      let s = agents.get(agentId)
      if (!s) {
        s = {
          agentId,
          sessions: 0,
          openSessions: 0,
          latestOpenTs: 0,
          latestOpenSessionKey: null,
          lastEventTs: 0,
          lastEventKind: null,
          lastCompletedTs: 0,
          lastFailedTs: 0,
        }
        agents.set(agentId, s)
      }
      const kind = String(r.kind || '')
      const ts = Number(r.occurred_at) || 0
      const key = String(r.session_key || '')
      s.sessions++
      if (ts > s.lastEventTs) {
        s.lastEventTs = ts
        s.lastEventKind = kind
      }
      if (kind === 'created' || kind === 'child_spawned') {
        s.openSessions++
        if (ts > s.latestOpenTs) {
          s.latestOpenTs = ts
          s.latestOpenSessionKey = key
        }
      } else if (kind === 'run_completed') {
        if (ts > s.lastCompletedTs) s.lastCompletedTs = ts
      } else if (kind === 'run_failed') {
        if (ts > s.lastFailedTs) s.lastFailedTs = ts
      }
    }
    // 每个 session 的创建时间暂时不参与状态，但保留在返回值里方便排查
    return {
      source: 'openclaw-sqlite',
      path: dbPath,
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessions: latestRows.length,
      agents,
      createdAt,
      error: null,
    }
  } catch (e) {
    ctx.warn(`会话状态库读取失败（${dbPath}）：${e.message || e}`)
    return { ...empty, path: dbPath, exists: true, error: String(e.message || e) }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ 映射 */

function mapTaskStatus(state) {
  const key = String(state || '').trim().toLowerCase()
  if (TASK_STATE_MAP[key]) return { status: TASK_STATE_MAP[key], known: true }
  return { status: 'queued', known: false }
}

function mapRoom(roomRaw, directDeptId, ctx) {
  const direct = String(directDeptId || '').trim()
  if (direct && DEPT_IDS.has(direct) && direct !== 'meeting') {
    return { deptId: direct, approx: false, room: roomRaw || direct, via: 'deptId' }
  }
  const room = String(roomRaw || '').trim()
  const hit = ROOM_MAP[room] || ROOM_MAP[room.toLowerCase()]
  if (hit && hit.deptId !== 'meeting') {
    if (hit.approx && !ctx.roomWarned.has(room)) {
      ctx.roomWarned.add(room)
      ctx.warn(`room "${room}" 在上游没有严格对应部门，近似映射到 ${hit.deptId}（meta.roomMapping.approximate=true）`)
    }
    return { ...hit, room: room || '(空)', via: 'room' }
  }
  const key = room || '(空)'
  if (!ctx.roomWarned.has(key)) {
    ctx.roomWarned.add(key)
    ctx.warn(`未知 room "${key}"，兜底映射到 eng（近似）`)
  }
  return { deptId: 'eng', approx: true, room: key, via: 'fallback' }
}

/* ------------------------------------------------------------------ 状态推断 */

const EMPTY_SESSION = {
  sessions: 0,
  openSessions: 0,
  latestOpenTs: 0,
  latestOpenSessionKey: null,
  lastEventTs: 0,
  lastEventKind: null,
  lastCompletedTs: 0,
  lastFailedTs: 0,
}

/**
 * 纯函数：根据最近任务 + 最近会话推断 agent 状态。
 * 返回 { status, basis, reason }，basis = task | session | none。
 *
 * 规则（证据不足一律 idle，绝不默认 running）：
 *   1. running：未结束的 running 任务在 2h 内；或该 agent 的最新会话事件是
 *      created/child_spawned（run 已开始、尚无结束事件）且在 2h 内
 *   2. blocked：最近任务 review/awaiting_approval，且在 24h 内
 *   3. error：running/blocked 都不成立时，最近任务 failed 或最近会话 run_failed 在 1h 内
 *   4. idle：其余情况（含 queued / done / 过期证据）
 *
 * 注意不能只看“是否存在未完成 session”：worker2 这类 agent 可能有一个 66 分钟前
 * 卡住的 child_spawned，但 10 分钟前已经完成了另一个 run。以 agent 的最新事件为准，
 * 避免把已完成的 agent 误报成 running。
 */
function resolveAgentStatus({ latestTask, session, nowTs, windows = DEFAULT_WINDOWS }) {
  const s = session || EMPTY_SESSION
  const taskStarted = latestTask ? Number(latestTask.startedAt || latestTask.createdAt) || 0 : 0
  const taskFinished = latestTask ? Number(latestTask.finishedAt || latestTask.createdAt) || 0 : 0

  if (
    latestTask &&
    latestTask.status === 'running' &&
    !latestTask.finishedAt &&
    taskStarted > 0 &&
    nowTs - taskStarted <= windows.runningMs
  ) {
    return {
      status: 'running',
      basis: 'task',
      reason: `最近任务 ${latestTask.id} 处于 running，开始于 ${new Date(taskStarted).toISOString()}`,
    }
  }
  if (
    s.lastEventTs > 0 &&
    (s.lastEventKind === 'created' || s.lastEventKind === 'child_spawned') &&
    nowTs - s.lastEventTs <= windows.runningMs
  ) {
    return {
      status: 'running',
      basis: 'session',
      reason: `会话 ${s.latestOpenSessionKey || '(unknown)'} 最近事件 ${new Date(s.lastEventTs).toISOString()} 为 ${s.lastEventKind}（run 未完成）`,
    }
  }
  if (
    latestTask &&
    latestTask.status === 'review' &&
    taskFinished > 0 &&
    nowTs - taskFinished <= windows.reviewMs
  ) {
    return {
      status: 'blocked',
      basis: 'task',
      reason: `最近任务 ${latestTask.id} 待复核/审批（review），最后更新 ${new Date(taskFinished).toISOString()}`,
    }
  }
  if (
    latestTask &&
    latestTask.status === 'failed' &&
    taskFinished > 0 &&
    nowTs - taskFinished <= windows.errorMs &&
    taskFinished >= (s.lastCompletedTs || 0)
  ) {
    return {
      status: 'error',
      basis: 'task',
      reason: `最近任务 ${latestTask.id} 失败（${latestTask.error ? clip(latestTask.error, 60) : 'failed'}）`,
    }
  }
  if (s.lastFailedTs > (s.lastCompletedTs || 0) && nowTs - s.lastFailedTs <= windows.errorMs) {
    return {
      status: 'error',
      basis: 'session',
      reason: `最近会话 run_failed 于 ${new Date(s.lastFailedTs).toISOString()}，之后没有成功完成`,
    }
  }
  return {
    status: 'idle',
    basis: 'none',
    reason: latestTask
      ? `最近任务状态 ${latestTask.status}，无 2h 内 running / 24h 内 review / 1h 内 failed 证据`
      : '无任务记录，且无 2h 内未完成会话 run',
  }
}

/* ------------------------------------------------------------------ 校验 */

const AGENT_STATUS = new Set(['idle', 'standby', 'running', 'blocked', 'error', 'offline', 'meeting'])
const TASK_STATUS = new Set(['queued', 'running', 'review', 'done', 'failed'])
const EVENT_KIND = new Set(['start', 'tool', 'done', 'error', 'retry', 'queue', 'meeting'])

/** 运行时结构校验：保证输出真的是上游 Snapshot 形状 */
function validateSnapshot(s) {
  const errs = []
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

  if (!isObj(s.kpis)) errs.push('kpis 不是对象')
  else {
    for (const k of ['total', 'running', 'blocked', 'done', 'avgMin', 'tokens', 'progress', 'inMeeting']) {
      if (!isNum(s.kpis[k])) errs.push(`kpis.${k} 不是有限数字`)
    }
  }
  if (!Array.isArray(s.agents)) errs.push('agents 不是数组')
  else {
    if (!s.agents.length) errs.push('agents 为空')
    s.agents.forEach((a, i) => {
      for (const k of ['id', 'deptId', 'name', 'status']) {
        if (typeof a[k] !== 'string' || !a[k]) errs.push(`agents[${i}].${k} 缺失`)
      }
      if (!AGENT_STATUS.has(a.status)) errs.push(`agents[${i}].status=${a.status} 非法`)
      if (!DEPT_IDS.has(a.deptId)) errs.push(`agents[${i}].deptId=${a.deptId} 不在 DEPTS`)
      for (const k of ['deskIndex', 'tokens', 'heat']) if (!isNum(a[k])) errs.push(`agents[${i}].${k} 不是数字`)
      if (isNum(a.heat) && (a.heat < 0 || a.heat > 1)) errs.push(`agents[${i}].heat=${a.heat} 越界`)
      if (a.taskId !== null && typeof a.taskId !== 'string') errs.push(`agents[${i}].taskId 类型错误`)
      if (a.startedAt !== null && !isNum(a.startedAt)) errs.push(`agents[${i}].startedAt 类型错误`)
      if (a.seatIndex !== null && !isNum(a.seatIndex)) errs.push(`agents[${i}].seatIndex 类型错误`)
      if (a.role !== 'director' && a.role !== 'member') errs.push(`agents[${i}].role=${a.role} 非法`)
    })
    const ids = s.agents.map((a) => a.id)
    if (new Set(ids).size !== ids.length) errs.push('agents[].id 有重复')
  }
  if (!Array.isArray(s.tasks)) errs.push('tasks 不是数组')
  else {
    s.tasks.forEach((t, i) => {
      for (const k of ['id', 'deptId', 'agentId', 'title', 'summary', 'tool']) {
        if (typeof t[k] !== 'string') errs.push(`tasks[${i}].${k} 不是字符串`)
      }
      if (!DEPT_IDS.has(t.deptId)) errs.push(`tasks[${i}].deptId=${t.deptId} 不在 DEPTS`)
      if (!TASK_STATUS.has(t.status)) errs.push(`tasks[${i}].status=${t.status} 非法`)
      if (!isNum(t.progress) || t.progress < 0 || t.progress > 100) errs.push(`tasks[${i}].progress 越界`)
      for (const k of ['createdAt', 'durationMs', 'tokens']) if (!isNum(t[k])) errs.push(`tasks[${i}].${k} 不是数字`)
      if (t.finishedAt !== null && !isNum(t.finishedAt)) errs.push(`tasks[${i}].finishedAt 类型错误`)
      if (t.error !== undefined && typeof t.error !== 'string') errs.push(`tasks[${i}].error 类型错误`)
    })
  }
  if (!Array.isArray(s.events)) errs.push('events 不是数组')
  else {
    s.events.forEach((e, i) => {
      if (typeof e.id !== 'string' || typeof e.text !== 'string') errs.push(`events[${i}] 字段缺失`)
      if (!EVENT_KIND.has(e.kind)) errs.push(`events[${i}].kind=${e.kind} 非法`)
      if (!isNum(e.ts)) errs.push(`events[${i}].ts 不是数字`)
      for (const k of ['deptId', 'agentId', 'taskId']) if (typeof e[k] !== 'string') errs.push(`events[${i}].${k} 不是字符串`)
    })
  }
  if (!Array.isArray(s.deptLoad)) errs.push('deptLoad 不是数组')
  else {
    const ids = s.deptLoad.map((d) => d.id)
    if (ids.length !== DEPTS.length || DEPTS.some((d) => !ids.includes(d.id))) errs.push('deptLoad 未覆盖全部 DEPTS')
    s.deptLoad.forEach((d, i) => {
      for (const k of ['running', 'total', 'error', 'meeting']) if (!isNum(d[k])) errs.push(`deptLoad[${i}].${k} 不是数字`)
    })
  }
  if (s.meeting !== null) {
    if (!isObj(s.meeting)) errs.push('meeting 既不是 null 也不是对象')
    else if (!['gather', 'talking', 'closing'].includes(s.meeting.phase)) errs.push('meeting.phase 非法')
  }
  if (!isNum(s.ts)) errs.push('ts 不是数字')
  return errs
}

/* ------------------------------------------------------------------ 构建 Snapshot */

function resolveDeptForAgent(agentId, latestRawTask, ctx, opts) {
  const legacyDept = LEGACY_AGENT_DEPT[agentId] || null
  if (legacyDept) {
    const upstream = LEGACY_DEPT_TO_UPSTREAM[legacyDept]
    if (upstream) {
      return {
        deptId: upstream,
        source: 'dept-agent-table',
        tableMatch: true,
        legacyDept,
        approx: ['dev', 'finance', 'chief'].includes(legacyDept),
        reason: `现有 dept→agent 表：${legacyDept}=${agentId}`,
      }
    }
    // legal 这类旧部门在上游没有房间：先看最近任务房间，再落到 fallback
    if (latestRawTask) {
      const mapped = mapRoom(latestRawTask.room, latestRawTask.deptId, ctx)
      if (mapped.deptId !== 'meeting') {
        return {
          deptId: mapped.deptId,
          source: 'dept-agent-table+task-room',
          tableMatch: true,
          legacyDept,
          approx: true,
          reason: `表中 ${legacyDept}=${agentId} 在上游无对应房间；按最近任务 room「${mapped.room}」映射到 ${mapped.deptId}`,
        }
      }
    }
    return {
      deptId: opts.fallbackDept,
      source: 'fallback-unassigned',
      tableMatch: true,
      legacyDept,
      approx: true,
      reason: `表中 ${legacyDept}=${agentId} 在上游无对应房间，且无任务可佐证；渲染到 fallback=${opts.fallbackDept}`,
    }
  }

  if (latestRawTask) {
    const mapped = mapRoom(latestRawTask.room, latestRawTask.deptId, ctx)
    if (mapped.deptId !== 'meeting') {
      return {
        deptId: mapped.deptId,
        source: 'latest-task-room',
        tableMatch: false,
        legacyDept: null,
        approx: mapped.approx,
        reason: `不在 dept→agent 表；按最近任务 room「${mapped.room}」映射到 ${mapped.deptId}`,
      }
    }
  }

  return {
    deptId: opts.fallbackDept,
    source: 'fallback-unassigned',
    tableMatch: false,
    legacyDept: null,
    approx: true,
    reason: `不在 dept→agent 表，且无任务房间可佐证；真实部门未知，渲染到 fallback=${opts.fallbackDept}`,
  }
}

async function buildSnapshot(opts, ctx = createContext(opts)) {
  // 允许被测试/其他脚本直接 import 调用：补全默认值
  opts = {
    dataDir: DEFAULT_DATA_DIR,
    live: false,
    quiet: false,
    sessionDb: DEFAULT_SESSION_DB,
    openclawConfig: null,
    agentsDir: DEFAULT_AGENTS_DIR,
    fallbackDept: 'ops',
    windows: { ...DEFAULT_WINDOWS },
    ...opts,
  }
  if (opts.sessionDb === undefined) opts.sessionDb = DEFAULT_SESSION_DB
  if (opts.agentsDir === undefined) opts.agentsDir = DEFAULT_AGENTS_DIR
  if (!opts.fallbackDept) opts.fallbackDept = 'ops'
  opts.windows = { ...DEFAULT_WINDOWS, ...(opts.windows || {}) }

  const dataDir = path.resolve(opts.dataDir)
  const tasksFile = path.join(dataDir, 'tasks.jsonl')
  const tasksParsed = readJsonl(tasksFile)
  const deptCheck = checkDeptsAgainstWorldTs(ctx)
  const metrics = await loadMetrics(dataDir, opts.live, ctx)
  const openclaw = loadOpenclawConfig(opts.openclawConfig, ctx)
  const agentDirs = loadAgentDirs(opts.agentsDir, ctx)
  const sessions = await loadSessionState(opts.sessionDb, ctx)

  if (tasksParsed.badLines.length) {
    ctx.warn(`tasks.jsonl 有 ${tasksParsed.badLines.length} 行无法解析，已跳过（行号 ${tasksParsed.badLines.slice(0, 8).join(',')}）`)
  }
  if (tasksParsed.error) ctx.warn(`tasks.jsonl 读取失败：${tasksParsed.error}`)
  if (!tasksParsed.records.length) ctx.warn('tasks.jsonl 为空或不可读：tasks/events 将是空数组')

  const usedRoomMapping = new Map()
  const unknownStates = new Set()

  /* ---- tasks ---- */
  const tasks = []
  const latestRawTaskByAgent = new Map()
  for (const t of tasksParsed.records) {
    const mappedRoom = mapRoom(t.room, t.deptId, ctx)
    const key = `${mappedRoom.room} -> ${mappedRoom.deptId}${mappedRoom.approx ? ' (近似)' : ''}`
    if (!usedRoomMapping.has(key)) usedRoomMapping.set(key, mappedRoom)

    const st = mapTaskStatus(t.state)
    if (!st.known) unknownStates.add(String(t.state))
    const title = clip(t.text, 140) || '(空任务)'
    const agentId = String(t.agent || '').trim()
    if (!agentId) {
      ctx.warn(`任务 ${t.id || 'line ' + t.__line} 缺少 agent 字段，已跳过`)
      continue
    }

    const createdAt = Number(t.ts) || ctx.now
    const startedAt = Number(t.startedAt) || null
    const finishedAt = Number(t.finishedAt) || null
    const task = {
      id: String(t.id || `line_${t.__line}`),
      deptId: mappedRoom.deptId,
      agentId,
      title,
      summary: clip(t.reply || t.text || '', 220),
      status: st.status,
      /* 未接：真实任务没有实时进度；只有 done 能确定 100% */
      progress: st.status === 'done' ? 100 : 0,
      createdAt,
      finishedAt: st.status === 'done' || st.status === 'failed' || st.status === 'review' ? finishedAt : null,
      durationMs: startedAt && finishedAt && finishedAt >= startedAt ? finishedAt - startedAt : 0,
      /* 未接：tasks.jsonl 没有 tool 字段 */
      tool: '未接（TODO）',
      /* 未接：tasks.jsonl 没有逐任务 token */
      tokens: 0,
    }
    if (st.status === 'failed') {
      task.error = clip(t.error || '未接（原始记录无错误字段）', 120)
    }
    tasks.push(task)

    const ts = Number(t.ts) || 0
    const prev = latestRawTaskByAgent.get(agentId)
    if (!prev || ts >= prev.ts) {
      latestRawTaskByAgent.set(agentId, { room: t.room, deptId: t.deptId, ts, id: task.id })
    }
  }

  /* ---- roster：配置 ∪ 会话库 ∪ metrics ∪ tasks，缺一不可 ---- */
  const roster = new Map()
  const addRoster = (agentId, source, extra = {}) => {
    const id = String(agentId || '').trim()
    if (!id) return
    let cur = roster.get(id)
    if (!cur) {
      cur = { id, name: null, workspace: null, sources: [] }
      roster.set(id, cur)
    }
    if (!cur.sources.includes(source)) cur.sources.push(source)
    if (!cur.name && extra.name) cur.name = extra.name
    if (!cur.workspace && extra.workspace) cur.workspace = extra.workspace
  }
  for (const a of openclaw.agents) addRoster(a.id, 'openclaw-config', { name: a.name, workspace: a.workspace })
  for (const a of agentDirs.agents) addRoster(a.id, 'agent-dir')
  for (const a of metrics.agents) addRoster(a.agentId, 'metrics')
  for (const a of sessions.agents.keys()) addRoster(a, 'sessions')
  for (const t of tasks) addRoster(t.agentId, 'tasks')

  for (const r of roster.values()) if (!r.name) r.name = r.id
  if (roster.size < 12) {
    ctx.warn(`真实 agent 合并后只有 ${roster.size} 个（目标至少 12）；请检查 openclaw 配置 / metrics / 会话库`)
  }

  /* ---- agents ---- */
  const metricsByAgent = new Map(metrics.agents.map((a) => [a.agentId, a]))
  const tasksByAgent = new Map()
  for (const t of tasks) {
    if (!tasksByAgent.has(t.agentId)) tasksByAgent.set(t.agentId, [])
    tasksByAgent.get(t.agentId).push(t)
  }
  const latestTaskByAgent = new Map()
  for (const [agentId, list] of tasksByAgent) {
    latestTaskByAgent.set(
      agentId,
      list.slice().sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)))[0]
    )
  }

  const agents = []
  const agentStats = []
  const deptMapping = []
  const unassignedAgents = []
  const directorTaken = new Set()

  const agentIds = Array.from(roster.keys()).sort()
  for (const agentId of agentIds) {
    const r = roster.get(agentId)
    const m = metricsByAgent.get(agentId)
    const latestTask = latestTaskByAgent.get(agentId) || null
    const session = sessions.agents.get(agentId) || EMPTY_SESSION
    const statusInfo = resolveAgentStatus({ latestTask, session, nowTs: ctx.now, windows: opts.windows })

    let dept = resolveDeptForAgent(agentId, latestRawTaskByAgent.get(agentId) || null, ctx, opts)
    // 总监办公室只有一个真实工位：多出来的不做“删除”，改用 fallback 渲染并记录
    if (dept.deptId === 'director') {
      if (directorTaken.has('director')) {
        dept = {
          deptId: opts.fallbackDept,
          source: 'director-overflow',
          tableMatch: dept.tableMatch,
          legacyDept: dept.legacyDept,
          approx: true,
          reason: `总监办公室只有一个工位，${agentId} 溢出到 fallback=${opts.fallbackDept}`,
        }
        ctx.warn(`总监办公室已有 agent，${agentId} 渲染到 ${opts.fallbackDept}（meta.deptMapping 记录）`)
      } else {
        directorTaken.add('director')
      }
    }

    const taskDriven = statusInfo.basis === 'task' && latestTask
    const startedAt = taskDriven
      ? Number(latestTask.startedAt || latestTask.createdAt) || null
      : statusInfo.basis === 'session'
        ? Number(session.latestOpenTs) || null
        : null

    const agent = {
      id: agentId,
      deptId: dept.deptId,
      name: r.name || agentId,
      status: statusInfo.status,
      deskIndex: 0,
      taskId: taskDriven ? latestTask.id : null,
      tokens: m ? Number(m.tokens) || 0 : 0,
      startedAt,
      /* 视觉亮灯值，派生字段：running=1 / blocked|error=0.35 / idle=0 */
      heat: statusInfo.status === 'running' ? 1 : statusInfo.status === 'error' || statusInfo.status === 'blocked' ? 0.35 : 0,
      seatIndex: null,
      role: dept.deptId === 'director' ? 'director' : 'member',
    }
    agents.push(agent)

    const stat = {
      agentId,
      name: agent.name,
      deptId: dept.deptId,
      deptSource: dept.source,
      tableMatch: dept.tableMatch,
      legacyDept: dept.legacyDept,
      status: statusInfo.status,
      statusBasis: statusInfo.basis,
      statusReason: statusInfo.reason,
      sessions: m ? m.sessions : null,
      tokens: m ? m.tokens : null,
      sources: r.sources,
    }
    agentStats.push(stat)

    deptMapping.push({
      agentId,
      deptId: dept.deptId,
      source: dept.source,
      tableMatch: dept.tableMatch,
      legacyDept: dept.legacyDept,
      approx: dept.approx,
      reason: dept.reason,
    })

    if (dept.source === 'fallback-unassigned') {
      unassignedAgents.push({
        agentId,
        deptId: null,
        renderedDeptId: dept.deptId,
        sessions: m ? m.sessions : null,
        tokens: m ? m.tokens : null,
        reason: dept.reason,
      })
    }
  }

  // deskIndex 按部门内顺序重排（0..n-1），与上游 deskPositions 约定一致
  const seq = new Map()
  for (const a of agents) {
    const n = seq.get(a.deptId) || 0
    a.deskIndex = n
    seq.set(a.deptId, n + 1)
  }

  // 按 DEPTS 顺序排序，保证输出稳定
  agents.sort((a, b) => DEPT_IDS.get(a.deptId) - DEPT_IDS.get(b.deptId) || a.id.localeCompare(b.id))
  // 重新分配 deskIndex（排序后）
  const seq2 = new Map()
  for (const a of agents) {
    const n = seq2.get(a.deptId) || 0
    a.deskIndex = n
    seq2.set(a.deptId, n + 1)
  }

  /* ---- events：由真实任务时间戳派生（不是真实工具调用流） ---- */
  const events = []
  for (const t of tasks) {
    const agentName = t.agentId
    const base = { deptId: t.deptId, agentId: t.agentId, taskId: t.id }
    events.push({ ...base, id: `ev_${t.id}_start`, ts: t.createdAt, kind: 'start', text: `${agentName} 开始 ${t.title}` })
    if (t.status === 'done') {
      events.push({ ...base, id: `ev_${t.id}_done`, ts: t.finishedAt || t.createdAt, kind: 'done', text: `${agentName} 交付 ${t.title}` })
    } else if (t.status === 'failed') {
      events.push({ ...base, id: `ev_${t.id}_error`, ts: t.finishedAt || t.createdAt, kind: 'error', text: `${agentName} 异常 · ${t.error || '任务失败'}` })
    } else if (t.status === 'review') {
      events.push({ ...base, id: `ev_${t.id}_review`, ts: t.finishedAt || t.createdAt, kind: 'done', text: `${agentName} 交付待复核 ${t.title}` })
    } else if (t.status === 'queued') {
      events.push({ ...base, id: `ev_${t.id}_queue`, ts: t.createdAt, kind: 'queue', text: `${agentName} 排队 ${t.title}` })
    }
  }
  events.sort((a, b) => b.ts - a.ts)
  const eventsCapped = events.slice(0, 40)

  /* ---- deptLoad：按部门统计真实 agent（含空部门，保证 UI 有行） ---- */
  const loadMap = new Map(DEPTS.map((d) => [d.id, { id: d.id, running: 0, total: 0, error: 0, meeting: 0 }]))
  for (const a of agents) {
    const row = loadMap.get(a.deptId)
    if (!row) continue
    row.total++
    if (a.status === 'running') row.running++
    if (a.status === 'error') row.error++
    if (a.status === 'meeting') row.meeting++
  }

  /* ---- kpis ---- */
  const doneCount = tasks.filter((t) => t.status === 'done').length
  const durations = tasks.filter((t) => t.status === 'done' && t.durationMs > 0).map((t) => t.durationMs / 60000)
  const sumTokens = agentStats.reduce((s, a) => s + (Number.isFinite(a.tokens) ? Number(a.tokens) : 0), 0)
  const totalTokens = metrics.totalTokens || sumTokens

  const kpis = {
    total: tasks.length,
    running: agents.filter((a) => a.status === 'running').length,
    blocked: agents.filter((a) => a.status === 'blocked' || a.status === 'error').length,
    done: doneCount,
    avgMin: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    tokens: totalTokens,
    progress: tasks.length ? Math.min(100, (doneCount / tasks.length) * 100) : 0,
    inMeeting: 0,
  }

  /* ---- meta ---- */
  const latestMetricsTs = metrics.ts
  const latestTaskTs = tasks.reduce((m, t) => Math.max(m, Number(t.createdAt) || 0), 0)
  const latestSessionEventTs = Array.from(sessions.agents.values()).reduce(
    (m, s) => Math.max(m, Number(s.lastEventTs) || 0),
    0
  )
  // meta.generatedAt 取“数据截止时间”而不是墙钟：页面轮询用快照指纹去重，
  // 每 5 秒变化的 generatedAt/ageSeconds 会让数据没变也触发 applySnapshot。
  const dataAsOf = Math.max(latestMetricsTs || 0, latestTaskTs, latestSessionEventTs) || null
  const metricsAgeSeconds = latestMetricsTs ? Math.max(0, Math.round((ctx.now - latestMetricsTs) / 1000)) : null
  const tableMappedAgents = deptMapping.filter((d) => d.tableMatch).length
  const unassignedCount = unassignedAgents.length
  const meta = {
    generator: 'scripts/real-snapshot.js',
    version: SNAPSHOT_VERSION,
    generatedAt: dataAsOf ? new Date(dataAsOf).toISOString() : null,
    generatedAtNote: '数据截止时间（metrics/tasks/会话事件的最大时间），不是脚本运行墙钟；用于页面指纹去重',
    note: 'top-level meta 是上游 Snapshot 之外的附加字段，读取时忽略即可',
    source: {
      tasks: {
        path: tasksFile,
        exists: tasksParsed.stat.exists,
        mtime: tasksParsed.stat.mtimeMs ? new Date(tasksParsed.stat.mtimeMs).toISOString() : null,
        records: tasksParsed.records.length,
        parsedLines: tasksParsed.totalLines,
        badLines: tasksParsed.badLines,
      },
      metrics: {
        source: metrics.source,
        path: metrics.file.path,
        exists: metrics.file.exists,
        mtime: metrics.file.mtimeMs ? new Date(metrics.file.mtimeMs).toISOString() : null,
        records: metrics.file.records,
        latestTs: latestMetricsTs,
        latestAt: latestMetricsTs ? new Date(latestMetricsTs).toISOString() : null,
        /* ageSeconds 是墙钟相对值、每轮都会变，不放进快照；看 stats/控制台输出即可 */
        ageSeconds: undefined,
        liveError: metrics.liveError || null,
      },
      openclawConfig: {
        path: openclaw.path,
        exists: openclaw.exists,
        mtime: openclaw.mtimeMs ? new Date(openclaw.mtimeMs).toISOString() : null,
        entries: openclaw.agents.length,
        error: openclaw.error || null,
      },
      agentDirs: {
        path: agentDirs.path,
        exists: agentDirs.exists,
        count: agentDirs.agents.length,
        error: agentDirs.error || null,
      },
      sessionDb: {
        source: sessions.source,
        path: sessions.path,
        exists: sessions.exists,
        latestEventAt: latestSessionEventTs ? new Date(latestSessionEventTs).toISOString() : null,
        sessions: sessions.sessions,
        agents: sessions.agents.size,
        error: sessions.error || null,
      },
      deptCheck,
    },
    counts: {
      realAgents: roster.size,
      placedAgents: agents.length,
      tableMappedAgents,
      unassignedAgents: unassignedCount,
      tasks: tasks.length,
      done: doneCount,
      events: eventsCapped.length,
      totalSessions: metrics.totalSessions,
    },
    statusCounts: {
      idle: agents.filter((a) => a.status === 'idle').length,
      running: agents.filter((a) => a.status === 'running').length,
      blocked: agents.filter((a) => a.status === 'blocked').length,
      error: agents.filter((a) => a.status === 'error').length,
    },
    agentStats,
    deptMapping,
    unassignedAgents,
    roster: Array.from(roster.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => ({ id: a.id, name: a.name, workspace: a.workspace, sources: a.sources })),
    roomMapping: Array.from(usedRoomMapping.values()).map((r) => ({
      room: r.room,
      deptId: r.deptId,
      approximate: r.approx,
      via: r.via,
    })),
    statusRules: [
      { status: 'running', rule: '未结束的 running 任务且开始时间在 2h 内；或会话库有未完成 run 且最近事件在 2h 内' },
      { status: 'blocked', rule: '最近任务 review / awaiting_approval，且在 24h 内' },
      { status: 'error', rule: '最近任务 failed（1h 内），或最近会话 run_failed 晚于最近 run_completed（1h 内）' },
      { status: 'idle', rule: '无上述证据；包括 queued / done / 证据超时。绝不默认 running' },
    ],
    unknownStates: Array.from(unknownStates),
    derived: [
      { field: 'agents[]', from: 'openclaw 配置 ∪ 会话库 ∪ metrics ∪ tasks', note: '全部真实 agent 都落位；没有 metrics 的 agent tokens=0' },
      { field: 'agents[].status', from: '最近任务 + 会话库未完成 run', note: '见 statusRules；证据超时一律 idle' },
      { field: 'agents[].deptId', from: '现有 dept→agent 表 → 最近任务 room → fallback', note: 'fallback 只是渲染位，真实未分配见 unassignedAgents' },
      { field: 'agents[].heat', from: 'status', note: '视觉亮度，running=1 / blocked|error=0.35 / idle=0' },
      { field: 'agents[].taskId/startedAt', from: '状态由任务驱动时取该任务；由会话驱动时 taskId=null、startedAt=会话事件时间' },
      { field: 'events', from: '任务 ts/startedAt/finishedAt', note: '按生命周期合成，不是真实工具调用流' },
      { field: 'kpis.total/done/progress', from: 'tasks.jsonl 可见记录', note: '不是历史累计总数；文件被裁剪时会变小' },
      { field: 'kpis.tokens', from: 'metrics.totalTokens', note: 'OpenClaw 工作区累计 token，不是本快照内任务消耗' },
      { field: 'kpis.blocked', from: 'status=blocked 或 error 的 agent 数', note: '上游只有一个 blocked 指标，用作异常总数' },
      { field: 'deptLoad', from: 'agents[] 按 deptId 聚合', note: '空部门保留 0 行，供上游 UI/场景遍历' },
    ],
    todo: [
      { field: 'meeting', status: '未接', reason: '没有真实会议数据源，固定 null' },
      { field: 'tasks[].tool', status: '未接', reason: 'tasks.jsonl 无 tool 字段' },
      { field: 'tasks[].progress', status: '未接', reason: '无实时进度，仅 done=100，其余暂置 0' },
      { field: 'tasks[].tokens', status: '未接', reason: '无逐任务 token，kpis.tokens 用工作区累计值' },
      { field: 'events[].kind=tool', status: '未接', reason: '没有真实工具调用事件流' },
      { field: 'agents[].sessions', status: '未接', reason: 'Session 数只在 meta.agentStats 里，Agent 类型无此字段' },
      { field: 'unassignedAgents[].deptId', status: '未接', reason: '上游 DEPTS 没有“未分配”房间；不改 src 时只能渲染到 fallback' },
    ],
    warnings: ctx.warnings,
  }

  return {
    snapshot: {
      kpis,
      agents,
      tasks: tasks.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 60),
      events: eventsCapped,
      deptLoad: DEPTS.map((d) => loadMap.get(d.id)),
      meeting: null,
      ts: ctx.now,
      meta,
    },
    stats: {
      agents: agents.length,
      roster: roster.size,
      tasks: tasks.length,
      events: eventsCapped.length,
      kpis,
      unassigned: unassignedCount,
      tableMapped: tableMappedAgents,
      totalSessions: metrics.totalSessions,
      metricsSource: metrics.source,
      metricsAgeSeconds,
      statusCounts: meta.statusCounts,
      warnings: ctx.warnings,
    },
  }
}

/* ------------------------------------------------------------------ main */

function printHelp() {
  console.log(`真实数据桥：生成 agent-hq-upstream 需要的 Snapshot JSON

用法:
  node scripts/real-snapshot.js [选项]

选项:
  --data-dir DIR          真实数据目录（默认 ${DEFAULT_DATA_DIR}）
  --out FILE              输出文件（默认 <repo>/public/snapshot.json）
  --live                  先尝试 http://127.0.0.1:8900/api/state，失败回退 metrics-history.jsonl
  --watch SECONDS         每 N 秒重新生成一次（原子写 tmp+rename，默认关闭）
  --openclaw-config FILE  openclaw 配置路径（默认自动找 D:\\OpenClaw\\data\\openclaw.json）
  --agents-dir DIR        agent 目录（默认 ${DEFAULT_AGENTS_DIR}）
  --no-agents-dir         不扫 agent 目录
  --session-db FILE       会话状态库（默认 ${DEFAULT_SESSION_DB}）
  --no-session-db         不读会话库，仅按任务推断状态
  --fallback-dept ID      未分配 agent 的渲染部门（默认 ops）
  --running-window MIN    running 证据时间窗（默认 120 分钟）
  --review-window MIN     blocked 证据时间窗（默认 1440 分钟）
  --error-window MIN      error 证据时间窗（默认 60 分钟）
  --quiet                 不打印普通日志（警告仍走 stderr）
  --help                  显示本帮助

数据源（只读）:
  tasks.jsonl              真实任务队列
  metrics-history.jsonl    每 60s 的指标/agent 会话快照
  openclaw.json            agents.entries 提供完整 agent 名单/显示名
  openclaw.sqlite          session_state_events 提供未完成 run 证据

输出是上游 src/data/types.ts 的 Snapshot + 附加 meta 字段。
拿不到的字段写 "未接（TODO）"，详见 meta.todo。
`)
}

async function runOnce(opts, { silent = false } = {}) {
  const ctx = createContext(opts)
  const { snapshot, stats } = await buildSnapshot(opts, ctx)
  sanitize(snapshot)
  const errs = validateSnapshot(snapshot)
  if (errs.length) {
    for (const e of errs) console.error('[real-snapshot][validate] ' + e)
    throw new Error(`输出未通过 Snapshot 结构校验（${errs.length} 项）`)
  }
  const body = JSON.stringify(snapshot, null, 2) + '\n'
  const outPath = path.resolve(opts.out)
  writeAtomic(outPath, body)

  if (!opts.quiet && !silent) {
    const size = Buffer.byteLength(body, 'utf8')
    console.log('[real-snapshot] 输出: ' + outPath)
    console.log('[real-snapshot] 大小: ' + size + ' bytes (' + (size / 1024).toFixed(1) + ' KiB)')
    console.log(
      `[real-snapshot] agents=${stats.agents}/${stats.roster} tasks=${stats.tasks} events=${stats.events} unassigned=${stats.unassigned} tableMapped=${stats.tableMapped} sessions=${stats.totalSessions}`
    )
    console.log(
      `[real-snapshot] 状态: idle=${stats.statusCounts.idle} running=${stats.statusCounts.running} blocked=${stats.statusCounts.blocked} error=${stats.statusCounts.error}`
    )
    console.log(
      `[real-snapshot] kpis: total=${stats.kpis.total} done=${stats.kpis.done} running=${stats.kpis.running} blocked=${stats.kpis.blocked} progress=${stats.kpis.progress.toFixed(1)}% tokens=${stats.kpis.tokens}`
    )
    console.log(
      `[real-snapshot] metrics 来源=${stats.metricsSource} 数据年龄=${stats.metricsAgeSeconds == null ? 'n/a' : stats.metricsAgeSeconds + 's'}`
    )
    console.log('[real-snapshot] 结构校验: OK')
    if (stats.warnings.length) console.log(`[real-snapshot] 警告 ${stats.warnings.length} 条（见 meta.warnings）`)
  }
  return { stats, size: Buffer.byteLength(body, 'utf8'), outPath }
}

async function watchLoop(opts) {
  const intervalMs = opts.watch * 1000
  let busy = false
  let stopping = false
  let count = 0
  let timer = null

  const tick = async () => {
    if (busy || stopping) return
    busy = true
    count++
    try {
      const r = await runOnce(opts, { silent: true })
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      console.log(
        `[real-snapshot][watch ${t}] #${count} agents=${r.stats.agents} tasks=${r.stats.tasks} size=${r.size}B out=${r.outPath}`
      )
    } catch (e) {
      console.error(`[real-snapshot][watch] 第 ${count} 次生成失败：${e && e.message ? e.message : e}`)
    } finally {
      busy = false
    }
  }

  const stop = (sig) => {
    if (stopping) return
    stopping = true
    if (timer) clearInterval(timer)
    console.log(`[real-snapshot][watch] 收到 ${sig}，等待当前生成结束后退出（已生成 ${count} 次）`)
    const wait = setInterval(() => {
      if (!busy) {
        clearInterval(wait)
        process.exit(0)
      }
    }, 50)
    setTimeout(() => {
      clearInterval(wait)
      process.exit(0)
    }, 3000)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => stop('SIGBREAK'))

  console.log(`[real-snapshot][watch] 启动：每 ${opts.watch}s 生成一次，输出 ${path.resolve(opts.out)}（Ctrl+C 停止）`)
  await tick()
  timer = setInterval(tick, intervalMs)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    printHelp()
    process.exit(0)
  }
  if (opts.badArgs) process.exit(2)
  if (opts.watch) {
    await watchLoop(opts)
    return
  }
  await runOnce(opts)
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntrypoint) {
  main().catch((e) => {
    console.error('[real-snapshot] 失败: ' + (e && e.stack ? e.stack : e))
    process.exit(1)
  })
}

export {
  buildSnapshot,
  validateSnapshot,
  resolveAgentStatus,
  resolveDeptForAgent,
  mapRoom,
  writeAtomic,
  DEPTS,
  LEGACY_AGENT_DEPT,
  LEGACY_DEPT_TO_UPSTREAM,
  DEFAULT_WINDOWS,
}
