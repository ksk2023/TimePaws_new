//! TimePaws — Tauri 2 版 (M0: 窗口 + 托盘 + IPC ping)
//! 里程碑：M1 追踪(windows crate)、M2 rusqlite、M3 任务箱、M4 提醒引擎、M5 设置/导出。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager,
};

use std::sync::Mutex;

pub mod autostart;
pub mod db;
pub mod overlay;
pub mod reminders;
pub mod tasks;
pub mod tracker;

/// M4：上一条快照的空闲毫秒（idle_back 检测用）
static IDLE_PREV: Mutex<u64> = Mutex::new(0);

/// M0 IPC：连通性探测（对应 Electron 版 timepaws/ping）
#[tauri::command]
fn ping(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "app": "timepaws",
        "version": app.package_info().version.to_string(),
        "at": chrono::Utc::now().timestamp_millis(),
    })
}

/// M0 IPC：窗口显隐切换（托盘行为）
#[tauri::command]
fn toggle_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// M1 IPC：当前前台快照
#[tauri::command]
fn tracker_current() -> Option<tracker::Snapshot> {
    tracker::current_snapshot()
}

// ---- M4 IPC：提醒 ----

#[tauri::command]
fn reminders_config() -> serde_json::Value {
    let c = reminders::current_config();
    serde_json::to_value(&c).unwrap_or(serde_json::json!({}))
}

#[tauri::command]
fn reminders_update_config(patch: serde_json::Value) -> serde_json::Value {
    let c = reminders::update_config(patch);
    serde_json::to_value(&c).unwrap_or(serde_json::json!({}))
}

#[tauri::command]
fn reminders_set_paused(paused: bool, app: tauri::AppHandle) {
    reminders::set_paused(paused, &app);
}

#[tauri::command]
fn reminders_snooze_all(ms: Option<i64>) {
    reminders::snooze_all(ms.unwrap_or(20 * 60_000));
}

#[tauri::command]
fn reminders_test(app: tauri::AppHandle) {
    // 设置页「预览一条提醒」：直接触发一条 heartbeat 样例
    reminders::fire_test(
        &app,
        "预览提醒",
        "这是一条提醒样例。到点时它会从屏幕右下角滑入，不会抢你的键盘焦点。",
    );
}

#[tauri::command]
fn overlay_snooze(app: tauri::AppHandle) {
    // 「稍后提醒」：全部规则静默 20 分钟 + 隐藏浮层
    reminders::snooze_all(20 * 60_000);
    reminders::hide_overlay(&app);
}

#[tauri::command]
fn overlay_dismiss(app: tauri::AppHandle) {
    reminders::hide_overlay(&app);
}

/// M1 IPC：追踪开关（对应 Electron 版设置页「暂停追踪」）
#[tauri::command]
fn tracker_set_paused(paused: bool, app: tauri::AppHandle) {
    if paused {
        tracker::stop();
    } else if !tracker::is_running() {
        tracker::start(app, tracker::current_idle_timeout());
    }
}

/// M2 IPC：今日统计
#[tauri::command]
fn stats_today() -> Result<serde_json::Value, String> {
    db::stats_today()
}

/// M2 IPC：近 N 天每日总量
#[tauri::command]
fn stats_daily_totals(days: i64) -> Result<Vec<serde_json::Value>, String> {
    db::stats_daily_totals(days)
}

/// M6 IPC：热力图时间桶聚合（halfhour/hour/halfday/day/week）
#[tauri::command]
fn stats_heatmap(mode: String) -> Result<Vec<serde_json::Value>, String> {
    db::stats_heatmap(&mode)
}

// ---- M5 IPC：设置 + 数据管理 ----

fn reminders_json() -> serde_json::Value {
    serde_json::to_value(reminders::current_config()).unwrap_or(serde_json::json!({}))
}

#[tauri::command]
fn settings_get() -> serde_json::Value {
    let mut v = db::settings_snapshot(reminders_json());
    // 自启状态以注册表实际值为准（可能被外部清理过）
    v["autostart"] = serde_json::json!(autostart::is_enabled());
    v
}

#[tauri::command]
fn settings_update(patch: serde_json::Value, app: tauri::AppHandle) -> serde_json::Value {
    if let Some(v) = patch.get("trackingPaused").and_then(|x| x.as_bool()) {
        let _ = db::setting_set("trackingPaused", if v { "1" } else { "0" });
        if v {
            tracker::stop();
        } else if !tracker::is_running() {
            tracker::start(app.clone(), tracker::current_idle_timeout());
        }
    }
    if let Some(v) = patch.get("idleTimeoutMs").and_then(|x| x.as_i64()) {
        let clamped = v.clamp(5_000, 600_000);
        let _ = db::setting_set("idleTimeoutMs", &clamped.to_string());
        tracker::set_idle_timeout(app.clone(), clamped as u64);
    }
    if let Some(v) = patch.get("remindersPaused").and_then(|x| x.as_bool()) {
        let _ = db::setting_set("remindersPaused", if v { "1" } else { "0" });
        reminders::set_paused(v, &app);
    }
    if let Some(v) = patch.get("autostart").and_then(|x| x.as_bool()) {
        let _ = db::setting_set("autostart", if v { "1" } else { "0" });
        if let Err(e) = autostart::set_enabled(v) {
            eprintln!("[autostart] 设置失败: {e}");
        }
    }
    if let Some(r) = patch.get("reminders") {
        let cfg = reminders::update_config(r.clone());
        if let Ok(s) = serde_json::to_string(&cfg) {
            let _ = db::setting_set("reminders", &s);
        }
    }
    settings_get()
}

#[tauri::command]
fn data_stats() -> Result<serde_json::Value, String> {
    db::data_stats()
}

#[tauri::command]
fn data_export() -> Result<serde_json::Value, String> {
    db::data_export()
}

#[tauri::command]
fn data_purge(include_tasks: bool, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let r = db::data_purge(include_tasks)?;
    tasks::notify_changed(&app);
    Ok(r)
}

// ---- M3 IPC：任务箱 ----

#[tauri::command]
fn tasks_list(include_done: Option<bool>) -> Result<Vec<db::TaskInfo>, String> {
    db::list_tasks(include_done.unwrap_or(false))
}

#[tauri::command]
fn tasks_current() -> Result<Option<db::TaskInfo>, String> {
    db::current_task()
}

#[tauri::command]
fn tasks_create(text: String, app: tauri::AppHandle) -> Result<db::TaskInfo, String> {
    let id = db::create_task(&text)?;
    tasks::notify_changed(&app);
    Ok(db::TaskInfo {
        id,
        text,
        status: "todo".into(),
        created_at: chrono::Utc::now().timestamp_millis(),
        done_at: None,
        focus_ms: 0,
    })
}

#[tauri::command]
fn tasks_update_text(id: i64, text: String, app: tauri::AppHandle) -> Result<(), String> {
    db::update_task_text(id, &text)?;
    tasks::notify_changed(&app);
    Ok(())
}

#[tauri::command]
fn tasks_delete(id: i64, app: tauri::AppHandle) -> Result<(), String> {
    db::delete_task(id)?;
    tasks::notify_changed(&app);
    Ok(())
}

#[tauri::command]
fn tasks_set_current(id: i64, app: tauri::AppHandle) -> Result<(), String> {
    db::set_current_task(id)?;
    tasks::notify_changed(&app);
    Ok(())
}

#[tauri::command]
fn tasks_complete(id: i64, app: tauri::AppHandle) -> Result<(), String> {
    db::complete_task(id)?;
    tasks::notify_changed(&app);
    Ok(())
}

#[tauri::command]
fn tasks_reopen(id: i64, app: tauri::AppHandle) -> Result<(), String> {
    db::reopen_task(id)?;
    tasks::notify_changed(&app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ping,
            toggle_main_window,
            tracker_current,
            tracker_set_paused,
            stats_today,
            stats_daily_totals,
            stats_heatmap,
            settings_get,
            settings_update,
            data_stats,
            data_export,
            data_purge,
            tasks_list,
            tasks_current,
            tasks_create,
            tasks_update_text,
            tasks_delete,
            tasks_set_current,
            tasks_complete,
            tasks_reopen,
            reminders_config,
            reminders_update_config,
            reminders_set_paused,
            reminders_snooze_all,
            reminders_test,
            overlay_snooze,
            overlay_dismiss
        ])
        .setup(|app| {
            // ---- M2：初始化数据库（先于追踪，会话才有落库目标）----
            if let Err(e) = db::init(app.handle()) {
                eprintln!("[db] 初始化失败: {e}");
            }

            // ---- M5：应用持久化设置（提醒配置 / 暂停状态 / 空闲阈值）----
            if let Some(s) = db::setting_get("reminders") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    reminders::update_config(v);
                }
            }
            let tracking_paused = db::setting_get("trackingPaused").as_deref() == Some("1");
            let reminders_paused = db::setting_get("remindersPaused").as_deref() == Some("1");
            let idle_timeout = db::setting_get("idleTimeoutMs")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60_000);
            if reminders_paused {
                reminders::set_paused(true, app.handle());
            }

            // ---- M2：会话结算 → 落库（桥接 tracker 事件）----
            {
                let handle = app.handle().clone();
                app.listen(tracker::EVT_SESSION, move |_evt| {
                    // 事件 payload 即 Session 的 JSON；直接解析落库
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(_evt.payload()) {
                        let counted = v["onPrimary"].as_bool().unwrap_or(false)
                            && !v["iconic"].as_bool().unwrap_or(false)
                            && v["countedMs"].as_i64().unwrap_or(0) > 0;
                        let _ = db::record_session(
                            v["appKey"].as_str().unwrap_or("unknown"),
                            v["appName"].as_str().unwrap_or("unknown"),
                            v["title"].as_str().unwrap_or(""),
                            v["startedAt"].as_i64().unwrap_or(0),
                            v["endedAt"].as_i64().unwrap_or(0),
                            v["durationMs"].as_i64().unwrap_or(0),
                            v["countedMs"].as_i64().unwrap_or(0),
                            v["onPrimary"].as_bool().unwrap_or(false),
                            counted,
                        );
                        // M3：counted 时长归账到当前 doing 任务
                        if counted {
                            tasks::credit_focus(v["countedMs"].as_i64().unwrap_or(0));
                        }
                        // M4：提醒规则评估（heartbeat / drift / switch_storm）
                        reminders::on_session_ended(
                            &handle,
                            v["appKey"].as_str().unwrap_or("unknown"),
                            v["onPrimary"].as_bool().unwrap_or(false),
                            counted,
                            v["countedMs"].as_i64().unwrap_or(0),
                        );
                    }
                });
            }

            // ---- M4：会话/快照 → 空闲恢复检测（idle_back）----
            {
                let handle = app.handle().clone();
                app.listen(tracker::EVT_SNAPSHOT, move |evt| {
                    // 快照 idle_ms 从 >60s 回落到 <60s 的瞬间 = 恢复活动
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(evt.payload()) {
                        let idle = v["idleMs"].as_u64().unwrap_or(0);
                        let mut prev = IDLE_PREV.lock().expect("idle_prev poisoned");
                        if *prev >= 60_000 && idle < 60_000 {
                            let before = *prev as i64;
                            *prev = idle;
                            drop(prev);
                            reminders::on_activity_resumed(&handle, before);
                        } else {
                            *prev = idle;
                        }
                    }
                });
            }

            // ---- M4：每分钟 tick（drift 需要「不切换也评估」）----
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    reminders::on_minute_tick(&handle);
                });
            }

            // ---- M4：浮层启动守护（visible:true 启动，窗口就绪后捕获 HWND 并隐藏）----
            overlay::spawn_startup_hide(app.handle().clone());

            // ---- 开发烟测：ANCHOR_TEST_FIRE=1 → 启动 8s 后触发一条预览提醒 ----
            if std::env::var("ANCHOR_TEST_FIRE").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    reminders::fire_test(
                        &handle,
                        "烟测提醒",
                        "M4 浮层链路验证：触发 → 显示 → 25s 自动隐藏。",
                    );
                });
            }

            // ---- M1：启动前台追踪（对应 Electron 版 startTracker；设置页可暂停）----
            if !tracking_paused {
                tracker::start(app.handle().clone(), idle_timeout);
            }

            // ---- 托盘（对应 Electron 版 tray.ts）----
            let show_i = MenuItem::with_id(app, "show", "显示 / 隐藏主窗口", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出 TimePaws", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            let _tray = TrayIconBuilder::with_id("timepaws-tray")
                .icon(icon)
                .tooltip("TimePaws")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击 = 显示/隐藏（对应 Electron 版行为）
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭 = 隐藏到托盘，不退出（对应 Electron 版常驻行为）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
