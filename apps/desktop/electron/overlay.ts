/**
 * 浮层提醒窗口（OverlayNudge，M4）
 *
 * 规格：
 * - 主屏右下角滑入的提醒浮层，不抢键盘焦点（showInactive + focusable:false）
 * - alwaysOnTop('screen-saver')，绝不打断全屏心流之外的场景
 * - 渲染层渲染提醒内容 + 「好的 / 稍后提醒」按钮
 * - 自动关闭：默认 25s 无操作自动淡出；用户点按钮立即关闭
 *
 * 不做点击穿透（整窗命中），因为浮层小且短暂，命中整窗最简单可靠。
 */
import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';

const OVERLAY_W = 320;
const OVERLAY_H = 148;
const AUTO_DISMISS_MS = 25_000;

let overlayWindow: BrowserWindow | null = null;
let autoDismissTimer: NodeJS.Timeout | null = null;

export interface OverlayPayload {
  title: string;
  body: string;
  kind: 'heartbeat' | 'drift' | 'switch_storm' | 'idle_back';
}

export function isOverlayVisible(): boolean {
  return overlayWindow !== null && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
}

function positionOverlay(win: BrowserWindow): void {
  const wa = screen.getPrimaryDisplay().workArea;
  win.setPosition(wa.x + wa.width - OVERLAY_W - 20, wa.y + wa.height - OVERLAY_H - 20);
}

export async function showOverlay(payload: OverlayPayload): Promise<void> {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = new BrowserWindow({
      width: OVERLAY_W,
      height: OVERLAY_H,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,          // 永不抢键盘焦点
      alwaysOnTop: true,
      backgroundColor: '#1B1E24',
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    void overlayWindow.loadURL(`file://${path.join(__dirname, '../dist/index.html')}#/overlay`);
    // 隐藏期预加载完成后再显示
    await new Promise<void>((resolve) => {
      if (!overlayWindow) return resolve();
      overlayWindow.once('ready-to-show', () => resolve());
    });
  }

  positionOverlay(overlayWindow);
  overlayWindow.showInactive(); // 不抢焦点
  overlayWindow.webContents.send('anchor:overlay:payload', payload);

  // 自动淡出
  if (autoDismissTimer) clearTimeout(autoDismissTimer);
  autoDismissTimer = setTimeout(() => {
    hideOverlay();
  }, AUTO_DISMISS_MS);
}

export function hideOverlay(): void {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
}

/** 用户点了「稍后提醒」→ 主进程标记静默（由 reminders.ts 消费） */
export function closeOverlay(): void {
  hideOverlay();
  void app; // 保持模块边界清晰：overlay 只管窗口，不碰规则状态
}
