/**
 * 统计页（M6）：GitHub 风格热力图。
 * 粒度：半小时 / 小时 / 半天 / 天 / 周，数据源 timepaws/stats_heatmap。
 * 色阶：surface-2 → accent 五档，按当期最大值分位。
 */
import { useEffect, useMemo, useState } from 'react';

type Mode = 'halfhour' | 'hour' | 'halfday' | 'day' | 'week';
interface Bucket { bucket: string; totalMs: number }

const MODES: Array<{ key: Mode; label: string; hint: string }> = [
  { key: 'halfhour', label: '半小时', hint: '近 7 天 · 48 桶/天' },
  { key: 'hour', label: '小时', hint: '近 14 天 · 24 桶/天' },
  { key: 'halfday', label: '半天', hint: '近 14 天 · 上午/下午' },
  { key: 'day', label: '天', hint: '近 26 周 · 日历视图' },
  { key: 'week', label: '周', hint: '近 26 周 · 每周总量' },
];

const LEVEL_BG = [
  'bg-surface-2',
  'bg-accent/20',
  'bg-accent/45',
  'bg-accent/70',
  'bg-accent',
];

function fmtShort(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '0m';
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 > 0 ? `${min % 60}m` : ''}` : `${min}m`;
}

function level(ms: number, max: number): number {
  if (ms <= 0 || max <= 0) return 0;
  const r = ms / max;
  if (r >= 0.75) return 4;
  if (r >= 0.5) return 3;
  if (r >= 0.25) return 2;
  return 1;
}

function dateKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} 周${wd}`;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(dateKeyOf(d));
  }
  return out;
}

function Cell(props: { ms: number; max: number; size: number; tip: string }) {
  return (
    <div
      className={`rounded-[3px] ${LEVEL_BG[level(props.ms, props.max)]} transition-transform hover:scale-125 hover:ring-1 hover:ring-accent`}
      style={{ width: props.size, height: props.size }}
      title={props.tip}
    />
  );
}

/** 行=天 × 列=时段 的日内热力图（半小时/小时/半天共用） */
function DaySlotGrid(props: {
  days: string[];
  slots: string[];
  slotLabel: (s: string) => string;
  colHeaderEvery: number;
  cellSize: number;
  data: Map<string, number>;
  max: number;
}) {
  const { days, slots, data, max, cellSize } = props;
  return (
    <div className="overflow-x-auto pb-1">
      <div className="inline-block">
        {/* 列头（时段） */}
        <div className="flex" style={{ marginLeft: 64 }}>
          {slots.map((s, i) => (
            <div key={s} style={{ width: cellSize + 3 }} className="shrink-0 text-center">
              {i % props.colHeaderEvery === 0 && (
                <span className="text-[9px] text-ink-faint whitespace-nowrap" style={{ marginLeft: -8 }}>
                  {props.slotLabel(s)}
                </span>
              )}
            </div>
          ))}
        </div>
        {/* 行 */}
        {days.map((dk) => (
          <div key={dk} className="flex items-center" style={{ height: cellSize + 3 }}>
            <span className="w-16 shrink-0 text-[10px] text-ink-faint pr-2 text-right">{dayLabel(dk)}</span>
            {slots.map((s) => {
              const ms = data.get(`${dk}|${s}`) ?? 0;
              return (
                <div key={s} style={{ width: cellSize + 3 }} className="shrink-0 flex justify-center">
                  <Cell ms={ms} max={max} size={cellSize} tip={`${dayLabel(dk)} ${props.slotLabel(s)}：${fmtShort(ms)}`} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 经典 GitHub 日历：7 行（周一~周日）× N 周列 */
function CalendarGrid(props: { data: Map<string, number>; max: number; weeks: number }) {
  const { data, max, weeks } = props;
  const size = 13;
  const today = new Date();
  // 起点：n 周前的周一
  const start = new Date(today);
  start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7);

  const cols: Array<Array<{ dk: string; ms: number } | null>> = [];
  for (let w = 0; w < weeks; w++) {
    const col: Array<{ dk: string; ms: number } | null> = [];
    for (let r = 0; r < 7; r++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + r);
      if (d > today) {
        col.push(null);
      } else {
        const dk = dateKeyOf(d);
        col.push({ dk, ms: data.get(dk) ?? 0 });
      }
    }
    cols.push(col);
  }

  // 月份标签：列首日是新月时标注
  const monthMarks = cols.map((col, i) => {
    const first = col.find((c) => c !== null);
    if (!first) return '';
    const d = new Date(`${first.dk}T00:00:00`);
    const prev = i > 0 ? cols[i - 1].find((c) => c !== null) : null;
    const prevD = prev ? new Date(`${prev.dk}T00:00:00`) : null;
    return !prevD || prevD.getMonth() !== d.getMonth() ? `${d.getMonth() + 1}月` : '';
  });

  const rowNames = ['一', '', '三', '', '五', '', '日'];
  return (
    <div className="overflow-x-auto pb-1">
      <div className="inline-block">
        <div className="flex" style={{ marginLeft: 24 }}>
          {monthMarks.map((m, i) => (
            <div key={i} style={{ width: size + 3 }} className="shrink-0">
              <span className="text-[9px] text-ink-faint whitespace-nowrap">{m}</span>
            </div>
          ))}
        </div>
        {rowNames.map((rn, r) => (
          <div key={r} className="flex items-center" style={{ height: size + 3 }}>
            <span className="w-6 shrink-0 text-[9px] text-ink-faint text-right pr-1.5">{rn}</span>
            {cols.map((col, c) => {
              const cell = col[r];
              return (
                <div key={c} style={{ width: size + 3 }} className="shrink-0 flex justify-center">
                  {cell && (
                    <Cell
                      ms={cell.ms}
                      max={max}
                      size={size}
                      tip={`${dayLabel(cell.dk)}：${fmtShort(cell.ms)}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 周视图：每周一格（键 = 本周周一日期，与后端 date(...,'weekday 1','-7 days') 一致），单行铺开 */
function WeekStrip(props: { data: Map<string, number>; max: number; weeks: number }) {
  const { data, max, weeks } = props;
  const size = 16;
  const cells: Array<{ key: string; label: string; ms: number }> = [];
  const today = new Date();
  // 本周周一
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  for (let i = weeks - 1; i >= 0; i--) {
    const monday = new Date(thisMonday);
    monday.setDate(thisMonday.getDate() - i * 7);
    const key = dateKeyOf(monday);
    cells.push({ key, label: `${monday.getMonth() + 1}/${monday.getDate()}周`, ms: data.get(key) ?? 0 });
  }

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex items-end gap-[3px]">
        {cells.map((c, i) => (
          <div key={i} className="flex flex-col items-center gap-1.5 shrink-0">
            <Cell ms={c.ms} max={max} size={size} tip={`${c.label}：${fmtShort(c.ms)}`} />
            {i % 4 === 0 && <span className="text-[9px] text-ink-faint whitespace-nowrap">{c.label}</span>}
            {i % 4 !== 0 && <span className="text-[9px]">&nbsp;</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StatsPage() {
  const [mode, setMode] = useState<Mode>('day');
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setBuckets(null);
    setFailed(false);
    window.timepaws
      .statsHeatmap(mode)
      .then(setBuckets)
      .catch(() => setFailed(true));
  }, [mode]);

  const data = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of buckets ?? []) m.set(b.bucket, b.totalMs);
    return m;
  }, [buckets]);

  const max = Math.max(0, ...(buckets ?? []).map((b) => b.totalMs));
  const totalMs = (buckets ?? []).reduce((a, b) => a + b.totalMs, 0);
  const activeBuckets = (buckets ?? []).filter((b) => b.totalMs > 0).length;

  const hourSlots = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const halfHourSlots = Array.from({ length: 48 }, (_, i) => String(i));

  return (
    <section className="max-w-3xl" aria-label="统计">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-semibold">统计</h1>
        {/* 粒度切换 */}
        <div className="flex rounded-lg bg-surface p-0.5 border border-line/60">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                mode === m.key
                  ? 'bg-accent text-white font-medium'
                  : 'text-ink-dim hover:text-ink hover:bg-surface-2'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* 概览条 */}
      <div className="flex gap-6 mb-4 text-sm">
        <span className="text-ink-dim">
          总计 <span className="text-ink font-semibold tabular">{fmtShort(totalMs)}</span>
        </span>
        <span className="text-ink-dim">
          活跃 <span className="text-ink font-semibold tabular">{activeBuckets}</span> 个时段
        </span>
        <span className="text-ink-faint text-xs ml-auto self-center">{MODES.find((m) => m.key === mode)?.hint}</span>
      </div>

      <div className="rounded-xl2 bg-surface shadow-card border border-line/50 p-5">
        {failed ? (
          <div className="text-ink-dim text-sm">
            数据读取失败。
            <button
              className="underline hover:text-ink"
              onClick={() =>
                window.timepaws.statsHeatmap(mode).then(setBuckets).catch(() => setFailed(true))
              }
            >
              重试
            </button>
          </div>
        ) : buckets === null ? (
          <p className="text-sm text-ink-faint">加载中…</p>
        ) : buckets.length === 0 ? (
          <p className="text-sm text-ink-faint">
            还没有历史数据。TimePaws 会从第一次运行开始积累，明天再来看趋势。
          </p>
        ) : (
          <>
            {mode === 'halfhour' && (
              <DaySlotGrid
                days={lastNDays(7)}
                slots={halfHourSlots}
                slotLabel={(s) => `${Math.floor(Number(s) / 2)}:${Number(s) % 2 === 0 ? '00' : '30'}`}
                colHeaderEvery={4}
                cellSize={10}
                data={data}
                max={max}
              />
            )}
            {mode === 'hour' && (
              <DaySlotGrid
                days={lastNDays(14)}
                slots={hourSlots}
                slotLabel={(s) => `${Number(s)}时`}
                colHeaderEvery={3}
                cellSize={13}
                data={data}
                max={max}
              />
            )}
            {mode === 'halfday' && (
              <DaySlotGrid
                days={lastNDays(14)}
                slots={['am', 'pm']}
                slotLabel={(s) => (s === 'am' ? '上午' : '下午')}
                colHeaderEvery={1}
                cellSize={18}
                data={data}
                max={max}
              />
            )}
            {mode === 'day' && <CalendarGrid data={data} max={max} weeks={26} />}
            {mode === 'week' && <WeekStrip data={data} max={max} weeks={26} />}

            {/* 图例 */}
            <div className="flex items-center justify-end gap-1.5 mt-4 text-[10px] text-ink-faint">
              <span>少</span>
              {LEVEL_BG.map((bg, i) => (
                <div key={i} className={`w-3 h-3 rounded-[3px] ${bg}`} />
              ))}
              <span>多</span>
            </div>
          </>
        )}
      </div>

      <p className="mt-4 text-xs text-ink-faint leading-relaxed">
        口径：主屏前台 + 非空闲时长。空闲超过阈值不计入；锁屏/最小化不算前台。
      </p>
    </section>
  );
}
