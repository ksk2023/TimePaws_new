/**
 * 常驻小组件（280x120 / 折叠 44 高）。
 * M0：骨架 + 拖拽区 + 折叠按钮；M2：今日前台分钟数 + 当前应用。
 * M3：当前任务与计时。
 */
import { useCallback, useEffect, useState } from 'react';
import { useUiStore } from '@/store/ui';
import type { DailySummary, ForegroundInfo, TaskInfo } from '@/lib/api';

export default function Widget() {
  const collapsed = useUiStore((s) => s.widgetCollapsed);
  const setCollapsed = useUiStore((s) => s.setWidgetCollapsed);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [current, setCurrent] = useState<ForegroundInfo | null>(null);
  const [task, setTask] = useState<TaskInfo | null>(null);

  const refresh = useCallback(() => {
    window.timepaws.statsToday().then(setSummary).catch(() => undefined);
  }, []);

  const refreshTask = useCallback(() => {
    window.timepaws.tasksCurrent().then(setTask).catch(() => undefined);
  }, []);

  // 主进程 → 渲染层同步折叠状态（窗口尺寸变化由主进程完成）
  useEffect(() => {
    window.timepaws.onWidgetCollapsedChanged(setCollapsed);
  }, [setCollapsed]);

  useEffect(() => {
    refresh();
    refreshTask();
    window.timepaws.trackerCurrent().then(setCurrent).catch(() => undefined);
    window.timepaws.onSessionEnded(() => refresh());
    window.timepaws.onTasksChanged(refreshTask);
    const t = setInterval(() => {
      window.timepaws.trackerCurrent().then(setCurrent).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(t);
  }, [refresh, refreshTask]);

  const totalMin = Math.floor((summary?.totalMs ?? 0) / 60_000);
  const totalLabel = totalMin >= 60
    ? `${Math.floor(totalMin / 60)}h${totalMin % 60 > 0 ? ` ${totalMin % 60}m` : ''}`
    : `${totalMin}m`;
  const currentApp = current?.appName ?? '—';
  const taskFocusMin = task ? Math.floor(task.focus_ms / 60_000) : 0;

      if (collapsed) {
    return (
      <div className="h-full flex items-center bg-surface/95 rounded-xl2 border border-line shadow-lg">
        <div className="drag-region flex-1 flex items-center px-3 gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full bg-accent shrink-0" aria-hidden />
          <span className="text-sm text-ink-dim truncate">{task ? task.text : '还没有当前任务'}</span>
        </div>
        <button
          className="no-drag px-2.5 h-full text-ink-dim hover:text-ink"
          onClick={() => window.timepaws.widgetToggleCollapse()}
          aria-label="展开小组件"
        >
          ▾
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface/95 rounded-xl2 border border-line shadow-lg overflow-hidden">
      {/* 标题栏：可拖拽 */}
      <div className="drag-region flex items-center px-3 pt-2.5 pb-1 gap-2">
        <span className="w-2 h-2 rounded-full bg-accent shrink-0" aria-hidden />
        <span className="text-xs font-medium text-ink-dim">TimePaws</span>
        <button
          className="no-drag ml-auto w-6 h-6 rounded-md text-ink-faint hover:text-ink hover:bg-surface-2"
          onClick={() => window.timepaws.widgetToggleCollapse()}
          aria-label="折叠小组件"
        >
          ▴
        </button>
      </div>

      {/* 当前任务（M3 绑定） */}
      <div className="px-3 pb-1">
        {task ? (
          <>
            <div className="text-lg2 font-semibold text-ink leading-snug truncate" title={task.text}>
              {task.text}
            </div>
            <div className="text-xs text-ink-faint mt-0.5">
              当前任务{taskFocusMin >= 1 ? ` · 专注 ${taskFocusMin}m` : ' · 开始你的第一步'}
            </div>
          </>
        ) : (
          <>
            <div className="text-lg2 font-semibold text-ink leading-snug">
              还没有任务
            </div>
            <div className="text-xs text-ink-faint mt-0.5">
              打开主窗口写下第一件事
            </div>
          </>
        )}
      </div>

      {/* 底部：今日前台分钟 + 最近应用 */}
      <div className="mt-auto px-3 pb-2.5 flex items-center gap-3 text-xs text-ink-faint">
        <span>今日前台 {summary ? totalLabel : '—'}</span>
        <span className="truncate" title="当前应用">{currentApp}</span>
      </div>
    </div>
  );
}
