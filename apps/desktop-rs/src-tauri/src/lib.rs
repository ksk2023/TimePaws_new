//! Anchor 锚点 — Tauri 2 版 (M0: 窗口 + 托盘 + IPC ping)
//! 后续里程碑在此之上递增：M1 追踪(windows crate 替代 koffi)、M2 rusqlite、M3+ 同 Electron 版逻辑。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// M0 IPC：连通性探测（对应 Electron 版 anchor/ping）
#[tauri::command]
fn ping(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "app": "anchor-tauri",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping, toggle_main_window])
        .setup(|app| {
            // ---- 托盘（对应 Electron 版 tray.ts）----
            let show_i = MenuItem::with_id(app, "show", "显示 / 隐藏主窗口", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出 Anchor", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            let _tray = TrayIconBuilder::with_id("anchor-tray")
                .icon(icon)
                .tooltip("Anchor 锚点")
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
