//! M2：SQLite 存储层（rusqlite bundled，替代 Electron 版 better-sqlite3）
//!
//! 表结构与 Electron 版 `db.ts` 完全一致，两版可读同一份历史数据：
//! - sessions / daily_app_stats / daily_title_stats / events_switch / tasks
//! - WAL 模式；recordSession 同步聚合日表
//!
//! Electron 版踩过的坑在这里不复存在：
//! - 布尔绑定无需手动 0/1（rusqlite bool 原生支持）

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection};
use tauri::Manager;

// ---------------------------------------------------------------- 连接管理

static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

pub fn db_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("anchor.db")
}

pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = Connection::open(db_path(app)).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| e.to_string())?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            app_key     TEXT NOT NULL,
            app_name    TEXT NOT NULL,
            title       TEXT NOT NULL,
            started_at  INTEGER NOT NULL,
            ended_at    INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            counted_ms  INTEGER NOT NULL,
            on_primary  INTEGER NOT NULL DEFAULT 0,
            counted     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);

        CREATE TABLE IF NOT EXISTS daily_app_stats (
            date_key TEXT NOT NULL,
            app_key  TEXT NOT NULL,
            app_name TEXT NOT NULL,
            total_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date_key, app_key)
        );

        CREATE TABLE IF NOT EXISTS daily_title_stats (
            date_key TEXT NOT NULL,
            title    TEXT NOT NULL,
            app_name TEXT NOT NULL,
            total_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date_key, title)
        );

        CREATE TABLE IF NOT EXISTS events_switch (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            at        INTEGER NOT NULL,
            app_key   TEXT NOT NULL,
            app_name  TEXT NOT NULL,
            title     TEXT NOT NULL,
            on_primary INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_events_at ON events_switch(at);

        CREATE TABLE IF NOT EXISTS tasks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            text       TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'todo',
            is_current INTEGER NOT NULL DEFAULT 0,
            focus_ms   INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            done_at    INTEGER
        );
        "#,
    )
    .map_err(|e| e.to_string())?;

    let _ = CONN.set(Mutex::new(conn));
    Ok(())
}

fn conn() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    CONN.get()
        .ok_or_else(|| "db not initialized".to_string())?
        .lock()
        .map_err(|e| e.to_string())
}

fn date_key_of(ms: i64) -> String {
    // 本地时区的 YYYY-MM-DD（与 Electron 版 dayKey 口径一致）
    use chrono::{Local, TimeZone};
    Local.timestamp_millis_opt(ms).unwrap().format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------- 会话落库

/// 会话结算 → 落库 + 聚合日表（对应 Electron 版 recordSession + session 监听）
pub fn record_session(
    app_key: &str,
    app_name: &str,
    title: &str,
    started_at: i64,
    ended_at: i64,
    duration_ms: i64,
    counted_ms: i64,
    on_primary: bool,
    counted: bool,
) -> Result<(), String> {
    let mut c = conn()?;
    let tx = c.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO sessions (app_key, app_name, title, started_at, ended_at, duration_ms, counted_ms, on_primary, counted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![app_key, app_name, title, started_at, ended_at, duration_ms, counted_ms, on_primary, counted],
    )
    .map_err(|e| e.to_string())?;

    // 前台切换事件流（用于 switch_storm 提醒）
    tx.execute(
        "INSERT INTO events_switch (at, app_key, app_name, title, on_primary) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ended_at, app_key, app_name, title, on_primary],
    )
    .map_err(|e| e.to_string())?;

    // 日聚合口径与 Electron 版一致：counted 才计入
    if counted {
        let dk = date_key_of(ended_at);
        tx.execute(
            "INSERT INTO daily_app_stats (date_key, app_key, app_name, total_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(date_key, app_key) DO UPDATE SET total_ms = total_ms + excluded.total_ms",
            params![dk, app_key, app_name, counted_ms],
        )
        .map_err(|e| e.to_string())?;

        let t = if title.trim().is_empty() { "(无标题)" } else { title };
        tx.execute(
            "INSERT INTO daily_title_stats (date_key, title, app_name, total_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(date_key, title) DO UPDATE SET total_ms = total_ms + excluded.total_ms",
            params![dk, t, app_name, counted_ms],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- 统计查询

#[derive(serde::Serialize)]
pub struct DailyAppRow {
    pub app_key: String,
    pub app_name: String,
    pub total_ms: i64,
}

/// 今日统计（对应 Electron 版 statsToday）
pub fn stats_today() -> Result<serde_json::Value, String> {
    let c = conn()?;
    let dk = date_key_of(now_ms());

    let total_ms: i64 = c
        .query_row(
            "SELECT COALESCE(SUM(counted_ms), 0) FROM sessions WHERE counted = 1 AND ended_at >= ?1",
            params![day_start_ms()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let counted_sessions: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE counted = 1 AND ended_at >= ?1",
            params![day_start_ms()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = c
        .prepare(
            "SELECT app_key, app_name, total_ms FROM daily_app_stats WHERE date_key = ?1 ORDER BY total_ms DESC LIMIT 8",
        )
        .map_err(|e| e.to_string())?;
    let top_apps: Vec<DailyAppRow> = stmt
        .query_map(params![dk], |r| {
            Ok(DailyAppRow {
                app_key: r.get(0)?,
                app_name: r.get(1)?,
                total_ms: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = c
        .prepare(
            "SELECT title, app_name, total_ms FROM daily_title_stats WHERE date_key = ?1 ORDER BY total_ms DESC LIMIT 5",
        )
        .map_err(|e| e.to_string())?;
    let top_titles: Vec<serde_json::Value> = stmt
        .query_map(params![dk], |r| {
            Ok(serde_json::json!({
                "title": r.get::<_, String>(0)?,
                "app_name": r.get::<_, String>(1)?,
                "total_ms": r.get::<_, i64>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = c
        .prepare(
            "SELECT app_name, title, ended_at, duration_ms FROM sessions WHERE counted = 1 AND ended_at >= ?1 ORDER BY ended_at DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let recent: Vec<serde_json::Value> = stmt
        .query_map(params![day_start_ms()], |r| {
            Ok(serde_json::json!({
                "app_name": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "ended_at": r.get::<_, i64>(2)?,
                "duration_ms": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::json!({
        "dateKey": dk,
        "totalMs": total_ms,
        "countedSessions": counted_sessions,
        "topApps": top_apps,
        "topTitles": top_titles,
        "recent": recent,
    }))
}

/// 近 N 天每日总量（对应 Electron 版 statsDailyTotals）
pub fn stats_daily_totals(days: i64) -> Result<Vec<serde_json::Value>, String> {
    let c = conn()?;
    let since = now_ms() - days * 86_400_000;
    let mut stmt = c
        .prepare(
            "SELECT date_key, SUM(total_ms) FROM daily_app_stats
             WHERE date_key >= date(?1 / 1000.0, 'unixepoch', 'localtime')
             GROUP BY date_key ORDER BY date_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![since], |r| {
            Ok(serde_json::json!({
                "dateKey": r.get::<_, String>(0)?,
                "totalMs": r.get::<_, i64>(1)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// ---------------------------------------------------------------- 工具

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn day_start_ms() -> i64 {
    use chrono::{Datelike, TimeZone};
    let now = chrono::Local::now();
    let d = now.date_naive();
    chrono::Local
        .with_ymd_and_hms(d.year(), d.month(), d.day(), 0, 0, 0)
        .single()
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}
