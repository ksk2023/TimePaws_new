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
static DB_FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn db_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("timepaws.db")
}

/// 数据库文件实际路径（init 后可用，设置页展示用）
pub fn db_file() -> PathBuf {
    DB_FILE.get().cloned().unwrap_or_else(|| PathBuf::from("timepaws.db"))
}

pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let path = db_path(app);
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
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

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())?;

    let _ = DB_FILE.set(path);
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

// ---------------------------------------------------------------- 任务箱 (M3)

#[derive(serde::Serialize)]
pub struct TaskInfo {
    pub id: i64,
    pub text: String,
    pub status: String, // todo | doing | done
    pub created_at: i64,
    pub done_at: Option<i64>,
    pub focus_ms: i64,
}

/// 任务列表（include_done=false 时隐藏已完成）
pub fn list_tasks(include_done: bool) -> Result<Vec<TaskInfo>, String> {
    let c = conn()?;
    let sql = if include_done {
        "SELECT id, text, status, created_at, done_at, focus_ms FROM tasks ORDER BY status='doing' DESC, status='todo' DESC, created_at DESC"
    } else {
        "SELECT id, text, status, created_at, done_at, focus_ms FROM tasks WHERE status != 'done' ORDER BY status='doing' DESC, created_at DESC"
    };
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TaskInfo {
                id: r.get(0)?,
                text: r.get(1)?,
                status: r.get(2)?,
                created_at: r.get(3)?,
                done_at: r.get(4)?,
                focus_ms: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 当前 doing 任务（全局至多一个）
pub fn current_task() -> Result<Option<TaskInfo>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT id, text, status, created_at, done_at, focus_ms FROM tasks WHERE status = 'doing' LIMIT 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([], |r| {
            Ok(TaskInfo {
                id: r.get(0)?,
                text: r.get(1)?,
                status: r.get(2)?,
                created_at: r.get(3)?,
                done_at: r.get(4)?,
                focus_ms: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.next().transpose().ok().flatten())
}

/// 新建任务（todo）
pub fn create_task(text: &str) -> Result<i64, String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO tasks (text, status, created_at) VALUES (?1, 'todo', ?2)",
        params![text, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

/// 改任务文本
pub fn update_task_text(id: i64, text: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute("UPDATE tasks SET text = ?1 WHERE id = ?2", params![text, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除任务（doing 也可删）
pub fn delete_task(id: i64) -> Result<(), String> {
    let c = conn()?;
    c.execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设为当前任务：先清掉其他 doing（全局唯一），再置 doing
pub fn set_current_task(id: i64) -> Result<(), String> {
    let c = conn()?;
    c.execute("UPDATE tasks SET status = 'todo' WHERE status = 'doing' AND id != ?1", params![id])
        .map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE tasks SET status = 'doing', done_at = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 完成任务：doing → done 也允许（完成即取消当前）
pub fn complete_task(id: i64) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE tasks SET status = 'done', done_at = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重新打开：done → todo
pub fn reopen_task(id: i64) -> Result<(), String> {
    let c = conn()?;
    c.execute("UPDATE tasks SET status = 'todo', done_at = NULL WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 专注时长累计到当前 doing 任务（M3 task-focus 直写版）
pub fn add_focus_ms_to_current(counted_ms: i64) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE tasks SET focus_ms = focus_ms + ?1 WHERE status = 'doing'",
        params![counted_ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- 设置 (M5)

pub fn setting_get(key: &str) -> Option<String> {
    let c = conn().ok()?;
    c.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

pub fn setting_set(key: &str, value: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置完整快照（缺省值兜底；reminders 由引擎当前配置序列化合并）
pub fn settings_snapshot(reminders_cfg: serde_json::Value) -> serde_json::Value {
    let get_bool = |k: &str, def: bool| setting_get(k).map(|v| v == "1").unwrap_or(def);
    let idle_ms = setting_get("idleTimeoutMs")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(60_000);
    serde_json::json!({
        "trackingPaused": get_bool("trackingPaused", false),
        "idleTimeoutMs": idle_ms,
        "remindersPaused": get_bool("remindersPaused", false),
        "autostart": get_bool("autostart", false),
        "reminders": reminders_cfg,
    })
}

// ---------------------------------------------------------------- 数据管理 (M5)

pub fn data_stats() -> Result<serde_json::Value, String> {
    let c = conn()?;
    let sessions: i64 = c
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let days: i64 = c
        .query_row("SELECT COUNT(DISTINCT date_key) FROM daily_app_stats", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let tasks: i64 = c
        .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "sessions": sessions,
        "days": days,
        "tasks": tasks,
        "dbFile": db_file().to_string_lossy(),
    }))
}

/// 导出全部数据为 JSON（写到 db 同级 exports/ 目录）
pub fn data_export() -> Result<serde_json::Value, String> {
    let c = conn()?;

    let mut stmt = c
        .prepare("SELECT app_key, app_name, title, started_at, ended_at, duration_ms, counted_ms, on_primary, counted FROM sessions ORDER BY started_at")
        .map_err(|e| e.to_string())?;
    let sessions: Vec<serde_json::Value> = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "appKey": r.get::<_, String>(0)?, "appName": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?, "startedAt": r.get::<_, i64>(3)?,
                "endedAt": r.get::<_, i64>(4)?, "durationMs": r.get::<_, i64>(5)?,
                "countedMs": r.get::<_, i64>(6)?,
                "onPrimary": r.get::<_, i64>(7)? != 0, "counted": r.get::<_, i64>(8)? != 0,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = c
        .prepare("SELECT date_key, app_key, app_name, total_ms FROM daily_app_stats ORDER BY date_key")
        .map_err(|e| e.to_string())?;
    let daily_app: Vec<serde_json::Value> = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "dateKey": r.get::<_, String>(0)?, "appKey": r.get::<_, String>(1)?,
                "appName": r.get::<_, String>(2)?, "totalMs": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let task_rows = list_tasks(true).unwrap_or_default();

    let payload = serde_json::json!({
        "exportedAt": now_ms(),
        "app": "TimePaws",
        "sessions": sessions,
        "dailyAppStats": daily_app,
        "tasks": task_rows,
    });

    let dir = db_file()
        .parent()
        .map(|p| p.join("exports"))
        .unwrap_or_else(|| PathBuf::from("exports"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("timepaws-export-{}.json", now_ms()));
    std::fs::write(&file, serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "file": file.to_string_lossy(),
        "sessions": sessions.len(),
        "dailyAppRows": daily_app.len(),
        "tasks": task_rows.len(),
    }))
}

/// 清空追踪数据（任务默认保留）
pub fn data_purge(include_tasks: bool) -> Result<serde_json::Value, String> {
    let mut c = conn()?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let sessions = tx.execute("DELETE FROM sessions", []).map_err(|e| e.to_string())?;
    let daily_app = tx.execute("DELETE FROM daily_app_stats", []).map_err(|e| e.to_string())?;
    let daily_title = tx.execute("DELETE FROM daily_title_stats", []).map_err(|e| e.to_string())?;
    let events = tx.execute("DELETE FROM events_switch", []).map_err(|e| e.to_string())?;
    let tasks = if include_tasks {
        tx.execute("DELETE FROM tasks", []).map_err(|e| e.to_string())?
    } else {
        0
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "sessions": sessions,
        "dailyAppRows": daily_app,
        "dailyTitleRows": daily_title,
        "events": events,
        "tasks": tasks,
    }))
}

// ---------------------------------------------------------------- 热力图 (M6)

/// 时间桶聚合（GitHub 风格热力图数据源）。
/// mode: halfhour(近7天48桶/天) | hour(近14天24桶/天) | halfday(近14天2桶/天) | day(近180天) | week(近26周)
/// 返回 { bucket: 桶标识, totalMs } 列表，仅含 counted 口径。
pub fn stats_heatmap(mode: &str) -> Result<Vec<serde_json::Value>, String> {
    let c = conn()?;
    // 桶表达式：本地时区，ended_at 为毫秒
    let (bucket_expr, since_ms) = match mode {
        // 近 7 天 × 48 个半小时桶：bucket = dateKey|slot(0-47)
        "halfhour" => (
            "date_key || '|' || CAST((CAST(strftime('%H', ended_at/1000.0, 'unixepoch', 'localtime') AS INTEGER) * 60
               + CAST(strftime('%M', ended_at/1000.0, 'unixepoch', 'localtime') AS INTEGER)) / 30 AS TEXT)",
            now_ms() - 7 * 86_400_000,
        ),
        // 近 14 天 × 24 小时桶
        "hour" => (
            "date_key || '|' || strftime('%H', ended_at/1000.0, 'unixepoch', 'localtime')",
            now_ms() - 14 * 86_400_000,
        ),
        // 近 14 天 × 上下午 2 桶
        "halfday" => (
            "date_key || '|' || (CASE WHEN CAST(strftime('%H', ended_at/1000.0, 'unixepoch', 'localtime') AS INTEGER) < 12 THEN 'am' ELSE 'pm' END)",
            now_ms() - 14 * 86_400_000,
        ),
        // 近 180 天 × 日
        "day" => ("date_key", now_ms() - 180 * 86_400_000),
        // 近 26 周 × 周（桶 = 本周周一的本地日期，前后端口径无歧义）
        "week" => (
            "date(ended_at/1000.0, 'unixepoch', 'localtime', 'weekday 1', '-7 days')",
            now_ms() - 26 * 7 * 86_400_000,
        ),
        _ => return Err(format!("unknown heatmap mode: {mode}")),
    };

    // date_key 由 sessions 行推导（与 daily 表口径一致：本地时区 YYYY-MM-DD）
    let sql = format!(
        "SELECT {bucket} AS bucket, SUM(counted_ms) FROM (
            SELECT counted_ms, ended_at,
                   date(ended_at/1000.0, 'unixepoch', 'localtime') AS date_key
            FROM sessions
            WHERE counted = 1 AND ended_at >= ?1
        ) GROUP BY bucket ORDER BY bucket"
    , bucket = bucket_expr);

    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![since_ms], |r| {
            Ok(serde_json::json!({
                "bucket": r.get::<_, String>(0)?,
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
