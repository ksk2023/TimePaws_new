/**
 * Anchor（锚点）Electron 主进程入口
 *
 * 职责边界（v1 约定）：
 * - Win32 API / SQLite / 定时器全部在本进程；渲染进程只做展示与交互
 * - M0 里程碑：主窗口 + 托盘 + 可拖动 alwaysOnTop 小组件，追踪逻辑占位
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { createTray } from './tray';
import { createWidgetWindow, getWidgetWindow, toggleWidgetCollapse } from './widget';
import { registerDisplayWatch } from './display';
import { startTracker, stopTracker, onSessionEnded, getCurrentSnapshot, localDateKey } from './tracker';
import {
  openDatabase,
  closeDatabase,
  recordSession,
  getDailySummary,
  getDailyTotals,
  listTasks,
  getCurrentTask,
  createTask,
  updateTaskText,
  deleteTask,
  setCurrentTask,
  completeTask,
  reopenTask,
} from './db';
import { startTaskFocusAccumulator, stopTaskFocusAccumulator } from './task-focus';
import { startReminders, stopReminders, setRemindersPaused, handleOverlaySnooze, snoozeAll, getReminderConfig, updateReminderConfig } from './reminders';
import { showOverlay, hideOverlay } from './overlay';
import { loadSettings, updateSettings, exportData, purgeTrackingData, dataStats } from './settings';

const isDev = !app.isPackaged;

// M6：固定 userData 目录。package.json 增加 productName 后，Electron 会改用 productName
// 作为 userData 目录名，导致老数据（anchor.db / settings.json / widget-pos.json）"消失"。
// 显式钉住到原位置，开发与打包共用，数据永不迁移。
app.setPath('userData', path.join(app.getPath('appData'), '@anchor', 'desktop'));

// M6：单实例锁 —— 二次启动直接唤起已有主窗口，避免双实例抢 SQLite WAL
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

// Windows 上保证托盘与小组件行为一致
app.setAppUserModelId('com.anchor.desktop');

// M6：GPU 进程崩溃兜底 —— 禁用硬件加速黑名单冲突，GPU 挂了自动软渲染，应用不白屏
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' && details.reason === 'crashed') {
    console.error('[main] GPU process crashed; relaunching with GPU disabled');
    app.relaunch();
    app.exit(0);
  }
});

// M6：未捕获异常兜底 —— 记日志、不打断托盘常驻
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});

let mainWindow: BrowserWindow | null = null;

/** 主窗口加载地址：优先 Vite dev server，连不上则回退 file:// 构建产物 */
async function resolveIndexUrl(): Promise<string> {
  const devUrl = 'http://127.0.0.1:5183/';
  if (isDev && (await probeDevServer(devUrl))) return devUrl;
  return `file://${path.join(__dirname, '../dist/index.html')}`;
}

/** 探测 Vite dev server 是否可用（500ms 超时） */
async function probeDevServer(url: string): Promise<boolean> {
  try {
    const net = await import('node:net');
    return await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(5183, '127.0.0.1');
    });
  } catch {
    void url;
    return false;
  }
}

/** 主窗口：关闭时隐藏到托盘而非退出（追踪与小组件继续常驻） */
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    show: false, // ready-to-show 后再展示，避免白闪
    backgroundColor: '#14161A',
    autoHideMenuBar: true,
    title: 'Anchor 锚点',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // better-sqlite3/koffi 均在主进程，preload 只走 IPC
    },
  });

  void resolveIndexUrl().then((url) => mainWindow?.loadURL(url));
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // M6：渲染进程崩溃自动重载（保留窗口，不丢会话数据——数据都在主进程）
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone:', details.reason);
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        try { mainWindow?.webContents.reload(); } catch { /* window gone */ }
      }, 1000);
    }
  });

  // 点关闭 = 隐藏到托盘；真正的退出走托盘菜单
  mainWindow.on('close', (event) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

/* ── M0 占位 IPC：后续里程碑逐一替换为真实能力 ───────────────── */

// 连通性自检
ipcMain.handle('anchor/ping', () => ({ pong: true, at: Date.now() }));

// 小组件折叠切换（渲染层点按钮触发）
ipcMain.on('anchor/widget/toggle-collapse', () => void toggleWidgetCollapse());

/* ── M2 统计 IPC ─────────────────────────────────────────── */

// 今日汇总（缺省今天；也可查任意 YYYY-MM-DD）
ipcMain.handle('anchor/stats/today', (_e, dateKey?: string) => getDailySummary(dateKey ?? localDateKey()));

// 最近 N 天每日总时长
ipcMain.handle('anchor/stats/daily-totals', (_e, days?: number) => getDailyTotals(Math.min(Math.max(days ?? 14, 1), 90)));

// 当前前台快照（小组件/今日页实时态）
ipcMain.handle('anchor/tracker/current', () => getCurrentSnapshot());

/* ── M3 任务 IPC ─────────────────────────────────────────── */

const broadcastTasksChanged = (): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('anchor:tasks:changed');
  }
};

ipcMain.handle('anchor/tasks/list', (_e, includeDone?: boolean) => listTasks(includeDone !== false));
ipcMain.handle('anchor/tasks/current', () => getCurrentTask());
ipcMain.handle('anchor/tasks/create', (_e, text: string) => {
  const t = createTask(String(text ?? '').trim().slice(0, 200));
  broadcastTasksChanged();
  return t;
});
ipcMain.handle('anchor/tasks/update-text', (_e, id: number, text: string) => {
  updateTaskText(id, String(text ?? '').trim().slice(0, 200));
  broadcastTasksChanged();
});
ipcMain.handle('anchor/tasks/delete', (_e, id: number) => {
  deleteTask(id);
  broadcastTasksChanged();
});
ipcMain.handle('anchor/tasks/set-current', (_e, id: number) => {
  setCurrentTask(id);
  broadcastTasksChanged();
});
ipcMain.handle('anchor/tasks/complete', (_e, id: number) => {
  completeTask(id);
  broadcastTasksChanged();
});
ipcMain.handle('anchor/tasks/reopen', (_e, id: number) => {
  reopenTask(id);
  broadcastTasksChanged();
});

/* ── M4 提醒 / 浮层 IPC ─────────────────────────────────── */

// 浮层按钮：稍后提醒（贪睡全部规则）
ipcMain.on('anchor/overlay/snooze', () => handleOverlaySnooze());
// 浮层按钮：知道了（直接关）
ipcMain.on('anchor/overlay/dismiss', () => hideOverlay());

// 托盘 / 设置页控制
ipcMain.handle('anchor/reminders/config', () => getReminderConfig());
ipcMain.handle('anchor/reminders/update-config', (_e, patch) => updateReminderConfig(patch ?? {}));
ipcMain.handle('anchor/reminders/set-paused', (_e, paused: boolean) => setRemindersPaused(Boolean(paused)));
ipcMain.handle('anchor/reminders/snooze-all', (_e, ms?: number) => snoozeAll(ms));
// 测试触发（设置页「预览提醒」用）
ipcMain.handle('anchor/reminders/test', () => {
  void showOverlay({
    kind: 'heartbeat',
    title: '提醒预览',
    body: '这是一条提醒长什么样。点「稍后提醒」20 分钟内不再打扰。',
  });
});

/* ── M5 设置 / 数据管理 IPC ──────────────────────────────── */

ipcMain.handle('anchor/settings/get', () => loadSettings());
ipcMain.handle('anchor/settings/update', (_e, patch) => updateSettings(patch ?? {}));
ipcMain.handle('anchor/data/export', () => exportData());
ipcMain.handle('anchor/data/purge', (_e, includeTasks: boolean) => purgeTrackingData(Boolean(includeTasks)));
ipcMain.handle('anchor/data/stats', () => dataStats());

app.whenReady().then(() => {
  // 数据库先行：追踪会话结束即落库
  openDatabase();
  onSessionEnded((s) => {
    try {
      recordSession(s);
    } catch (err) {
      console.error('[db] recordSession failed:', err);
    }
  });
  createMainWindow();
  void createWidgetWindow();
  createTray(() => showMainWindow());
  // 主显示器热插拔/分辨率变化时，把小组件拉回主屏可视区
  registerDisplayWatch();
  // M1 起启用真实追踪（tracker 内部已含空闲检测）
  startTracker();
  // M3：doing 任务专注时长积累器
  startTaskFocusAccumulator();
  // M4：提醒规则引擎
  startReminders();
  // M5：应用持久化设置（暂停态/空闲阈值/提醒参数/自启）
  applySettingsFromDisk();
  // 会话结束 → 广播给渲染层（小组件/今日页增量刷新）
  onSessionEnded((s) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('anchor:tracker:sessionEnded', s);
    }
  });

  app.on('activate', () => showMainWindow());
});

/** M5：启动时应用磁盘上的设置（在各子系统 start 之后调用） */
function applySettingsFromDisk(): void {
  try {
    const s = loadSettings();
    void updateSettings(s); // updateSettings 内部会 applySettings 同步到子系统
  } catch (err) {
    console.error('[settings] apply failed:', err);
  }
}

// macOS 惯例兜底（本项目仅 Windows，但保留规范写法）
app.on('window-all-closed', () => {
  // 不退出：托盘常驻。真正退出见 tray.ts
});

// 退出前把小组件位置交给其自身持久化逻辑处理（见 widget.ts）
app.on('before-quit', () => {
  (app as unknown as { isQuitting?: boolean }).isQuitting = true;
  getWidgetWindow()?.close();
});

// 退出时收尾：停追踪（冲刷当前会话）→ 停提醒 → 停专注积累器（冲刷任务桶）→ 关库
app.on('will-quit', () => {
  try { stopTracker(); } catch { /* 幂等 */ }
  try { stopReminders(); } catch { /* 幂等 */ }
  try { stopTaskFocusAccumulator(); } catch { /* 幂等 */ }
  try { closeDatabase(); } catch { /* 幂等 */ }
});
