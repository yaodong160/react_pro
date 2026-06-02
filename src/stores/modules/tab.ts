import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

interface InitialStateType {
  activeFirstLevelMenuKey: string;
  activeTabId: string;
  removeCacheKey: any | null;
  tabs: App.Global.Tab[];
}

const initialState: InitialStateType = {
  /** - 当前一级菜单 */
  activeFirstLevelMenuKey: '',
  /** - 当前标签页 */
  activeTabId: '',
  /** - 需要删除的缓存页面 */
  removeCacheKey: null,
  /** - 标签页 */
  tabs: []
};

export const tabSlice = createSlice({
  initialState,
  name: 'tab',
  reducers: {
    addTab: (state, { payload }: PayloadAction<App.Global.Tab>) => {
      const { fixedIndex, id } = payload;

      // 防止添加重复 id 的 tab
      const existingIndex = state.tabs.findIndex(tab => tab.id === id);
      if (existingIndex !== -1) {
        state.tabs[existingIndex] = payload;
        return;
      }

      if (fixedIndex || fixedIndex === 0) {
        state.tabs.splice(fixedIndex, 0, payload);
      } else {
        state.tabs = [...state.tabs, payload];
      }
    },
    changeTabLabel(state, { payload }: PayloadAction<{ index: number; label?: string }>) {
      const { index, label } = payload;

      if (label) {
        state.tabs[index].i18nKey = label;
      } else {
        state.tabs[index].i18nKey = state.tabs[index].oldLabel;
      }
    },
    setActiveFirstLevelMenuKey: (state, action: PayloadAction<string>) => {
      state.activeFirstLevelMenuKey = action.payload;
    },
    setActiveTabId: (state, action: PayloadAction<string>) => {
      state.activeTabId = action.payload;
    },
    setTabs: (state, action: PayloadAction<App.Global.Tab[]>) => {
      // 去除重复 id 的 tab，防止 localStorage 中的脏数据导致 React key 冲突
      const seen = new Set<string>();
      state.tabs = action.payload.filter(tab => {
        if (seen.has(tab.id)) {
          return false;
        }
        seen.add(tab.id);
        return true;
      });
    },
    updateTab: (state, { payload }: PayloadAction<{ index: number; tab: App.Global.Tab }>) => {
      const { index, tab } = payload;

      state.tabs[index] = tab;
    }
  },
  selectors: {
    selectActiveFirstLevelMenuKey: tab => tab.activeFirstLevelMenuKey,
    selectActiveTabId: tab => tab.activeTabId,
    selectTabs: tab => tab.tabs
  }
});

export const { addTab, changeTabLabel, setActiveFirstLevelMenuKey, setActiveTabId, setTabs, updateTab } =
  tabSlice.actions;

export const { selectActiveFirstLevelMenuKey, selectActiveTabId, selectTabs } = tabSlice.selectors;
