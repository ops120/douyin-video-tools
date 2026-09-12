// 批量页入口（按 PRD §3.2 FR-B2/B3/B4/B5/B6）
// 卡片网格、选择/删除/清空/排序、ZIP 下载、保存到文件夹、失效链接刷新

import JSZip from 'jszip';
import type { VideoItem } from '../shared/types.js';
import {
  DYX_ADD_ITEMS,
  DYX_GET_LIST,
  DYX_REMOVE_ITEMS,
  DYX_CLEAR_LIST,
  DYX_RESOLVE_ITEMS,
} from '../shared/protocol.js';
import { loadSettings } from '../shared/settings.js';
import { renderFilename } from '../shared/filename.js';
import { errorMessage, classifySaveError } from '../shared/errors.js';
import { runQueue } from '../shared/queue.js';
import { buildZipFilename, buildUniqueFilename } from '../shared/zip.js';

// DOM 便捷函数
function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`元素未找到: ${sel}`);
  return el;
}

// 全局状态
let listMap: Record<string, VideoItem> = {};
let selectedVids = new Set<string>();
let sortKey: 'addedAt' | 'digg' | 'duration' = 'addedAt';
let isDownloading = false;

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

// 格式化数字（大数简写）
function fmtNum(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

// 格式化时长（ms → mm:ss）
function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// 获取排序后的列表
function getSortedItems(): VideoItem[] {
  const items = Object.values(listMap);
  items.sort((a, b) => {
    if (sortKey === 'addedAt') return (b.addedAt || 0) - (a.addedAt || 0);
    if (sortKey === 'digg') return (b.statistics?.digg || 0) - (a.statistics?.digg || 0);
    if (sortKey === 'duration') return (b.duration || 0) - (a.duration || 0);
    return 0;
  });
  return items;
}

// ============ 渲染 ============

function updateCounts(): void {
  const total = Object.keys(listMap).length;
  const selected = selectedVids.size;
  $<HTMLSpanElement>('#dyx-total-count').textContent = `共 ${total} 个`;
  $<HTMLSpanElement>('#dyx-selected-count').textContent = `选中 ${selected} 个`;
}

function renderGrid(): void {
  const grid = $<HTMLDivElement>('#dyx-grid');
  const emptyEl = $<HTMLDivElement>('#dyx-empty');
  const items = getSortedItems();

  if (items.length === 0) {
    grid.hidden = true;
    emptyEl.hidden = false;
    updateCounts();
    return;
  }

  emptyEl.hidden = true;
  grid.hidden = false;

  // 清空重建（列表规模 <200 时足够流畅，PRD §3.2 验收）
  grid.textContent = '';

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'dyx-card';
    card.setAttribute('data-vid', item.vid);
    if (selectedVids.has(item.vid)) card.classList.add('dyx-card--selected');
    if (item.status === 'stale') card.classList.add('dyx-card--stale');

    // 复选框
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'dyx-card-checkbox';
    cb.checked = selectedVids.has(item.vid);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedVids.add(item.vid);
      else selectedVids.delete(item.vid);
      card.classList.toggle('dyx-card--selected', cb.checked);
      updateCounts();
    });
    card.appendChild(cb);

    // 封面
    const coverDiv = document.createElement('div');
    coverDiv.className = 'dyx-card-cover';
    if (item.cover) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = item.title || '';
      img.src = item.cover;
      img.onerror = () => { img.style.display = 'none'; }; // 第三轮修复 #9：封面加载失败时隐藏
      coverDiv.appendChild(img);
    }
    // 时长
    if (item.duration > 0) {
      const dur = document.createElement('span');
      dur.className = 'dyx-card-duration';
      dur.textContent = fmtDuration(item.duration);
      coverDiv.appendChild(dur);
    }
    // 商品角标
    if (item.goods?.title) {
      const goodsBadge = document.createElement('span');
      goodsBadge.className = 'dyx-card-goods-badge';
      goodsBadge.textContent = '商品';
      coverDiv.appendChild(goodsBadge);
    }
    // 失效角标
    if (item.status === 'stale') {
      const staleBadge = document.createElement('span');
      staleBadge.className = 'dyx-card-stale-badge';
      staleBadge.textContent = '失效';
      coverDiv.appendChild(staleBadge);
    }
    card.appendChild(coverDiv);

    // 信息区
    const info = document.createElement('div');
    info.className = 'dyx-card-info';

    const title = document.createElement('p');
    title.className = 'dyx-card-title';
    title.textContent = item.title || '抖音视频';
    info.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'dyx-card-meta';
    const metaParts: string[] = [];
    if (item.name) metaParts.push(item.name);
    if (item.date) metaParts.push(item.date);
    meta.textContent = metaParts.join(' · ');
    info.appendChild(meta);

    const stats = document.createElement('p');
    stats.className = 'dyx-card-stats';
    const s = item.statistics || { digg: 0, comment: 0, collect: 0, share: 0 };
    stats.textContent = `♥ ${fmtNum(s.digg)}  💬 ${fmtNum(s.comment)}  ⭐ ${fmtNum(s.collect)}  ↗ ${fmtNum(s.share)}`;
    info.appendChild(stats);

    card.appendChild(info);

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'dyx-card-actions';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'dyx-card-btn';
    dlBtn.textContent = '单条下载';
    dlBtn.addEventListener('click', () => handleSingleDownload(item));
    actions.appendChild(dlBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'dyx-card-btn dyx-card-btn--danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => handleDelete([item.vid]));
    actions.appendChild(delBtn);

    if (item.status === 'stale') {
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'dyx-card-btn dyx-card-btn--warn';
      refreshBtn.textContent = '刷新链接';
      refreshBtn.addEventListener('click', () => handleRefreshLinks([item.vid]));
      actions.appendChild(refreshBtn);
    }

    card.appendChild(actions);
    grid.appendChild(card);
  }

  updateCounts();
}

// ============ 列表操作 ============

async function loadList(): Promise<void> {
  try {
    listMap = await sendMsg<Record<string, VideoItem>>({ type: DYX_GET_LIST, list: 'batch' });
  } catch {
    listMap = {};
  }
  renderGrid();
}

// 全选
function handleSelectAll(): void {
  for (const vid of Object.keys(listMap)) {
    selectedVids.add(vid);
  }
  renderGrid();
}

// 反选
function handleInvert(): void {
  const allVids = Object.keys(listMap);
  const newSelected = new Set<string>();
  for (const vid of allVids) {
    if (!selectedVids.has(vid)) newSelected.add(vid);
  }
  selectedVids = newSelected;
  renderGrid();
}

// 删除（带二次确认：>10 条时）
async function handleDelete(vids: string[]): Promise<void> {
  if (vids.length === 0) return;
  if (vids.length > 10) {
    const confirmed = await showConfirmDialog(`确认删除 ${vids.length} 条视频？`);
    if (!confirmed) return;
  }
  await sendMsg({ type: DYX_REMOVE_ITEMS, list: 'batch', vids });
  for (const vid of vids) {
    delete listMap[vid];
    selectedVids.delete(vid);
  }
  renderGrid();
}

// 清空（二次确认）
async function handleClear(): Promise<void> {
  const total = Object.keys(listMap).length;
  if (total === 0) return;
  const confirmed = await showConfirmDialog(`确认清空全部 ${total} 条视频？`);
  if (!confirmed) return;
  await sendMsg({ type: DYX_CLEAR_LIST, list: 'batch' });
  listMap = {};
  selectedVids.clear();
  renderGrid();
}

// 排序切换
function handleSort(key: string): void {
  sortKey = (key as typeof sortKey) || 'addedAt';
  renderGrid();
}

// ============ 确认对话框 ============

function showConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = $<HTMLDivElement>('#dyx-dialog');
    const msgEl = $<HTMLParagraphElement>('#dyx-dialog-msg');
    const cancelBtn = $<HTMLButtonElement>('#dyx-dialog-cancel');
    const confirmBtn = $<HTMLButtonElement>('#dyx-dialog-confirm');

    msgEl.textContent = message;
    overlay.hidden = false;

    const cleanup = () => {
      overlay.hidden = true;
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
    };
    const onCancel = () => { cleanup(); resolve(false); };
    const onConfirm = () => { cleanup(); resolve(true); };
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
  });
}

// ============ 进度显示 ============

function showProgress(text: string, detail?: string): void {
  const bar = $<HTMLDivElement>('#dyx-progress-bar');
  bar.hidden = false;
  $<HTMLDivElement>('#dyx-progress-text').textContent = text;
  $<HTMLDivElement>('#dyx-progress-detail').textContent = detail || '';
}

function updateProgress(percent: number, text?: string, detail?: string): void {
  $<HTMLDivElement>('#dyx-progress-fill').style.width = `${percent}%`;
  if (text) $<HTMLDivElement>('#dyx-progress-text').textContent = text;
  if (detail !== undefined) $<HTMLDivElement>('#dyx-progress-detail').textContent = detail;
}

function hideProgress(): void {
  $<HTMLDivElement>('#dyx-progress-bar').hidden = true;
  $<HTMLDivElement>('#dyx-progress-fill').style.width = '0%';
}

// ============ 单条下载 ============

async function handleSingleDownload(item: VideoItem): Promise<void> {
  if (!item.url || item.status === 'stale') {
    // 尝试刷新直链
    try {
      const refreshed = await resolveItems([item.vid]);
      if (refreshed && refreshed.length > 0 && refreshed[0].item) {
        Object.assign(item, refreshed[0].item);
        // 持久化刷新后的直链，避免刷新批量页后丢失
        listMap[item.vid] = { ...listMap[item.vid], ...item, status: 'ready' };
        await sendMsg({ type: DYX_ADD_ITEMS, list: 'batch', items: [listMap[item.vid]] });
      } else {
        alert('直链解析失败，无法下载');
        return;
      }
    } catch {
      alert('直链解析失败，请先刷新页面后重试');
      return;
    }
  }
  try {
    showProgress('下载中…', item.title || '');
    const resp = await fetch(item.url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const settings = await loadSettings();
    const filename = renderFilename(item, settings.fileNameFormat) + '.mp4';
    // 锚点下载
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    hideProgress();
  } catch {
    hideProgress();
    alert('下载失败，请重试');
  }
}

// ============ 失效链接刷新 ============

interface ResolveResultItem {
  vid: string;
  item?: VideoItem;
  error?: string;
}

async function resolveItems(vids: string[]): Promise<ResolveResultItem[]> {
  try {
    const resp: { results?: ResolveResultItem[]; error?: string } = await sendMsg({
      type: DYX_RESOLVE_ITEMS,
      vids,
    });
    if (resp.error) throw new Error(resp.error);
    return resp.results || [];
  } catch (e) {
    // 返回每条都失败
    return vids.map((vid) => ({ vid, error: e instanceof Error ? e.message : String(e) }));
  }
}

async function handleRefreshLinks(vids: string[]): Promise<void> {
  if (vids.length === 0) return;
  isDownloading = true;
  showProgress('刷新直链中…', `${vids.length} 条待刷新，串行处理，每条间隔 ≥300ms`);

  const results = await resolveItems(vids);
  let successCount = 0;
  let failCount = 0;

  for (const r of results) {
    if (r.item && r.item.url) {
      // 更新列表中的条目
      listMap[r.vid] = { ...listMap[r.vid], ...r.item, status: 'ready' };
      successCount++;
    } else {
      failCount++;
    }
  }

  // 更新 storage
  if (successCount > 0) {
    await sendMsg({ type: DYX_ADD_ITEMS, list: 'batch', items: Object.values(listMap) });
  }

  renderGrid();
  isDownloading = false;
  hideProgress();
  if (failCount > 0) {
    alert(`刷新完成：成功 ${successCount} 条，失败 ${failCount} 条`);
  }
}

// ============ 下载 ZIP ============

async function handleDownloadZip(): Promise<void> {
  if (isDownloading) {
    alert('正在下载中，请等待当前操作完成');
    return;
  }
  const selectedItems = getSelectedItems();
  if (selectedItems.length === 0) {
    alert('请先选择要下载的视频');
    return;
  }

  // 检查失效项
  const staleItems = selectedItems.filter((i) => i.status === 'stale');
  if (staleItems.length > 0) {
    const validItems = selectedItems.filter((i) => i.status !== 'stale');
    if (validItems.length === 0) {
      alert('选中的视频链接全部已失效，请先刷新链接');
      return;
    }
    const confirmed = await showConfirmDialog(
      `将跳过 ${staleItems.length} 条失效链接，仅下载剩余 ${validItems.length} 条，是否继续？`
    );
    if (confirmed) {
      await doDownloadZip(validItems, staleItems.length);
    }
    return;
  }

  await doDownloadZip(selectedItems);
}

async function doDownloadZip(items: VideoItem[], skippedStale = 0): Promise<void> {
  // 第十一轮修复：先弹保存对话框（保持用户手势有效），再做下载等耗时操作
  // 用户取消（AbortError）→ 立即返回，不浪费流量
  let writable: any = null;
  let useFsa = false;
  if ('showSaveFilePicker' in window) {
    useFsa = true;
    try {
      const zipName = buildZipFilename();
      const fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: zipName,
        types: [{ description: 'ZIP 文件', accept: { 'application/zip': ['.zip'] } }],
      });
      writable = await fileHandle.createWritable();
    } catch (e) {
      // 用户取消对话框 → 静默返回
      if (e instanceof DOMException && e.name === 'AbortError') return;
      // 手势超时等 → 分类提示，不浪费流量
      const code = classifySaveError(e);
      alert(errorMessage(code));
      return;
    }
  }

  // 以下操作在拿到 writable 之后进行（手势不再需要）
  const settings = await loadSettings();
  const concurrency = Math.max(1, Math.min(10, settings.concurrency || 4));
  const retry = Math.max(0, Math.min(3, settings.retry ?? 1));

  isDownloading = true;
  showProgress('准备下载…', `${items.length} 条视频，并发 ${concurrency}`);

  const zip = new JSZip();
  const usedNames = new Set<string>();
  let successCount = 0;
  let failCount = 0;
  const failedVids: string[] = [];

  // 构建下载任务（不再在任务内部触发 resolveItems，避免并发绕过限速；
  // 失效项已在上层统一过滤/刷新，此处仅做 fetch）
  const tasks = items.map((item) => ({
    id: item.vid,
    run: async () => {
      const url = item.url;
      if (!url) throw new Error('E1003');

      const resp = await fetch(url);
      if (!resp.ok) {
        if (resp.status === 403) throw new Error('E1003');
        if (resp.status === 404) throw new Error('E1007');
        throw new Error('E1004');
      }
      const blob = await resp.blob();
      return { item, blob };
    },
  }));

  const results = await runQueue(tasks, {
    concurrency,
    retry,
    onProgress: (done, total) => {
      const pct = Math.round((done / total) * 80); // 前 80% 为下载进度
      updateProgress(pct, `下载中… ${done}/${total}`, '');
    },
  });

  // 收集成功项加入 zip
  for (const r of results) {
    if (r.success && r.value) {
      const { item, blob } = r.value as { item: VideoItem; blob: Blob };
      const baseName = renderFilename(item, settings.fileNameFormat) + '.mp4';
      const uniqueName = buildUniqueFilename(baseName, usedNames, item.vid);
      zip.file(uniqueName, blob);
      successCount++;
    } else {
      failCount++;
      failedVids.push(r.id);
      if (listMap[r.id]) listMap[r.id].status = 'failed';
    }
  }

  // 全部下载失败 → abort writable，不留下 0 字节文件
  if (successCount === 0) {
    if (writable) {
      try { await writable.abort(); } catch { /* 忽略 abort 错误 */ }
    }
    isDownloading = false;
    hideProgress();
    alert('所有视频下载失败');
    return;
  }

  // 生成 ZIP 并落盘
  updateProgress(80, '正在生成 ZIP 文件…', '');

  try {
    if (useFsa && writable) {
      // 主通道：FSA 流式写入（带背压：pause/resume 确保写完再继续）
      // 使用 generateInternalStream 流式写入，带背压控制
      const stream = zip.generateInternalStream({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      await new Promise<void>((resolve, reject) => {
        let closed = false;
        stream.on('data', (chunk: Uint8Array, metadata: { percent: number }) => {
          // 暂停流，等写入完成后再恢复（背压）
          stream.pause();
          writable.write(chunk).then(() => {
            const pct = 80 + Math.round(metadata.percent * 0.2);
            updateProgress(pct, '压缩写入中…', `${metadata.percent.toFixed(0)}%`);
            stream.resume();
          }).catch((err: Error) => {
            reject(err);
          });
        });
        stream.on('end', () => {
          // 等所有写入完成后再 close
          writable.close().then(() => {
            closed = true;
            resolve();
          }).catch(reject);
        });
        stream.on('error', (err: Error) => {
          if (!closed) reject(err);
        });
        stream.resume();
      });
    } else {
      // 退化通道：blob + 锚点下载
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        streamFiles: true,
      }, (metadata: { percent: number }) => {
        const pct = 80 + Math.round(metadata.percent * 0.2);
        updateProgress(pct, '压缩中…', `${metadata.percent.toFixed(0)}%`);
      });
      const zipName = buildZipFilename();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }
  } catch (e) {
    // 用户取消（AbortError）静默处理
    if (e instanceof DOMException && e.name === 'AbortError') {
      isDownloading = false;
      hideProgress();
      return;
    }
    // 写入失败：abort 残留文件句柄
    if (writable) {
      try { await writable.abort(); } catch { /* 忽略 abort 错误 */ }
    }
    isDownloading = false;
    hideProgress();
    // 分类错误：区分手势超时与磁盘写入失败
    const code = classifySaveError(e);
    alert(errorMessage(code));
    return;
  }

  // 更新 storage（标记 failed 条目）
  await sendMsg({ type: DYX_ADD_ITEMS, list: 'batch', items: Object.values(listMap) });

  isDownloading = false;
  hideProgress();
  renderGrid();

  // 汇总：包含跳过的失效项信息
  const parts: string[] = [`成功 ${successCount} 条`];
  if (failCount > 0) parts.push(`失败 ${failCount} 条`);
  if (skippedStale > 0) parts.push(`跳过 ${skippedStale} 条失效链接`);
  const summary = `下载完成：${parts.join('，')}`;
  if (failCount > 0) {
    alert(`${summary}\n失败条目可在列表中查看并重试`);
  } else {
    alert(summary);
  }
}

// ============ 保存到文件夹 ============

async function handleDownloadFolder(): Promise<void> {
  if (isDownloading) {
    alert('正在下载中，请等待当前操作完成');
    return;
  }
  const selectedItems = getSelectedItems();
  if (selectedItems.length === 0) {
    alert('请先选择要下载的视频');
    return;
  }

  if (!('showDirectoryPicker' in window)) {
    alert('当前浏览器不支持文件夹保存，请使用 Chrome 114+ 或使用 ZIP 下载');
    return;
  }

  // 第十一轮修复：先弹目录选择框（保持用户手势有效），再做失效项刷新等耗时操作
  let dirHandle: any;
  try {
    dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    // 用户取消 → 静默返回
    if (e instanceof DOMException && e.name === 'AbortError') return;
    // 手势超时等 → 分类提示
    const code = classifySaveError(e);
    alert(errorMessage(code));
    return;
  }

  // 以下操作在拿到目录句柄之后进行（手势不再需要）
  const settings = await loadSettings();
  const concurrency = Math.max(4, Math.min(8, settings.concurrency || 4));
  const retry = Math.max(0, Math.min(3, settings.retry ?? 1));

  // 检查失效项：统一刷新，再下载（避免并发绕过限速）
  const staleItems = selectedItems.filter((i) => i.status === 'stale' || !i.url);
  if (staleItems.length > 0) {
    showProgress('刷新直链中…', `${staleItems.length} 条需刷新`);
    const refreshResults = await resolveItems(staleItems.map((i) => i.vid));
    let refreshOk = 0;
    for (const r of refreshResults) {
      if (r.item && r.item.url) {
        listMap[r.vid] = { ...listMap[r.vid], ...r.item, status: 'ready' };
        // 同步更新 selectedItems 中的引用
        const si = selectedItems.find((i) => i.vid === r.vid);
        if (si) Object.assign(si, r.item, { status: 'ready' });
        refreshOk++;
      }
    }
    // 持久化刷新结果
    if (refreshOk > 0) {
      await sendMsg({ type: DYX_ADD_ITEMS, list: 'batch', items: Object.values(listMap) });
    }
    // 过滤掉仍无直链的条目
    const validItems = selectedItems.filter((i) => i.url);
    const skippedCount = selectedItems.length - validItems.length;
    if (validItems.length === 0) {
      hideProgress();
      alert('所有选中视频的链接解析失败');
      return;
    }
    if (skippedCount > 0) {
      hideProgress();
      const confirmed = await showConfirmDialog(
        `${skippedCount} 条链接解析失败，将跳过，仅保存剩余 ${validItems.length} 条，是否继续？`
      );
      if (!confirmed) return;
      // 用过滤后的列表替换
      selectedItems.length = 0;
      selectedItems.push(...validItems);
    }
    hideProgress();
  }

  isDownloading = true;
  showProgress('保存到文件夹…', `${selectedItems.length} 条视频，写入目标文件夹`);

  const usedNames = new Set<string>();
  let successCount = 0;
  let failCount = 0;

  // 失效项已在上层处理，此处仅对有直链的条目做 fetch
  const tasks = selectedItems.map((item) => ({
    id: item.vid,
    run: async () => {
      const url = item.url;
      if (!url) throw new Error('E1003');

      const resp = await fetch(url);
      if (!resp.ok) {
        if (resp.status === 403) throw new Error('E1003');
        if (resp.status === 404) throw new Error('E1007');
        throw new Error('E1004');
      }
      const blob = await resp.blob();
      return { item, blob };
    },
  }));

  const results = await runQueue(tasks, {
    concurrency,
    retry,
    onProgress: (done, total) => {
      const pct = Math.round((done / total) * 100);
      updateProgress(pct, `写入文件夹… ${done}/${total}`, '');
    },
  });

  // 逐条写入文件夹
  for (const r of results) {
    if (r.success && r.value) {
      const { item, blob } = r.value as { item: VideoItem; blob: Blob };
      try {
        const baseName = renderFilename(item, settings.fileNameFormat) + '.mp4';
        const uniqueName = buildUniqueFilename(baseName, usedNames, item.vid);
        const fileHandle = await dirHandle.getFileHandle(uniqueName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        successCount++;
      } catch (e) {
        // 磁盘写入失败
        if (e instanceof DOMException && e.name === 'AbortError') {
          // 用户取消
          isDownloading = false;
          hideProgress();
          return;
        }
        failCount++;
        if (listMap[r.id]) listMap[r.id].status = 'failed';
      }
    } else {
      failCount++;
      if (listMap[r.id]) listMap[r.id].status = 'failed';
    }
  }

  // 更新 storage
  await sendMsg({ type: DYX_ADD_ITEMS, list: 'batch', items: Object.values(listMap) });

  isDownloading = false;
  hideProgress();
  renderGrid();

  const summary = `保存完成：成功 ${successCount} 条，失败 ${failCount} 条`;
  if (failCount > 0) {
    alert(`${summary}\n失败条目可在列表中查看并重试`);
  } else {
    alert(summary);
  }
}

// ============ 辅助 ============

function getSelectedItems(): VideoItem[] {
  if (selectedVids.size === 0) return [];
  return Array.from(selectedVids)
    .map((vid) => listMap[vid])
    .filter(Boolean);
}

// ============ 绑定事件 ============

function bindEvents(): void {
  $<HTMLButtonElement>('#dyx-select-all').addEventListener('click', handleSelectAll);
  $<HTMLButtonElement>('#dyx-invert').addEventListener('click', handleInvert);
  $<HTMLButtonElement>('#dyx-delete').addEventListener('click', () => handleDelete(Array.from(selectedVids)));
  $<HTMLButtonElement>('#dyx-clear').addEventListener('click', handleClear);
  $<HTMLButtonElement>('#dyx-refresh').addEventListener('click', loadList);
  $<HTMLSelectElement>('#dyx-sort').addEventListener('change', (e) => {
    handleSort((e.target as HTMLSelectElement).value);
  });
  $<HTMLButtonElement>('#dyx-download-zip').addEventListener('click', handleDownloadZip);
  $<HTMLButtonElement>('#dyx-download-folder').addEventListener('click', handleDownloadFolder);
}

// ============ 启动 ============

async function init(): Promise<void> {
  bindEvents();
  await loadList();
}

init();
