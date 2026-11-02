import React from 'react'
import ReactDOM from 'react-dom/client'
import { world } from './data/world'
import { fetchSnapshot, startLivePolling } from './data/live'
import './styles/ui.css'

/** 把异常渲染成 #root 里一行可读错误，避免 boot 失败时白屏 */
function renderFatal(e: unknown) {
  const message =
    e instanceof Error
      ? e.message || e.name || '未知错误'
      : typeof e === 'string'
        ? e
        : String(e)

  try {
    document.documentElement.setAttribute('data-source', 'error')
    const root = document.getElementById('root')
    if (!root) return
    root.textContent = ''
    const line = document.createElement('div')
    line.setAttribute('role', 'alert')
    line.style.cssText =
      'padding:24px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#ff6b6b;white-space:pre-wrap'
    line.textContent = `AGENT HQ 启动失败：${message}（请刷新页面或查看控制台）`
    root.appendChild(line)
  } catch (renderError) {
    console.error('[boot] 错误提示渲染失败', renderError)
  }
}

async function boot() {
  try {
    // 1) 先拿真实快照并覆盖 world 单例
    const snap = await fetchSnapshot()
    if (snap) {
      world.applySnapshot(snap)
      console.info(
        `[live] 已接入真实快照：${snap.agents.length} agents / ${snap.tasks.length} tasks / ts=${new Date(snap.ts).toISOString()}`
      )
    } else {
      console.info('[live] 使用内置模拟世界')
    }

    // 数据源标记，便于验收（无需读控制台）
    document.documentElement.setAttribute('data-source', snap ? 'live' : 'mock')

    // 2) 动态 import：保证 App / TaskTable / useHQ 的模块级求值发生在 applySnapshot 之后
    const [{ default: App }, { useHQ }] = await Promise.all([
      import('./App'),
      import('./store/useHQ'),
    ])
    // 兜底同步一次 store（若打包器把动态模块体提前求值，这一步仍能纠正 UI 快照）
    useHQ.setState({ snap: world.snapshot() })

    const root = document.getElementById('root')
    if (!root) throw new Error('找不到 #root 容器')
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )

    // 3) 实时刷新：每 30s 拉一次 /snapshot.json，内容有变化才 apply。
    //    - 间隔可用 window.__HQ_POLL_MS 覆盖（调试用）
    //    - 页面隐藏时暂停，恢复可见时立即补拉一次
    //    - 启动时已拉过一次，immediate=false 避免重复请求
    //    - apply 后显式同步 store：world.subscribe 的 420ms 节流可能吞掉 paused 世界的唯一一次通知
    startLivePolling({
      initialSnapshot: snap,
      immediate: false,
      onSnapshot: (next) => {
        world.applySnapshot(next)
        useHQ.setState({ snap: world.snapshot() })
        document.documentElement.setAttribute('data-source', 'live')
      },
    })
  } catch (e) {
    console.error('[boot] 启动失败：', e)
    renderFatal(e)
  }
}

void boot()
