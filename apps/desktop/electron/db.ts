/**
 * SQLite 数据层（M2）—— better-sqlite3，主进程独占连接，渲染层一律走 IPC。
 *
 * 表设计（本地优先，全部存 userData/anchor.db）：
 * - sessions        前台会话片段：一次前台停留 = 一行（app/title/起止/是否主屏/是否计入）
 * - daily_app_stats 每日×应用聚合（查询热路径，写入时同步 upsert）
 * - daily_title_stats 每日×标题聚合（Top 标题用）
 * - events_switch   事件流（switch/idle_back/lost_foreground/primary_changed，M4 回放用）
 *
 * 计入口径（与 tracker 一致）：
 * - 只计主屏前台（onPrimary 且非 iconic）
 * - 空闲超时不计（db 层依据 session.counted 标记，tracker 决定标记值）
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';

export interface SessionRow {
  id: number;
  date_key: string;      // YYYY-MM-DD 本地
  app_key: string;       // code.exe
  app_name: string;      // VS Code
  title: string;
  started_at: number;    // epoch ms
  ended_at: number;      // epoch ms
  duration_ms: number;
  on_primary: 0 | 1;
  counted: 0 | 1;        // 是否计入时长（主屏 + 非空闲）
}

export interface DailyAppRow {
  app_key: string;
  app_name: string;
  total_ms: number;
}

export interface DailySummary {
  dateKey: string;
  totalMs: number;          // 今日计入总时长
  countedSessions: number;
  topApps: DailyAppRow[];
  topTitles: Array<{ title: string; app_name: string; total_ms: number }>;
  recent: Array<{ app_name: string; title: string; ended_at: number; duration_ms: number }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  app_key TEXT NOT NULL,
  app_name TEXT NOT NULL,
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  on_primary INTEGER NOT NULL DEFAULT 0,
  counted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date_key);
CREATE INDEX IF NOT EXISTS idx_sessions_date_app ON sessions(date_key, app_key);

CREATE TABLE IF NOT EXISTS daily_app_stats (
  date_key TEXT NOT NULL,
  app_key TEXT NOT NULL,
  app_name TEXT NOT NULL,
  total_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date_key, app_key)
);

CREATE TABLE IF NOT EXISTS daily_title_stats (
  date_key TEXT NOT NULL,
  title TEXT NOT NULL,
  app_key TEXT NOT NULL,
  app_name TEXT NOT NULL,
  total_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date_key, title, app_key)
);

CREATE TABLE IF NOT EXISTS events_switch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  app_key TEXT,
  app_name TEXT,
  title TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',   -- todo | doing | done（doing = 当前任务，全局至多一个）
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  focus_ms INTEGER NOT NULL DEFAULT 0    -- 累计专注：当前任务期间的主屏计入时长
);
`;

let db: Database.Database | null = null;

/** 供 settings.ts（导出/清理）直接访问连接实例；未打开时为 null */
export function getDb(): Database.Database | null {
  return db;
}

/** 打开（幂等）：WAL 模式，主进程独占。失败抛错由调用方决定降级 */
export function openDatabase(): void {
  if (db) return;
  const file = path.join(app.getPath('userData'), 'anchor.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

/* ── 写入 ─────────────────────────────────────────────────── */

interface SessionInput {
  dateKey: string;
  appKey: string;
  appName: string;
  title: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  onPrimary: boolean;
  counted: boolean;
}

const insertSession = () =>
  db!.prepare(
    `INSERT INTO sessions (date_key, app_key, app_name, title, started_at, ended_at, duration_ms, on_primary, counted)
     VALUES (@dateKey, @appKey, @appName, @title, @startedAt, @endedAt, @durationMs, @onPrimary, @counted)`,
  );

const upsertDailyApp = () =>
  db!.prepare(
    `INSERT INTO daily_app_stats (date_key, app_key, app_name, total_ms) VALUES (@dateKey, @appKey, @appName, @durationMs)
     ON CONFLICT(date_key, app_key) DO UPDATE SET total_ms = total_ms + @durationMs, app_name = @appName`,
  );

const upsertDailyTitle = () =>
  db!.prepare(
    `INSERT INTO daily_title_stats (date_key, title, app_key, app_name, total_ms) VALUES (@dateKey, @title, @appKey, @appName, @durationMs)
     ON CONFLICT(date_key, title, app_key) DO UPDATE SET total_ms = total_ms + @durationMs`,
  );

const insertEvent = () =>
  db!.prepare(
    `INSERT INTO events_switch (at, kind, app_key, app_name, title) VALUES (@at, @kind, @appKey, @appName, @title)`,
  );

/** 落一条会话（tracker 会话结束时调用；counted=false 也落库，供完整时间线） */
export function recordSession(s: SessionInput): void {
  if (!db) return;
  // better-sqlite3 只接受 number/string/bigint/buffer/null，boolean 必须显式转 0/1
  const row = { ...s, onPrimary: s.onPrimary ? 1 : 0, counted: s.counted ? 1 : 0 };
  const tx = db.transaction(() => {
    insertSession().run(row);
    if (s.counted) {
      upsertDailyApp().run(row);
      upsertDailyTitle().run(row);
    }
  });
  tx();

  // 事件流：只记关键事件，防止无限膨胀（M4 回放/复盘用）
  if (db) {
    insertEvent().run({
      at: s.endedAt,
      kind: s.counted ? 'switch' : 'uncounted',
      appKey: s.appKey,
      appName: s.appName,
      title: s.title,
    });
  }
}

/* ── 查询 ─────────────────────────────────────────────────── */

/** 今日汇总：总时长、Top 应用、Top 标题、最近会话 */
export function getDailySummary(dateKey: string): DailySummary {
  if (!db) {
    return { dateKey, totalMs: 0, countedSessions: 0, topApps: [], topTitles: [], recent: [] };
  }

  const total = db
    .prepare(`SELECT COALESCE(SUM(total_ms), 0) AS ms FROM daily_app_stats WHERE date_key = ?`)
    .get(dateKey) as { ms: number };

  const counted = db
    .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE date_key = ? AND counted = 1`)
  .get(dateKey) as { n: number };

  const topApps = db
    .prepare(
      `SELECT app_key, app_name, total_ms FROM daily_app_stats WHERE date_key = ? ORDER BY total_ms DESC LIMIT 8`,
    )
    .all(dateKey) as DailyAppRow[];

  const topTitles = db
    .prepare(
      `SELECT title, app_name, total_ms FROM daily_title_stats WHERE date_key = ? ORDER BY total_ms DESC LIMIT 10`,
    )
    .all(dateKey) as Array<{ title: string; app_name: string; total_ms: number }>;

  const recent = db
    .prepare(
      `SELECT app_name, title, ended_at, duration_ms FROM sessions
       WHERE date_key = ? AND counted = 1 AND duration_ms >= 5000
       ORDER BY ended_at DESC LIMIT 12`,
    )
    .all(dateKey) as Array<{ app_name: string; title: string; ended_at: number; duration_ms: number }>;

  return { dateKey, totalMs: total.ms, countedSessions: counted.n, topApps, topTitles, recent };
}

/** 最近 N 天每日总时长（统计页趋势条） */
export function getDailyTotals(days: number): Array<{ dateKey: string; totalMs: number }> {
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT date_key AS dateKey, SUM(total_ms) AS ms FROM daily_app_stats GROUP BY date_key ORDER BY date_key DESC LIMIT ?`,
    )
    .all(days) as Array<{ dateKey: string; ms: number }>;
  return rows.map((r) => ({ dateKey: r.dateKey, totalMs: r.ms }));
}

/* ── 任务（M3）────────────────────────────────────────────── */

export interface TaskRow {
  id: number;
  text: string;
  status: 'todo' | 'doing' | 'done';
  created_at: number;
  done_at: number | null;
  focus_ms: number;
}

/** 任务列表：doing 优先，其余按创建倒序；可选隐藏已完成 */
export function listTasks(includeDone = true): TaskRow[] {
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT id, text, status, created_at, done_at, focus_ms FROM tasks
       ${includeDone ? '' : `WHERE status != 'done'`}
       ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, created_at DESC`,
    )
    .all() as unknown as TaskRow[];
  return rows;
}

export function getCurrentTask(): TaskRow | null {
  if (!db) return null;
  return (db
    .prepare(`SELECT id, text, status, created_at, done_at, focus_ms FROM tasks WHERE status = 'doing' LIMIT 1`)
    .get() as unknown as TaskRow) ?? null;
}

export function createTask(text: string): TaskRow {
  if (!db) throw new Error('db not open');
  const now = Date.now();
  const res = db
    .prepare(`INSERT INTO tasks (text, status, created_at) VALUES (?, 'todo', ?)`)
    .run(text, now);
  return {
    id: Number(res.lastInsertRowid),
    text,
    status: 'todo',
    created_at: now,
    done_at: null,
    focus_ms: 0,
  };
}

export function updateTaskText(id: number, text: string): void {
  db?.prepare(`UPDATE tasks SET text = ? WHERE id = ?`).run(text, id);
}

/** 删除任务（doing 也可删，当前任务随之清空） */
export function deleteTask(id: number): void {
  db?.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

/**
 * 设定当前任务：全局至多一个 doing。
 * 旧 doing 退回 todo（保留累计专注时长）；目标任务置为 doing。
 */
export function setCurrentTask(id: number): void {
  if (!db) return;
  const tx = db.transaction(() => {
    db!.prepare(`UPDATE tasks SET status = 'todo' WHERE status = 'doing'`).run();
    db!.prepare(`UPDATE tasks SET status = 'doing' WHERE id = ?`).run(id);
  });
  tx();
}

/** 完成任务：doing/todo → done；若有会话在计时（见 focusTick），先结算 */
export function completeTask(id: number): void {
  if (!db) return;
  db.prepare(`UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status != 'done'`).run(Date.now(), id);
}

/** 恢复到待办 */
export function reopenTask(id: number): void {
  if (!db) return;
  db.prepare(`UPDATE tasks SET status = 'todo', done_at = NULL WHERE id = ?`).run(id);
}

/**
 * 专注时长入账：当前 doing 任务累计 focus_ms。
 * 由主进程的 focus 积累器定期调用（见 reminders.ts / main.ts 的 tick）。
 */
export function addFocusMs(ms: number): void {
  if (!db || ms <= 0) return;
  db.prepare(`UPDATE tasks SET focus_ms = focus_ms + ? WHERE status = 'doing'`).run(ms);
}
