/**
 * 空闲检测：GetLastInputInfo。
 * - idleMs()：自最后一次键鼠输入以来的毫秒数（GetTickCount64 不回绕，稳）
 * - 不单独开定时器：tracker 的 1Hz 轮询顺带调用，CPU 零开销
 */
import koffi from 'koffi';
import { user32Lib, kernel32Lib, LASTINPUTINFO } from './win32';

const lastInputMem = koffi.alloc(LASTINPUTINFO, 1);
const getLastInputInfo = user32Lib.func('bool GetLastInputInfo(LastInputInfoPtr info)');
const getTickCount64 = kernel32Lib.func('uint64 GetTickCount64()');

/** 当前空闲毫秒数；调用失败返回 0（宁可多记不漏记） */
export function idleMs(): number {
  try {
    koffi.encode(lastInputMem, 0, LASTINPUTINFO, { cbSize: 8, dwTime: 0 });
    if (!getLastInputInfo(lastInputMem)) return 0;
    const { dwTime } = koffi.decode(lastInputMem, 0, LASTINPUTINFO);
    return Math.max(0, getTickCount64() - dwTime);
  } catch {
    return 0;
  }
}
