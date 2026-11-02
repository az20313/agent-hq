import type { Snapshot } from './types'

/** 最小结构校验：防止把 404 页面 / 错误 JSON 当成快照灌进世界 */
function isSnapshot(v: unknown): v is Snapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<Snapshot>
  return (
    !!s.kpis &&
    typeof s.kpis === 'object' &&
    Array.isArray(s.agents) &&
    Array.isArray(s.tasks) &&
    Array.isArray(s.events) &&
    Array.isArray(s.deptLoad) &&
    (s.meeting === null || typeof s.meeting === 'object') &&
    typeof s.ts === 'number'
  )
}

/**
 * 读取构建产物同目录的真实快照。
 * 关键点：8901 静态服务器对缺失文件会 SPA fallback 返回 200 text/html，
 * 所以必须校验 content-type，不能只看 res.ok。
 * 任何失败都只 warn 并返回 null，由调用方回退内置模拟数据。
 */
export async function fetchSnapshot(url = './snapshot.json'): Promise<Snapshot | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('application/json')) {
      throw new Error(`content-type 不是 JSON: ${ct || '(empty)'}`)
    }

    const data: unknown = await res.json()
    if (!isSnapshot(data)) throw new Error('snapshot 结构不合法')

    return data
  } catch (e) {
    console.warn('[live] 真实快照加载失败，回退内置模拟世界：', e)
    return null
  }
}
