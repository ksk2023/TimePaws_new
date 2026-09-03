/**
 * Win32 API 绑定（koffi）—— tracker / idle / display 共用的底层封装。
 *
 * koffi 2.x 实测要点：
 * - 句柄类型不能写 'hwnd'，用 koffi.pointer(opaque()) 定义
 * - 结构体出参：koffi.alloc(struct, 1) → koffi.encode 写初值 → 调用 → koffi.decode 读回
 * - 标量出参（_Out_ uint32 *pid）传 [0] 数组即可自动回写
 */
import koffi from 'koffi';

/** 句柄（HWND/HMONITOR/HANDLE 等）；koffi 2.x 函数参数均为 any，这里用别名保证语义 */
export type KHandle = unknown;
/** koffi.alloc 返回的内存块 */
export type KMemory = any;

/* ── 类型定义 ─────────────────────────────────────────────── */

export const HWND = koffi.pointer('HWND', koffi.opaque());
export const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', {
  cbSize: 'uint32',
  dwTime: 'uint32',
});
export const LastInputInfoPtr = koffi.pointer('LastInputInfoPtr', LASTINPUTINFO);
export const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long',
});
export const RectPtr = koffi.pointer('RectPtr', RECT);

/** MONITORINFO：cbSize + rcMonitor + rcWork + dwFlags（共 40 字节） */
export const MONITORINFO = koffi.struct('MONITORINFO', {
  cbSize: 'uint32',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32',
});
export const MonitorInfoPtr = koffi.pointer('MonitorInfoPtr', MONITORINFO);

/**
 * WinEventProc 回调原型（SetWinEventHook 用）。
 * 实测：koffi 2.16 里命名原型在 func 签名中必须以“指针形式”引用（WinEventProc *pfn），
 * 裸名字会报 “Type ... cannot be used as a parameter”。
 * tracker.ts 的 koffi.register 复用此对象，避免重复注册同名原型。
 */
export const WinEventProcProto = koffi.proto(
  'WinEventProc',
  'void',
  ['HWND', 'uint32', 'HWND', 'int32', 'int32', 'uint32', 'uint32'],
);

/* ── 加载库并绑定 ─────────────────────────────────────────── */

export const user32Lib = koffi.load('user32.dll');
export const kernel32Lib = koffi.load('kernel32.dll');

export const user32 = {
  GetForegroundWindow: user32Lib.func('HWND *GetForegroundWindow()'),
  GetWindowTextLengthW: user32Lib.func('int GetWindowTextLengthW(HWND *h)'),
  GetWindowTextW: user32Lib.func('int GetWindowTextW(HWND *h, uint16 *buf, int max)'),
  GetWindowThreadProcessId: user32Lib.func('uint32 GetWindowThreadProcessId(HWND *h, _Out_ uint32 *pid)'),
  IsWindowVisible: user32Lib.func('bool IsWindowVisible(HWND *h)'),
  IsIconic: user32Lib.func('bool IsIconic(HWND *h)'),
  GetWindowRect: user32Lib.func('bool GetWindowRect(HWND *h, _Out_ RectPtr rect)'),
  GetShellWindow: user32Lib.func('HWND *GetShellWindow()'),
  MonitorFromWindow: user32Lib.func('HWND *MonitorFromWindow(HWND *h, uint32 flags)'),
  GetMonitorInfoW: user32Lib.func('bool GetMonitorInfoW(HWND *hmon, _Inout_ MonitorInfoPtr info)'),
  // EnumDisplayMonitors 不绑定：display.ts 走 MonitorFromWindow 路线，且回调参数绑定徒增复杂度
  SetWinEventHook: user32Lib.func(
    'HWND *SetWinEventHook(uint32 eventMin, uint32 eventMax, HWND *hmod, WinEventProc *pfn, uint32 idProcess, uint32 idThread, uint32 dwFlags)',
  ),
  UnhookWinEvent: user32Lib.func('bool UnhookWinEvent(HWND *hook)'),
};

export const kernel32 = {
  GetTickCount64: kernel32Lib.func('uint64 GetTickCount64()'),
  OpenProcess: kernel32Lib.func('HWND *OpenProcess(uint32 access, bool inherit, uint32 pid)'),
  CloseHandle: kernel32Lib.func('bool CloseHandle(HWND *h)'),
  K32GetProcessImageFileNameW: kernel32Lib.func(
    'uint32 K32GetProcessImageFileNameW(HWND *h, uint16 *buf, uint32 max)',
  ),
  QueryDosDeviceW: kernel32Lib.func('uint32 QueryDosDeviceW(uint16 *name, uint16 *buf, uint32 max)'),
  GetLogicalDrives: kernel32Lib.func('uint32 GetLogicalDrives()'),
};

/* ── 高层封装 ─────────────────────────────────────────────── */

/** 读窗口标题（UTF-16 → JS string） */
export function readWindowTitle(hwnd: KHandle): string {
  const len = user32.GetWindowTextLengthW(hwnd);
  if (len <= 0) return '';
  const buf = new Uint16Array(len + 1);
  user32.GetWindowTextW(hwnd, buf, len + 1);
  return Buffer.from(buf.buffer).toString('utf16le').replace(/\0.*$/, '');
}

/** 读窗口 PID */
export function readWindowPid(hwnd: KHandle): number {
  const pidOut = [0];
  user32.GetWindowThreadProcessId(hwnd, pidOut);
  return pidOut[0] ?? 0;
}

/** 读窗口矩形 */
export function readWindowRect(hwnd: KHandle): { left: number; top: number; right: number; bottom: number } | null {
  const mem = koffi.alloc(RECT, 1);
  if (!user32.GetWindowRect(hwnd, mem)) return null;
  return koffi.decode(mem, 0, RECT);
}

/** 读窗口是否位于指定显示器（MONITOR_DEFAULTTONEAREST = 2） */
export const MONITOR_DEFAULTTONEAREST = 2;

/** 读显示器信息（工作区矩形） */
export function readMonitorInfo(hmon: KHandle): { rcWork: RECT_VALUE; rcMonitor: RECT_VALUE; primary: boolean } | null {
  const mem = koffi.alloc(MONITORINFO, 1);
  koffi.encode(mem, 0, MONITORINFO, {
    cbSize: koffi.sizeof(MONITORINFO),
    rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
    rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
    dwFlags: 0,
  });
  if (!user32.GetMonitorInfoW(hmon, mem)) return null;
  const info = koffi.decode(mem, 0, MONITORINFO);
  return {
    rcMonitor: info.rcMonitor,
    rcWork: info.rcWork,
    primary: (info.dwFlags & 1) !== 0, // MONITORINFOF_PRIMARY
  };
}

export interface RECT_VALUE { left: number; top: number; right: number; bottom: number }

/* ── 进程映像路径（NT 设备路径 → 盘符路径） ───────────────── */

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
let driveMapCache: Array<[string, string]> | null = null;

/** PID → exe 完整路径；失败返回 '' */
export function readProcessImageName(pid: number): string {
  if (!pid) return '';
  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return '';
  try {
    const buf = new Uint16Array(1024);
    kernel32.K32GetProcessImageFileNameW(handle, buf, 1024);
    const ntPath = Buffer.from(buf.buffer).toString('utf16le').replace(/\0.*$/, '');
    return ntDeviceToDrive(ntPath);
  } finally {
    kernel32.CloseHandle(handle);
  }
}

/** \Device\HarddiskVolume3\... → E:\...（盘符映射缓存进程内一次） */
export function ntDeviceToDrive(ntPath: string): string {
  if (!ntPath.startsWith('\\Device\\')) return ntPath;
  if (!driveMapCache) buildDriveMap();
  for (const [device, drive] of driveMapCache ?? []) {
    if (ntPath.startsWith(device)) return drive + ntPath.slice(device.length);
  }
  return ntPath;
}

function buildDriveMap(): void {
  driveMapCache = [];
  const drives = kernel32.GetLogicalDrives();
  const nameBuf = new Uint16Array(4);
  const buf = new Uint16Array(1024);
  for (let i = 0; i < 26; i++) {
    if (!(drives & (1 << i))) continue;
    const letter = String.fromCharCode(65 + i);
    Buffer.from(`${letter}:`, 'utf16le').copy(Buffer.from(nameBuf.buffer));
    nameBuf[2] = 0;
    kernel32.QueryDosDeviceW(nameBuf, buf, 1024);
    const device = Buffer.from(buf.buffer).toString('utf16le').replace(/\0.*$/, '');
    if (device) driveMapCache.push([device, `${letter}:`]);
  }
}

/** 从路径提取进程名（code.exe） */
export function exeNameOf(path: string): string {
  const i = path.lastIndexOf('\\');
  return i >= 0 ? path.slice(i + 1) : path;
}
