/**
 * Tauri 桥接层：把 Electron preload 暴露的 window.anchor API 映射到 Tauri invoke/listen。
 * 前端组件零改动 —— 仍按 window.anchor.* 调用。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Cb = () => void;

const tasksChangedCbs = new Set<Cb>();
let sessionCb: ((s: unknown) => void) | null = null;
let overlayPayloadCb: ((p: unknown) => void) | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse<T>(v: any): T {
  return v as T;
}

export async function installAnchorBridge(): Promise<void> {
  const anchor = {
    ping: () =>
      invoke<{ ok: boolean; at: number }>('ping').then((r) => ({
        pong: r.ok,
        at: r.at,
      })),
    widgetToggleCollapse: () => invoke('toggle_main_window'),
    onWidgetCollapsedChanged: (_cb: (collapsed: boolean) => void) => {
      /* 小组件折叠：Tauri 版 M4 实现 */
    },
    statsToday: () => invoke<unknown>('stats_today').then((v) => parse(v)),
    statsDailyTotals: (days?: number) =>
      invoke<unknown[]>('stats_daily_totals', { days: days ?? 14 }),
    trackerCurrent: () => invoke<unknown | null>('tracker_current'),
    onSessionEnded: (cb: (s: unknown) => void) => {
      sessionCb = cb;
    },

    tasksList: (includeDone?: boolean) =>
      invoke<unknown[]>('tasks_list', { includeDone: includeDone ?? false }),
    tasksCurrent: () => invoke<unknown | null>('tasks_current'),
    tasksCreate: (text: string) => invoke<unknown>('tasks_create', { text }),
    tasksUpdateText: (id: number, text: string) =>
      invoke('tasks_update_text', { id, text }),
    tasksDelete: (id: number) => invoke('tasks_delete', { id }),
    tasksSetCurrent: (id: number) => invoke('tasks_set_current', { id }),
    tasksComplete: (id: number) => invoke('tasks_complete', { id }),
    tasksReopen: (id: number) => invoke('tasks_reopen', { id }),
    onTasksChanged: (cb: Cb) => {
      tasksChangedCbs.add(cb);
    },

    // M4：提醒/设置/数据管理
    remindersConfig: () => invoke<Record<string, number>>('reminders_config'),
    remindersUpdateConfig: (p: Record<string, number>) =>
      invoke<Record<string, number>>('reminders_update_config', { patch: p }),
    remindersSetPaused: (paused: boolean) => invoke<void>('reminders_set_paused', { paused }),
    remindersSnoozeAll: (ms?: number) => invoke<void>('reminders_snooze_all', { ms: ms ?? null }),
    remindersTest: () => invoke<void>('reminders_test'),
    settingsGet: () => Promise.resolve({}),
    settingsUpdate: (p: Record<string, unknown>) => Promise.resolve(p),
    dataExport: () =>
      Promise.resolve({ file: '', sessions: 0, dailyAppRows: 0, tasks: 0 }),
    dataPurge: (_includeTasks: boolean) =>
      Promise.resolve({
        sessions: 0,
        dailyAppRows: 0,
        dailyTitleRows: 0,
        events: 0,
        tasks: 0,
      }),
    dataStats: () =>
      Promise.resolve({ sessions: 0, days: 0, tasks: 0, dbFile: '' }),

    // M4：浮层（#/overlay 路由消费）
    onOverlayPayload: (cb: (p: { kind: string; title: string; body: string }) => void) => {
      overlayPayloadCb = cb as (p: unknown) => void;
    },
    overlaySnooze: () => invoke('overlay_snooze'),
    overlayDismiss: () => invoke('overlay_dismiss'),
  };

  (window as unknown as { anchor: unknown }).anchor = anchor;

  // 订阅后端事件
  void listen<unknown>('tracker://session-ended', (e) => {
    sessionCb?.(e.payload);
  });
  void listen('tasks://changed', () => {
    tasksChangedCbs.forEach((cb) => cb());
  });
  void listen<unknown>('anchor:overlay:payload', (e) => {
    overlayPayloadCb?.(e.payload);
  });
}
