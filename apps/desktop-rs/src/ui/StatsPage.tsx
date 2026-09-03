/**
 * 统计页（M2）：最近 N 天每日前台总时长趋势条。
 * 数据源：timepaws/stats/daily-totals。
 */
import { useEffect, useState } from 'react';

interface DayRow { dateKey: string; totalMs: number }

function fmtShort(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '—';
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 > 0 ? `${min % 60}m` : ''}` : `${min}m`;
}

function dayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return isToday ? '今天' : `${d.getMonth() + 1}/${d.getDate()} 周${wd}`;
}

export default function StatsPage() {
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    window.timepaws.statsDailyTotals(14)
      .then(setRows)
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <section className="max-w-xl" aria-label="统计">
        <h1 className="text-xl font-semibold mb-6">统计</h1>
        <div className="rounded-xl2 bg-surface p-5 text-ink-dim">
          数据读取失败。<button className="underline hover:text-ink" onClick={() => window.timepaws.statsDailyTotals(14).then(setRows).catch(() => setFailed(true))}>重试</button>
        </div>
      </section>
    );
  }

  const data = rows ?? [];
  const maxMs = Math.max(1, ...data.map((r) => r.totalMs));
  // 升序排列（旧 → 今），趋势从左往右
  const asc = [...data].reverse();

  return (
    <section className="max-w-xl" aria-label="统计">
      <h1 className="text-xl font-semibold mb-6">统计</h1>

      <div className="rounded-xl2 bg-surface p-5">
        <div className="text-sm text-ink-dim mb-4">最近 14 天 · 每日前台总时长</div>
        {data.length === 0 ? (
          <p className="text-sm text-ink-faint">
            还没有历史数据。TimePaws 会从第一次运行开始积累，明天再来看趋势。
          </p>
        ) : (
          <div className="flex items-end gap-2 h-40">
            {asc.map((r) => (
              <div key={r.dateKey} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
                <span className="text-[10px] text-ink-faint">{r.totalMs >= 60_000 ? fmtShort(r.totalMs) : ''}</span>
                <div
                  className="w-full max-w-8 rounded-t-md bg-accent/60 hover:bg-accent transition-colors"
                  style={{ height: `${Math.max(3, (r.totalMs / maxMs) * 100)}%` }}
                  title={`${r.dateKey}：${fmtShort(r.totalMs)}`}
                />
                <span className="text-[10px] text-ink-faint truncate w-full text-center">{dayLabel(r.dateKey)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-ink-faint leading-relaxed">
        口径：主屏前台 + 非空闲时长。空闲超过 1 分钟不计入；锁屏/最小化不算前台。
      </p>
    </section>
  );
}
