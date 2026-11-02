import { DEPTS } from '../data/world'
import { useHQ } from '../store/useHQ'
import type { Task } from '../data/types'

const STATUS: Record<Task['status'], { cls: string; label: string }> = {
  running: { cls: 'run', label: 'RUN' },
  review: { cls: 'review', label: 'REVIEW' },
  done: { cls: 'done', label: 'DONE' },
  failed: { cls: 'err', label: 'ERR' },
  queued: { cls: 'wait', label: 'WAIT' },
}

export default function TaskTable() {
  const snap = useHQ((s) => s.snap)
  const filter = useHQ((s) => s.filter)
  const focusDept = useHQ((s) => s.focusDept)

  const rows = snap.tasks.filter((t) => {
    if (focusDept && t.deptId !== focusDept) return false
    if (filter === 'running') return t.status === 'running'
    if (filter === 'error') return t.status === 'failed'
    return true
  })

  return (
    <aside className="hud-right panel rise d2">
      <div className="p-head">
        <div className="p-title">
          <b>任务流</b> / TASK FEED
        </div>
        <div className="p-title" style={{ color: 'var(--green)' }}>
          {rows.length} 条
        </div>
      </div>
      <div className="tasks">
        {rows.map((t) => {
          const dept = DEPTS.find((d) => d.id === t.deptId)!
          const agent = snap.agents.find((a) => a.id === t.agentId)
          const st = STATUS[t.status]
          return (
            <div
              key={t.id}
              className="task-row"
              style={{ ['--c' as string]: dept.color }}
              onClick={() => {
                useHQ.getState().setFocusDept(t.deptId)
                useHQ.getState().openAgent(t.agentId)
              }}
            >
              <div className="t-main">
                <div className="t-title">
                  <i />
                  {t.title}
                </div>
                <div className="t-meta">
                  <span>{agent?.name ?? '—'}</span>
                  <span>·</span>
                  <span>{t.tool}</span>
                  {t.status === 'running' && <span>· {t.progress.toFixed(0)}%</span>}
                  {t.status === 'failed' && <span style={{ color: 'var(--red)' }}>· {t.error}</span>}
                </div>
              </div>
              <span className={`badge ${st.cls}`}>{st.label}</span>
            </div>
          )
        })}
        {rows.length === 0 && (
          <div style={{ padding: '28px 12px', textAlign: 'center', color: 'var(--faint)', fontSize: 11 }}>
            当前筛选下暂无任务
          </div>
        )}
      </div>
    </aside>
  )
}
