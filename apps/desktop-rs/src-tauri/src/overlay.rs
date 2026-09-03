/**
 * 提醒浮层窗口（M4）—— 与 Electron 版 overlay.ts 对齐
 *
 * 规格：
 * - 主屏右下角 320×148 无边框小窗，alwaysOnTop，不抢键盘焦点
 * - 渲染 #/overlay 路由（Overlay.tsx，前端零改动）
 * - 25s 无操作自动隐藏（在 reminders.rs fire() 内处理）
 *
 * ⚠ 关键实现约束（本机踩坑实证）：
 * - tao/tauri 的 dispatcher（win.show/hide/set_position）从非主线程调用会被
 *   静默丢弃 —— 唯一可靠的窗口操作路径是直接 Win32 API（tracker 同款）：
 *   ShowWindow + SetWindowPos，线程安全、不经事件循环。
 * - SW_SHOWNA / SW_SHOWNOACTIVATE = 不抢焦点（对应 Electron showInactive）。
 * - 浮层窗口由 tauri.conf.json 静态声明、visible:true 启动（WebView2 标准初始化
 *   路径，页面正常加载），启动后立即用 Win32 隐藏。
 */
use tauri::Manager;

const OVERLAY_W: f64 = 320.0;
const OVERLAY_H: f64 = 148.0;
const MARGIN_R: f64 = 20.0;
const MARGIN_B: f64 = 60.0; // 底部留任务栏

/// 浮层窗口的 HWND + 主屏几何（init 时捕获一次）
static OVERLAY_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static MON_X: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static MON_Y: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static MON_W: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static MON_H: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static MON_SCALE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(100); // percent

/// setup 阶段调用：捕获 HWND 与主屏几何（纯读取，无 dispatcher 派发）
pub fn init_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("overlay")
        .ok_or_else(|| "overlay window missing from config".to_string())?;

    let hwnd = win
        .hwnd()
        .map_err(|e| format!("hwnd unavailable: {e}"))?
        .0 as isize;
    OVERLAY_HWND.store(hwnd, std::sync::atomic::Ordering::SeqCst);

    if let Ok(Some(m)) = app.primary_monitor() {
        MON_X.store(m.position().x, std::sync::atomic::Ordering::SeqCst);
        MON_Y.store(m.position().y, std::sync::atomic::Ordering::SeqCst);
        MON_W.store(m.size().width as i32, std::sync::atomic::Ordering::SeqCst);
        MON_H.store(m.size().height as i32, std::sync::atomic::Ordering::SeqCst);
        MON_SCALE.store(
            (m.scale_factor() * 100.0) as u32,
            std::sync::atomic::Ordering::SeqCst,
        );
    }
    Ok(())
}

/// 计算浮层逻辑坐标（主屏右下角）
fn overlay_logical_pos() -> (i32, i32) {
    let mx = MON_X.load(std::sync::atomic::Ordering::SeqCst);
    let my = MON_Y.load(std::sync::atomic::Ordering::SeqCst);
    let mw = MON_W.load(std::sync::atomic::Ordering::SeqCst);
    let mh = MON_H.load(std::sync::atomic::Ordering::SeqCst);
    let scale = MON_SCALE.load(std::sync::atomic::Ordering::SeqCst) as f64 / 100.0;
    if mw == 0 || mh == 0 {
        return (100, 100);
    }
    let x = ((mx + mw) as f64 / scale) - OVERLAY_W - MARGIN_R;
    let y = ((my + mh) as f64 / scale) - OVERLAY_H - MARGIN_B;
    (x.round() as i32, y.round() as i32)
}

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE, SWP_SHOWWINDOW,
    SW_HIDE, SW_SHOWNA,
};

/// 显示浮层（右下角定位 + 不抢焦点）—— 纯 Win32，任意线程可调
pub fn show_on_main(app: &tauri::AppHandle) {
    let hwnd = OVERLAY_HWND.load(std::sync::atomic::Ordering::SeqCst);
    if hwnd == 0 {
        return;
    }
    let (lx, ly) = overlay_logical_pos();
    let scale = MON_SCALE.load(std::sync::atomic::Ordering::SeqCst) as f64 / 100.0;
    let px = (lx as f64 * scale).round() as i32;
    let py = (ly as f64 * scale).round() as i32;
    unsafe {
        let h = HWND(hwnd as *mut _);
        let _ = SetWindowPos(
            h,
            Some(HWND_TOPMOST),
            px,
            py,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        let _ = ShowWindow(h, SW_SHOWNA);
    }
    let _ = app; // 保留签名一致性（供 tauri 命令路径调用）
}

/// 隐藏浮层 —— 纯 Win32，任意线程可调
pub fn hide_on_main(app: &tauri::AppHandle) {
    let hwnd = OVERLAY_HWND.load(std::sync::atomic::Ordering::SeqCst);
    if hwnd == 0 {
        return;
    }
    unsafe {
        let _ = ShowWindow(HWND(hwnd as *mut _), SW_HIDE);
    }
    let _ = app;
}
