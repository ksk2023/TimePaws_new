/**
 * 今日页（M2）：今日前台总时长、Top 应用、最近活动时间线。
 * 数据源：timepaws/stats/today；会话结束事件触发增量刷新。
 */
import { useCallback, useEffect, useState } from 'react';
import type { DailySummary, ForegroundInfo } from '@/lib/api';

function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '不到 1 分钟';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

function fmtClock(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function fmtShort(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 > 0 ? `${min % 60}m` : ''}` : `${min}m`;
}

export default function TodayPage() {
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [current, setCurrent] = useState<ForegroundInfo | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    window.timepaws.statsToday().then(setSummary).catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    window.timepaws.trackerCurrent().then(setCurrent).catch(() => undefined);
    window.timepaws.onSessionEnded(() => refresh());
    // 实时态 10s 轮询（会话结束事件不覆盖"一直停在同一个应用"的情况）
    const t = setInterval(() => {
      window.timepaws.trackerCurrent().then(setCurrent).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (failed) {
    return (
      <section className="max-w-xl" aria-label="今日">
        <h1 className="text-xl font-semibold mb-2">今天</h1>
        <div className="rounded-xl2 bg-surface shadow-card p-5 text-ink-dim">
          数据读取失败。<button className="underline hover:text-ink" onClick={refresh}>重试</button>
        </div>
      </section>
    );
  }

  const total = summary?.totalMs ?? 0;
  const topApps = summary?.topApps ?? [];
  const maxMs = Math.max(1, ...topApps.map((a) => a.total_ms));

  return (
    <section className="max-w-xl" aria-label="今日">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">今天想完成什么？</h1>
      <p className="text-sm text-ink-dim mb-7">
        {current
          ? `此刻 · ${current.appName}${current.windowTitle ? ` · ${current.windowTitle}` : ''}${current.onPrimary ? '' : '（副屏）'}`
          : '此刻没有追踪到前台活动'}
      </p>

      {/* 总时长 hero */}
      <div className="rounded-xl2 bg-surface shadow-card px-6 py-7 mb-5">
        <div className="text-sm text-ink-dim mb-2">今日专注（主屏计入）</div>
        <div className="text-display font-display font-semibold text-ink tabular leading-none">
          {fmtDuration(total)}
        </div>
        <div className="mt-4 inline-flex items-center gap-1.5 text-xs text-ink-dim bg-surface-2 rounded-full px-3 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-paw" aria-hidden />
          {summary ? `${summary.countedSessions} 段有效会话` : '加载中…'}
        </div>
      </div>

      {/* Top 应用 */}
      <div className="rounded-xl2 bg-surface shadow-card p-5 mb-4">
        <div className="text-sm text-ink-dim mb-3">应用分布</div>
        {topApps.length === 0 ? (
          <p className="text-sm text-ink-faint">还没有数据。正常使用电脑，几分钟后回来看。</p>
        ) : (
          <ul className="space-y-2.5">
            {topApps.map((a) => (
              <li key={a.app_key} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-base2 text-ink-dim" title={a.app_name}>{a.app_name}</span>
                <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent/70"
                    style={{ width: `${Math.max(4, (a.total_ms / maxMs) * 100)}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right text-sm text-ink-faint">{fmtShort(a.total_ms)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 最近活动 */}
      <div className="rounded-xl2 bg-surface shadow-card p-5">
        <div className="text-sm text-ink-dim mb-3">最近活动</div>
        {(summary?.recent?.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-faint">暂无记录（会话 ≥5 秒才显示）。</p>
        ) : (
          <ul className="divide-y divide-line/60">
            {summary!.recent.map((r, i) => (
              <li key={i} className="py-2 flex items-baseline gap-3 min-w-0">
                <span className="text-xs text-ink-faint shrink-0 w-9">{fmtClock(r.ended_at)}</span>
                <span className="text-sm text-ink-dim shrink-0 w-20 truncate" title={r.app_name}>{r.app_name}</span>
                <span className="text-sm text-ink truncate flex-1" title={r.title}>{r.title || '（无标题）'}</span>
                <span className="text-xs text-ink-faint shrink-0">{fmtShort(r.duration_ms)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
