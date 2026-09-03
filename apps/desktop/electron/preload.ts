/**
 * 预加载桥：渲染进程唯一允许的入口。
 * 只暴露白名单 IPC，不透传 ipcRenderer 本体（安全边界）。
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** 连通性自检（M0） */
  ping: (): Promise<{ pong: boolean; at: number }> => ipcRenderer.invoke('anchor/ping'),

  /** 小组件折叠/展开（M0） */
  widgetToggleCollapse: (): void => ipcRenderer.send('anchor/widget/toggle-collapse'),

  /** 通知渲染层折叠状态变化 */
  onWidgetCollapsedChanged: (cb: (collapsed: boolean) => void): void => {
    ipcRenderer.on('anchor:widget:collapsedChanged', (_e, collapsed: boolean) => cb(collapsed));
  },

  /** 今日（或指定日）使用汇总（M2） */
  statsToday: (dateKey?: string) => ipcRenderer.invoke('anchor/stats/today', dateKey),

  /** 最近 N 天每日总时长（M2） */
  statsDailyTotals: (days?: number) => ipcRenderer.invoke('anchor/stats/daily-totals', days),

  /** 当前前台快照（M2，小组件/今日页实时态） */
  trackerCurrent: () => ipcRenderer.invoke('anchor/tracker/current'),

  /** 订阅会话结束事件（主进程落库后广播，渲染层增量刷新） */
  onSessionEnded: (cb: (s: unknown) => void): void => {
    ipcRenderer.on('anchor:tracker:sessionEnded', (_e, s) => cb(s));
  },

  /** 任务列表（M3；includeDone=false 隐藏已完成） */
  tasksList: (includeDone?: boolean) => ipcRenderer.invoke('anchor/tasks/list', includeDone),

  /** 当前任务（doing；没有则 null） */
  tasksCurrent: () => ipcRenderer.invoke('anchor/tasks/current'),

  tasksCreate: (text: string) => ipcRenderer.invoke('anchor/tasks/create', text),
  tasksUpdateText: (id: number, text: string) => ipcRenderer.invoke('anchor/tasks/update-text', id, text),
  tasksDelete: (id: number) => ipcRenderer.invoke('anchor/tasks/delete', id),
  tasksSetCurrent: (id: number) => ipcRenderer.invoke('anchor/tasks/set-current', id),
  tasksComplete: (id: number) => ipcRenderer.invoke('anchor/tasks/complete', id),
  tasksReopen: (id: number) => ipcRenderer.invoke('anchor/tasks/reopen', id),

  /** 订阅任务变更（任何窗口改动后广播） */
  onTasksChanged: (cb: () => void): void => {
    ipcRenderer.on('anchor:tasks:changed', () => cb());
  },

  /** 浮层：接收提醒内容（M4，仅 overlay 窗口消费） */
  onOverlayPayload: (cb: (p: { kind: string; title: string; body: string }) => void): void => {
    ipcRenderer.on('anchor:overlay:payload', (_e, p) => cb(p));
  },
  overlaySnooze: (): void => ipcRenderer.send('anchor/overlay/snooze'),
  overlayDismiss: (): void => ipcRenderer.send('anchor/overlay/dismiss'),

  /** 提醒配置与控制（M4/M5） */
  remindersConfig: () => ipcRenderer.invoke('anchor/reminders/config'),
  remindersUpdateConfig: (patch: Record<string, number>) => ipcRenderer.invoke('anchor/reminders/update-config', patch),
  remindersSetPaused: (paused: boolean) => ipcRenderer.invoke('anchor/reminders/set-paused', paused),
  remindersSnoozeAll: (ms?: number) => ipcRenderer.invoke('anchor/reminders/snooze-all', ms),
  remindersTest: () => ipcRenderer.invoke('anchor/reminders/test'),

  /** 设置与数据管理（M5） */
  settingsGet: () => ipcRenderer.invoke('anchor/settings/get'),
  settingsUpdate: (patch: Record<string, unknown>) => ipcRenderer.invoke('anchor/settings/update', patch),
  dataExport: () => ipcRenderer.invoke('anchor/data/export'),
  dataPurge: (includeTasks: boolean) => ipcRenderer.invoke('anchor/data/purge', includeTasks),
  dataStats: () => ipcRenderer.invoke('anchor/data/stats'),
};

contextBridge.exposeInMainWorld('anchor', api);

export type AnchorApi = typeof api;
