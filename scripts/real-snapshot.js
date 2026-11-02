#!/usr/bin/env node
'use strict'
/**
 * real-snapshot.js — 把真实智能体数据桥接成 agent-hq-upstream 的 Snapshot JSON
 *
 * 零依赖（只用 Node 内置模块），只读数据源，只写一个输出文件。
 *
 * 数据源（默认）：
 *   D:\OpenClaw\workspace\projects\agent-hq\tasks.jsonl
 *   D:\OpenClaw\workspace\projects\agent-hq\metrics-history.jsonl
 *
 * 输出：
 *   <repo>/public/snapshot.json   （可用 --out 改路径）
 *
 * 用法：
 *   node scripts/real-snapshot.js
 *   node scripts/real-snapshot.js --data-dir "D:\path\to\agent-hq" --out public/snapshot.json
 *   node scripts/real-snapshot.js --live        # 额外尝试 http://127.0.0.1:8900/api/state
 *   node scripts/real-snapshot.js --help
 *
 * 设计原则：
 *   - 真实字段直接用；推导字段在 meta.todo / meta.derived 里写明
 *   - 拿不到的字段写 "未接"，不编造
 *   - 不改 src/，不依赖 ts 源码
 */

import fs from 'node:fs'
import path from 'node:path'

/* package.json 是 type:module，脚本用 ESM。Node >= 20.11 提供 import.meta.dirname */
const __dirname = import.meta.dirname

/* ------------------------------------------------------------------ 常量 */

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_DATA_DIR = 'D:\\OpenClaw\\workspace\\projects\\agent-hq'
const SNAPSHOT_VERSION = 1

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

function parseArgs(argv) {
  const opts = { dataDir: DEFAULT_DATA_DIR, out: path.join(REPO_ROOT, 'public', 'snapshot.json'), live: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--live') opts.live = true
    else if (a === '--data-dir') opts.dataDir = argv[++i]
    else if (a.startsWith('--data-dir=')) opts.dataDir = a.slice('--data-dir='.length)
    else if (a === '--out') opts.out = argv[++i]
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length)
    else if (a === '--quiet') opts.quiet = true
    else {
      console.error(`[real-snapshot] 未知参数: ${a}`)
      opts.badArgs = true
    }
  }
  if (!opts.dataDir) opts.dataDir = DEFAULT_DATA_DIR
  if (!opts.out) opts.out = path.join(REPO_ROOT, 'public', 'snapshot.json')
  return opts
}

/* ------------------------------------------------------------------ 工具 */

const now = Date.now()
const warnings = []
let quietMode = false
const warn = (msg) => {
  warnings.push(msg)
  if (!quietMode) console.error('[real-snapshot][warn] ' + msg)
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
    raw = fs.readFileSync(file, 'utf8')
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

function sortedAscByTs(records) {
  return records
    .filter((r) => Number.isFinite(Number(r.ts)))
    .sort((a, b) => Number(a.ts) - Number(b.ts))
}

/** 校验脚本里镜像的 DEPTS 与 world.ts 是否一致（只读、失败不阻断） */
function checkDeptsAgainstWorldTs() {
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
      warn(`脚本镜像的 DEPTS 与 src/data/world.ts 不一致（脚本=${expected} 实际=${actual}）；请同步 real-snapshot.js`)
      return { checked: true, consistent: false, actual }
    }
    return { checked: true, consistent: true, count: found.length }
  } catch (e) {
    return { checked: false, reason: String(e.message || e) }
  }
}

/* ------------------------------------------------------------------ 真实数据读取 */

/** 优先文件；--live 时尝试 8900 /api/state（失败则回退文件） */
async function loadMetrics(dataDir, live) {
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
        if (j && j.sessions) liveData = { ts: Number(j.ts) || now, totalSessions: j.sessions.totalSessions, totalTokens: j.sessions.totalTokens, agents: j.sessions.agents }
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
      agents: liveData.agents.map((a) => ({ agentId: String(a.agentId), sessions: Number(a.sessions) || 0, tokens: Number(a.tokens) || 0 })),
      file: { path: file, ...safeStat(file), records: records.length },
      liveError,
    }
  }

  if (!latest) {
    warn(`metrics-history.jsonl 无可用记录（${file}）`)
    return { source: 'none', ts: null, totalSessions: 0, totalTokens: 0, agents: [], file: { path: file, ...safeStat(file), records: 0 }, liveError }
  }

  return {
    source: 'metrics-history.jsonl',
    ts: Number(latest.ts),
    totalSessions: Number(latest.totalSessions) || 0,
    totalTokens: Number(latest.totalTokens) || 0,
    agents: Array.isArray(latest.agents)
      ? latest.agents.map((a) => ({ agentId: String(a.agentId), sessions: Number(a.sessions) || 0, tokens: Number(a.tokens) || 0 }))
      : [],
    file: { path: file, ...safeStat(file), records: records.length },
    liveError,
  }
}

/* ------------------------------------------------------------------ 映射 */

function mapTaskStatus(state) {
  const key = String(state || '').trim().toLowerCase()
  if (TASK_STATE_MAP[key]) return { status: TASK_STATE_MAP[key], known: true }
  return { status: 'queued', known: false }
}

const reportedRoomWarnings = new Set()

function mapRoom(roomRaw, directDeptId) {
  const direct = String(directDeptId || '').trim()
  if (direct && DEPT_IDS.has(direct) && direct !== 'meeting') {
    return { deptId: direct, approx: false, room: roomRaw || direct, via: 'deptId' }
  }
  const room = String(roomRaw || '').trim()
  const hit = ROOM_MAP[room] || ROOM_MAP[room.toLowerCase()]
  if (hit && hit.deptId !== 'meeting') {
    if (hit.approx && !reportedRoomWarnings.has(room)) {
      reportedRoomWarnings.add(room)
      warn(`room "${room}" 在上游没有严格对应部门，近似映射到 ${hit.deptId}（meta.roomMapping.approximate=true）`)
    }
    return { ...hit, room: room || '(空)', via: 'room' }
  }
  if (!reportedRoomWarnings.has(room || '(空)')) {
    reportedRoomWarnings.add(room || '(空)')
    warn(`未知 room "${room || '(空)'}"，兜底映射到 eng（近似）`)
  }
  return { deptId: 'eng', approx: true, room: room || '(空)', via: 'fallback' }
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
    s.agents.forEach((a, i) => {
      for (const k of ['id', 'deptId', 'name', 'status']) if (typeof a[k] !== 'string' || !a[k]) errs.push(`agents[${i}].${k} 缺失`)
      if (!AGENT_STATUS.has(a.status)) errs.push(`agents[${i}].status=${a.status} 非法`)
      if (!DEPT_IDS.has(a.deptId)) errs.push(`agents[${i}].deptId=${a.deptId} 不在 DEPTS`)
      for (const k of ['deskIndex', 'tokens', 'heat']) if (!isNum(a[k])) errs.push(`agents[${i}].${k} 不是数字`)
      if (a.taskId !== null && typeof a.taskId !== 'string') errs.push(`agents[${i}].taskId 类型错误`)
      if (a.startedAt !== null && !isNum(a.startedAt)) errs.push(`agents[${i}].startedAt 类型错误`)
      if (a.seatIndex !== null && !isNum(a.seatIndex)) errs.push(`agents[${i}].seatIndex 类型错误`)
      if (a.role !== 'director' && a.role !== 'member') errs.push(`agents[${i}].role=${a.role} 非法`)
    })
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
    })
  }
  if (!Array.isArray(s.events)) errs.push('events 不是数组')
  else {
    s.events.forEach((e, i) => {
      if (typeof e.id !== 'string' || typeof e.text !== 'string') errs.push(`events[${i}] 字段缺失`)
      if (!EVENT_KIND.has(e.kind)) errs.push(`events[${i}].kind=${e.kind} 非法`)
      for (const k of ['ts']) if (!isNum(e[k])) errs.push(`events[${i}].${k} 不是数字`)
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

async function buildSnapshot(opts) {
  const dataDir = path.resolve(opts.dataDir)
  const tasksFile = path.join(dataDir, 'tasks.jsonl')
  const tasksParsed = readJsonl(tasksFile)
  const deptCheck = checkDeptsAgainstWorldTs()
  const metrics = await loadMetrics(dataDir, opts.live)

  if (tasksParsed.badLines.length) warn(`tasks.jsonl 有 ${tasksParsed.badLines.length} 行无法解析，已跳过（行号 ${tasksParsed.badLines.slice(0, 8).join(',')}）`)
  if (tasksParsed.error) warn(`tasks.jsonl 读取失败：${tasksParsed.error}`)
  if (!tasksParsed.records.length) warn('tasks.jsonl 为空或不可读：tasks/agents/events 将是空数组')

  const usedRoomMapping = new Map()
  const unknownStates = new Set()

  /* ---- tasks ---- */
  const tasks = []
  for (const t of tasksParsed.records) {
    const mappedRoom = mapRoom(t.room, t.deptId)
    const key = `${mappedRoom.room} -> ${mappedRoom.deptId}${mappedRoom.approx ? ' (近似)' : ''}`
    if (!usedRoomMapping.has(key)) usedRoomMapping.set(key, mappedRoom)

    const st = mapTaskStatus(t.state)
    if (!st.known) unknownStates.add(String(t.state))
    const title = clip(t.text, 140) || '(空任务)'
    const agentId = String(t.agent || '').trim()
    if (!agentId) warn(`任务 ${t.id || 'line ' + t.__line} 缺少 agent 字段，已跳过`)
    if (!agentId) continue

    const createdAt = Number(t.ts) || now
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
      finishedAt: st.status === 'done' || st.status === 'failed' ? finishedAt : null,
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
  }

  /* ---- agents ---- */
  const metricsByAgent = new Map(metrics.agents.map((a) => [a.agentId, a]))
  const tasksByAgent = new Map()
  for (const t of tasks) {
    if (!tasksByAgent.has(t.agentId)) tasksByAgent.set(t.agentId, [])
    tasksByAgent.get(t.agentId).push(t)
  }
  // 每个真实 agent 的“最近任务”用于推导部门/状态
  const latestTaskByAgent = new Map()
  for (const [agentId, list] of tasksByAgent) {
    latestTaskByAgent.set(agentId, list.slice().sort((a, b) => b.createdAt - a.createdAt)[0])
  }

  const agentIds = uniq([...tasksByAgent.keys(), ...metrics.agents.map((a) => a.agentId)]).sort()
  const agents = []
  const unplacedAgents = []
  const agentStats = []

  for (const agentId of agentIds) {
    const m = metricsByAgent.get(agentId)
    const latest = latestTaskByAgent.get(agentId)
    const stat = { agentId, sessions: m ? m.sessions : null, tokens: m ? m.tokens : null }
    agentStats.push(stat)

    if (!latest) {
      unplacedAgents.push({
        agentId,
        sessions: stat.sessions,
        tokens: stat.tokens,
        reason: '有真实会话/Token 数据，但 tasks.jsonl 里没有任务记录，无法确定部门',
      })
      continue
    }

    const room = mapRoom(latest.deptId, latest.deptId) // 已被映射过，恒等
    const deptId = room.deptId
    if (deptId === 'meeting') {
      unplacedAgents.push({ agentId, sessions: stat.sessions, tokens: stat.tokens, reason: '最近任务映射到会议室，非工位部门' })
      continue
    }

    let status = 'standby'
    if (latest.status === 'running') status = 'running'
    else if (latest.status === 'queued') status = 'standby'
    else if (latest.status === 'review') status = 'blocked'
    else if (latest.status === 'failed') status = 'error'
    else status = 'standby'

    const activeTask = status === 'running' || status === 'error' || status === 'blocked' ? latest.id : null
    agents.push({
      id: agentId,
      deptId,
      name: agentId,
      status,
      deskIndex: 0,
      taskId: activeTask,
      tokens: m ? Number(m.tokens) || 0 : 0,
      startedAt: activeTask ? (latest.createdAt || null) : null,
      /* 视觉亮灯值，派生字段：running=1 / blocked|error=0.35 / standby=0 */
      heat: status === 'running' ? 1 : status === 'error' || status === 'blocked' ? 0.35 : 0,
      seatIndex: null,
      role: deptId === 'director' ? 'director' : 'member',
    })
  }

  // deskIndex 按部门内顺序重排（0..n-1），与上游 deskPositions 约定一致
  const deskSeq = new Map()
  for (const a of agents) {
    const n = deskSeq.get(a.deptId) || 0
    a.deskIndex = n
    deskSeq.set(a.deptId, n + 1)
  }

  // 总监办公室只有一个“老板位”，多人会重叠：只保留一个，其余标记未安置
  const directors = agents.filter((a) => a.deptId === 'director')
  if (directors.length > 1) {
    const keep = directors[0]
    for (const a of directors.slice(1)) {
      const idx = agents.indexOf(a)
      if (idx >= 0) agents.splice(idx, 1)
      unplacedAgents.push({ agentId: a.id, sessions: metricsByAgent.get(a.id)?.sessions ?? null, tokens: metricsByAgent.get(a.id)?.tokens ?? null, reason: '总监办公室只有一个真实工位，其余未安置' })
    }
    warn(`有 ${directors.length} 个 agent 映射到总监办公室，只保留 ${keep.id}`)
  }

  // 按 DEPTS 顺序排序，保证输出稳定
  agents.sort((a, b) => (DEPT_IDS.get(a.deptId) - DEPT_IDS.get(b.deptId)) || a.id.localeCompare(b.id))
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
  const durations = tasks
    .filter((t) => t.status === 'done' && t.durationMs > 0)
    .map((t) => t.durationMs / 60000)
  const sumTokens = agentStats.reduce((s, a) => s + (Number.isFinite(a.tokens) ? a.tokens : 0), 0)
  const totalTokens = metrics.totalTokens || sumTokens

  const kpis = {
    total: tasks.length,
    running: agents.filter((a) => a.status === 'running').length,
    blocked: agents.filter((a) => a.status === 'error').length,
    done: doneCount,
    avgMin: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    tokens: totalTokens,
    progress: tasks.length ? Math.min(100, (doneCount / tasks.length) * 100) : 0,
    inMeeting: 0,
  }

  /* ---- meta ---- */
  const latestMetricsTs = metrics.ts
  const meta = {
    generator: 'scripts/real-snapshot.js',
    version: SNAPSHOT_VERSION,
    generatedAt: new Date(now).toISOString(),
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
        ageSeconds: latestMetricsTs ? Math.max(0, Math.round((now - latestMetricsTs) / 1000)) : null,
        liveError: metrics.liveError || null,
      },
      deptCheck,
    },
    counts: {
      realAgentsFromMetrics: metrics.agents.length,
      placedAgents: agents.length,
      unplacedAgents: unplacedAgents.length,
      tasks: tasks.length,
      done: doneCount,
      events: eventsCapped.length,
      totalSessions: metrics.totalSessions,
    },
    agentStats,
    unplacedAgents,
    roomMapping: Array.from(usedRoomMapping.values()).map((r) => ({ room: r.room, deptId: r.deptId, approximate: r.approx, via: r.via })),
    unknownStates: Array.from(unknownStates),
    derived: [
      { field: 'agents[].status', from: '该 agent 最近一条任务 state', note: '不是实时心跳；queued→standby，review→blocked，error→error' },
      { field: 'agents[].deptId', from: '该 agent 最近一条任务的 room / deptId', note: '任务跨部门时取最近一条' },
      { field: 'agents[].heat', from: 'status', note: '视觉亮度，running=1 / blocked|error=0.35 / standby=0' },
      { field: 'agents[].taskId/startedAt', from: '最近一条 running/blocked/error 任务' },
      { field: 'events', from: '任务 ts/startedAt/finishedAt', note: '按生命周期合成，不是真实工具调用流' },
      { field: 'kpis.total/done/progress', from: 'tasks.jsonl 可见记录', note: '不是历史累计总数；文件被裁剪时会变小' },
      { field: 'kpis.tokens', from: 'metrics.totalTokens', note: 'OpenClaw 工作区累计 token，不是本快照内任务消耗' },
      { field: 'deptLoad', from: 'agents[] 按 deptId 聚合', note: '空部门保留 0 行，供上游 UI/场景遍历' },
    ],
    todo: [
      { field: 'meeting', status: '未接', reason: '没有真实会议数据源，固定 null' },
      { field: 'tasks[].tool', status: '未接', reason: 'tasks.jsonl 无 tool 字段' },
      { field: 'tasks[].progress', status: '未接', reason: '无实时进度，仅 done=100，其余暂置 0' },
      { field: 'tasks[].tokens', status: '未接', reason: '无逐任务 token，kpis.tokens 用工作区累计值' },
      { field: 'events[].kind=tool', status: '未接', reason: '没有真实工具调用事件流' },
      { field: 'agents[].sessions', status: '未接', reason: 'Session 数只在 meta.agentStats 里，Agent 类型无此字段' },
    ],
    warnings,
  }

  return {
    snapshot: {
      kpis,
      agents,
      tasks: tasks.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 60),
      events: eventsCapped,
      deptLoad: DEPTS.map((d) => loadMap.get(d.id)),
      meeting: null,
      ts: now,
      meta,
    },
    stats: {
      agents: agents.length,
      tasks: tasks.length,
      events: eventsCapped.length,
      kpis,
      unplaced: unplacedAgents.length,
      totalSessions: metrics.totalSessions,
      metricsSource: metrics.source,
      metricsAgeSeconds: meta.source.metrics.ageSeconds,
      warnings,
    },
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  quietMode = !!opts.quiet
  if (opts.help) {
    console.log(`真实数据桥：生成 agent-hq-upstream 需要的 Snapshot JSON

用法:
  node scripts/real-snapshot.js [选项]

选项:
  --data-dir DIR   真实数据目录（默认 ${DEFAULT_DATA_DIR}）
  --out FILE       输出文件（默认 <repo>/public/snapshot.json）
  --live           先尝试 http://127.0.0.1:8900/api/state，失败回退 metrics-history.jsonl
  --quiet          不打印警告到 stderr
  --help           显示本帮助

数据源（只读）:
  tasks.jsonl              真实任务队列
  metrics-history.jsonl    每 60s 的指标/agent 会话快照

输出是上游 src/data/types.ts 的 Snapshot + 附加 meta 字段。
拿不到的字段写 "未接（TODO）"，详见 meta.todo。
`)
    process.exit(0)
  }
  if (opts.badArgs) process.exit(2)

  const outPath = path.resolve(opts.out)
  const { snapshot, stats } = await buildSnapshot(opts)
  const errs = validateSnapshot(snapshot)
  if (errs.length) {
    for (const e of errs) console.error('[real-snapshot][validate] ' + e)
    throw new Error(`输出未通过 Snapshot 结构校验（${errs.length} 项）`)
  }
  const body = JSON.stringify(snapshot, null, 2) + '\n'
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, body, 'utf8')

  if (!opts.quiet) {
    const size = Buffer.byteLength(body, 'utf8')
    console.log('[real-snapshot] 输出: ' + outPath)
    console.log('[real-snapshot] 大小: ' + size + ' bytes (' + (size / 1024).toFixed(1) + ' KiB)')
    console.log(`[real-snapshot] agents=${stats.agents} tasks=${stats.tasks} events=${stats.events} unplaced=${stats.unplaced} sessions=${stats.totalSessions}`)
    console.log(`[real-snapshot] kpis: total=${stats.kpis.total} done=${stats.kpis.done} running=${stats.kpis.running} blocked=${stats.kpis.blocked} progress=${stats.kpis.progress.toFixed(1)}% tokens=${stats.kpis.tokens}`)
    console.log(`[real-snapshot] metrics 来源=${stats.metricsSource} 数据年龄=${stats.metricsAgeSeconds == null ? 'n/a' : stats.metricsAgeSeconds + 's'}`)
    console.log('[real-snapshot] 结构校验: OK')
    if (stats.warnings.length) console.log(`[real-snapshot] 警告 ${stats.warnings.length} 条（见 meta.warnings）`)
  }
}

main().catch((e) => {
  console.error('[real-snapshot] 失败: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
