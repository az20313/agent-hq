import React from 'react'
import ReactDOM from 'react-dom/client'
import { world } from './data/world'
import { fetchSnapshot } from './data/live'
import './styles/ui.css'

async function boot() {
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
  document.documentElement.dataset.dataSource = snap ? 'live' : 'mock'

  // 2) 动态 import：保证 App / TaskTable / useHQ 的模块级求值发生在 applySnapshot 之后
  const [{ default: App }, { useHQ }] = await Promise.all([import('./App'), import('./store/useHQ')])
  // 兜底同步一次 store（若打包器把动态模块体提前求值，这一步仍能纠正 UI 快照）
  useHQ.setState({ snap: world.snapshot() })

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

boot()
