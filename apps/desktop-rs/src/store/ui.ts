/**
 * 全局 store（Zustand）。
 * M0：只有 UI 状态。M2/M3 追加统计与任务 slice。
 */
import { create } from 'zustand';

interface UiState {
  widgetCollapsed: boolean;
  setWidgetCollapsed: (v: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  widgetCollapsed: false,
  setWidgetCollapsed: (v) => set({ widgetCollapsed: v }),
}));
