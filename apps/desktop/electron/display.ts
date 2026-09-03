/**
 * 主显示器判定。
 *
 * 口径（与需求一致）：
 * - focused_on_primary：窗口中心落在主显示器工作区内
 * - visible_on_primary：窗口矩形与主显示器工作区相交
 * 副屏上的窗口不产生 focused_on_primary 计时。
 */
import { user32, MONITOR_DEFAULTTONEAREST, readMonitorInfo, RECT, KHandle } from './win32';
import koffi from 'koffi';

export interface WinRect { left: number; top: number; right: number; bottom: number }

/** 取窗口所在显示器信息（按最近显示器）；失败返回 null */
export function monitorOfWindow(hwnd: KHandle) {
  const hmon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!hmon) return null;
  return readMonitorInfo(hmon);
}

/** 主显示器工作区（用 Electron screen 也可，但这里保持 Win32 单一来源） */
let cachedPrimaryWork: WinRect | null = null;
let primaryCacheAt = 0;

export function primaryWorkArea(): WinRect | null {
  // 缓存 5 秒，避免每秒轮询都走 GetMonitorInfo
  if (cachedPrimaryWork && Date.now() - primaryCacheAt < 5000) return cachedPrimaryWork;
  const hwndShell = user32.GetShellWindow();
  if (!hwndShell) return cachedPrimaryWork;
  const mon = monitorOfWindow(hwndShell);
  if (!mon) return cachedPrimaryWork;
  if (mon.primary) {
    cachedPrimaryWork = mon.rcWork;
    primaryCacheAt = Date.now();
  }
  return cachedPrimaryWork;
}

/** 窗口中心是否在主屏工作区内（focused_on_primary 判定） */
export function isFocusedOnPrimary(hwnd: KHandle): boolean {
  const rect = rectOf(hwnd);
  if (!rect) return false;
  const wa = primaryWorkArea();
  if (!wa) return false;
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  return cx >= wa.left && cx <= wa.right && cy >= wa.top && cy <= wa.bottom;
}

/** 窗口矩形是否与主屏工作区相交（visible_on_primary 判定） */
export function isVisibleOnPrimary(hwnd: KHandle): boolean {
  const rect = rectOf(hwnd);
  if (!rect) return false;
  const wa = primaryWorkArea();
  if (!wa) return false;
  return (
    rect.left < wa.right &&
    wa.left < rect.right &&
    rect.top < wa.bottom &&
    wa.top < rect.bottom
  );
}

function rectOf(hwnd: KHandle): WinRect | null {
  const mem = koffi.alloc(RECT, 1);
  if (!user32.GetWindowRect(hwnd, mem)) return null;
  return koffi.decode(mem, 0, RECT);
}

/** 主屏变化后清缓存（display-metrics-changed 时调用） */
export function invalidatePrimaryCache(): void {
  cachedPrimaryWork = null;
  primaryCacheAt = 0;
}

/**
 * 监听显示器变化（热插拔/改主屏/改分辨率）：
 * 清 Win32 主屏缓存 + 把小组件拉回主屏可视区。
 * （M0 的 widget.repositionWidgetIntoPrimary 在这里接线）
 */
export function registerDisplayWatch(): void {
  // 延迟 import 避免 widget↔display 循环依赖
  const { screen } = require('electron') as typeof import('electron');
  const reposition = (): void => {
    invalidatePrimaryCache();
    // widget.ts 的函数在此处动态 require，保持模块边界
    try {
      const w = require('./widget') as { repositionWidgetIntoPrimary: () => void };
      w.repositionWidgetIntoPrimary();
    } catch {
      // widget 未就绪时忽略
    }
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-removed', reposition);
}
