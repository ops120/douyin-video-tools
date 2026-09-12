// 直链解析 + 下载执行器（按 PRD §3.1 FR-A2/A3/A4/A5）
// M3：新增 parseGoodsInfo 解析商品信息（研究报告 §6.2 U(e) 逻辑）

import type { VideoItem, VideoGoods } from '../shared/types.js';
import { dyxFetch, getWebId } from './bridge.js';
import { renderFilename } from '../shared/filename.js';
import { loadSettings } from '../shared/settings.js';

// 内存缓存：key=vid，TTL 30 分钟（直链有时效），最多 200 条（超出淘汰最旧）
const CACHE_TTL = 30 * 60 * 1000;
const DETAIL_CACHE_MAX = 200;
const detailCache = new Map<string, { data: any; ts: number }>();

// 淘汰最旧条目（Map 插入序 = 插入时间序）
function evictDetailCache(): void {
  while (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next().value;
    if (oldest) detailCache.delete(oldest);
    else break;
  }
}

function getCachedDetail(vid: string): any | null {
  const entry = detailCache.get(vid);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    detailCache.delete(vid);
    return null;
  }
  return entry.data;
}

function setCachedDetail(vid: string, data: any): void {
  detailCache.set(vid, { data, ts: Date.now() });
  evictDetailCache();
}

// 重试前失效缓存，避免用过期直链重试
export function invalidateDetail(vid: string): void {
  detailCache.delete(vid);
}

// 供内容脚本 bs.ts 捕获响应时调用（vid 为调用方已知，detail 内 aweme_id 优先）
export function cacheCapturedDetail(vid: string, res: any): void {
  const detail = res?.aweme_detail || res;
  const resolvedVid = detail?.aweme_id ? String(detail.aweme_id) : vid;
  if (resolvedVid) {
    setCachedDetail(resolvedVid, detail);
  }
}

// 详情接口参数白名单（严格按原版实现，签名参数一律丢弃）
// 每个字段：捕获值 ?? 默认值
const DETAIL_PARAM_DEFAULTS: Record<string, string> = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  update_version_code: '170400',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1835',
  screen_height: '1032',
  browser_language: 'zh-CN',
  browser_platform: 'Linux x86_64',
  browser_name: 'Chrome',
  browser_version: '124.0.0.0',
  browser_online: 'true',
  engine_name: 'Blink',
  engine_version: '124.0.0.0',
  os_name: 'Linux',
  os_version: 'x86_64',
  cpu_core_num: '16',
  device_memory: '8',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  round_trip_time: '50',
};

// webid 缓存（从页面 localStorage 读取，启动时取一次）
let cachedWebId: string | null = null;

// 预取 webid（启动时调用，异步不阻塞）
export function prefetchWebId(): void {
  getWebId().then((id) => {
    if (id) {
      cachedWebId = id;
      console.log(`[抖存] webid 已缓存: ${id.slice(0, 8)}...`);
    } else {
      console.log('[抖存] webid 读取为空，使用兜底值');
    }
  }).catch(() => {
    console.log('[抖存] webid 读取失败，使用兜底值');
  });
}

const FALLBACK_WEBID = '7373573059258828323';

// 严格白名单构造：只输出白名单字段，签名参数一律丢弃
export function buildDetailUrl(vid: string, savedParams: Record<string, string> = {}): string {
  const entries: [string, string][] = [];

  for (const [key, defaultVal] of Object.entries(DETAIL_PARAM_DEFAULTS)) {
    const val = savedParams[key] ?? defaultVal;
    entries.push([key, String(val)]);
  }

  // webid：优先缓存的页面值，其次捕获值，最后兜底
  const webid = cachedWebId || savedParams['webid'] || FALLBACK_WEBID;
  entries.push(['webid', webid]);

  // aweme_id 追加在最后
  entries.push(['aweme_id', vid]);

  console.log(`[抖存] detail 请求参数 keys=[${entries.map(([k]) => k).join(', ')}]`);

  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://www.douyin.com/aweme/v1/web/aweme/detail/?${qs}`;
}

// 码率选择：按 play_addr.width 降序取第一，URL 优先 https://www.douyin.com 开头
function selectBitrate(detail: any): string | null {
  const bitRates: any[] = detail?.video?.bit_rate;
  if (!Array.isArray(bitRates) || bitRates.length === 0) {
    // 兜底：play_addr
    const playAddr = detail?.video?.play_addr;
    if (playAddr?.url_list?.[0]) return normalizeUrl(playAddr.url_list[0]);
    return null;
  }
  const sorted = [...bitRates].sort(
    (a, b) => (b?.play_addr?.width || 0) - (a?.play_addr?.width || 0)
  );
  const top = sorted[0]?.play_addr;
  if (!top?.url_list?.length) return null;
  // 优先同域直链
  const sameDomain = top.url_list.find((u: string) => u.startsWith('https://www.douyin.com'));
  return normalizeUrl(sameDomain || top.url_list[0]);
}

// http 一律替换为 https
function normalizeUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('http:')) return url.replace(/^http:/, 'https:');
  return url;
}

// M3：解析商品信息（研究报告 §6.2 U(e) 逻辑）
// detail.anchor_info.type === 3 时解析 anchor_info.extra（JSON 字符串数组）
export function parseGoodsInfo(detail: any): VideoGoods | undefined {
  const anchor = detail?.anchor_info;
  if (!anchor || anchor.type !== 3) return undefined;
  const extra = anchor.extra;
  if (!extra) return undefined;
  try {
    const arr = JSON.parse(extra);
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const e = arr[0];
    // price 单位为分，除以 100 保留两位；缺失时兜底 price_info.price
    let price = '';
    if (e.price != null) {
      price = (e.price / 100).toFixed(2);
    } else if (e.price_info?.price != null) {
      price = (e.price_info.price / 100).toFixed(2);
    }
    return {
      productId: e.product_id || '',
      title: e.title || '',
      price,
      sales: e.sales != null ? String(e.sales) : '',
      url: e.jump_schema || '',
      goodsImage: e.elastic_images?.[0]?.url_list?.[0] || '',
    };
  } catch {
    return undefined;
  }
}

// 从 detail 响应解析出 VideoItem（含最高码率直链 + 商品信息）
function parseDetail(detail: any): VideoItem {
  const vid = String(detail.aweme_id || detail.vid || '');
  const createTime = detail.create_time ? new Date(detail.create_time * 1000) : new Date();
  const y = createTime.getFullYear();
  const m = String(createTime.getMonth() + 1).padStart(2, '0');
  const d = String(createTime.getDate()).padStart(2, '0');
  const date = `${y}-${m}-${d}`;

  return {
    vid,
    title: detail.desc || '抖音视频',
    name: detail.author?.nickname || '',
    uniqueId: detail.author?.unique_id || '',
    secUid: detail.author?.sec_uid || '',
    date,
    duration: detail.video?.duration || 0,
    cover: normalizeUrl(detail.video?.cover?.url_list?.[0] || ''),
    url: selectBitrate(detail) || '',
    mixId: detail.mix_info?.mix_id || undefined,
    mixName: detail.mix_info?.mix_name || undefined,
    statistics: {
      digg: detail.statistics?.digg_count || 0,
      comment: detail.statistics?.comment_count || 0,
      collect: detail.statistics?.collect_count || 0,
      share: detail.statistics?.share_count || 0,
    },
    goods: parseGoodsInfo(detail),
    source: 'detail',
    addedAt: Date.now(),
    status: 'ready',
  };
}

// 解析直链（优先级：缓存 → bridge 请求 → 缓存兜底）
export async function resolveVideoUrl(vid: string): Promise<VideoItem> {
  // ① 缓存命中
  let detail = getCachedDetail(vid);
  if (detail) {
    console.log(`[抖存] 解析来源=缓存 vid=${vid}`);
    return parseDetail(detail);
  }

  // ② 经 bridge 发 detail 请求（严格白名单参数，不带签名）
  console.log(`[抖存] 解析来源=桥请求 vid=${vid}`);
  let savedParams: Record<string, string> = {};
  try {
    const stored = await new Promise<any>((resolve) => {
      chrome.storage.local.get(['dyx:requestParams'], (r) => resolve(r['dyx:requestParams'] || {}));
    });
    savedParams = stored;
  } catch {
    // storage 不可用时用默认值
  }
  const url = buildDetailUrl(vid, savedParams);
  let res: any;
  try {
    res = await dyxFetch(url, { credentials: 'include' });
  } catch (fetchErr) {
    // 请求本身失败（超时/网络/NON_JSON），尝试缓存兜底
    const fallback = getCachedDetail(vid);
    if (fallback) {
      const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.warn(`[抖存] 桥请求失败(${errMsg})，缓存兜底 vid=${vid}`);
      return parseDetail(fallback);
    }
    throw fetchErr;
  }

  detail = res?.aweme_detail || res;
  if (!detail || !detail.aweme_id) {
    // 200 但无 aweme_detail：打印响应摘要用于诊断
    const topKeys = res ? Object.keys(res).slice(0, 10) : [];
    console.warn(`[抖存] 解析失败: 无 aweme_detail vid=${vid} status_code=${res?.status_code} top_keys=[${topKeys}]`);

    // 兜底：再次尝试缓存（时序问题：用户点得比页面响应快）
    const fallback = getCachedDetail(vid);
    if (fallback) {
      console.warn(`[抖存] 桥请求无数据，缓存兜底 vid=${vid}`);
      return parseDetail(fallback);
    }

    throw new Error('E1006');
  }
  // 缓存
  setCachedDetail(vid, detail);
  console.log(`[抖存] 解析成功来源=桥请求 vid=${vid}`);
  return parseDetail(detail);
}

// 下载执行器
// 第三轮修复 #5：content-length 未知时 percent=-1，新增 received 字段
export interface DownloadProgress {
  percent: number;
  received?: number;
}

export async function downloadVideo(
  item: VideoItem,
  onProgress?: (p: DownloadProgress) => void,
  onLargeFile?: (sizeMB: number) => void
): Promise<void> {
  let url = item.url;
  if (!url) throw new Error('E1003');
  url = normalizeUrl(url);

  console.log(`[抖存] 开始下载 vid=${item.vid}`);
  const res = await fetch(url);
  if (!res.ok) {
    // 403 基本是直链过期/防盗链，不是风控；404 表示视频已删除或不可用
    if (res.status === 403) throw new Error('E1003');
    if (res.status === 404) throw new Error('E1007');
    throw new Error('E1004');
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);

  // PRD §3.1 FR-A2：单条视频 >300MB 提示（不阻断下载，只提示一次）
  const LARGE_FILE_THRESHOLD = 300 * 1024 * 1024;
  if (contentLength > LARGE_FILE_THRESHOLD && onLargeFile) {
    const sizeMB = Math.round(contentLength / (1024 * 1024));
    console.warn(`[DouCun] 文件较大: ${sizeMB}MB (vid=${item.vid})`);
    onLargeFile(sizeMB);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('E1004');

  const chunks: ArrayBuffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 拷贝为独立 ArrayBuffer，避开 SharedArrayBuffer 类型不兼容
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    chunks.push(copy.buffer);
    received += value.byteLength;
    // 第三轮修复 #5：content-length 未知时 percent=-1，始终回调 received
    if (onProgress) {
      if (contentLength > 0) {
        onProgress({ percent: Math.round((received / contentLength) * 100), received });
      } else {
        onProgress({ percent: -1, received });
      }
    }
  }

  const blob = new Blob(chunks, { type: 'video/mp4' });
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
}

// 带重试的下载入口（失败自动重试 1 次，间隔 1s；重试前失效缓存避免用过期直链）
export async function downloadWithRetry(
  vid: string,
  onProgress?: (p: DownloadProgress) => void,
  onLargeFile?: (sizeMB: number) => void
): Promise<VideoItem> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const item = await resolveVideoUrl(vid);
      await downloadVideo(item, onProgress, onLargeFile);
      return item;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) {
        // 重试前清缓存，让 resolveVideoUrl 重新走 bridge 请求拿新直链
        invalidateDetail(vid);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr;
}
