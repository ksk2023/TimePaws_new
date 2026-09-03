/**
 * 任务专注积累器（M3）
 *
 * 规则：有 doing 任务时，主进程每分钟把「该分钟内主屏计入的前台时长」累计到任务的 focus_ms。
 * 实现：订阅 tracker 会话结束事件，把 counted 会话的时长累加进内存桶，每 60s 冲刷一次入库。
 * 轻量、无定时器漂移问题；应用退出时冲刷兜底。
 */
import { onSessionEnded } from './tracker';
import { addFocusMs } from './db';

let bucketMs = 0;
let flushTimer: NodeJS.Timeout | null = null;
let subscribed = false;

function flush(): void {
  if (bucketMs <= 0) return;
  const ms = bucketMs;
  bucketMs = 0;
  try {
    addFocusMs(ms);
  } catch (err) {
    console.error('[task-focus] flush failed:', err);
  }
}

export function startTaskFocusAccumulator(): void {
  if (subscribed) return;
  subscribed = true;
  onSessionEnded((s) => {
    if (s.counted) bucketMs += s.durationMs;
  });
  // 60s 冲刷一次（不必精准对齐分钟，任务专注本来就是近似量级）
  flushTimer = setInterval(flush, 60_000);
}

export function stopTaskFocusAccumulator(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  flush(); // 退出兜底
  subscribed = false;
}
