// 按 PRD §3.4 D 与 §4.7：dyx:settings 默认值与读写
// M3：新增 exportFields（导出字段配置，默认 13 项全选）

import type { FileNameFormat } from './filename.js';
import { ALL_EXPORT_KEYS } from './fields.js';

export interface DyxSettings {
  fileNameFormat: FileNameFormat;
  concurrency: number; // 1-10，M1 预留
  retry: number; // 0-3
  requestInterval: number; // 0-2000ms
  exportFields: string[]; // M3：导出字段 key 列表，默认全选
}

export const DEFAULT_SETTINGS: DyxSettings = {
  fileNameFormat: 'date_title',
  concurrency: 4,
  retry: 1,
  requestInterval: 300,
  exportFields: [...ALL_EXPORT_KEYS],
};

const STORAGE_KEY = 'dyx:settings';

export async function loadSettings(): Promise<DyxSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const saved = result[STORAGE_KEY] as Partial<DyxSettings> | undefined;
      resolve({ ...DEFAULT_SETTINGS, ...(saved || {}) });
    });
  });
}

export async function saveSettings(patch: Partial<DyxSettings>): Promise<DyxSettings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: next }, () => resolve(next));
  });
}
