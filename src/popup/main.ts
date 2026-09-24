// popup 入口：三 tab，M2 列表 tab 可用（显示列表数量 + 封面缩略图 + 打开批量页 + 清空）
// M3：导出 tab（字段勾选 + 复制/导出 CSV）

import { loadSettings, saveSettings } from '../shared/settings.js';
import { renderFilename, type FileNameFormat } from '../shared/filename.js';
import { DYX_GET_LIST, DYX_OPEN_BATCH, DYX_OPEN_SOUND, DYX_CLEAR_LIST } from '../shared/protocol.js';
import {
  EXPORT_FIELDS,
  ALL_EXPORT_KEYS,
  generateTsv,
  generateCsv,
  buildExportFilename,
} from '../shared/fields.js';
import type { VideoItem } from '../shared/types.js';
import { applyVersionLabel } from '../shared/version.js';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`元素未找到: ${sel}`);
  return el;
};

// 向 SW 发消息
function sendMsg<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp as T);
    });
  });
}

// Tab 切换
function initTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.dyx-tab');
  const panels = document.querySelectorAll<HTMLElement>('.dyx-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('dyx-tab--active'));
      panels.forEach((p) => {
        p.hidden = true;
        p.classList.remove('dyx-panel--active');
      });
      tab.classList.add('dyx-tab--active');
      const target = tab.dataset.tab || '';
      const panel = document.querySelector<HTMLElement>(`.dyx-panel[data-panel="${target}"]`);
      if (panel) {
        panel.hidden = false;
        panel.classList.add('dyx-panel--active');
      }
      // 切换到列表/导出 tab 时刷新数据
      if (target === 'list') loadListSummary();
      if (target === 'export') loadExportTab();
    });
  });
}

// 预览文件名
function previewFilename(format: FileNameFormat): string {
  const sample = {
    vid: '7412345678901234567',
    title: '这个视频太有意思了',
    name: '创作者名',
    date: '2026-09-10',
  };
  return renderFilename(sample, format) + '.mp4';
}

// 设置 tab
function initSettings(): void {
  const formatSel = $<HTMLSelectElement>('#dyx-format');
  const intervalInput = $<HTMLInputElement>('#dyx-interval');
  const concurrencyInput = $<HTMLInputElement>('#dyx-concurrency');
  const retryInput = $<HTMLInputElement>('#dyx-retry');
  const previewEl = $('#dyx-preview');
  const saveBtn = $<HTMLButtonElement>('#dyx-save');

  // 加载当前设置
  loadSettings().then((settings) => {
    formatSel.value = settings.fileNameFormat;
    intervalInput.value = String(settings.requestInterval);
    concurrencyInput.value = String(settings.concurrency);
    retryInput.value = String(settings.retry);
    previewEl.textContent = previewFilename(settings.fileNameFormat);
  });

  // 模板变更 → 实时预览
  formatSel.addEventListener('change', () => {
    previewEl.textContent = previewFilename(formatSel.value as FileNameFormat);
  });

  // 保存
  saveBtn.addEventListener('click', async () => {
    const format = formatSel.value as FileNameFormat;
    const interval = Math.max(0, Math.min(2000, parseInt(intervalInput.value, 10) || 0));
    const concurrency = Math.max(1, Math.min(10, parseInt(concurrencyInput.value, 10) || 4));
    const retry = Math.max(0, Math.min(3, parseInt(retryInput.value, 10) || 0));
    await saveSettings({ fileNameFormat: format, requestInterval: interval, concurrency, retry });
    saveBtn.textContent = '已保存 ✓';
    setTimeout(() => {
      saveBtn.textContent = '保存设置';
    }, 1500);
  });
}

// 列表 tab：加载列表摘要
async function loadListSummary(): Promise<void> {
  const countEl = $<HTMLParagraphElement>('#dyx-list-count');
  const thumbsEl = $<HTMLDivElement>('#dyx-list-thumbs');
  const clearBtn = $<HTMLButtonElement>('#dyx-clear-batch');

  try {
    const list = await sendMsg<Record<string, VideoItem>>({ type: DYX_GET_LIST, list: 'batch' });
    const items = Object.values(list);
    countEl.textContent = `批量列表：${items.length} 条`;

    // 显示最多 4 张封面缩略图
    thumbsEl.textContent = '';
    const recent = items
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 4);
    for (const item of recent) {
      if (item.cover) {
        const img = document.createElement('img');
        img.className = 'dyx-thumb';
        img.src = item.cover;
        img.alt = item.title || '';
        img.loading = 'lazy';
        img.onerror = () => { img.style.display = 'none'; }; // 第三轮修复 #9：加载失败时隐藏占位
        thumbsEl.appendChild(img);
      }
    }

    // 清空按钮状态
    clearBtn.disabled = items.length === 0;
  } catch {
    countEl.textContent = '批量列表：0 条';
    thumbsEl.textContent = '';
    clearBtn.disabled = true;
  }
}

// 列表 tab 操作
function initListTab(): void {
  const openBtn = $<HTMLButtonElement>('#dyx-open-batch');
  const soundBtn = $<HTMLButtonElement>('#dyx-open-sound');
  const clearBtn = $<HTMLButtonElement>('#dyx-clear-batch');

  // 打开批量页
  openBtn.addEventListener('click', async () => {
    await sendMsg({ type: DYX_OPEN_BATCH });
    window.close();
  });

  // M4：打开原声采集页
  soundBtn.addEventListener('click', async () => {
    await sendMsg({ type: DYX_OPEN_SOUND });
    window.close();
  });

  // 清空（二次确认）
  clearBtn.addEventListener('click', async () => {
    const confirmed = confirm('确认清空全部批量列表？');
    if (!confirmed) return;
    await sendMsg({ type: DYX_CLEAR_LIST, list: 'batch' });
    await loadListSummary();
  });

  // 初始加载
  loadListSummary();
}

// ============================================================
// M3：导出 tab
// ============================================================

// 渲染字段勾选列表
function renderExportFieldCheckboxes(selectedKeys: string[]): void {
  const container = $<HTMLDivElement>('#dyx-export-fields');
  container.textContent = '';
  const selectedSet = new Set(selectedKeys);

  for (const field of EXPORT_FIELDS) {
    const label = document.createElement('label');
    label.className = 'dyx-export-field-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = field.key;
    checkbox.checked = selectedSet.has(field.key);
    checkbox.className = 'dyx-export-field-cb';
    checkbox.addEventListener('change', () => {
      saveCurrentExportFields();
    });

    const span = document.createElement('span');
    span.textContent = field.header;

    label.appendChild(checkbox);
    label.appendChild(span);
    container.appendChild(label);
  }
}

// 读取当前勾选状态并持久化
async function saveCurrentExportFields(): Promise<void> {
  const checkboxes = document.querySelectorAll<HTMLInputElement>('.dyx-export-field-cb');
  const selected: string[] = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) selected.push(cb.value);
  });
  await saveSettings({ exportFields: selected });
}

// 加载导出 tab
async function loadExportTab(): Promise<void> {
  const countEl = $<HTMLParagraphElement>('#dyx-export-count');

  // 加载 searchList 计数
  try {
    const list = await sendMsg<Record<string, VideoItem>>({ type: DYX_GET_LIST, list: 'search' });
    const count = Object.keys(list).length;
    countEl.textContent = `当前搜索页已选 ${count} 条`;
  } catch {
    countEl.textContent = '当前搜索页已选 0 条';
  }

  // 加载字段勾选
  const settings = await loadSettings();
  renderExportFieldCheckboxes(settings.exportFields);
}

// 导出 tab 初始化
function initExportTab(): void {
  const defaultsBtn = $<HTMLButtonElement>('#dyx-export-defaults');
  const copyBtn = $<HTMLButtonElement>('#dyx-export-copy');
  const csvBtn = $<HTMLButtonElement>('#dyx-export-csv');

  // 恢复默认
  defaultsBtn.addEventListener('click', async () => {
    await saveSettings({ exportFields: [...ALL_EXPORT_KEYS] });
    renderExportFieldCheckboxes(ALL_EXPORT_KEYS);
    defaultsBtn.textContent = '已恢复 ✓';
    setTimeout(() => { defaultsBtn.textContent = '恢复默认'; }, 1500);
  });

  // 复制 TSV（复核修复 #4：加 execCommand 兜底）
  copyBtn.addEventListener('click', async () => {
    try {
      const list = await sendMsg<Record<string, VideoItem>>({ type: DYX_GET_LIST, list: 'search' });
      const items = Object.values(list);
      if (items.length === 0) { alert('暂无已选内容'); return; }
      const settings = await loadSettings();
      const tsv = generateTsv(items, settings.exportFields);
      // 第三轮修复 #6：条目非空但生成结果为空（未勾选任何字段）时提示
      if (!tsv) { alert('请至少勾选一个导出字段'); return; }
      try {
        await navigator.clipboard.writeText(tsv);
      } catch {
        // 兜底：textarea + execCommand（popup 失焦/无权限时）
        const ta = document.createElement('textarea');
        ta.value = tsv;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        // 第三轮修复 #16：execCommand 返回值检查
        const execOk = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!execOk) {
          alert('复制失败，请手动复制');
          return;
        }
      }
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    } catch {
      alert('复制失败，请手动复制');
    }
  });

  // 导出 CSV
  csvBtn.addEventListener('click', async () => {
    try {
      const list = await sendMsg<Record<string, VideoItem>>({ type: DYX_GET_LIST, list: 'search' });
      const items = Object.values(list);
      if (items.length === 0) { alert('暂无已选内容'); return; }
      const settings = await loadSettings();
      const csv = generateCsv(items, settings.exportFields);
      // 第三轮修复 #6：条目非空但生成结果为空（未勾选任何字段）时提示
      if (!csv || csv === '\uFEFF') { alert('请至少勾选一个导出字段'); return; }
      const filename = buildExportFilename();
      // popup 中通过 chrome.downloads 或 blob URL 下载
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      csvBtn.textContent = '已导出 ✓';
      setTimeout(() => { csvBtn.textContent = '导出 CSV'; }, 1500);
    } catch {
      alert('导出失败');
    }
  });

  // 初始加载
  loadExportTab();
}

// 启动
applyVersionLabel('.dyx-version');
initTabs();
initSettings();
initListTab();
initExportTab();
