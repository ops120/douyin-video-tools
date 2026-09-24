// 原声采集页（M4）：粘贴链接 → 解析 → 分页采集作品 → 汇入批量列表 / 导出 CSV
// 请求直接由本页发起（扩展页受 host_permissions 保护，不受 CORS 限制）

import type { VideoItem } from '../shared/types.js';
import {
  parseSoundInput,
  buildSoundPageUrl,
  buildSoundInfoUrl,
  extractSoundPage,
  parseSoundInfo,
  describeApiError,
  dedupeItems,
  clampLimit,
  collectMissingAuthorVids,
  mergeResolvedDetails,
  describeResolveFailure,
  chunk,
  SOUND_LIMIT_DEFAULT,
} from '../shared/sound.js';
import type { SoundTarget, SoundMeta, ResolveResult } from '../shared/sound.js';
import { DYX_ADD_ITEMS, DYX_OPEN_BATCH, DYX_RESOLVE_ITEMS } from '../shared/protocol.js';
import { loadSettings } from '../shared/settings.js';
import { generateCsv, buildExportFilename, ALL_EXPORT_KEYS } from '../shared/fields.js';
import { renderFilename } from '../shared/filename.js';
import { applyVersionLabel } from '../shared/version.js';

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`元素未找到: ${sel}`);
  return el;
}

function sendMsg<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp as T);
    });
  });
}

function fmtNum(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============ 状态 ============

let target: SoundTarget | null = null;
let meta: SoundMeta | null = null;
let items: VideoItem[] = [];
let selected = new Set<string>();
let collecting = false;
let stopRequested = false;
// M4.1：作者补全
let enriching = false;
let stopEnrichRequested = false;
// 是否已把当前这批加入过批量列表（补全后需重推一次，避免批量页停留在空作者）
let addedToBatch = false;

// 补全请求的分片大小：太大则进度久不刷新、消息通道长时间挂起；太小则消息往返过多
const ENRICH_CHUNK = 5;

// ============ 提示与进度 ============

function setHint(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const el = $<HTMLParagraphElement>('#dyx-sound-hint');
  el.textContent = text;
  el.classList.toggle('dyx-parse-hint--error', kind === 'error');
  el.classList.toggle('dyx-parse-hint--ok', kind === 'ok');
}

function showProgress(text: string, ratio = 0, detail = ''): void {
  $<HTMLDivElement>('#dyx-sound-progress').hidden = false;
  $<HTMLDivElement>('#dyx-sound-progress-text').textContent = text;
  $<HTMLDivElement>('#dyx-sound-progress-fill').style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  $<HTMLDivElement>('#dyx-sound-progress-detail').textContent = detail;
}

function hideProgress(): void {
  $<HTMLDivElement>('#dyx-sound-progress').hidden = true;
}

function updateCounts(): void {
  $<HTMLSpanElement>('#dyx-sound-total').textContent = `共 ${items.length} 个`;
  $<HTMLSpanElement>('#dyx-sound-selected').textContent = `选中 ${selected.size} 个`;
  updateEnrichButton();
}

// 有缺作者的条目时才显示补全按钮；补全进行中由 enrichAuthors 自行控制文案
function updateEnrichButton(): void {
  if (enriching) return;
  const btn = $<HTMLButtonElement>('#dyx-sound-enrich');
  const missing = collectMissingAuthorVids(items).length;
  btn.hidden = missing === 0;
  if (missing > 0) btn.textContent = `补全作者 (${missing})`;
}

// ============ 渲染 ============

function renderGrid(): void {
  const grid = $<HTMLDivElement>('#dyx-sound-grid');
  const emptyEl = $<HTMLDivElement>('#dyx-sound-empty');
  const toolbar = $<HTMLDivElement>('#dyx-sound-toolbar');

  if (items.length === 0) {
    grid.hidden = true;
    emptyEl.hidden = false;
    toolbar.hidden = true;
    updateCounts();
    return;
  }

  emptyEl.hidden = true;
  grid.hidden = false;
  toolbar.hidden = false;
  grid.textContent = '';

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'dyx-card';
    card.setAttribute('data-vid', item.vid);
    if (selected.has(item.vid)) card.classList.add('dyx-card--selected');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'dyx-card-checkbox';
    cb.checked = selected.has(item.vid);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(item.vid);
      else selected.delete(item.vid);
      card.classList.toggle('dyx-card--selected', cb.checked);
      updateCounts();
    });
    card.appendChild(cb);

    const coverDiv = document.createElement('div');
    coverDiv.className = 'dyx-card-cover';
    if (item.cover) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = item.title || '';
      img.src = item.cover;
      img.onerror = () => { img.style.display = 'none'; };
      coverDiv.appendChild(img);
    }
    if (item.duration > 0) {
      const dur = document.createElement('span');
      dur.className = 'dyx-card-duration';
      dur.textContent = fmtDuration(item.duration);
      coverDiv.appendChild(dur);
    }
    card.appendChild(coverDiv);

    const info = document.createElement('div');
    info.className = 'dyx-card-info';

    const title = document.createElement('p');
    title.className = 'dyx-card-title';
    title.textContent = item.title || '抖音视频';
    info.appendChild(title);

    const metaParts: string[] = [];
    if (item.name) metaParts.push(item.name);
    if (item.date) metaParts.push(item.date);
    const metaEl = document.createElement('p');
    metaEl.className = 'dyx-card-meta';
    metaEl.textContent = metaParts.join(' · ') || `id ${item.vid}`;
    info.appendChild(metaEl);

    const s = item.statistics;
    const stats = document.createElement('p');
    stats.className = 'dyx-card-stats';
    stats.textContent = `♥ ${fmtNum(s.digg)}  💬 ${fmtNum(s.comment)}  ⭐ ${fmtNum(s.collect)}  ↗ ${fmtNum(s.share)}`;
    info.appendChild(stats);

    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'dyx-card-actions';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'dyx-card-btn';
    dlBtn.textContent = '下载';
    dlBtn.addEventListener('click', () => handleSingleDownload(item, dlBtn));
    actions.appendChild(dlBtn);

    const openBtn = document.createElement('button');
    openBtn.className = 'dyx-card-btn';
    openBtn.textContent = '打开';
    openBtn.addEventListener('click', () => {
      window.open(`https://www.douyin.com/video/${item.vid}`, '_blank', 'noopener');
    });
    actions.appendChild(openBtn);

    card.appendChild(actions);
    grid.appendChild(card);
  }

  updateCounts();
}

// ============ 解析 ============

// 跟随短链 302 拿到最终地址；body 不需要，直接取消
async function resolveShortLink(url: string): Promise<string | null> {
  const res = await fetch(url, { redirect: 'follow' });
  const finalUrl = res.url || '';
  try { await res.body?.cancel(); } catch { /* 忽略 */ }
  return finalUrl || null;
}

async function handleParse(): Promise<void> {
  // 采集或补全进行中不重入：items 会被替换，中途重解析会让补全结果落到旧数组上
  if (collecting || enriching) return;
  const raw = $<HTMLInputElement>('#dyx-sound-input').value;

  let parsed = parseSoundInput(raw);
  if (!parsed.ok && parsed.needsResolve) {
    setHint('正在跟随短链跳转…');
    let finalUrl: string | null = null;
    try {
      finalUrl = await resolveShortLink(parsed.url);
    } catch {
      setHint('短链请求失败，请检查网络或换用完整链接', 'error');
      return;
    }
    if (!finalUrl) {
      setHint('短链没有跳转到有效地址', 'error');
      return;
    }
    const again = parseSoundInput(finalUrl);
    if (!again.ok) {
      setHint(
        again.needsResolve ? '短链未跳转到可识别的原声页' : again.reason,
        'error'
      );
      return;
    }
    parsed = again;
  }
  if (!parsed.ok) {
    setHint(parsed.reason, 'error');
    return;
  }

  target = parsed.target;
  await loadMeta(target);
  await startCollect();
}

async function loadMeta(t: SoundTarget): Promise<void> {
  const card = $<HTMLElement>('#dyx-sound-meta');
  const coverEl = $<HTMLImageElement>('#dyx-sound-cover');
  const titleEl = $<HTMLParagraphElement>('#dyx-sound-title');
  const authorEl = $<HTMLParagraphElement>('#dyx-sound-author');
  const kindEl = $<HTMLParagraphElement>('#dyx-sound-kind');

  meta = null;
  card.hidden = false;
  coverEl.removeAttribute('src');
  titleEl.textContent = t.kind === 'trends' ? '（活动）' : '（原声）';
  authorEl.textContent = `music_id ${t.musicId}${t.trendsId ? ` · trends_id ${t.trendsId}` : ''}`;
  kindEl.textContent = '正在读取原声信息…';

  try {
    const res = await fetch(buildSoundInfoUrl(t.musicId));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    meta = parseSoundInfo(json);
  } catch {
    meta = null;
  }

  if (meta) {
    titleEl.textContent = meta.title || '（未知原声）';
    const authorBits: string[] = [];
    if (meta.author) authorBits.push(`原声作者：${meta.author}`);
    if (meta.userCount > 0) authorBits.push(`${meta.userCount} 人使用`);
    authorEl.textContent = authorBits.join(' · ') || `music_id ${meta.musicId}`;
    if (meta.cover) coverEl.src = meta.cover;
  }

  kindEl.textContent =
    t.kind === 'trends'
      ? '活动采集：翻页获取全部参与作品'
      : '原声采集：获取使用该原声的作品';
}

// ============ 采集 ============

async function startCollect(): Promise<void> {
  if (!target) return;

  collecting = true;
  stopRequested = false;
  items = [];
  selected.clear();
  addedToBatch = false;
  renderGrid();

  const limitInput = $<HTMLInputElement>('#dyx-sound-limit');
  const limit = clampLimit(limitInput.value ? Number(limitInput.value) : SOUND_LIMIT_DEFAULT);
  limitInput.value = String(limit);

  const pageSize = target.kind === 'trends' ? 15 : 20;
  const MAX_PAGES = 300; // 安全阀：防止接口异常时无限翻页
  let cursor = 0;
  let stopped = false;

  $<HTMLButtonElement>('#dyx-sound-parse').disabled = true;
  $<HTMLButtonElement>('#dyx-sound-stop').hidden = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (stopRequested) { stopped = true; break; }
    if (items.length >= limit) break;

    const url = buildSoundPageUrl(target, cursor, pageSize);
    let json: any;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHint(`采集中断：${msg}`, 'error');
      break;
    }

    const apiErr = describeApiError(json);
    if (apiErr) {
      setHint(`采集中断：${apiErr}`, 'error');
      break;
    }

    const pageRes = extractSoundPage(json, target.kind, cursor + pageSize);
    if (pageRes.items.length === 0) break;

    const before = items.length;
    items = dedupeItems([...items, ...pageRes.items]).slice(0, limit);
    if (items.length === before) break; // 重复返回同一批，停止

    renderGrid();
    showProgress(
      `已采集 ${items.length} / 上限 ${limit}`,
      items.length / limit,
      `第 ${page + 1} 页${pageRes.hasMore ? '' : '（已到末尾）'}`
    );

    if (!pageRes.hasMore) break;
    cursor = pageRes.cursor;
    await sleep(200); // 轻节流，避免高频请求
  }

  collecting = false;
  stopRequested = false;
  $<HTMLButtonElement>('#dyx-sound-parse').disabled = false;
  $<HTMLButtonElement>('#dyx-sound-stop').hidden = true;

  if (items.length === 0) {
    hideProgress();
    setHint('没有采集到作品，请确认链接是否有效', 'error');
    return;
  }

  showProgress(
    stopped ? `已停止，共采集 ${items.length} 个` : `采集完成，共 ${items.length} 个`,
    1,
    '可全选后「加入批量列表」，到批量页做 ZIP 打包或保存到文件夹'
  );
  const missingCount = collectMissingAuthorVids(items).length;
  setHint(
    (meta ? `已采集「${meta.title}」下 ${items.length} 个作品` : `已采集 ${items.length} 个作品`) +
      (missingCount ? `；其中 ${missingCount} 条缺作者，可点「补全作者」补齐` : ''),
    'ok'
  );

  // 默认全选，方便直接加入批量列表
  selected = new Set(items.map((i) => i.vid));
  renderGrid();
}

// ============ M4.1 作者补全 ============

// 纯原声接口返回的精简 aweme 不含 author，经既有 DYX_RESOLVE_ITEMS 链路
// （SW → 内容脚本 → 页面桥 → 详情接口）补齐昵称、抖音号、日期与统计
async function enrichAuthors(): Promise<void> {
  // 二次点击 = 请求停止
  if (enriching) {
    stopEnrichRequested = true;
    $<HTMLButtonElement>('#dyx-sound-enrich').textContent = '正在停止…';
    return;
  }

  const vids = collectMissingAuthorVids(items);
  if (vids.length === 0) return;

  enriching = true;
  stopEnrichRequested = false;
  const total = vids.length;
  let done = 0;
  let updatedTotal = 0;
  let failedTotal = 0;
  let stopped = false;
  let fatal = '';
  let fatalCode = '';

  const btn = $<HTMLButtonElement>('#dyx-sound-enrich');
  btn.textContent = '停止补全';
  showProgress(`补全作者 0/${total}`, 0, '串行请求，每条 ≥300ms；没有可用抖音页面时会自动开一个后台页代跑');

  for (const batch of chunk(vids, ENRICH_CHUNK)) {
    if (stopEnrichRequested) { stopped = true; break; }

    let resp: { results?: ResolveResult[]; error?: string; code?: string } | undefined;
    try {
      resp = await sendMsg<{ results?: ResolveResult[]; error?: string; code?: string }>({
        type: DYX_RESOLVE_ITEMS,
        vids: batch,
      });
    } catch (e) {
      fatal = e instanceof Error ? e.message : String(e);
      break;
    }
    if (resp?.error) {
      fatal = resp.error;
      fatalCode = resp.code || '';
      break;
    }

    const outcome = mergeResolvedDetails(items, resp?.results || []);
    items = outcome.items;
    updatedTotal += outcome.updated;
    failedTotal += outcome.failed;
    done += batch.length;

    renderGrid();
    showProgress(
      `补全作者 ${Math.min(done, total)}/${total}`,
      done / total,
      `成功 ${updatedTotal} 条，失败 ${failedTotal} 条`
    );
  }

  enriching = false;
  stopEnrichRequested = false;
  btn.textContent = '补全作者';

  // 联系不上抖音页面是最常见的前置失败，映射成可操作的提示而非 Chrome 英文原文
  if (fatal) {
    hideProgress();
    setHint(describeResolveFailure(fatalCode, fatal), 'error');
    updateEnrichButton();
    return;
  }

  // 此前已加入过批量列表的话，把补全后的数据重推一次（SW 按 vid 合并覆盖）
  if (addedToBatch && updatedTotal > 0) {
    try {
      await sendMsg({ type: DYX_ADD_ITEMS, list: 'batch', items });
    } catch {
      // 重推失败不影响页面展示，用户可手动再点一次「加入批量列表」
    }
  }

  hideProgress();
  const remain = collectMissingAuthorVids(items).length;
  setHint(
    `${stopped ? '已停止，' : ''}作者信息补全 ${updatedTotal} 条` +
      (failedTotal ? `，失败 ${failedTotal} 条` : '') +
      (remain ? `，仍有 ${remain} 条缺作者` : '') +
      (addedToBatch && updatedTotal > 0 ? '；批量列表已同步更新' : ''),
    remain ? 'info' : 'ok'
  );
  updateEnrichButton();
}

// ============ 动作 ============

function getSelectedItems(): VideoItem[] {
  const picked = items.filter((i) => selected.has(i.vid));
  return picked.length > 0 ? picked : items;
}

async function handleSingleDownload(item: VideoItem, btn: HTMLButtonElement): Promise<void> {
  if (!item.url) {
    btn.textContent = '无直链';
    setTimeout(() => { btn.textContent = '下载'; }, 1500);
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    const res = await fetch(item.url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const settings = await loadSettings();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = renderFilename(item, settings.fileNameFormat) + '.mp4';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    btn.textContent = '完成 ✓';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
  } catch {
    btn.textContent = '失败 ✗';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
  }
}

async function handleAddToBatch(): Promise<void> {
  const picked = getSelectedItems();
  if (picked.length === 0) return;
  const btn = $<HTMLButtonElement>('#dyx-sound-add');
  btn.disabled = true;
  try {
    const resp = await sendMsg<{ total: number }>({ type: DYX_ADD_ITEMS, list: 'batch', items: picked });
    addedToBatch = true;
    btn.textContent = `已加入（共 ${resp?.total ?? '?'}）`;
  } catch {
    btn.textContent = '加入失败';
  }
  setTimeout(() => { btn.textContent = '加入批量列表'; btn.disabled = false; }, 1800);
}

async function handleExportCsv(): Promise<void> {
  const picked = getSelectedItems();
  if (picked.length === 0) return;
  const settings = await loadSettings();
  const keys = settings.exportFields?.length ? settings.exportFields : ALL_EXPORT_KEYS;
  const csv = generateCsv(picked, keys);
  if (!csv) return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = buildExportFilename();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ============ 初始化 ============

function init(): void {
  applyVersionLabel('.dyx-sound-ver');
  $<HTMLButtonElement>('#dyx-sound-parse').addEventListener('click', () => { void handleParse(); });

  $<HTMLInputElement>('#dyx-sound-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void handleParse();
  });

  $<HTMLButtonElement>('#dyx-sound-stop').addEventListener('click', () => {
    stopRequested = true;
    $<HTMLButtonElement>('#dyx-sound-stop').hidden = true;
  });

  $<HTMLButtonElement>('#dyx-sound-select-all').addEventListener('click', () => {
    selected = new Set(items.map((i) => i.vid));
    renderGrid();
  });

  $<HTMLButtonElement>('#dyx-sound-invert').addEventListener('click', () => {
    const next = new Set<string>();
    for (const i of items) if (!selected.has(i.vid)) next.add(i.vid);
    selected = next;
    renderGrid();
  });

  $<HTMLButtonElement>('#dyx-sound-enrich').addEventListener('click', () => { void enrichAuthors(); });

  $<HTMLButtonElement>('#dyx-sound-add').addEventListener('click', () => { void handleAddToBatch(); });
  $<HTMLButtonElement>('#dyx-sound-csv').addEventListener('click', () => { void handleExportCsv(); });
  $<HTMLButtonElement>('#dyx-sound-open-batch').addEventListener('click', () => {
    void sendMsg({ type: DYX_OPEN_BATCH });
  });

  renderGrid();
  updateCounts();
}

init();
