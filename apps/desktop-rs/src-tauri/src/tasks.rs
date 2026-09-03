//! M3：任务箱 + 专注时长累计（对应 Electron 版 task-focus.ts + db.ts 任务部分）
//!
//! 规则：
//! - `tasks` 表全局至多一个 `doing`（当前任务）
//! - tracker 会话 counted 时长 → 自动累计到当前任务 `focus_ms`
//! - 任务变更广播 `tasks://changed`，多窗口同步

use tauri::{AppHandle, Emitter};

use crate::db;

pub const EVT_TASKS_CHANGED: &str = "tasks://changed";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// tracker 会话结算 → 归账到当前 doing 任务（对应 Electron 版 task-focus 累计器）
/// 在 lib.rs 的 session 桥接里调用；60s 批量 flush 的逻辑简化为逐笔直写（SQLite 本地写足够快）
pub fn credit_focus(counted_ms: i64) {
    if counted_ms <= 0 {
        return;
    }
    let _ = db::add_focus_ms_to_current(counted_ms);
}

/// 通知所有窗口任务有变
pub fn notify_changed(app: &AppHandle) {
    let _ = app.emit(EVT_TASKS_CHANGED, ());
}
