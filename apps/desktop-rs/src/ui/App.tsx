/**
 * 主窗口 Shell：M0 为骨架 + 占位导航。
 * 左侧导航（今日/统计/任务箱/设置）M3/M5 逐步填充真实页面。
 */
import { useEffect, useState, type ReactElement } from 'react';
import TodayPage from './TodayPage';
import StatsPage from './StatsPage';
import TasksPage from './TasksPage';
import SettingsPage from './SettingsPage';

type NavKey = 'today' | 'stats' | 'tasks' | 'settings';

/* 细线图标（stroke=currentColor），克制、不抢戏 */
const ICONS: Record<NavKey, ReactElement> = {
  today: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  ),
  stats: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </svg>
  ),
  tasks: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  ),
  settings: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.61.7 1 1.32 1H21a2 2 0 1 1 0 4h-.09c-.63 0-1.18.39-1.51 1z" />
    </svg>
  ),
};

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
    window.timepaws.ping().then((res) => setPongAt(res.at)).catch(() => setPongAt(null));
  }, []);

  return (
    <div className="flex h-screen">
      {/* 左侧导航 */}
      <nav className="w-56 shrink-0 bg-surface border-r border-line p-4 flex flex-col gap-1" aria-label="主导航">
        <div className="px-2 pt-2 pb-4">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-paw shrink-0" aria-hidden />
            <span className="text-lg2 font-semibold text-ink tracking-tight">TimePaws</span>
          </div>
          <div className="text-sm text-ink-faint mt-1 pl-5">陪你回到计划</div>
        </div>
        {NAV.map((item) => (
          <button
            key={item.key}
            onClick={() => item.ready && setActive(item.key)}
            className={`relative flex items-center gap-2.5 text-left rounded-xl2 pl-3 pr-3 py-2.5 text-base2 transition-colors ${
              active === item.key
                ? 'bg-surface-2 text-ink font-medium'
                : item.ready
                  ? 'text-ink-dim hover:bg-surface-2 hover:text-ink'
                  : 'text-ink-faint cursor-default'
            }`}
          >
            {active === item.key && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-full bg-accent" aria-hidden />
            )}
            <span className={active === item.key ? 'text-accent' : 'text-ink-faint'} aria-hidden>
              {ICONS[item.key]}
            </span>
            {item.label}
            {!item.ready && <span className="ml-1.5 text-xs text-ink-faint">即将到来</span>}
          </button>
        ))}
        <div className="mt-auto px-2 pt-4 text-xs text-ink-faint border-t border-line">
          {pongAt ? `已连接 · ${new Date(pongAt).toLocaleTimeString()}` : '连接中…'}
        </div>
      </nav>

      {/* 主内容（key 触发换页上浮动效） */}
      <main className="flex-1 p-8 overflow-y-auto">
        <div key={active} className="animate-rise">
          {active === 'today' && <TodayPage />}
          {active === 'stats' && <StatsPage />}
          {active === 'tasks' && <TasksPage />}
          {active === 'settings' && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
