/**
 * 窗口追踪（M1）
 *
 * 设计：
 * - 事件驱动为主：SetWinEventHook(EVENT_SYSTEM_FOREGROUND / EVENT_SYSTEM_MINIMIZEEND)
 *   在 WinEvent 回调里立刻刷新一次前台快照
 * - 1Hz 轮询兜底：GetForegroundWindow 快照对比变化（钩子偶尔漏发，轮询保底）
 * - 空闲：GetLastInputInfo，超过 idleTimeout 停止计费；有输入立刻恢复
 * - 主屏口径：前台窗口中心落在主屏工作区才计 focused_on_primary
 * - 忽略名单：本应用窗口 / Shell_TrayWnd / Progman / WorkerW / 开始菜单 / 搜索 / 通知中心 / 锁屏
 *
 * M1 输出 console 日志（M2 接 DB）。
 * 时间语义：epoch ms（墙钟）+ Date 本地时区生成 YYYY-MM-DD。
 */
import koffi from 'koffi';
import {
  user32,
  readWindowTitle,
  readWindowPid,
  readProcessImageName,
  exeNameOf,
  KHandle,
} from './win32';
import { idleMs } from './idle';
import { isFocusedOnPrimary } from './display';

/* Win32 常量 */
const EVENT_SYSTEM_FOREGROUND = 0x0003;
const EVENT_SYSTEM_MINIMIZEEND = 0x0017;
const EVENT_SYSTEM_MOVESIZEEND = 0x000b;
const WINEVENT_OUTOFCONTEXT = 0x0;
const WINEVENT_SKIPOWNPROCESS = 0x2;

/** 忽略的窗口类/标题关键词（小写匹配） */
const IGNORE_TITLE_KEYWORDS = [
  'shell_traywnd', 'progman', 'workerw', 'windowsinputexperience',
  'startmenuexperiencehost', 'searchhost', 'shellexperiencehost',
  'lockapp', 'logonui', 'notifyiconwin32', 'actioncenter',
];

/** 友好名映射（常见应用；取不到文件描述时的兜底） */
const FRIENDLY_NAMES: Record<string, string> = {
  'code.exe': 'VS Code',
  'chrome.exe': 'Chrome',
  'msedge.exe': 'Edge',
  'firefox.exe': 'Firefox',
  'wechat.exe': '微信',
  'weixin.exe': '微信',
  'qq.exe': 'QQ',
  'explorer.exe': '资源管理器',
  'winword.exe': 'Word',
  'excel.exe': 'Excel',
  'powerpnt.exe': 'PowerPoint',
  'onenote.exe': 'OneNote',
  'outlook.exe': 'Outlook',
  'idea64.exe': 'IntelliJ IDEA',
  'pycharm64.exe': 'PyCharm',
  'windowsterminal.exe': 'Windows Terminal',
  'powershell.exe': 'PowerShell',
  'pwsh.exe': 'PowerShell',
  'cmd.exe': '命令提示符',
  'notion.exe': 'Notion',
  'obsidian.exe': 'Obsidian',
  'typora.exe': 'Typora',
  'steam.exe': 'Steam',
  'spotify.exe': 'Spotify',
  'cloudmusic.exe': '网易云音乐',
  'snipaste.exe': 'Snipaste',
  'everything.exe': 'Everything',
  'listary.exe': 'Listary',
  'pot.exe': 'Pot',
  'anchor.exe': 'Anchor 锚点',
};

export interface ForegroundSnapshot {
  hwnd: string;         // 运行时标识（数字转字符串；不做长期主键）
  appKey: string;       // 进程可执行文件名（小写，如 code.exe）
  appName: string;      // 友好名
  windowTitle: string;  // 归一化后的窗口标题
  pid: number;
  onPrimary: boolean;
  iconic: boolean;      // 最小化
  at: number;           // epoch ms
}

export type SnapshotListener = (snap: ForegroundSnapshot | null, prev: ForegroundSnapshot | null) => void;

/** 一段前台会话结束（M2 落库用） */
export interface SessionEnded {
  dateKey: string;
  appKey: string;
  appName: string;
  title: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  onPrimary: boolean;
  counted: boolean; // 主屏 + 非最小化 + 非空闲才计时长
}

export type SessionListener = (s: SessionEnded) => void;

const listeners: SnapshotListener[] = [];
const sessionListeners: SessionListener[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let hookHandles: KHandle[] = [];
let current: ForegroundSnapshot | null = null;
let currentSince = 0;      // 当前会话开始时间
let idleState = false;
let idleSince = 0;         // 进入空闲的时刻（0 = 非空闲）
let idleAccruedMs = 0;     // 当前会话内累计空闲时长（从计入时长中扣除）

export function onSnapshotChange(fn: SnapshotListener): void {
  listeners.push(fn);
}

export function onSessionEnded(fn: SessionListener): void {
  sessionListeners.push(fn);
}

export function getCurrentSnapshot(): ForegroundSnapshot | null {
  return current;
}

export function isIdle(): boolean {
  return idleState;
}

/** 主入口：装钩子 + 启动 1Hz 兜底轮询 */
export function startTracker(idleTimeoutMs: number = 60_000): void {
  bindWinEventHooks();
  // 兜底轮询 1Hz
  pollTimer = setInterval(() => pollOnce(idleTimeoutMs), 1000);
  // 先立即采一次
  pollOnce(idleTimeoutMs);
}

export function stopTracker(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  for (const h of hookHandles) {
    try { user32.UnhookWinEvent(h); } catch { /* 已销毁 */ }
  }
  hookHandles = [];
}

/* ── WinEventHook 绑定 ────────────────────────────────────── */

function bindWinEventHooks(): void {
  // koffi 2.x: koffi.register(fn, 'TypeName *') —— 函数在前，类型用命名原型的指针字符串
  const proc = koffi.register(
    (
      hHook: unknown,
      event: number,
      hwnd: unknown,
      idObject: number,
      idChild: number,
      dwEventThread: number,
      dwmsEventTime: number,
    ) => {
      void hHook; void idObject; void idChild; void dwEventThread; void dwmsEventTime;
      // 前台变化 / 最小化结束 / 拖动结束：立刻刷新（事件驱动主路径）
      if (event === EVENT_SYSTEM_FOREGROUND || event === EVENT_SYSTEM_MINIMIZEEND || event === EVENT_SYSTEM_MOVESIZEEND) {
        if (hwnd) pollOnce(60_000);
      }
    },
    'WinEventProc *' as never,
  );

  const events = [EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MOVESIZEEND];
  for (const ev of events) {
    const h = user32.SetWinEventHook(ev, ev, null, proc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    if (h) hookHandles.push(h);
  }
}

/* ── 快照采集 ─────────────────────────────────────────────── */

let idleTimeoutMsGlobal = 60_000;
let trackingPaused = false;

/** M5：暂停/恢复追踪。暂停期间快照视为无前台（不计入任何时长），恢复即回来 */
export function setTrackingPaused(p: boolean): void {
  trackingPaused = p;
  if (p && current) {
    const now = Date.now();
    if (current) {
      endSession(now, current, false); // 暂停不虚增计入时长
      current = null;
    }
  }
}

export function setIdleTimeoutMs(ms: number): void {
  if (ms >= 10_000) idleTimeoutMsGlobal = ms;
}

function pollOnce(idleTimeoutMs: number): void {
  if (typeof idleTimeoutMs === 'number') idleTimeoutMsGlobal = idleTimeoutMs;
  try {
    sample();
  } catch (err) {
    console.error('[tracker] sample error:', err);
  }
}

function sample(): void {
  // 暂停追踪：一切从简（不更新 current，也不触发事件）
  if (trackingPaused) return;

  const now = Date.now();

  // 1. 空闲检测：GetLastInputInfo
  const idle = idleMs();
  const wasIdle = idleState;
  idleState = idle >= idleTimeoutMsGlobal;

  // 空闲时长记账：空闲期间不计入当前会话时长
  if (idleState && !wasIdle) {
    idleSince = now; // 刚进入空闲
  } else if (idleState && wasIdle) {
    // 持续空闲：空闲起点随最后一次输入后移（idleMs 本身就是距上次输入的时长）
    idleSince = now - idle;
  } else if (!idleState && wasIdle) {
    // 从空闲恢复：把这段空闲累计进当前会话的扣除项
    idleAccruedMs += Math.max(0, now - idleSince);
    idleSince = 0;
    emit(null, current, now, 'idle_back');
  }

  // 2. 取前台窗口
  const hwnd = user32.GetForegroundWindow();
  if (!hwnd) {
    // 没有前台窗口（如锁屏瞬间）：当前片段按无前台处理
    updateCurrent(null, now);
    return;
  }

  // 锁屏检测：没有前台窗口或前台是锁屏进程
  const title0 = readWindowTitle(hwnd).toLowerCase();
  if (IGNORE_TITLE_KEYWORDS.some((k) => title0.includes(k))) {
    updateCurrent(null, now);
    return;
  }

  const pid = readWindowPid(hwnd);
  const exePath = readProcessImageName(pid);
  const appKey = exeNameOf(exePath || '').toLowerCase() || '(unknown)';
  const rawTitle = readWindowTitle(hwnd);
  const iconic = user32.IsIconic(hwnd);
  const onPrimary = !iconic && isFocusedOnPrimary(hwnd);

  // 本应用自己的窗口不追踪
  if (exePath && exePath.toLowerCase().includes('anchor')) {
    updateCurrent(null, now);
    return;
  }

  const snap: ForegroundSnapshot = {
    hwnd: hwndKey(hwnd),
    appKey,
    appName: FRIENDLY_NAMES[appKey] ?? appKey.replace(/\.exe$/, ''),
    windowTitle: normalizeTitle(appKey, rawTitle),
    pid,
    onPrimary,
    iconic,
    at: now,
  };

  updateCurrent(snap, now);
}

/** 快照对比 + 变更分发 */
function updateCurrent(next: ForegroundSnapshot | null, now: number): void {
  const prev = current;
  if (!next) {
    if (current && prev) {
      endSession(now, prev, prev.onPrimary && !prev.iconic && !idleState);
      current = null;
      emit(null, prev, now, 'lost_foreground');
    }
    return;
  }
  // 同一窗口同一标题：只更新时间戳与主屏标记
  if (current && prev && current.hwnd === next.hwnd && current.windowTitle === next.windowTitle) {
    const primaryChanged = current.onPrimary !== next.onPrimary;
    current = next;
    if (primaryChanged) emit(next, prev, now, 'primary_changed');
    return;
  }
  // 应用/标题切换：结束上一段会话
  if (current && prev) {
    endSession(now, prev, prev.onPrimary && !prev.iconic && !idleState);
  }
  current = next;
  currentSince = now;
  idleAccruedMs = 0;
  emit(next, prev, now, 'switch');
}

/** 结束当前会话并通知订阅者（db 层落库） */
function endSession(now: number, snap: ForegroundSnapshot, counted: boolean): void {
  const durationMs = Math.max(0, now - currentSince - idleAccruedMs);
  if (durationMs < 1000) return; // <1s 的闪切不入库
  const s: SessionEnded = {
    dateKey: localDateKey(new Date(currentSince)),
    appKey: snap.appKey,
    appName: snap.appName,
    title: snap.windowTitle,
    startedAt: currentSince,
    endedAt: now,
    durationMs,
    onPrimary: snap.onPrimary,
    counted,
  };
  for (const fn of sessionListeners) {
    try { fn(s); } catch (err) { console.error('[tracker] session listener error:', err); }
  }
}

function emit(snap: ForegroundSnapshot | null, prev: ForegroundSnapshot | null, at: number, reason: string): void {
  // M1：控制台日志（M2 起 DB 写入订阅这里）
  const t = new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
  if (reason === 'idle_back') {
    console.log(`[tracker] ${t} | 空闲恢复，重新开始记录`);
  } else if (!snap) {
    console.log(`[tracker] ${t} | 前台无追踪窗口 (${reason})`);
  } else {
    const title = snap.windowTitle.length > 42 ? snap.windowTitle.slice(0, 40) + '…' : snap.windowTitle;
    console.log(
      `[tracker] ${t} | ${snap.appName.padEnd(12)} | ${title.padEnd(44)} | 主屏=${snap.onPrimary ? 'Y' : 'N'}${idleState ? ' | idle' : ''} (${reason})`,
    );
  }
  for (const fn of listeners) fn(snap, prev);
}

/* ── 标题归一化 ───────────────────────────────────────────── */

/**
 * 去掉浏览器窗口后缀（"页面标题 - Google Chrome" → "页面标题"），
 * 保留站点主体；不做更激进的清洗（避免所有标签变同一段）。
 */
const BROWSER_SUFFIXES = [
  ' - Google Chrome', ' – Google Chrome',
  ' - Microsoft Edge', ' – Microsoft Edge',
  ' - Mozilla Firefox',
  ' - Internet Explorer',
];

export function normalizeTitle(appKey: string, title: string): string {
  let t = title.trim();
  if (!t) return t;
  if (isBrowser(appKey)) {
    for (const suf of BROWSER_SUFFIXES) {
      if (t.endsWith(suf)) {
        t = t.slice(0, -suf.length).trim();
        break;
      }
    }
  }
  return t;
}

function isBrowser(appKey: string): boolean {
  return ['chrome.exe', 'msedge.exe', 'firefox.exe', 'browser.exe', '360se.exe', 'sogouexplorer.exe'].includes(appKey);
}

/** HWND 不透明对象 → 稳定标识字符串（koffi.address 返回 BigInt） */
function hwndKey(hwnd: unknown): string {
  try {
    return koffi.address(hwnd as never).toString();
  } catch {
    return '(null)';
  }
}

/** 本地日期字符串 YYYY-MM-DD（本地时区，非 UTC） */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
