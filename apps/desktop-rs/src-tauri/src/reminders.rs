/**
 * 提醒规则引擎（M4）—— 四条规则 + 去重 + 贪睡静默
 *
 * 与 Electron 版 reminders.ts 对齐（并修正其 drift 窗口剪枝 bug）：
 * 1. heartbeat     同一 doing 任务连续主屏计入 ≥ heartbeatFocusMs → 休息提醒
 * 2. drift         有 doing 任务，但过去 driftWindowMs 主屏计入 < driftMinCountedMs → 轻推
 * 3. switch_storm  stormWindowMs 内前台切换 ≥ stormSwitchThreshold → 平复提醒
 * 4. idle_back     空闲 ≥ idleBackMinMs 后恢复活动 → 欢迎回来
 *
 * 通用约束：
 * - 每种规则 perRuleCooldownMs 内最多触发一次
 * - 「稍后提醒」→ snoozeMs 内静默（针对单条规则或全部）
 * - 触发即发 EVT_REMINDER 事件 → overlay 窗口消费
 * - Tauri 版无 Electron 的独立 overlay 窗口句柄检查，用 OVERLAY_VISIBLE 原子标志代替
 */
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub const EVT_REMINDER: &str = "reminders://fired";

/* ── 配置（M5 设置页可改）────────────────────────────────── */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderConfig {
    pub heartbeat_focus_ms: i64,      // 默认 50min
    pub drift_window_ms: i64,         // 默认 5min
    pub drift_min_counted_ms: i64,    // 默认 30s
    pub storm_window_ms: i64,         // 默认 5min
    pub storm_switch_threshold: i64,  // 默认 15
    pub idle_back_min_ms: i64,        // 默认 10min
    pub per_rule_cooldown_ms: i64,    // 默认 10min
    pub snooze_ms: i64,               // 默认 20min
}

impl Default for ReminderConfig {
    fn default() -> Self {
        Self {
            heartbeat_focus_ms: 50 * 60_000,
            drift_window_ms: 5 * 60_000,
            drift_min_counted_ms: 30_000,
            storm_window_ms: 5 * 60_000,
            storm_switch_threshold: 15,
            idle_back_min_ms: 10 * 60_000,
            per_rule_cooldown_ms: 10 * 60_000,
            snooze_ms: 20 * 60_000,
        }
    }
}

type RuleKey = &'static str;

const RULE_TITLE: fn(RuleKey) -> &'static str = |k| match k {
    "heartbeat" => "连续专注了一段时间",
    "drift" => "好像走神了？",
    "switch_storm" => "切换有点频繁",
    _ => "欢迎回来",
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPayload {
    pub kind: String,
    pub title: String,
    pub body: String,
}

/* ── 全局状态 ────────────────────────────────────────────── */

static PAUSED: AtomicBool = AtomicBool::new(false);
static OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct State {
    last_fired_at: HashMap<String, i64>,
    snoozed_until: HashMap<String, i64>,
    // heartbeat：当前 doing 任务连续计入时长（切任务/不计入会话即清零）
    continuous_focus_ms: i64,
    continuous_task_id: Option<i64>,
    // switch_storm：环形切换时刻
    switch_times: Vec<i64>,
    // drift：窗口内计入片段 (at, ms)
    counted_segments: Vec<(i64, i64)>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static CFG: Mutex<Option<ReminderConfig>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut guard = STATE.lock().expect("reminders state poisoned");
    let s = guard.get_or_insert_with(State::default);
    f(s)
}

fn config() -> ReminderConfig {
    CFG.lock()
        .expect("reminders cfg poisoned")
        .clone()
        .unwrap_or_default()
}

pub fn current_config() -> ReminderConfig {
    config()
}

pub fn update_config(patch: serde_json::Value) -> ReminderConfig {
    let mut cfg = config();
    if let Some(v) = patch.get("heartbeatFocusMs").and_then(|x| x.as_i64()) {
        cfg.heartbeat_focus_ms = v;
    }
    if let Some(v) = patch.get("driftWindowMs").and_then(|x| x.as_i64()) {
        cfg.drift_window_ms = v;
    }
    if let Some(v) = patch.get("driftMinCountedMs").and_then(|x| x.as_i64()) {
        cfg.drift_min_counted_ms = v;
    }
    if let Some(v) = patch.get("stormWindowMs").and_then(|x| x.as_i64()) {
        cfg.storm_window_ms = v;
    }
    if let Some(v) = patch.get("stormSwitchThreshold").and_then(|x| x.as_i64()) {
        cfg.storm_switch_threshold = v;
    }
    if let Some(v) = patch.get("idleBackMinMs").and_then(|x| x.as_i64()) {
        cfg.idle_back_min_ms = v;
    }
    if let Some(v) = patch.get("perRuleCooldownMs").and_then(|x| x.as_i64()) {
        cfg.per_rule_cooldown_ms = v;
    }
    if let Some(v) = patch.get("snoozeMs").and_then(|x| x.as_i64()) {
        cfg.snooze_ms = v;
    }
    *CFG.lock().expect("reminders cfg poisoned") = Some(cfg.clone());
    cfg
}

pub fn set_paused(p: bool, app: &AppHandle) {
    PAUSED.store(p, Ordering::SeqCst);
    if p {
        hide_overlay(app);
    }
}

pub fn snooze_all(ms: i64) {
    let now = now_ms();
    with_state(|s| {
        for k in ["heartbeat", "drift", "switch_storm", "idle_back"] {
            s.snoozed_until.insert(k.to_string(), now + ms);
        }
    });
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 设置页「预览提醒」：绕过 canFire 直接触发一条样例
pub fn fire_test(app: &AppHandle, title: &str, body: &str) {
    let payload = OverlayPayload {
        kind: "test".to_string(),
        title: title.to_string(),
        body: body.to_string(),
    };
    show_and_emit(app, &payload);
}

/* ── 浮层窗口句柄（lib.rs 注入）──────────────────────────── */

static OVERLAY_WINDOW: Mutex<Option<tauri::WebviewWindow>> = Mutex::new(None);

pub fn set_overlay_window(win: tauri::WebviewWindow) {
    *OVERLAY_WINDOW.lock().expect("overlay win poisoned") = Some(win);
}

pub fn is_overlay_visible() -> bool {
    OVERLAY_VISIBLE.load(Ordering::SeqCst)
}

pub fn show_overlay() {
    OVERLAY_VISIBLE.store(true, Ordering::SeqCst);
}

pub fn hide_overlay(app: &AppHandle) {
    OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
    crate::overlay::hide_on_main(app);
}

/* ── 触发判定 ────────────────────────────────────────────── */

fn can_fire(rule: RuleKey, now: i64, cfg: &ReminderConfig) -> bool {
    if PAUSED.load(Ordering::SeqCst) {
        return false;
    }
    if is_overlay_visible() {
        return false;
    }
    if now < with_state(|s| s.snoozed_until.get(rule).copied().unwrap_or(0)) {
        return false;
    }
    if now - with_state(|s| s.last_fired_at.get(rule).copied().unwrap_or(0)) < cfg.per_rule_cooldown_ms {
        return false;
    }
    true
}

fn fire(app: &AppHandle, rule: RuleKey, body: String) {
    let now = now_ms();
    with_state(|s| s.last_fired_at.insert(rule.to_string(), now));
    let payload = OverlayPayload {
        kind: rule.to_string(),
        title: RULE_TITLE(rule).to_string(),
        body,
    };
    show_and_emit(app, &payload);
    let _ = app.emit(EVT_REMINDER, &payload);
}

/// 显示浮层 + 25s 自动隐藏（fire / fire_test 共用）
/// 启动初期浮层窗口可能尚未创建完成（异步 build），此处最多等待 5s。
/// 窗口显示/隐藏必须在主线程执行（overlay::show_on_main / hide_on_main）。
fn show_and_emit(app: &AppHandle, payload: &OverlayPayload) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        {
            let guard = OVERLAY_WINDOW.lock().expect("overlay win poisoned");
            if guard.is_some() {
                break;
            }
        }
        if std::time::Instant::now() >= deadline {
            // 浮层始终未就绪：至少把提醒事件发给前端，不留悬挂的可见标志
            let _ = app.emit(EVT_REMINDER, payload);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    OVERLAY_VISIBLE.store(true, Ordering::SeqCst);
    crate::overlay::show_on_main(app);
    let _ = app.emit(EVT_REMINDER, payload);
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25_000));
        if OVERLAY_VISIBLE.load(Ordering::SeqCst) {
            OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
            crate::overlay::hide_on_main(&app2);
        }
    });
}

/* ── 会话事件入口（lib.rs 桥接 tracker::EVT_SESSION）────── */

pub fn on_session_ended(
    app: &AppHandle,
    app_key: &str,
    on_primary: bool,
    counted: bool,
    counted_ms: i64,
) {
    let cfg = config();
    let now = now_ms();
    let _ = app_key;

    with_state(|s| {
        // switch_storm：所有前台会话都算一次切换（含副屏不计入）
        s.switch_times.push(now);
        while !s.switch_times.is_empty() && now - s.switch_times[0] > cfg.storm_window_ms {
            s.switch_times.remove(0);
        }

        if counted {
            // drift 窗口（Electron 版剪枝条件写反，此处修正：保留窗口内片段）
            s.counted_segments.push((now, counted_ms));
            while !s.counted_segments.is_empty() && s.counted_segments[0].0 < now - cfg.drift_window_ms {
                s.counted_segments.remove(0);
            }

            // heartbeat：同一 doing 任务连续主屏计入
            let task = crate::db::current_task().ok().flatten();
            if let Some(t) = task {
                if on_primary {
                    if s.continuous_task_id == Some(t.id) {
                        s.continuous_focus_ms += counted_ms;
                    } else {
                        s.continuous_task_id = Some(t.id);
                        s.continuous_focus_ms = counted_ms;
                    }
                    return; // 注意：闭包内 return 结束本次 with_state
                }
            }
            // 没有 doing 任务 / 非主屏 → 打断连续专注
            s.continuous_focus_ms = 0;
            s.continuous_task_id = None;
        } else {
            // 不计入的会话（副屏/空闲）打断连续专注
            s.continuous_focus_ms = 0;
            s.continuous_task_id = None;
        }
    });

    evaluate(app, now);
}

/// 空闲恢复入口（lib.rs 桥接 tracker::EVT_SNAPSHOT：idle → active）
pub fn on_activity_resumed(app: &AppHandle, idle_ms_before: i64) {
    let cfg = config();
    let now = now_ms();
    if idle_ms_before >= cfg.idle_back_min_ms && can_fire("idle_back", now, &cfg) {
        fire(
            app,
            "idle_back",
            format!("离开了 {} 分钟。要继续刚才的任务吗？", idle_ms_before / 60_000),
        );
    }
}

/// 主循环 tick：评估 drift（有 doing 任务但窗口内计入过少）
pub fn on_minute_tick(app: &AppHandle) {
    evaluate(app, now_ms());
}

fn evaluate(app: &AppHandle, now: i64) {
    let cfg = config();

    // 1. heartbeat
    let (hb_focus, hb_task_id) = with_state(|s| (s.continuous_focus_ms, s.continuous_task_id));
    if hb_focus >= cfg.heartbeat_focus_ms && can_fire("heartbeat", now, &cfg) {
        let task_text = crate::db::list_tasks(true)
            .ok()
            .and_then(|v| {
                let tid = hb_task_id.unwrap_or(-1);
                v.into_iter().find(move |t| t.id == tid)
            })
            .map(|t| t.text)
            .unwrap_or_else(|| "当前任务".to_string());
        fire(
            app,
            "heartbeat",
            format!(
                "「{}」已专注 {} 分钟，起来走走。",
                task_text,
                hb_focus / 60_000
            ),
        );
        with_state(|s| {
            s.continuous_focus_ms = 0;
            s.continuous_task_id = None;
        });
        return;
    }

    // 2. switch_storm
    let storm_n = with_state(|s| s.switch_times.len() as i64);
    if storm_n >= cfg.storm_switch_threshold && can_fire("switch_storm", now, &cfg) {
        fire(
            app,
            "switch_storm",
            format!(
                "{} 分钟内切换了 {} 次窗口。先停一下，回到一件事上。",
                cfg.storm_window_ms / 60_000,
                storm_n
            ),
        );
        with_state(|s| s.switch_times.clear());
        return;
    }

    // 3. drift：有 doing 任务但窗口内计入过少
    if crate::db::current_task().ok().flatten().is_some() {
        let counted_sum = with_state(|s| {
            s.counted_segments
                .iter()
                .filter(|(at, _)| *at >= now - cfg.drift_window_ms)
                .map(|(_, ms)| *ms)
                .sum::<i64>()
        });
        if counted_sum < cfg.drift_min_counted_ms && can_fire("drift", now, &cfg) {
            let task_text = crate::db::current_task()
                .ok()
                .flatten()
                .map(|t| t.text)
                .unwrap_or_else(|| "当前任务".to_string());
            fire(
                app,
                "drift",
                format!(
                    "「{}」还在等你。刚过去 {} 分钟里，主屏只计了 {} 秒。",
                    task_text,
                    cfg.drift_window_ms / 60_000,
                    counted_sum / 1000
                ),
            );
        }
    }
}
