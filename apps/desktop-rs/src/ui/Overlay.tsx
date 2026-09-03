/**
 * 浮层提醒页（#/overlay，M4）。
 * 320x148 无边框小卡：标题 + 正文 + 「稍后提醒 / 知道了」。
 * 主进程 showInactive 显示，不抢焦点；25s 无操作自动隐藏。
 */
import { useEffect, useState } from 'react';
import type { TimepawsApi } from '@/lib/api';

interface Payload { kind: string; title: string; body: string }

export default function Overlay() {
  const [p, setP] = useState<Payload | null>(null);
  const tp = window.timepaws as TimepawsApi;

  useEffect(() => {
    tp.onOverlayPayload(setP);
  }, [tp]);

  // 无 payload 时透明静默（窗口隐藏态预加载）
  if (!p) return <div className="h-full bg-surface/95 rounded-xl2" />;

  return (
    <div className="h-full flex flex-col bg-surface/95 rounded-xl2 border border-line shadow-lg overflow-hidden">
      {/* 标题 */}
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="w-2 h-2 rounded-full bg-accent shrink-0" aria-hidden />
        <span className="text-sm font-medium text-ink">{p.title}</span>
      </div>

      {/* 正文 */}
      <div className="flex-1 px-3.5 py-2 min-h-0 overflow-hidden">
        <p className="text-sm text-ink-dim leading-relaxed line-clamp-3">{p.body}</p>
      </div>

      {/* 操作 */}
      <div className="flex items-center gap-2 px-3.5 pb-3">
        <button
          onClick={() => { setP(null); tp.overlaySnooze(); }}
          className="flex-1 rounded-lg bg-surface-2 hover:bg-surface-2/70 py-1.5 text-sm text-ink-dim transition-colors"
        >
          稍后提醒
        </button>
        <button
          onClick={() => { setP(null); tp.overlayDismiss(); }}
          className="flex-1 rounded-lg bg-accent/80 hover:bg-accent py-1.5 text-sm font-medium text-white transition-colors"
        >
          知道了
        </button>
      </div>
    </div>
  );
}
