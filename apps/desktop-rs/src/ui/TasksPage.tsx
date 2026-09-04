/**
 * 任务箱（M3）：任务 CRUD + 设定当前任务（doing，全局至多一个）+ 专注时长展示。
 * 多窗口同步：订阅 timepaws:tasks:changed 广播。
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
    window.timepaws.tasksList(true).then(setTasks).catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    window.timepaws.onTasksChanged(refresh);
  }, [refresh]);

  const submitDraft = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    setAdding(true);
    try {
      await window.timepaws.tasksCreate(text);
      setDraft('');
    } finally {
      setAdding(false);
      inputRef.current?.focus();
    }
  };

  const saveEdit = async (id: number): Promise<void> => {
    const text = editDraft.trim();
    if (text) await window.timepaws.tasksUpdateText(id, text);
    setEditingId(null);
  };

  if (failed) {
    return (
      <section className="max-w-xl" aria-label="任务箱">
        <h1 className="text-xl font-semibold mb-6">任务箱</h1>
        <div className="rounded-xl2 bg-surface shadow-card p-5 text-ink-dim">
          数据读取失败。<button className="underline hover:text-ink" onClick={refresh}>重试</button>
        </div>
      </section>
    );
  }

  const list = tasks ?? [];

  return (
    <section className="max-w-xl" aria-label="任务箱">
      <h1 className="text-xl font-semibold mb-1">任务箱</h1>
      <p className="text-sm text-ink-dim mb-6">一次只做一件事。把最重要的设为「当前」，专注时长会自动累计。</p>

      {/* 新增输入框 */}
      <div className="flex gap-2 mb-5">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submitDraft(); }}
          placeholder="写一件最小的事，比如：回一封邮件"
          maxLength={200}
          className="flex-1 rounded-xl2 bg-surface shadow-card border border-line px-4 py-2.5 text-base2 text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
        />
        <button
          onClick={() => void submitDraft()}
          disabled={!draft.trim() || adding}
          className="rounded-xl2 bg-accent/80 hover:bg-accent disabled:opacity-40 disabled:hover:bg-accent/80 px-4 py-2.5 text-sm font-medium text-white transition-colors"
        >
          添加
        </button>
      </div>

      {/* 任务列表 */}
      {list.length === 0 ? (
        <div className="rounded-xl2 bg-surface shadow-card p-6 text-center">
          <p className="text-ink-dim">还没有任务</p>
          <p className="text-sm text-ink-faint mt-1">从最小的一步开始写下来。</p>
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
                    ? 'bg-surface-2 border-accent/60'
                    : 'bg-surface border-transparent hover:border-line'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* 状态点 / 完成勾选 */}
                  {t.status === 'done' ? (
                    <button
                      onClick={() => void window.timepaws.tasksReopen(t.id)}
                      title="恢复为待办"
                      className="w-5 h-5 shrink-0 rounded-full bg-accent/70 text-white text-xs flex items-center justify-center"
                      aria-label={`恢复任务：${t.text}`}
                    >
                      ✓
                    </button>
                  ) : (
                    <button
                      onClick={() => void window.timepaws.tasksComplete(t.id)}
                      title="标记完成"
                      className="w-5 h-5 shrink-0 rounded-full border border-ink-faint hover:border-accent hover:bg-accent/20 transition-colors"
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
                        className="w-full bg-transparent text-base2 text-ink focus:outline-none border-b border-accent"
                      />
                    ) : (
                      <button
                        onClick={() => { setEditingId(t.id); setEditDraft(t.text); }}
                        className={`block w-full text-left text-base2 truncate ${t.status === 'done' ? 'text-ink-faint line-through' : 'text-ink'}`}
                        title="点击编辑"
                      >
                        {t.text}
                      </button>
                    )}
                  </div>

                  {/* 专注时长 */}
                  {t.focus_ms >= 60_000 && (
                    <span className="shrink-0 text-xs text-accent" title="累计专注（主屏计入）">
                      ⏱ {fmtFocus(t.focus_ms)}
                    </span>
                  )}

                  {/* 状态徽标 */}
                  <span
                    className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                      t.status === 'doing' ? 'bg-accent/20 text-accent' : 'text-ink-faint'
                    }`}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>

                  {/* 操作：设为当前 / 删除 */}
                  {t.status !== 'doing' && t.status !== 'done' && (
                    <button
                      onClick={() => void window.timepaws.tasksSetCurrent(t.id)}
                      className="shrink-0 text-xs text-ink-faint hover:text-accent"
                      title="设为当前任务"
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    onClick={() => void window.timepaws.tasksDelete(t.id)}
                    className="shrink-0 text-xs text-ink-faint hover:text-red-600"
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
