/**
 * 主窗口 Shell：M0 为骨架 + 占位导航。
 * 左侧导航（今日/统计/任务箱/设置）M3/M5 逐步填充真实页面。
 */
import { useEffect, useState } from 'react';
import TodayPage from './TodayPage';
import StatsPage from './StatsPage';
import TasksPage from './TasksPage';
import SettingsPage from './SettingsPage';

type NavKey = 'today' | 'stats' | 'tasks' | 'settings';

const NAV: Array<{ key: NavKey; label: string; ready: boolean }> = [
  { key: 'today', label: '今日', ready: true },
  { key: 'stats', label: '统计', ready: true },
  { key: 'tasks', label: '任务箱', ready: true },
  { key: 'settings', label: '设置', ready: true },
];

export default function App() {
  const [active, setActive] = useState<NavKey>('today');
  const [pongAt, setPongAt] = useState<number | null>(null);

  useEffect(() => {
    // M0 自检：preload 桥是否工作
    window.anchor.ping().then((res) => setPongAt(res.at)).catch(() => setPongAt(null));
  }, []);

  return (
    <div className="flex h-screen">
      {/* 左侧导航 */}
      <nav className="w-44 shrink-0 bg-ink-800 p-3 flex flex-col gap-1" aria-label="主导航">
        <div className="px-2 py-3">
          <div className="text-lg2 font-semibold text-mist">Anchor</div>
          <div className="text-sm text-mist-faint">锚点 · 陪你回到计划</div>
        </div>
        {NAV.map((item) => (
          <button
            key={item.key}
            onClick={() => item.ready && setActive(item.key)}
            className={`text-left rounded-xl2 px-3 py-2.5 text-base2 transition-colors ${
              active === item.key
                ? 'bg-ink-600 text-mist'
                : item.ready
                  ? 'text-mist-dim hover:bg-ink-700 hover:text-mist'
                  : 'text-mist-faint cursor-default'
            }`}
          >
            {item.label}
            {!item.ready && <span className="ml-1.5 text-xs text-mist-faint">即将到来</span>}
          </button>
        ))}
        <div className="mt-auto px-2 text-xs text-mist-faint">
          {pongAt ? `桥已连接 ${new Date(pongAt).toLocaleTimeString()}` : '桥未连接'}
        </div>
      </nav>

      {/* 主内容 */}
      <main className="flex-1 p-8 overflow-y-auto">
        {active === 'today' && <TodayPage />}
        {active === 'stats' && <StatsPage />}
        {active === 'tasks' && <TasksPage />}
        {active === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
