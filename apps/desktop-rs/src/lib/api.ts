/**
 * 渲染进程可用的 TimePaws API 类型（preload 暴露的白名单）。
 * M0：ping/折叠；M2：统计查询 + 会话事件。
 */

export interface DailyAppRow {
  app_key: string;
  app_name: string;
  total_ms: number;
}

export interface DailySummary {
  dateKey: string;
  totalMs: number;
  countedSessions: number;
  topApps: DailyAppRow[];
  topTitles: Array<{ title: string; app_name: string; total_ms: number }>;
  recent: Array<{ app_name: string; title: string; ended_at: number; duration_ms: number }>;
}

export interface ForegroundInfo {
  hwnd: string;
  appKey: string;
  appName: string;
  windowTitle: string;
  pid: number;
  onPrimary: boolean;
  iconic: boolean;
  at: number;
}

export interface TaskInfo {
  id: number;
  text: string;
  status: 'todo' | 'doing' | 'done';
  created_at: number;
  done_at: number | null;
  focus_ms: number;
}

export interface TimepawsApi {
  ping: () => Promise<{ pong: boolean; at: number }>;
  widgetToggleCollapse: () => void;
  onWidgetCollapsedChanged: (cb: (collapsed: boolean) => void) => void;
  statsToday: (dateKey?: string) => Promise<DailySummary>;
  statsDailyTotals: (days?: number) => Promise<Array<{ dateKey: string; totalMs: number }>>;
  trackerCurrent: () => Promise<ForegroundInfo | null>;
  onSessionEnded: (cb: (s: unknown) => void) => void;
  tasksList: (includeDone?: boolean) => Promise<TaskInfo[]>;
  tasksCurrent: () => Promise<TaskInfo | null>;
  tasksCreate: (text: string) => Promise<TaskInfo>;
  tasksUpdateText: (id: number, text: string) => Promise<void>;
  tasksDelete: (id: number) => Promise<void>;
  tasksSetCurrent: (id: number) => Promise<void>;
  tasksComplete: (id: number) => Promise<void>;
  tasksReopen: (id: number) => Promise<void>;
  onTasksChanged: (cb: () => void) => void;
  onOverlayPayload: (cb: (p: { kind: string; title: string; body: string }) => void) => void;
  overlaySnooze: () => void;
  overlayDismiss: () => void;
  remindersConfig: () => Promise<Record<string, number>>;
  remindersUpdateConfig: (patch: Record<string, number>) => Promise<Record<string, number>>;
  remindersSetPaused: (paused: boolean) => Promise<void>;
  remindersSnoozeAll: (ms?: number) => Promise<void>;
  remindersTest: () => Promise<void>;
  settingsGet: () => Promise<Record<string, unknown>>;
  settingsUpdate: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  dataExport: () => Promise<{ file: string; sessions: number; dailyAppRows: number; tasks: number }>;
  dataPurge: (includeTasks: boolean) => Promise<{ sessions: number; dailyAppRows: number; dailyTitleRows: number; events: number; tasks: number }>;
  dataStats: () => Promise<{ sessions: number; days: number; tasks: number; dbFile: string }>;
}

declare global {
  interface Window {
    timepaws: TimepawsApi;
  }
}

export {};
