/**
 * 设置与隐私（M5）
 *
 * - 设置持久化：userData/settings.json（JSON 读写，字段少不值得上库）
 * - 数据导出：sessions/daily_app_stats/tasks → userData/exports/anchor-export-<ts>.json
 *   （CSV 导出 M6 打包前按需加；JSON 结构稳定且够用）
 * - 数据清理：清空追踪数据（sessions/聚合/事件流），保留任务；或全清
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db';

/** 提醒规则参数补丁（与 reminders.ts 的 ReminderConfig 字段对齐的子集） */
export type ReminderConfigPatch = Record<string, number>;

/* ── 设置结构 ────────────────────────────────────────────── */

export interface AnchorSettings {
  trackingPaused: boolean;        // 暂停追踪
  idleTimeoutMs: number;          // 空闲阈值（默认 60s，最小 10s）
  remindersPaused: boolean;       // 暂停提醒
  reminders: ReminderConfigPatch; // 提醒规则参数
  autostart: boolean;             // 开机自启
}

export const DEFAULT_SETTINGS: AnchorSettings = {
  trackingPaused: false,
  idleTimeoutMs: 60_000,
  remindersPaused: false,
  reminders: {},
  autostart: false,
};

let cache: AnchorSettings | null = null;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): AnchorSettings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AnchorSettings>;
    cache = { ...DEFAULT_SETTINGS, ...parsed, reminders: { ...(parsed.reminders ?? {}) } };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export function saveSettings(next: AnchorSettings): void {
  cache = next;
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] save failed:', err);
  }
}

export function updateSettings(patch: Partial<AnchorSettings>): AnchorSettings {
  const cur = loadSettings();
  const next: AnchorSettings = {
    ...cur,
    ...patch,
    reminders: { ...cur.reminders, ...(patch.reminders ?? {}) },
  };
  saveSettings(next);
  applySettings(next);
  return next;
}

/** 设置变化后同步到各子系统 */
export function applySettings(s: AnchorSettings): void {
  // 延迟 require 避免循环依赖
  const { setIdleTimeoutMs, setTrackingPaused } = require('./tracker') as typeof import('./tracker');
  const { setRemindersPaused, updateReminderConfig } = require('./reminders') as typeof import('./reminders');
  setIdleTimeoutMs(s.idleTimeoutMs);
  setTrackingPaused(s.trackingPaused);
  setRemindersPaused(s.remindersPaused);
  updateReminderConfig(s.reminders);
  applyAutostart(s.autostart);
}

/* ── 开机自启 ────────────────────────────────────────────── */

export function applyAutostart(enable: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enable, path: process.execPath });
  } catch (err) {
    console.error('[settings] autostart failed:', err);
  }
}

/* ── 数据导出 ────────────────────────────────────────────── */

export interface ExportResult {
  file: string;
  sessions: number;
  dailyAppRows: number;
  tasks: number;
}

export function exportData(): ExportResult {
  const db = getDb();
  if (!db) throw new Error('db not open');
  const dir = path.join(app.getPath('userData'), 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `anchor-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  const sessions = db.prepare(`SELECT * FROM sessions ORDER BY started_at`).all();
  const dailyApp = db.prepare(`SELECT * FROM daily_app_stats ORDER BY date_key`).all();
  const dailyTitle = db.prepare(`SELECT * FROM daily_title_stats ORDER BY date_key`).all();
  const tasks = db.prepare(`SELECT * FROM tasks ORDER BY created_at`).all();

  const payload = {
    exportedAt: Date.now(),
    app: 'Anchor 锚点',
    version: 1,
    sessions,
    dailyAppStats: dailyApp,
    dailyTitleStats: dailyTitle,
    tasks,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return { file, sessions: sessions.length, dailyAppRows: dailyApp.length, tasks: tasks.length };
}

/* ── 数据清理 ────────────────────────────────────────────── */

export interface PurgeResult {
  sessions: number;
  dailyAppRows: number;
  dailyTitleRows: number;
  events: number;
  tasks: number; // includeTasks=true 时才 >0
}

/** 清空追踪数据；includeTasks=false 保留任务（默认保留） */
export function purgeTrackingData(includeTasks: boolean): PurgeResult {
  const db = getDb();
  if (!db) throw new Error('db not open');
  const count = (sql: string): number =>
    (db!.prepare(sql).get() as { n: number }).n;

  const before: PurgeResult = {
    sessions: count(`SELECT COUNT(*) n FROM sessions`),
    dailyAppRows: count(`SELECT COUNT(*) n FROM daily_app_stats`),
    dailyTitleRows: count(`SELECT COUNT(*) n FROM daily_title_stats`),
    events: count(`SELECT COUNT(*) n FROM events_switch`),
    tasks: 0,
  };

  const tx = db.transaction(() => {
    db!.prepare(`DELETE FROM sessions`).run();
    db!.prepare(`DELETE FROM daily_app_stats`).run();
    db!.prepare(`DELETE FROM daily_title_stats`).run();
    db!.prepare(`DELETE FROM events_switch`).run();
    if (includeTasks) {
      before.tasks = count(`SELECT COUNT(*) n FROM tasks`);
      db!.prepare(`DELETE FROM tasks`).run();
    }
  });
  tx();

  // WAL checkpoint 让文件立刻瘦身
  db.pragma('wal_checkpoint(TRUNCATE)');
  return before;
}

/** 数据规模概览（设置页显示） */
export function dataStats(): { sessions: number; days: number; tasks: number; dbFile: string } {
  const db = getDb();
  if (!db) return { sessions: 0, days: 0, tasks: 0, dbFile: '' };
  const sessions = (db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number }).n;
  const days = (db.prepare(`SELECT COUNT(DISTINCT date_key) n FROM sessions`).get() as { n: number }).n;
  const tasks = (db.prepare(`SELECT COUNT(*) n FROM tasks`).get() as { n: number }).n;
  return { sessions, days, tasks, dbFile: path.join(app.getPath('userData'), 'anchor.db') };
}
