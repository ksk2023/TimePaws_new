/**
 * 设置页（M5）：追踪开关、空闲阈值、提醒参数、开机自启、数据导出/清理。
 * 隐私立场：所有数据只在本地（userData），导出/清理都给用户明确反馈。
 */
import { useCallback, useEffect, useState } from 'react';

interface SettingsShape {
  trackingPaused: boolean;
  idleTimeoutMs: number;
  remindersPaused: boolean;
  autostart: boolean;
  reminders: Record<string, number>;
}

interface DataStats { sessions: number; days: number; tasks: number; dbFile: string }

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-center justify-between py-3 ${props.disabled ? 'opacity-50' : ''}`}>
      <span className="min-w-0 pr-4">
        <span className="block text-base2 text-ink">{props.label}</span>
        {props.hint && <span className="block text-xs text-ink-faint mt-0.5">{props.hint}</span>}
      </span>
      <button
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={() => !props.disabled && props.onChange(!props.checked)}
        className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${props.checked ? 'bg-accent' : 'bg-surface-2'}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${props.checked ? 'left-[22px]' : 'left-0.5'}`}
        />
      </button>
    </label>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<SettingsShape | null>(null);
  const [stats, setStats] = useState<DataStats | null>(null);
  const [notice, setNotice] = useState('');
  const [confirmPurge, setConfirmPurge] = useState(false);

  const refresh = useCallback(() => {
    window.timepaws.settingsGet().then((v) => setS(v as unknown as SettingsShape)).catch(() => undefined);
    window.timepaws.dataStats().then(setStats).catch(() => undefined);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const flash = (msg: string): void => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 3500);
  };

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    const next = await window.timepaws.settingsUpdate(p);
    setS(next as unknown as SettingsShape);
  };

  if (!s) {
    return (
      <section className="max-w-xl" aria-label="设置">
        <h1 className="text-xl font-semibold mb-6">设置</h1>
        <p className="text-sm text-ink-faint">加载中…</p>
      </section>
    );
  }

  return (
    <section className="max-w-xl" aria-label="设置">
      <h1 className="text-xl font-semibold mb-6">设置</h1>

      {notice && (
        <div className="mb-4 rounded-xl2 bg-accent/15 border border-accent/40 px-4 py-2.5 text-sm text-accent">
          {notice}
        </div>
      )}

      {/* 追踪 */}
      <div className="rounded-xl2 bg-surface shadow-card px-5 mb-4 divide-y divide-line/50">
        <Toggle
          checked={!s.trackingPaused}
          onChange={(v) => void patch({ trackingPaused: !v })}
          label="使用追踪"
          hint="关闭后不计任何前台时长，已有数据保留"
        />
        <div className="py-3">
          <div className="flex items-center justify-between">
            <span className="text-base2 text-ink">空闲阈值</span>
            <span className="text-sm text-ink-faint">{Math.round(s.idleTimeoutMs / 1000)} 秒</span>
          </div>
          <input
            type="range"
            min={10}
            max={300}
            step={5}
            value={Math.round(s.idleTimeoutMs / 1000)}
            onChange={(e) => void patch({ idleTimeoutMs: Number(e.target.value) * 1000 })}
            className="w-full mt-2 accent-accent"
          />
          <p className="text-xs text-ink-faint mt-1">无键鼠输入超过该时长，停止计时长（10s–5min）。</p>
        </div>
      </div>

      {/* 提醒 */}
      <div className="rounded-xl2 bg-surface shadow-card px-5 mb-4 divide-y divide-line/50">
        <Toggle
          checked={!s.remindersPaused}
          onChange={(v) => void patch({ remindersPaused: !v })}
          label="陪伴提醒"
          hint="走神轻推 / 专注休息 / 切换平复 / 回归欢迎"
        />
        <div className="py-3">
          <div className="flex items-center justify-between">
            <span className="text-base2 text-ink">专注休息间隔</span>
            <span className="text-sm text-ink-faint">{Math.round((s.reminders.heartbeatFocusMs ?? 3_000_000) / 60_000)} 分钟</span>
          </div>
          <input
            type="range"
            min={20}
            max={120}
            step={5}
            value={Math.round((s.reminders.heartbeatFocusMs ?? 3_000_000) / 60_000)}
            onChange={(e) => void patch({ reminders: { ...s.reminders, heartbeatFocusMs: Number(e.target.value) * 60_000 } })}
            className="w-full mt-2 accent-accent"
          />
        </div>
        <div className="py-3 flex items-center justify-between">
          <span className="text-base2 text-ink">预览一条提醒</span>
          <button
            onClick={() => void window.timepaws.remindersTest()}
            className="rounded-lg bg-surface-2 hover:bg-surface-2/70 px-3 py-1.5 text-sm text-ink-dim transition-colors"
          >
            预览
          </button>
        </div>
      </div>

      {/* 系统 */}
      <div className="rounded-xl2 bg-surface shadow-card px-5 mb-4">
        <Toggle
          checked={s.autostart}
          onChange={(v) => void patch({ autostart: v })}
          label="开机自动启动"
          hint="登录 Windows 后在后台运行（托盘常驻）"
        />
      </div>

      {/* 数据与隐私 */}
      <div className="rounded-xl2 bg-surface shadow-card px-5 py-4 mb-4">
        <div className="text-sm text-ink-dim mb-3">数据（全部只存在本机）</div>
        <div className="text-sm text-ink-dim space-y-1 mb-4">
          <div>{stats ? `${stats.sessions} 段会话 · 覆盖 ${stats.days} 天 · ${stats.tasks} 个任务` : '—'}</div>
          {stats && <div className="text-xs text-ink-faint break-all">{stats.dbFile}</div>}
        </div>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              const r = await window.timepaws.dataExport();
              flash(`已导出 ${r.sessions} 段会话到 exports 目录`);
            }}
            className="rounded-lg bg-surface-2 hover:bg-surface-2/70 px-4 py-2 text-sm text-ink-dim transition-colors"
          >
            导出全部数据（JSON）
          </button>
          {confirmPurge ? (
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const r = await window.timepaws.dataPurge(false);
                  setConfirmPurge(false);
                  refresh();
                  flash(`已清空 ${r.sessions} 段会话与聚合数据（任务保留）`);
                }}
                className="rounded-lg bg-red-600 hover:bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                确认清空
              </button>
              <button
                onClick={() => setConfirmPurge(false)}
                className="rounded-lg bg-surface-2 px-4 py-2 text-sm text-ink-dim"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPurge(true)}
              className="rounded-lg border border-red-600/50 text-red-600 hover:bg-red-600/10 px-4 py-2 text-sm transition-colors"
            >
              清空追踪数据
            </button>
          )}
        </div>
        <p className="text-xs text-ink-faint mt-3">清空只删会话/统计/事件流，任务默认保留；导出包含全部内容。</p>
      </div>

      <p className="text-xs text-ink-faint leading-relaxed">
        TimePaws 不联网、不上传任何数据。标题仅在本机数据库中用于展示，可随时清空或导出后删除。
      </p>
    </section>
  );
}
