/**
 * 常驻桌面小组件（Widget）
 *
 * 规格：
 * - 默认 280x120，主屏，alwaysOnTop，可拖动、位置持久化、贴主屏边缘吸附
 * - 无系统边框、点击穿透由渲染层用 -webkit-app-region 处理
 * - 可折叠成一条（渲染层决定高度，主进程负责窗口尺寸动画）
 *
 * 位置持久化存 app.getPath('userData')/widget-pos.json，重启恢复。
 */
import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WIDGET_W = 280;
const WIDGET_H = 120;
const WIDGET_H_COLLAPSED = 44;
const SNAP_MARGIN = 12; // 距主屏工作区边缘 <=12px 时吸附

let widgetWindow: BrowserWindow | null = null;
let collapsed = false;

interface WidgetPos { x: number; y: number; collapsed: boolean }

function posFile(): string {
  return path.join(app.getPath('userData'), 'widget-pos.json');
}

function loadPos(): WidgetPos | null {
  try {
    const raw = fs.readFileSync(posFile(), 'utf8');
    const parsed = JSON.parse(raw) as WidgetPos;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed;
  } catch {
    // 首次启动没有文件，正常
  }
  return null;
}

function savePos(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const [x, y] = widgetWindow.getPosition();
  try {
    fs.writeFileSync(posFile(), JSON.stringify({ x, y, collapsed } satisfies WidgetPos));
  } catch {
    // 持久化失败不致命，忽略
  }
}

/** 把坐标夹回主屏工作区（含多屏拔掉后位置失效的兜底） */
function clampToPrimary(x: number, y: number): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.min(Math.max(x, wa.x), wa.x + wa.width - WIDGET_W),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - WIDGET_H_COLLAPSED),
  };
}

/** 边缘吸附：接近主屏工作区左右/上下边缘时贴齐 */
function snapToEdge(x: number, y: number): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea;
  const h = collapsed ? WIDGET_H_COLLAPSED : WIDGET_H;
  const res = { x, y };
  if (Math.abs(x - wa.x) < SNAP_MARGIN) res.x = wa.x;
  if (Math.abs(x + WIDGET_W - (wa.x + wa.width)) < SNAP_MARGIN) res.x = wa.x + wa.width - WIDGET_W;
  if (Math.abs(y - wa.y) < SNAP_MARGIN) res.y = wa.y;
  if (Math.abs(y + h - (wa.y + wa.height)) < SNAP_MARGIN) res.y = wa.y + wa.height - h;
  return res;
}

export async function createWidgetWindow(): Promise<BrowserWindow> {
  const saved = loadPos();
  const wa = screen.getPrimaryDisplay().workArea;
  // 默认出现在主屏右下角（任务栏上方）
  const initial = clampToPrimary(
    saved?.x ?? wa.x + wa.width - WIDGET_W - 24,
    saved?.y ?? wa.y + wa.height - WIDGET_H - 24,
  );
  collapsed = saved?.collapsed ?? false;

  widgetWindow = new BrowserWindow({
    width: WIDGET_W,
    height: collapsed ? WIDGET_H_COLLAPSED : WIDGET_H,
    x: initial.x,
    y: initial.y,
    frame: false, // 无边框：小组件形态
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#1B1E24',
    hasShadow: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 永远在最上层（level 在 Windows 上由 alwaysOnTop 保证；这里确保置顶不被其他置顶窗盖过）
  widgetWindow.setAlwaysOnTop(true, 'screen-saver');

  // 拖动结束后持久化 + 吸附
  const onMove = (): void => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const [x, y] = widgetWindow.getPosition();
    const snapped = snapToEdge(x, y);
    if (snapped.x !== x || snapped.y !== y) widgetWindow.setPosition(snapped.x, snapped.y);
  };
  widgetWindow.on('moved', onMove);
  widgetWindow.on('moved', savePos);

  // 加载策略与主窗口一致：优先 Vite dev server，连不上回退 file:// 构建产物（hash 路由 #/widget）
  const isDev = !app.isPackaged;
  // pathToFileURL 生成 file:///D:\... 三斜杠形式（Windows 盘符不能被当主机名）
  const fileUrl = `${pathToFileURL(path.join(__dirname, '../dist/index.html')).href}#/widget`;
  let url = fileUrl;
  if (isDev) {
    try {
      const net = await import('node:net');
      const viteUp = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(500);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(5183, '127.0.0.1');
      });
      if (viteUp) url = 'http://127.0.0.1:5183/#/widget';
    } catch { /* 探测失败走 file:// */ }
  }
  void widgetWindow.loadURL(url);

  return widgetWindow;
}

/** 折叠/展开（渲染层通过 IPC 触发） */
export async function toggleWidgetCollapse(): Promise<void> {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  collapsed = !collapsed;
  const [, y] = widgetWindow.getPosition();
  const wa = screen.getPrimaryDisplay().workArea;
  // 展开时若超出底部则上移
  const targetY = collapsed ? y : Math.min(y, wa.y + wa.height - WIDGET_H);
  widgetWindow.setSize(WIDGET_W, collapsed ? WIDGET_H_COLLAPSED : WIDGET_H);
  widgetWindow.setPosition(widgetWindow.getPosition()[0], targetY);
  savePos();
  widgetWindow.webContents.send('anchor:widget:collapsedChanged', collapsed);
}
export function getWidgetWindow(): BrowserWindow | null {
  return widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow : null;
}

/** 主屏变化（热插拔/改主屏/改分辨率）时把小组件拉回可视区 */
export function repositionWidgetIntoPrimary(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const [x, y] = widgetWindow.getPosition();
  const clamped = clampToPrimary(x, y);
  widgetWindow.setPosition(clamped.x, clamped.y);
}
