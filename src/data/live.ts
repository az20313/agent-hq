import type { Agent, Snapshot, Task } from './types'
import { DEPTS } from './world'

/** 快照请求超时：8901 或 CDN 挂起时不能让首屏无限等待 */
const FETCH_TIMEOUT_MS = 5_000
/** 非轮询（首屏/手工）失败告警限流 */
const FETCH_WARN_INTERVAL_MS = 60_000
let lastFetchWarnAt = 0

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v)
}

const AGENT_STATUSES = new Set([
  'idle',
  'standby',
  'running',
  'blocked',
  'error',
  'offline',
  'meeting',
])

const TASK_STATUSES = new Set(['queued', 'running', 'review', 'done', 'failed'])
/** 场景/抽屉按固定 DEPTS 建房间；未知 deptId 的 agent 会在 3D 初始化时崩，直接判快照不可用 */
const DEPT_IDS = new Set(DEPTS.map((d) => d.id))

function isAgent(v: unknown): v is Agent {
  if (!isRecord(v)) return false
  return (
    typeof v.id === 'string' &&
    v.id !== '' &&
    typeof v.deptId === 'string' &&
    v.deptId !== '' &&
    DEPT_IDS.has(v.deptId) &&
    typeof v.name === 'string' &&
    typeof v.status === 'string' &&
    AGENT_STATUSES.has(v.status) &&
    isFiniteNumber(v.deskIndex) &&
    isStringOrNull(v.taskId) &&
    isFiniteNumber(v.tokens) &&
    isNumberOrNull(v.startedAt) &&
    isFiniteNumber(v.heat) &&
    isNumberOrNull(v.seatIndex) &&
    (v.role === 'director' || v.role === 'member')
  )
}

function isTask(v: unknown): v is Task {
  if (!isRecord(v)) return false
  return (
    typeof v.id === 'string' &&
    v.id !== '' &&
    typeof v.deptId === 'string' &&
    v.deptId !== '' &&
    typeof v.agentId === 'string' &&
    typeof v.title === 'string' &&
    typeof v.summary === 'string' &&
    typeof v.status === 'string' &&
    TASK_STATUSES.has(v.status) &&
    isFiniteNumber(v.progress) &&
    isFiniteNumber(v.createdAt) &&
    isNumberOrNull(v.finishedAt) &&
    isFiniteNumber(v.durationMs) &&
    typeof v.tool === 'string' &&
    isFiniteNumber(v.tokens) &&
    (v.error === undefined || typeof v.error === 'string')
  )
}

function isKpis(v: unknown): boolean {
  if (!isRecord(v)) return false
  return ['total', 'running', 'blocked', 'done', 'avgMin', 'tokens', 'progress', 'inMeeting'].every(
    (k) => isFiniteNumber(v[k])
  )
}

function isMeeting(v: unknown): boolean {
  // null 合法；对象必须带可 slice 的 agentIds/deptIds，applySnapshot 才不会抛 TypeError
  return (
    v === null ||
    (isRecord(v) && Array.isArray(v.agentIds) && Array.isArray(v.deptIds))
  )
}

/** 最小结构校验：防止把 404 页面 / 错误 JSON / 半截快照当成快照灌进世界 */
function isSnapshot(v: unknown): v is Snapshot {
  if (!isRecord(v)) return false
  const s = v as Partial<Snapshot>
  return (
    isKpis(s.kpis) &&
    Array.isArray(s.agents) &&
    s.agents.every(isAgent) &&
    Array.isArray(s.tasks) &&
    s.tasks.every(isTask) &&
    Array.isArray(s.events) &&
    Array.isArray(s.deptLoad) &&
    isMeeting(s.meeting) &&
    isFiniteNumber(s.ts)
  )
}

function isAbortError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'AbortError'
  )
}

function warnFetchThrottled(message: string) {
  const now = Date.now()
  if (now - lastFetchWarnAt < FETCH_WARN_INTERVAL_MS) return
  lastFetchWarnAt = now
  console.warn(message)
}

export interface FetchSnapshotOptions {
  /** 轮询时静默：不在这里打 warn，由轮询器统一限流提示 */
  quiet?: boolean
}

/**
 * 读取构建产物同目录的真实快照。
 * 关键点：8901 静态服务器对缺失文件会 SPA fallback 返回 200 text/html，
 * 所以必须校验 content-type，不能只看 res.ok。
 * 任何失败都只 warn（quiet 时静默）并返回 null，由调用方回退内置模拟数据。
 */
export async function fetchSnapshot(
  url = './snapshot.json',
  opts: FetchSnapshotOptions = {}
): Promise<Snapshot | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('application/json')) {
      throw new Error(`content-type 不是 JSON: ${ct || '(empty)'}`)
    }

    const data: unknown = await res.json()
    if (!isSnapshot(data)) throw new Error('snapshot 结构不合法')

    return data
  } catch (e) {
    if (!opts.quiet) {
      const reason = isAbortError(e)
        ? `请求超时（>${FETCH_TIMEOUT_MS}ms）`
        : e instanceof Error
          ? e.message
          : String(e)
      warnFetchThrottled(`[live] 真实快照加载失败，回退内置模拟世界：${reason}`)
    }
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ 快照指纹 */

/**
 * 稳定序列化：对象键排序，保证服务端换行/键序变化不会误判为“数据变了”。
 * 顶层 ts 不参与指纹：脚本每次重跑都会刷新 ts，但它只是生成时间，
 * 数据完全相同时不应触发 applySnapshot（否则每 30 秒闪一下）。
 */
function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

/** cyrb53：53 位非加密哈希，无依赖，足够做“变没变”的判定 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * 快照指纹：数据（除顶层 ts）完全一致 → 指纹一致；任一字段变化 → 指纹变化。
 * 导出用于单测/手工验证。
 */
export function snapshotSignature(s: Snapshot): string {
  const { ts: _ts, ...rest } = s
  const body = canonical(rest)
  return `${body.length.toString(36)}-${cyrb53(body).toString(36)}`
}

/* ------------------------------------------------------------------ 轮询 */

const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 1_000
/** 失败提示限流：最坏 5 分钟一条，不随 30 秒轮询刷屏 */
const WARN_INTERVAL_MS = 5 * 60_000

export type PollOutcome = 'changed' | 'unchanged' | 'failed' | 'skipped'

export interface LiveStats {
  running: boolean
  intervalMs: number
  polls: number
  applied: number
  unchanged: number
  failures: number
  consecutiveFailures: number
  lastSignature: string | null
  lastPollAt: number | null
  lastAppliedAt: number | null
  lastError: string | null
}

export interface LiveOptions {
  /** 快照地址，默认 ./snapshot.json */
  url?: string
  /** 轮询间隔；优先级：显式参数 > window.__HQ_POLL_MS > 30000 */
  intervalMs?: number
  /** 启动前已经应用过的快照：用它初始化指纹，避免启动后立刻重复 apply */
  initialSnapshot?: Snapshot | null
  /** 实际上屏钩子（通常是 world.applySnapshot + store 同步） */
  onSnapshot: (s: Snapshot) => void
  /** 是否启动时立刻拉一次，默认 true（main.tsx 启动已完成首拉，会传 false） */
  immediate?: boolean
}

export interface LiveController {
  stop(): void
  /** 手动触发一次（可见性恢复、调试用）；并发调用会复用同一个 Promise */
  pollNow(): Promise<PollOutcome>
  getStats(): LiveStats
}

declare global {
  interface Window {
    __HQ_POLL_MS?: number
    /** 热更新/重复启动时用于回收上一实例的定时器 */
    __HQ_LIVE_STOP?: () => void
  }
}

function validInterval(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_POLL_MS
}

function resolveInterval(explicit?: number): number {
  if (validInterval(explicit)) return explicit
  if (typeof window !== 'undefined' && validInterval(window.__HQ_POLL_MS)) {
    return window.__HQ_POLL_MS
  }
  return DEFAULT_POLL_MS
}

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true
}

let active: LiveController | null = null
let lastWarnAt = 0

function warnThrottled(msg: string) {
  const t = Date.now()
  if (t - lastWarnAt < WARN_INTERVAL_MS) return
  lastWarnAt = t
  console.warn(msg)
}

export function startLivePolling(options: LiveOptions): LiveController {
  if (active && active.getStats().running) return active

  // 模块热替换会让旧模块的 active 丢失引用；借 window 上的钩子回收旧定时器
  if (typeof window !== 'undefined' && typeof window.__HQ_LIVE_STOP === 'function') {
    try {
      window.__HQ_LIVE_STOP()
    } catch {
      /* 旧实例清理失败不影响新实例 */
    }
  }

  const url = options.url || './snapshot.json'
  const intervalMs = resolveInterval(options.intervalMs)

  let running = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<PollOutcome> | null = null
  let lastSignature: string | null = options.initialSnapshot
    ? snapshotSignature(options.initialSnapshot)
    : null
  let polls = 0
  let applied = 0
  let unchanged = 0
  let failures = 0
  let consecutiveFailures = 0
  let lastPollAt: number | null = null
  let lastAppliedAt: number | null = null
  let lastError: string | null = null

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule() {
    clearTimer()
    if (!running || docHidden()) return
    timer = setTimeout(() => {
      timer = null
      void pollNow().finally(schedule)
    }, intervalMs)
  }

  async function pollNow(): Promise<PollOutcome> {
    if (!running) return 'skipped'
    if (inflight) return inflight
    if (docHidden()) return 'skipped'

    inflight = (async (): Promise<PollOutcome> => {
      polls++
      lastPollAt = Date.now()

      const snap = await fetchSnapshot(url, { quiet: true })
      if (!snap) {
        failures++
        consecutiveFailures++
        lastError = 'fetchSnapshot 返回 null'
        warnThrottled(
          `[live] 快照轮询失败（${consecutiveFailures} 次），将继续静默重试；5 分钟内不再重复提示`
        )
        return 'failed'
      }

      consecutiveFailures = 0
      const sig = snapshotSignature(snap)
      if (sig === lastSignature) {
        unchanged++
        lastError = null
        return 'unchanged'
      }

      try {
        options.onSnapshot(snap)
      } catch (e) {
        failures++
        lastError = e instanceof Error ? e.message : String(e)
        warnThrottled(`[live] 应用新快照失败，将继续重试：${lastError}`)
        return 'failed'
      }

      lastSignature = sig
      applied++
      lastAppliedAt = Date.now()
      lastError = null
      console.info(
        `[live] 快照更新：${snap.agents.length} agents / ${snap.tasks.length} tasks / ts=${new Date(snap.ts).toISOString()}`
      )
      return 'changed'
    })()

    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function onVisibilityChange() {
    if (!running) return
    if (docHidden()) {
      // 页面不可见：停表，避免后台标签页继续请求
      clearTimer()
      return
    }
    // 恢复可见：立刻拉一次，再重新排下一轮
    clearTimer()
    void pollNow().finally(schedule)
  }

  function stop() {
    if (!running) return
    running = false
    clearTimer()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    if (typeof window !== 'undefined' && window.__HQ_LIVE_STOP === stop) {
      delete window.__HQ_LIVE_STOP
    }
    if (active === controller) active = null
    console.info(
      `[live] 轮询已停止（polls=${polls} applied=${applied} unchanged=${unchanged} failures=${failures}）`
    )
  }

  const controller: LiveController = {
    stop,
    pollNow,
    getStats: () => ({
      running,
      intervalMs,
      polls,
      applied,
      unchanged,
      failures,
      consecutiveFailures,
      lastSignature,
      lastPollAt,
      lastAppliedAt,
      lastError,
    }),
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.__HQ_LIVE_STOP = stop
  }

  active = controller
  console.info(
    `[live] 轮询已启动：每 ${Math.round(intervalMs / 1000)}s 检查 ${url}` +
      (options.immediate === false ? '（首拉由启动流程负责）' : '')
  )

  if (options.immediate === false) {
    schedule()
  } else if (docHidden()) {
    schedule() // 不可见时不会真正排表，等 visibilitychange 恢复
  } else {
    void pollNow().finally(schedule)
  }

  return controller
}

export function stopLivePolling() {
  active?.stop()
}

/** 调试/验收用：当前实例的计数与最近一次指纹 */
export function getLiveStats(): LiveStats | null {
  return active ? active.getStats() : null
}
