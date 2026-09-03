/**
 * 提醒规则引擎（M4）—— 四条规则 + 去重 + 贪睡静默
 *
 * 规则（每次快照变化 / 每分钟 tick 时评估）：
 * 1. heartbeat  连续专注 50 分钟（同一 doing 任务 + 主屏计入）→ 休息提醒
 * 2. drift      有 doing 任务，但过去 5 分钟主屏计入时长 < 30s（分心）→ 轻推
 * 3. switch_storm 5 分钟内前台切换 ≥ 15 次（高频跳窗）→ 平复提醒
 * 4. idle_back  空闲 ≥ 10 分钟后恢复输入 → 欢迎/确认回来
 *
 * 通用约束：
 * - 每种规则 10 分钟内最多触发一次（同 key 去重）
 * - 用户点「稍后提醒」→ 该规则静默 snoozeMs（默认 20 分钟）
 * - overlay 可见时不再触发新提醒
 */
import { onSnapshotChange, onSessionEnded, isIdle } from './tracker';
import { getCurrentTask } from './db';
import { showOverlay, hideOverlay, isOverlayVisible, type OverlayPayload } from './overlay';

/* ── 配置（M5 设置页可改）────────────────────────────────── */
export interface ReminderConfig {
  heartbeatFocusMs: number;      // 专注多久提醒（默认 50min）
  driftWindowMs: number;         // 分心检测窗口（默认 5min）
  driftMinCountedMs: number;     // 窗口内最少计入时长（默认 30s）
  stormWindowMs: number;         // 切换风暴窗口（默认 5min）
  stormSwitchThreshold: number;  // 切换次数阈值（默认 15）
  idleBackMinMs: number;         // 空闲多久恢复算 idle_back（默认 10min）
  perRuleCooldownMs: number;     // 同规则去重间隔（默认 10min）
  snoozeMs: number;              // 「稍后提醒」静默时长（默认 20min）
}

export const DEFAULT_CONFIG: ReminderConfig = {
  heartbeatFocusMs: 50 * 60_000,
  driftWindowMs: 5 * 60_000,
  driftMinCountedMs: 30_000,
  stormWindowMs: 5 * 60_000,
  stormSwitchThreshold: 15,
  idleBackMinMs: 10 * 60_000,
  perRuleCooldownMs: 10 * 60_000,
  snoozeMs: 20 * 60_000,
};

type RuleKey = 'heartbeat' | 'drift' | 'switch_storm' | 'idle_back';

const RULE_TITLE: Record<RuleKey, string> = {
  heartbeat: '连续专注了一段时间',
  drift: '好像走神了？',
  switch_storm: '切换有点频繁',
  idle_back: '欢迎回来',
};

/* ── 运行时状态 ──────────────────────────────────────────── */

let cfg: ReminderConfig = { ...DEFAULT_CONFIG };
let enabled = true;
let paused = false; // 托盘「暂停提醒」

// 去重 / 静默
const lastFiredAt = new Map<RuleKey, number>();
const snoozedUntil = new Map<RuleKey, number>();

// heartbeat：当前 doing 任务累计的连续计入时长（会话事件累加，切任务/空闲即清零）
let continuousFocusMs = 0;
let continuousTaskId: number | null = null;

// switch 计数环形记录（时间窗口用）
const switchTimes: number[] = [];

// drift：窗口内计入时长（滚动求和）
const countedSegments: Array<{ at: number; ms: number }> = [];

// idle_back：进入空闲的时刻与时长
let idleStartedAt = 0;

let listeners: Array<(r: OverlayPayload) => void> = [];
export function onReminderFired(fn: (r: OverlayPayload) => void): void {
  listeners.push(fn);
}

/* ── 对外控制（M5 设置 / 托盘菜单用）────────────────────── */

export function startReminders(config?: Partial<ReminderConfig>): void {
  if (config) cfg = { ...cfg, ...config };
  wireTracking();
}

export function stopReminders(): void {
  enabled = false;
}

export function setRemindersPaused(p: boolean): void {
  paused = p;
  if (p) hideOverlay();
}

export function snoozeRule(rule: RuleKey, ms = cfg.snoozeMs): void {
  snoozedUntil.set(rule, Date.now() + ms);
}

export function snoozeAll(ms = cfg.snoozeMs): void {
  (['heartbeat', 'drift', 'switch_storm', 'idle_back'] as RuleKey[]).forEach((k) => snoozeRule(k, ms));
}

/** 渲染层点「稍后提醒」回调 */
export function handleOverlaySnooze(): void {
  // 找到当前可见的提醒对应规则：简化为全部静默（一次只有一个浮层）
  snoozeAll();
  hideOverlay();
}

/* ── 内部实现 ────────────────────────────────────────────── */

function canFire(rule: RuleKey, now: number): boolean {
  if (!enabled || paused) return false;
  if (isOverlayVisible()) return false;
  const snoozed = snoozedUntil.get(rule) ?? 0;
  if (now < snoozed) return false;
  const last = lastFiredAt.get(rule) ?? 0;
  if (now - last < cfg.perRuleCooldownMs) return false;
  return true;
}

function fire(rule: RuleKey, body: string): void {
  const now = Date.now();
  lastFiredAt.set(rule, now);
  const payload: OverlayPayload = {
    kind: rule,
    title: RULE_TITLE[rule],
    body,
  };
  void showOverlay(payload);
  for (const fn of listeners) {
    try { fn(payload); } catch { /* listener error 不影响主流程 */ }
  }
}

let wired = false;

function wireTracking(): void {
  if (wired) return;
  wired = true;

  // 会话结束：累计 heartbeat 专注 / drift 计入 / switch 计数
  onSessionEnded((s) => {
    const now = s.endedAt;

    // switch_storm：所有前台会话都算一次切换（含不计入的副屏）
    switchTimes.push(now);
    while (switchTimes.length > 0 && now - switchTimes[0] > cfg.stormWindowMs) switchTimes.shift();

    if (s.counted) {
      // drift 窗口
      countedSegments.push({ at: now, ms: s.durationMs });
      while (countedSegments.length > 0 && now - countedSegments[0].at < now - cfg.driftWindowMs) countedSegments.shift();

      // heartbeat：doing 任务连续专注
      const task = getCurrentTask();
      if (task && s.onPrimary) {
        if (continuousTaskId === task.id) {
          continuousFocusMs += s.durationMs;
        } else {
          continuousTaskId = task.id;
          continuousFocusMs = s.durationMs;
        }
      } else {
        resetContinuous();
      }
    } else {
      // 不计入的会话（副屏/空闲）打断连续专注
      resetContinuous();
    }

    evaluate(s.endedAt);
  });

  // 快照变化：idle_back 检测
  onSnapshotChange((snap) => {
    const now = Date.now();
    if (!snap && isIdle()) {
      if (idleStartedAt === 0) idleStartedAt = now;
    } else if (snap && idleStartedAt > 0) {
      const idleDur = now - idleStartedAt;
      idleStartedAt = 0;
      if (idleDur >= cfg.idleBackMinMs && canFire('idle_back', now)) {
        fire('idle_back', `离开了 ${Math.round(idleDur / 60_000)} 分钟。要继续刚才的任务吗？`);
      }
    }
  });
}

function resetContinuous(): void {
  continuousFocusMs = 0;
  continuousTaskId = null;
}

function evaluate(now: number): void {
  // 1. heartbeat
  if (continuousFocusMs >= cfg.heartbeatFocusMs && canFire('heartbeat', now)) {
    const task = getCurrentTask();
    fire('heartbeat', `「${task?.text ?? '当前任务'}」已专注 ${Math.round(continuousFocusMs / 60_000)} 分钟，起来走走。`);
    resetContinuous(); // 提醒后重新累计
    return;
  }

  // 2. switch_storm
  if (switchTimes.length >= cfg.stormSwitchThreshold && canFire('switch_storm', now)) {
    fire('switch_storm', `${cfg.stormWindowMs / 60_000} 分钟内切换了 ${switchTimes.length} 次窗口。先停一下，回到一件事上。`);
    switchTimes.length = 0; // 平复窗口
    return;
  }

  // 3. drift：有 doing 任务但窗口内计入过少
  const task = getCurrentTask();
  if (task) {
    const cutoff = now - cfg.driftWindowMs;
    const counted = countedSegments
      .filter((seg) => seg.at >= cutoff)
      .reduce((sum, seg) => sum + seg.ms, 0);
    if (counted < cfg.driftMinCountedMs && canFire('drift', now)) {
      fire('drift', `「${task.text}」还在等你。刚过去 ${cfg.driftWindowMs / 60_000} 分钟里，主屏只计了 ${Math.round(counted / 1000)} 秒。`);
    }
  }
}

/** 渲染层查询当前提醒配置（M5 设置页） */
export function getReminderConfig(): ReminderConfig {
  return { ...cfg };
}

export function updateReminderConfig(patch: Partial<ReminderConfig>): ReminderConfig {
  cfg = { ...cfg, ...patch };
  return { ...cfg };
}
