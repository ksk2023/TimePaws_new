//! M1：原生 Win32 前台窗口追踪（替代 Electron 版的 koffi FFI）
//!
//! 与 Electron 版 `tracker.ts` 统计口径保持一致，便于两版数据对比：
//! - `EVENT_SYSTEM_FOREGROUND` 事件（快速响应）+ 1Hz 轮询兜底
//! - 空闲检测走 `GetLastInputInfo`
//! - 主屏判定走 `MonitorFromWindow`
//! - `counted_ms = 会话时长 - 空闲累计`，`counted = on_primary && !iconic && counted_ms > 0`
//!
//! 实现要点（Electron 版踩过的坑在这里不复存在）：
//! - 不再需要 FFI 回调原型声明，windows crate 直接给出类型安全的 `extern "system"` 签名
//! - `SetWinEventHook` 的 `WINEVENT_OUTOFCONTEXT` 模式要求**调用线程有消息泵**，
//!   因此 hook 注册与本循环同处一个工作线程，用 `PeekMessageW` 非阻塞泵消息

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    PeekMessageW, TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, PM_REMOVE,
    WINEVENT_OUTOFCONTEXT,
};

// ---------------------------------------------------------------- 数据结构

/// 一次采样的前台窗口快照
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub hwnd: i64,
    pub app_key: String,
    pub app_name: String,
    pub title: String,
    pub on_primary: bool,
    pub iconic: bool,
    pub idle_ms: u64,
    pub at: i64,
}

/// 一次完整会话（窗口切走或应用退出时结算）
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub app_key: String,
    pub app_name: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub duration_ms: i64,
    pub counted_ms: i64,
    pub on_primary: bool,
}

struct CurrentSession {
    snap: Snapshot,
    started_at: i64,
    idle_accrued_ms: i64,
    last_sample_at: i64,
}

// ---------------------------------------------------------------- 全局状态

static STOP: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
/// 当前生效的空闲阈值（设置页可改，改动即重启引擎）
static IDLE_TIMEOUT: AtomicU64 = AtomicU64::new(60_000);
/// WinEvent 回调只做「有变化」标记，避免在 OS 回调里做重活
static DIRTY: AtomicBool = AtomicBool::new(false);
static CURRENT: OnceLock<Arc<Mutex<Option<Snapshot>>>> = OnceLock::new();

fn current_slot() -> &'static Arc<Mutex<Option<Snapshot>>> {
    CURRENT.get_or_init(|| Arc::new(Mutex::new(None)))
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

pub fn current_idle_timeout() -> u64 {
    IDLE_TIMEOUT.load(Ordering::SeqCst)
}

/// 设置页改空闲阈值：运行中则停→等退出→以新阈值重启
pub fn set_idle_timeout(app: AppHandle, ms: u64) {
    IDLE_TIMEOUT.store(ms, Ordering::SeqCst);
    if !is_running() {
        return;
    }
    stop();
    for _ in 0..100 {
        if !is_running() {
            break;
        }
        thread::sleep(Duration::from_millis(30));
    }
    start(app, ms);
}

pub fn current_snapshot() -> Option<Snapshot> {
    current_slot().lock().ok().and_then(|g| g.clone())
}

// ---------------------------------------------------------------- 事件名

pub const EVT_SNAPSHOT: &str = "tracker://snapshot";
pub const EVT_SESSION: &str = "tracker://session-ended";

// ---------------------------------------------------------------- 工具函数

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 系统空闲时长（毫秒）：基于最后一次用户输入事件
fn idle_ms() -> u64 {
    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut lii).as_bool() {
            GetTickCount().saturating_sub(lii.dwTime) as u64
        } else {
            0
        }
    }
}

/// 窗口是否位于主显示器
fn is_on_primary(hwnd: HWND) -> bool {
    unsafe {
        let primary = MonitorFromWindow(HWND(std::ptr::null_mut()), MONITOR_DEFAULTTOPRIMARY);
        let mine = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        primary.0 == mine.0
    }
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 从窗口取进程可执行文件信息 → (app_key 小写, app_name 原始大小写)
fn app_info_from_hwnd(hwnd: HWND) -> (String, String) {
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return ("unknown".to_string(), "unknown".to_string());
        }

        let handle: HANDLE = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return (format!("pid-{}", pid), format!("pid-{}", pid)),
        };

        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);

        if ok.is_err() || size == 0 {
            return (format!("pid-{}", pid), format!("pid-{}", pid));
        }

        let full = wide_to_string(&buf[..size as usize]);
        // C:\...\chrome.exe → app_name=chrome, app_key=chrome（小写）
        let file = full
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&full)
            .to_string();
        let stem = file
            .trim_end_matches(".exe")
            .trim_end_matches(".EXE")
            .to_string();
        (stem.to_lowercase(), stem)
    }
}

/// 采样当前前台窗口
fn sample() -> Option<Snapshot> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        let mut title_buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title_buf);
        let title = if len > 0 {
            wide_to_string(&title_buf[..len as usize])
        } else {
            String::new()
        };

        // 标题为空的窗口（部分 UWP/后台窗口）不追踪，避免脏数据
        if title.trim().is_empty() {
            return None;
        }

        let (app_key, app_name) = app_info_from_hwnd(hwnd);
        let idle = idle_ms();

        Some(Snapshot {
            hwnd: hwnd.0 as i64,
            app_key,
            app_name,
            title,
            on_primary: is_on_primary(hwnd),
            iconic: IsIconic(hwnd).as_bool(),
            idle_ms: idle,
            at: now_ms(),
        })
    }
}

// ---------------------------------------------------------------- WinEvent 回调

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        DIRTY.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- 主循环

struct Engine {
    app: AppHandle,
    idle_timeout_ms: u64,
    cur: Option<CurrentSession>,
}

impl Engine {
    fn end_session(&mut self, at: i64) {
        if let Some(c) = self.cur.take() {
            let duration_ms = (at - c.started_at).max(0);
            let counted_ms = (duration_ms - c.idle_accrued_ms).max(0);
            let session = Session {
                app_key: c.snap.app_key.clone(),
                app_name: c.snap.app_name.clone(),
                title: c.snap.title.clone(),
                started_at: c.started_at,
                ended_at: at,
                duration_ms,
                counted_ms,
                on_primary: c.snap.on_primary,
            };
            let counted = session.on_primary && !c.snap.iconic && counted_ms > 0;
            println!(
                "[tracker] {} | {} | {}ms (counted {}ms, counted={})",
                session.app_name, session.title, duration_ms, counted_ms, counted
            );
            let _ = self.app.emit(EVT_SESSION, session);
        }
    }

    fn tick(&mut self, now: i64) {
        let snap = match sample() {
            Some(s) => s,
            None => return,
        };

        // 空闲累计：本次采样区间若整体处于空闲阈值以上，全计入空闲
        let idle_over = snap.idle_ms >= self.idle_timeout_ms;

        let switched = match &self.cur {
            None => true,
            Some(c) => c.snap.hwnd != snap.hwnd,
        };

        if switched {
            self.end_session(now);
            self.cur = Some(CurrentSession {
                started_at: now,
                idle_accrued_ms: 0,
                last_sample_at: now,
                snap: snap.clone(),
            });
        } else if let Some(c) = self.cur.as_mut() {
            let delta = (now - c.last_sample_at).max(0);
            if idle_over {
                c.idle_accrued_ms += delta;
            }
            c.last_sample_at = now;
            c.snap = snap.clone();
        }

        if let Ok(mut slot) = current_slot().lock() {
            *slot = Some(snap.clone());
        }
        let _ = self.app.emit(EVT_SNAPSHOT, snap);
    }
}

// ---------------------------------------------------------------- 对外接口

pub fn start(app: AppHandle, idle_timeout_ms: u64) {
    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // 已在运行
    }
    STOP.store(false, Ordering::SeqCst);
    IDLE_TIMEOUT.store(idle_timeout_ms, Ordering::SeqCst);

    thread::spawn(move || {
        let mut engine = Engine {
            app,
            idle_timeout_ms,
            cur: None,
        };

        unsafe {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None, // HMODULE: WINEVENT_OUTOFCONTEXT 模式不需要 DLL 句柄
                Some(win_event_proc),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );

            if hook.is_invalid() {
                eprintln!("[tracker] SetWinEventHook 注册失败，退化为纯轮询模式");
            }

            let mut last_sample = 0i64;
            while !STOP.load(Ordering::SeqCst) {
                // 泵消息：让 WinEvent 回调得以触发（非阻塞）
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                let now = now_ms();
                let dirty = DIRTY.swap(false, Ordering::SeqCst);
                if dirty || now - last_sample >= 1000 {
                    engine.tick(now);
                    last_sample = now;
                }

                thread::sleep(Duration::from_millis(100));
            }

            engine.end_session(now_ms());
            if !hook.is_invalid() {
                let _ = UnhookWinEvent(hook);
            }
        }

        RUNNING.store(false, Ordering::SeqCst);
        println!("[tracker] 已停止");
    });
}

pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
}
