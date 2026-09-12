// 内容脚本入口：注入 bs.js、启动观察器、监听 SPA 路由、注入下载按钮 + 加入列表按钮
// M2：新增「加入列表」按钮注入、DYX_RESOLVE_FROM_BATCH 处理（失效链接刷新链路）
// M3：搜索页注入三个按钮（下载+加入列表+选择）、搜索响应缓存、计数浮条、清空/复制/导出 CSV
// M3 复核修复：搜索卡片同时注入三按钮、searchList 快照缓存、handleSelect disabled 恢复

import {
  DYX_CAPTURED,
  DYX_READY,
  DYX_ROUTE_CHANGE,
  DYX_ADD_ITEMS,
  DYX_GET_LIST,
  DYX_CLEAR_LIST,
  DYX_REMOVE_ITEMS,
  DYX_RESOLVE_FROM_BATCH,
  DYX_INJECT_BRIDGE,
} from '../shared/protocol.js';
import { findVideoCards, findSearchCards, getCurrentPageType, logInjectSummary, logSearchInjectSummary } from './selectors.js';
import type { CoverMatchEntry } from './selectors.js';
import {
  createDownloadButton,
  createAddToListButton,
  createSelectButton,
  createButtonContainer,
  setButtonState,
  setAddToListState,
  setSelectState,
  markInjected,
  isInjected,
  showToast,
  initFloatingBar,
  updateFloatingBarCount,
} from './inject-ui.js';
import { cacheCapturedDetail, downloadWithRetry, resolveVideoUrl, prefetchWebId } from './downloader.js';
import { errorMessage, inferError } from '../shared/errors.js';
import { generateTsv, generateCsv, buildExportFilename } from '../shared/fields.js';
import { loadSettings } from '../shared/settings.js';
import { extractAwemeEntries } from '../shared/capture.js';
import type { VideoItem } from '../shared/types.js';
import type { DiagState } from '../shared/diag.js';
import { createDefaultDiagState, buildDiagJson } from '../shared/diag.js';

// 注入 bs.js 到页面世界：优先 SW executeScript（MAIN world，绕过页面 CSP），失败则回退 script 标签
function injectBridge(): void {
  if ((window as any).__DYX_BRIDGE__) {
    console.log('[抖存] 桥已注入，跳过');
    return;
  }

  // 方案 A：经 SW 用 chrome.scripting.executeScript 注入到 MAIN world
  chrome.runtime.sendMessage(
    { type: DYX_INJECT_BRIDGE },
    (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn(`[抖存] SW 桥注入消息失败: ${err.message}，回退 script 标签`);
        injectBridgeFallback();
        return;
      }
      if (resp?.success) {
        console.log('[抖存] 桥注入成功（MAIN world）');
      } else {
        console.warn(`[抖存] SW 桥注入失败: ${resp?.error || 'unknown'}，回退 script 标签`);
        injectBridgeFallback();
      }
    }
  );
}

// 兜底：script 标签注入（受页面 CSP 限制）
function injectBridgeFallback(): void {
  if ((window as any).__DYX_BRIDGE__) return;
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('bs.js');
  s.onload = () => {
    s.remove();
    console.log('[抖存] 桥注入成功（script 标签兜底）');
  };
  s.onerror = () => {
    console.warn('[抖存] 桥注入失败（script 标签也被拦截）');
  };
  (document.head || document.documentElement).appendChild(s);
}

// ============================================================
// 批量列表快照（M1/M2，不变量 ⑨ 前置）
// 第三轮修复 #4：generation token 防 in-flight 竞态
// ============================================================
let batchListSnapshot: Record<string, VideoItem> | null = null;
let batchSnapshotPromise: Promise<Record<string, VideoItem>> | null = null;
let batchGen = 0;

function ensureBatchListSnapshot(): Promise<Record<string, VideoItem>> {
  if (batchListSnapshot !== null) return Promise.resolve(batchListSnapshot);
  if (batchSnapshotPromise) return batchSnapshotPromise;
  const myGen = batchGen;
  batchSnapshotPromise = new Promise<Record<string, VideoItem>>((resolve) => {
    chrome.runtime.sendMessage({ type: DYX_GET_LIST, list: 'batch' }, (resp) => {
      resolve((resp || {}) as Record<string, VideoItem>);
    });
  }).then((map) => {
    if (myGen !== batchGen) return map;
    batchListSnapshot = map;
    batchSnapshotPromise = null;
    return map;
  }).catch(() => {
    batchSnapshotPromise = null;
    return {};
  });
  return batchSnapshotPromise;
}

// 失效批量列表快照（加入列表/删除后调用）
function invalidateBatchListSnapshot(): void {
  batchGen++;
  batchListSnapshot = null;
}

// M3 复核修复 #3：搜索列表快照（与 batchListSnapshot 同款模式，避免每卡各发一次 DYX_GET_LIST）
// 第三轮修复 #4：generation token 防 in-flight 竞态
let searchListSnapshot: Record<string, VideoItem> | null = null;
let searchSnapshotPromise: Promise<Record<string, VideoItem>> | null = null;
let searchGen = 0;

function ensureSearchListSnapshot(): Promise<Record<string, VideoItem>> {
  if (searchListSnapshot !== null) return Promise.resolve(searchListSnapshot);
  if (searchSnapshotPromise) return searchSnapshotPromise;
  const myGen = searchGen;
  searchSnapshotPromise = new Promise<Record<string, VideoItem>>((resolve) => {
    chrome.runtime.sendMessage({ type: DYX_GET_LIST, list: 'search' }, (resp) => {
      resolve((resp || {}) as Record<string, VideoItem>);
    });
  }).then((map) => {
    if (myGen !== searchGen) return map;
    searchListSnapshot = map;
    searchSnapshotPromise = null;
    return map;
  }).catch(() => {
    searchSnapshotPromise = null;
    return {};
  });
  return searchSnapshotPromise;
}

// 失效搜索列表快照（选择/取消/清空后调用）
function invalidateSearchListSnapshot(): void {
  searchGen++;
  searchListSnapshot = null;
}

// ============================================================
// 全局解析串行队列（M2 复核修复 #3，不变量 ⑨）
// ============================================================
let resolveQueue: Promise<void> = Promise.resolve();

function enqueueResolve(vids: string[]): Promise<{ results: ResolveResultFromCS[] }> {
  const p = resolveQueue.then(() => execResolveSerial(vids));
  resolveQueue = p.then(() => {}, () => {});
  return p;
}

interface ResolveResultFromCS {
  vid: string;
  item?: VideoItem;
  error?: string;
}

async function execResolveSerial(vids: string[]): Promise<{ results: ResolveResultFromCS[] }> {
  // 第三轮修复 #3：从 settings 读取 requestInterval（clamp 0–2000，缺省 300）
  let interval = 300;
  try {
    const settings = await loadSettings();
    interval = Math.max(0, Math.min(2000, settings.requestInterval ?? 300));
  } catch {
    // settings 读取失败，用默认值
  }
  const results: ResolveResultFromCS[] = [];
  for (let i = 0; i < vids.length; i++) {
    const vid = vids[i];
    try {
      const item = await resolveVideoUrl(vid);
      results.push({ vid, item });
    } catch (e) {
      results.push({ vid, error: e instanceof Error ? e.message : String(e) });
    }
    if (i < vids.length - 1 && interval > 0) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return { results };
}

// ============================================================
// M3：搜索页 vid→aweme_info 缓存（零请求结构化）
// 第三轮修复 #7：上限 500 条，超出清空（搜索页场景：换关键词时旧缓存已无意义）
// ============================================================
const SEARCH_CACHE_MAX = 500;
const searchDetailCache = new Map<string, any>();

function cacheSearchDetail(vid: string, detail: any): void {
  if (vid && detail) {
    // 超出上限时清空：搜索页换关键词后旧缓存已无意义，清空比逐条淘汰更高效
    if (searchDetailCache.size >= SEARCH_CACHE_MAX) {
      searchDetailCache.clear();
    }
    searchDetailCache.set(vid, detail);
  }
}

function getCachedSearchDetail(vid: string): any | null {
  return searchDetailCache.get(vid) || null;
}

// 统一捕获缓存：从任意已拦截的 API 响应中抽取 aweme 条目，写入 vid→aweme 缓存
function cacheCapturedResponse(_kind: string, res: any): number {
  const entries = extractAwemeEntries(res);
  for (const { vid, aweme } of entries) {
    cacheSearchDetail(vid, aweme);
    cacheCapturedDetail(vid, aweme);
  }
  return entries.length;
}

// ============================================================
// 第八轮修复：诊断镜像（data-dyx-diag 属性）
// 挂在 document.documentElement 上，紧凑 JSON，便于无控制台排查
// 第九轮修复：新增 bridgeReady / bridgeRegErr 字段；纯函数抽到 shared/diag.ts
// ============================================================
const diagState: DiagState = createDefaultDiagState();

function updateDiag(): void {
  try {
    diagState.cachedItems = searchDetailCache.size;
    // 从页面桥读取执行时机（bs.js 在 document_start 设置）
    try {
      const meta = (window as any).__DYX_BRIDGE_META__;
      if (meta && typeof meta.readyState === 'string') {
        diagState.bridgeReady = meta.readyState;
      }
    } catch {
      // MAIN world 属性在 isolated world 不可读，静默忽略
    }
    const json = buildDiagJson(diagState);
    document.documentElement.setAttribute('data-dyx-diag', json);
  } catch {
    // 设置属性失败，静默忽略
  }
}

// 第九轮修复：从 storage 读取常驻注册失败原因，写入诊断镜像
function loadBridgeRegError(): void {
  try {
    chrome.storage.local.get('dyx:bridgeRegError', (result) => {
      const err = result['dyx:bridgeRegError'];
      diagState.bridgeRegErr = typeof err === 'string' ? err.slice(0, 120) : '';
    });
  } catch {
    // storage 读取失败，静默忽略
  }
}

// ============================================================
// M1/M2：下载按钮 + 加入列表按钮注入（非搜索页）
// 搜索页由 injectSearchUI 单独处理（注入三按钮）
// ============================================================
function injectButtons(): void {
  if (getCurrentPageType() === 'search') return;

  const cards = findVideoCards();
  for (const { el, vid } of cards) {
    if (isInjected(el)) continue;
    if (!vid) continue;

    // 详情页（el === document.body）用 fixed 定位容器，卡片页用 absolute
    const isDetail = el === document.body;
    if (!isDetail) {
      const cs = getComputedStyle(el as HTMLElement);
      if (cs.position === 'static') {
        (el as HTMLElement).style.position = 'relative';
      }
    }

    const stack = createButtonContainer(isDetail);

    const dlBtn = createDownloadButton(vid);
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      console.log(`[抖存] 点击下载 vid=${vid}`);
      handleDownload(dlBtn, vid);
    });
    stack.appendChild(dlBtn);

    const addBtn = createAddToListButton(vid);
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      console.log(`[抖存] 点击加入列表 vid=${vid}`);
      handleAddToList(addBtn, vid);
    });
    stack.appendChild(addBtn);

    (el as HTMLElement).appendChild(stack);

    ensureBatchListSnapshot().then((snapshot) => {
      if (snapshot[vid]) {
        setAddToListState(addBtn, 'added');
      }
    });

    markInjected(el);
    console.log(`[抖存] 按钮注入成功 vid=${vid} (detail=${isDetail})`);
  }

  // 第四轮修复：诊断日志
  logInjectSummary(getCurrentPageType(), cards.length);
}

// ============================================================
// M3：搜索页注入三按钮（下载 ↓、加入列表 +、选择）+ 计数浮条
// 复核修复 #1：搜索卡片同时注入三个按钮，不再只注入选择按钮
// ============================================================
function injectSearchUI(): void {
  if (getCurrentPageType() !== 'search') return;

  // 第六轮修复：传入搜索缓存条目供封面文件 ID 匹配兜底
  const coverEntries: CoverMatchEntry[] = Array.from(searchDetailCache.entries()).map(
    ([vid, aweme]) => ({ vid, aweme }),
  );
  const cards = findSearchCards(coverEntries);
  for (const { el, vid } of cards) {
    if (isInjected(el)) continue;
    if (!vid) continue;

    const cs = getComputedStyle(el as HTMLElement);
    if (cs.position === 'static') {
      (el as HTMLElement).style.position = 'relative';
    }

    // 按钮容器：右上角纵向排列
    const stack = createButtonContainer(false);

    // 按钮 1：下载
    const dlBtn = createDownloadButton(vid);
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      console.log(`[抖存] 搜索页点击下载 vid=${vid}`);
      handleDownload(dlBtn, vid);
    });
    stack.appendChild(dlBtn);

    // 按钮 2：加入列表
    const addBtn = createAddToListButton(vid);
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      console.log(`[抖存] 搜索页点击加入列表 vid=${vid}`);
      handleAddToList(addBtn, vid);
    });
    stack.appendChild(addBtn);

    // 按钮 3：选择
    const selectBtn = createSelectButton(vid);
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handleSelect(selectBtn, vid);
    });
    stack.appendChild(selectBtn);

    (el as HTMLElement).appendChild(stack);

    // 一次性标记已注入（容器注入完毕后才标记）
    markInjected(el);
    console.log(`[抖存] 搜索页按钮注入成功 vid=${vid}`);
  }

  // 用快照批量检测已选/已加入状态（避免每卡各发一次消息，复核修复 #3）
  if (cards.length > 0) {
    Promise.all([ensureBatchListSnapshot(), ensureSearchListSnapshot()]).then(([batchSnap, searchSnap]) => {
      for (const { el, vid } of cards) {
        if (!vid) continue;
        const addBtn = el.querySelector<HTMLButtonElement>('.dyx-addlist-btn');
        if (addBtn && batchSnap[vid]) {
          setAddToListState(addBtn, 'added');
        }
        const selectBtn = el.querySelector<HTMLButtonElement>('.dyx-select-btn');
        if (selectBtn && searchSnap[vid]) {
          setSelectState(selectBtn, 'selected');
        }
      }
    });

    // 初始化浮条
    initFloatingBar(
      cards[0].el,
      handleClearSearchList,
      handleCopySearchList,
      handleExportCsvSearchList,
    );
    refreshFloatingBarCount();
  }

  // 第六轮修复：诊断日志（含 vid 解析策略）
  const injectedCount = cards.filter((c) => c.vid).length;
  const strategyOrder = ['waterfall-id', 'anchor', 'cover-match', 'none'] as const;
  let dominantStrategy: string = 'none';
  for (const s of strategyOrder) {
    if (cards.some((c) => c.strategy === s)) { dominantStrategy = s; break; }
  }
  logSearchInjectSummary(cards.length, injectedCount, dominantStrategy);

  // 第八轮修复：更新诊断镜像
  diagState.cards = cards.length;
  diagState.injected = injectedCount;
  diagState.strategy = dominantStrategy;
  updateDiag();
}

// ============================================================
// M3：处理「选择」按钮点击（选择/取消切换）
// 复核修复 #2：成功分支恢复 btn.disabled = false
// ============================================================
async function handleSelect(btn: HTMLButtonElement, vid: string): Promise<void> {
  const currentState = btn.getAttribute('data-dyx-select-state');
  if (currentState === 'selected') {
    // 取消选择：从 searchList 移除
    try {
      await sendMsg({ type: DYX_REMOVE_ITEMS, list: 'search', vids: [vid] });
      invalidateSearchListSnapshot();
      setSelectState(btn, 'idle');
      refreshFloatingBarCount();
    } catch {
      showToast('取消失败', 'error');
    }
    return;
  }

  // 选择：结构化为 VideoItem
  try {
    btn.textContent = '…';
    btn.disabled = true;

    let item: VideoItem;
    const cached = getCachedSearchDetail(vid);
    if (cached) {
      cacheCapturedDetail(vid, cached);
      item = await resolveVideoUrl(vid);
    } else {
      const result = await enqueueResolve([vid]);
      if (result.results[0]?.item) {
        item = result.results[0].item;
      } else {
        throw new Error(result.results[0]?.error || 'E1002');
      }
    }

    item.source = 'search';
    const resp: { total: number } = await sendMsg({
      type: DYX_ADD_ITEMS,
      list: 'search',
      items: [item],
    });
    invalidateSearchListSnapshot();
    setSelectState(btn, 'selected');
    btn.disabled = false; // 复核修复 #2：恢复可点击（用户需再次点击取消选择）
    refreshFloatingBarCount();
    showToast(`已选择（共 ${resp.total} 条）`, 'success');
  } catch (e) {
    setSelectState(btn, 'idle');
    btn.textContent = '选择';
    btn.disabled = false;
    const code = inferError(e);
    const msg = errorMessage(code);
    if (msg) showToast(msg, 'error');
    // 第八轮修复：更新诊断镜像
    diagState.lastError = code;
    updateDiag();
  }
}

// ============================================================
// M3：浮条操作 — 清空
// 第三轮修复 #15：检查 lastError，失败时提示且不重置 UI
// ============================================================
function handleClearSearchList(): void {
  if (!confirm('确认清空全部已选？')) return;
  chrome.runtime.sendMessage({ type: DYX_CLEAR_LIST, list: 'search' }, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      showToast('清空失败: ' + err.message, 'error');
      return;
    }
    invalidateSearchListSnapshot();
    document.querySelectorAll<HTMLButtonElement>('.dyx-select-btn[data-dyx-select-state="selected"]').forEach((b) => {
      setSelectState(b, 'idle');
    });
    updateFloatingBarCount(0);
    showToast('已清空', 'success');
  });
}

// ============================================================
// M3：浮条操作 — 复制 TSV 到剪贴板
// ============================================================
async function handleCopySearchList(): Promise<void> {
  try {
    const list = await sendMsg<Record<string, VideoItem>>({ type: DYX_GET_LIST, list: 'search' });
    const items = Object.values(list);
    if (items.length === 0) {
      showToast('暂无已选内容', 'warning');
      return;
    }
    const settings = await loadSettings();
    const tsv = generateTsv(items, settings.exportFields);
    // 第三轮修复 #6：条目非空但生成结果为空（未勾选任何字段）时提示
    if (!tsv) { showToast('请至少勾选一个导出字段', 'warning'); return; }
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // 兜底：textarea + execCommand
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
        showToast('复制失败，请手动复制', 'error');
        return;
      }
    }
    showToast(`已复制 ${items.length} 条到剪贴板`, 'success');
  } catch {
    showToast('复制失败', 'error');
  }
}

// ============================================================
// M3：浮条操作 — 导出 CSV
// ============================================================
async function handleExportCsvSearchList(): Promise<void> {
  try {
    const list = await sendMsg<Record<string, VideoItem>>({ type: DYX_GET_LIST, list: 'search' });
    const items = Object.values(list);
    if (items.length === 0) {
      showToast('暂无已选内容', 'warning');
      return;
    }
    const settings = await loadSettings();
    const csv = generateCsv(items, settings.exportFields);
    // 第三轮修复 #6：条目非空但生成结果为空（未勾选任何字段）时提示
    if (!csv || csv === '\uFEFF') { showToast('请至少勾选一个导出字段', 'warning'); return; }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const filename = buildExportFilename();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    showToast(`已导出 ${items.length} 条`, 'success');
  } catch {
    showToast('导出失败', 'error');
  }
}

// 刷新浮条计数
function refreshFloatingBarCount(): void {
  chrome.runtime.sendMessage({ type: DYX_GET_LIST, list: 'search' }, (resp) => {
    const map = (resp || {}) as Record<string, VideoItem>;
    updateFloatingBarCount(Object.keys(map).length);
  });
}

// ============================================================
// 下载处理（M1）
// ============================================================
async function handleDownload(btn: HTMLButtonElement, vid: string): Promise<void> {
  console.log(`[抖存] 开始解析 vid=${vid}`);
  setButtonState(btn, 'resolving');
  try {
    console.log(`[抖存] 解析成功，开始下载 vid=${vid}`);
    await downloadWithRetry(vid, (p) => {
      setButtonState(btn, 'downloading', p.percent);
    }, (sizeMB) => {
      showToast(`文件较大（${sizeMB}MB），建议在批量页使用「保存到文件夹」以避免内存占用`, 'warning');
    });
    setButtonState(btn, 'done');
    console.log(`[抖存] 下载完成 vid=${vid}`);
    showToast('已保存', 'success');
  } catch (e) {
    setButtonState(btn, 'failed');
    const code = inferError(e);
    const msg = errorMessage(code);
    console.warn(`[抖存] 下载失败 vid=${vid} code=${code} error=`, e);
    // 所有错误码必须有可见反馈；E2001 不应出现在下载链路
    showToast(msg || '下载失败，请重试', 'error');
    // 第八轮修复：更新诊断镜像
    diagState.lastError = code;
    updateDiag();
  }
}

// ============================================================
// 加入列表处理（M2）
// ============================================================
async function handleAddToList(btn: HTMLButtonElement, vid: string): Promise<void> {
  if (btn.getAttribute('data-dyx-addlist-state') === 'added') return;

  try {
    console.log(`[抖存] 加入列表: 解析 vid=${vid}`);
    const item = await resolveVideoUrl(vid);
    const resp: { total: number } = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: DYX_ADD_ITEMS, list: 'batch', items: [item] },
        (r) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(r);
        }
      );
    });
    if (batchListSnapshot) batchListSnapshot[vid] = item; // 注意：invalidateBatchListSnapshot 会重置引用
    setAddToListState(btn, 'added');
    console.log(`[抖存] 加入列表成功 vid=${vid} total=${resp.total}`);
    showToast(`已加入批量列表（共 ${resp.total} 条）`, 'success');
  } catch (e) {
    const code = inferError(e);
    const msg = errorMessage(code);
    console.warn(`[抖存] 加入列表失败 vid=${vid} code=${code} error=`, e);
    showToast(msg || '加入列表失败，请重试', 'error');
  }
}

// ============================================================
// 工具函数
// ============================================================
function sendMsg<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp as T);
    });
  });
}

// 防抖扫描
let scanTimer: number | undefined;
function debouncedScan(): void {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    injectButtons();
    injectSearchUI();
  }, 300);
}

// ============================================================
// 监听 bs.js 捕获的响应（detail / search / post 统一缓存）
// ============================================================
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;

  if (data.type === DYX_CAPTURED) {
    const kind = data.kind;
    const res = data.res;
    const path: string = data.path || '';
    const count = cacheCapturedResponse(kind, res);
    console.log(`[抖存] 捕获 ${kind} 响应，缓存 ${count} 条`);
    // 第八轮修复：更新诊断镜像
    diagState.captures += count;
    diagState.lastKind = kind;
    // 第十轮修复：记录捕获来源路径（便于诊断接口变更）
    if (path) {
      diagState.lastPath = path;
    }
    updateDiag();
  }
});

// 第八轮修复：向页面桥发送就绪信号，触发缓冲队列回放
// 立即发送一次，1 秒后重发一次（容错：桥侧重复收到 DYX_READY 无害）
window.postMessage({ type: DYX_READY }, '*');
setTimeout(() => {
  window.postMessage({ type: DYX_READY }, '*');
}, 1000);

// MutationObserver
const observer = new MutationObserver(() => {
  debouncedScan();
});

// SPA 路由监听
function startRouteListener(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === DYX_ROUTE_CHANGE) {
      invalidateBatchListSnapshot();
      invalidateSearchListSnapshot();
      searchDetailCache.clear();
      debouncedScan();
    }
  });
}

// M2：监听 SW 转发的批量直链刷新请求
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== DYX_RESOLVE_FROM_BATCH) return false;

  const vids: string[] = msg.vids || [];
  if (vids.length === 0) {
    sendResponse({ results: [] });
    return false;
  }

  enqueueResolve(vids).then((resp) => {
    sendResponse(resp);
  }).catch((e) => {
    sendResponse({ error: e instanceof Error ? e.message : String(e) });
  });

  return true;
});

// ============================================================
// 第三轮修复 #15：监听 storage 变化，搜索列表变更时刷新浮条计数
// ============================================================
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['dyx:searchList']) {
    const newMap = changes['dyx:searchList'].newValue as Record<string, VideoItem> | undefined;
    const count = newMap ? Object.keys(newMap).length : 0;
    updateFloatingBarCount(count);
    // 同步失效快照，下次访问时重新拉取
    invalidateSearchListSnapshot();
  }
});

// ============================================================
// 启动
// ============================================================
function init(): void {
  injectBridge();
  prefetchWebId();
  startRouteListener();
  // 第九轮修复：读取常驻注册失败原因（异步，不阻塞启动）
  loadBridgeRegError();
  observer.observe(document.body, { childList: true, subtree: true });
  if (document.body) {
    injectButtons();
    injectSearchUI();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
