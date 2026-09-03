/**
 * 任务箱（M3）：任务 CRUD + 设定当前任务（doing，全局至多一个）+ 专注时长展示。
 * 多窗口同步：订阅 anchor:tasks:changed 广播。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskInfo } from '@/lib/api';

function fmtFocus(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '';
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

const STATUS_LABEL: Record<TaskInfo['status'], string> = {
  doing: '当前',
  todo: '待办',
  done: '已完成',
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    window.anchor.tasksList(true).then(setTasks).catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    window.anchor.onTasksChanged(refresh);
  }, [refresh]);

  const submitDraft = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    setAdding(true);
    try {
      await window.anchor.tasksCreate(text);
      setDraft('');
    } finally {
      setAdding(false);
      inputRef.current?.focus();
    }
  };

  const saveEdit = async (id: number): Promise<void> => {
    const text = editDraft.trim();
    if (text) await window.anchor.tasksUpdateText(id, text);
    setEditingId(null);
  };

  if (failed) {
    return (
      <section className="max-w-xl" aria-label="任务箱">
        <h1 className="text-xl font-semibold mb-6">任务箱</h1>
        <div className="rounded-xl2 bg-ink-800 p-5 text-mist-dim">
          数据读取失败。<button className="underline hover:text-mist" onClick={refresh}>重试</button>
        </div>
      </section>
    );
  }

  const list = tasks ?? [];

  return (
    <section className="max-w-xl" aria-label="任务箱">
      <h1 className="text-xl font-semibold mb-1">任务箱</h1>
      <p className="text-sm text-mist-faint mb-6">一次只做一件事。把最重要的设为「当前」，专注时长会自动累计。</p>

      {/* 新增输入框 */}
      <div className="flex gap-2 mb-5">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submitDraft(); }}
          placeholder="写一件最小的事，比如：回一封邮件"
          maxLength={200}
          className="flex-1 rounded-xl2 bg-ink-800 border border-ink-600 px-4 py-2.5 text-base2 text-mist placeholder:text-mist-faint focus:outline-none focus:border-calm"
        />
        <button
          onClick={() => void submitDraft()}
          disabled={!draft.trim() || adding}
          className="rounded-xl2 bg-calm/80 hover:bg-calm disabled:opacity-40 disabled:hover:bg-calm/80 px-4 py-2.5 text-sm font-medium text-ink-900 transition-colors"
        >
          添加
        </button>
      </div>

      {/* 任务列表 */}
      {list.length === 0 ? (
        <div className="rounded-xl2 bg-ink-800 p-6 text-center">
          <p className="text-mist-dim">还没有任务</p>
          <p className="text-sm text-mist-faint mt-1">从最小的一步开始写下来。</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((t) => {
            const isEditing = editingId === t.id;
            return (
              <li
                key={t.id}
                className={`rounded-xl2 border px-4 py-3 transition-colors ${
                  t.status === 'doing'
                    ? 'bg-ink-700 border-calm/60'
                    : 'bg-ink-800 border-transparent hover:border-ink-600'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* 状态点 / 完成勾选 */}
                  {t.status === 'done' ? (
                    <button
                      onClick={() => void window.anchor.tasksReopen(t.id)}
                      title="恢复为待办"
                      className="w-5 h-5 shrink-0 rounded-full bg-calm/70 text-ink-900 text-xs flex items-center justify-center"
                      aria-label={`恢复任务：${t.text}`}
                    >
                      ✓
                    </button>
                  ) : (
                    <button
                      onClick={() => void window.anchor.tasksComplete(t.id)}
                      title="标记完成"
                      className="w-5 h-5 shrink-0 rounded-full border border-mist-faint hover:border-calm hover:bg-calm/20 transition-colors"
                      aria-label={`完成任务：${t.text}`}
                    />
                  )}

                  {/* 文本（点击进入编辑） */}
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onBlur={() => void saveEdit(t.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit(t.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="w-full bg-transparent text-base2 text-mist focus:outline-none border-b border-calm"
                      />
                    ) : (
                      <button
                        onClick={() => { setEditingId(t.id); setEditDraft(t.text); }}
                        className={`block w-full text-left text-base2 truncate ${t.status === 'done' ? 'text-mist-faint line-through' : 'text-mist'}`}
                        title="点击编辑"
                      >
                        {t.text}
                      </button>
                    )}
                  </div>

                  {/* 专注时长 */}
                  {t.focus_ms >= 60_000 && (
                    <span className="shrink-0 text-xs text-calm" title="累计专注（主屏计入）">
                      ⏱ {fmtFocus(t.focus_ms)}
                    </span>
                  )}

                  {/* 状态徽标 */}
                  <span
                    className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                      t.status === 'doing' ? 'bg-calm/20 text-calm' : 'text-mist-faint'
                    }`}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>

                  {/* 操作：设为当前 / 删除 */}
                  {t.status !== 'doing' && t.status !== 'done' && (
                    <button
                      onClick={() => void window.anchor.tasksSetCurrent(t.id)}
                      className="shrink-0 text-xs text-mist-faint hover:text-calm"
                      title="设为当前任务"
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    onClick={() => void window.anchor.tasksDelete(t.id)}
                    className="shrink-0 text-xs text-mist-faint hover:text-red-400"
                    aria-label={`删除任务：${t.text}`}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
