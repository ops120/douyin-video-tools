// 原声采集（M4）：链接解析、接口 URL 拼接、aweme → VideoItem 映射、分页去重
// 纯逻辑模块，不依赖 DOM 与 chrome API，便于单测

import type { VideoItem } from './types.js';

// 采集对象：趋势活动（带 trends_id）或纯原声（只有 music_id）
export type SoundKind = 'trends' | 'music';

export interface SoundTarget {
  kind: SoundKind;
  musicId: string;
  trendsId?: string;
  ugId?: string;
  // 趋势接口的 original_material 参数，原样透传分享链接里的 original_materials
  originalMaterial?: string;
}

export interface SoundMeta {
  musicId: string;
  title: string;
  author: string;
  cover: string;
  duration: number;
  userCount: number;
}

export interface SoundPageResult {
  items: VideoItem[];
  hasMore: boolean;
  cursor: number;
}

// 解析结果：命中 / 需要先跟随短链跳转 / 明确不支持
export type SoundInputResult =
  | { ok: true; target: SoundTarget }
  | { ok: false; needsResolve: true; url: string }
  | { ok: false; needsResolve: false; reason: string };

const SHORT_LINK_HOSTS = new Set(['v.douyin.com', 'v.iesdouyin.com']);

// 采集上限：默认 100，硬上限 1000（趋势列表可无限翻页，必须设闸）
export const SOUND_LIMIT_DEFAULT = 100;
export const SOUND_LIMIT_MAX = 1000;

// 分享文案里常带一大段文字，抽出其中第一个 http(s) 链接
export function extractUrl(text: string): string | null {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>）)】\]]+/);
  return m ? m[0] : null;
}

// 短链需要先跟随 302 才能拿到最终地址
export function isShortLink(url: string): boolean {
  try {
    return SHORT_LINK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// 纯数字 music_id
function isBareId(text: string): boolean {
  return /^\d{10,25}$/.test(text.trim());
}

// 解析最终形态的 URL 或纯数字 ID
function parseFinal(url: string): SoundTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');

  // 分享落地页：/share/trends/ 与 /share/music/
  if (host === 'www.iesdouyin.com' || host === 'iesdouyin.com') {
    const musicId = u.searchParams.get('music_id') || '';
    if (path.startsWith('/share/trends')) {
      const trendsId = u.searchParams.get('trends_id') || '';
      if (!trendsId) return null;
      return {
        kind: 'trends',
        musicId,
        trendsId,
        ugId: u.searchParams.get('ug_id') || undefined,
        originalMaterial: u.searchParams.get('original_materials') || undefined,
      };
    }
    if (path.startsWith('/share/music')) {
      if (!musicId) return null;
      return { kind: 'music', musicId };
    }
    return null;
  }

  // 桌面站：/music/{id}
  if (host === 'www.douyin.com' || host === 'douyin.com') {
    const m = path.match(/^\/music\/(\d{8,25})$/);
    if (m) return { kind: 'music', musicId: m[1] };
    return null;
  }

  return null;
}

// 统一入口：接受分享文案 / 各种链接 / 纯数字 ID
export function parseSoundInput(raw: string): SoundInputResult {
  const text = String(raw || '').trim();
  if (!text) {
    return { ok: false, needsResolve: false, reason: '请输入原声链接或分享文案' };
  }

  if (isBareId(text)) {
    return { ok: true, target: { kind: 'music', musicId: text } };
  }

  const url = extractUrl(text);
  if (!url) {
    return { ok: false, needsResolve: false, reason: '没找到链接，请粘贴完整分享文案或链接' };
  }

  if (isShortLink(url)) {
    return { ok: false, needsResolve: true, url };
  }

  const target = parseFinal(url);
  if (!target) {
    return {
      ok: false,
      needsResolve: false,
      reason: '暂不支持这种链接，请用原声页、活动页或 v.douyin.com 分享短链',
    };
  }
  return { ok: true, target };
}

// 分页接口地址
export function buildSoundPageUrl(target: SoundTarget, cursor: number, count: number): string {
  if (target.kind === 'trends') {
    const q = new URLSearchParams({
      trends_id: target.trendsId || '',
      flash_mob_id: '',
      music_id: target.musicId,
      ug_id: target.ugId || '',
      trends_detail_enter_from: '5',
      count: String(count),
      cursor: String(cursor),
    });
    if (target.originalMaterial) q.set('original_material', target.originalMaterial);
    return `https://www.iesdouyin.com/aweme/v1/trends/aweme/?${q.toString()}`;
  }

  const q = new URLSearchParams({
    music_id: target.musicId,
    count: String(count),
    cursor: String(cursor),
  });
  return `https://www.iesdouyin.com/web/api/v2/music/list/aweme/?${q.toString()}`;
}

// 原声信息接口（趋势链接也带 music_id，同样能取到原声标题与作者）
export function buildSoundInfoUrl(musicId: string): string {
  const q = new URLSearchParams({ music_id: musicId });
  return `https://www.iesdouyin.com/web/api/v2/music/info/?${q.toString()}`;
}

function normalizeUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('http:')) return url.replace(/^http:/, 'https:');
  return url;
}

// 最高码率直链：按 play_addr.width 降序，URL 优先 https://www.douyin.com 同域
export function pickBestUrl(video: any): string | null {
  const bitRates: any[] = video?.bit_rate;
  if (Array.isArray(bitRates) && bitRates.length > 0) {
    const sorted = [...bitRates].sort(
      (a, b) => (b?.play_addr?.width || 0) - (a?.play_addr?.width || 0)
    );
    const top = sorted[0]?.play_addr;
    if (top?.url_list?.length) {
      const sameDomain = top.url_list.find((u: string) =>
        String(u).startsWith('https://www.douyin.com')
      );
      return normalizeUrl(sameDomain || top.url_list[0]);
    }
  }
  const playAddr = video?.play_addr;
  if (playAddr?.url_list?.[0]) return normalizeUrl(playAddr.url_list[0]);
  return null;
}

// create_time（秒）→ YYYY-MM-DD；缺省留空（原声接口的精简 aweme 不带该字段）
function formatDate(sec: number): string {
  if (!sec || sec <= 0) return '';
  const d = new Date(sec * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// aweme → VideoItem。趋势接口是完整对象（含 author/create_time），
// 原声接口是精简对象（缺 author/create_time/collect_count），故各字段一律兜底。
export function mapAwemeToItem(aweme: any): VideoItem {
  const ts = Number(aweme?.create_time) || 0;
  return {
    vid: String(aweme?.aweme_id || ''),
    title: aweme?.desc || '抖音视频',
    name: aweme?.author?.nickname || '',
    uniqueId: aweme?.author?.unique_id || '',
    secUid: aweme?.author?.sec_uid || '',
    date: formatDate(ts),
    duration: Number(aweme?.video?.duration) || 0,
    cover: normalizeUrl(aweme?.video?.cover?.url_list?.[0] || ''),
    url: pickBestUrl(aweme?.video) || '',
    statistics: {
      digg: Number(aweme?.statistics?.digg_count) || 0,
      comment: Number(aweme?.statistics?.comment_count) || 0,
      collect: Number(aweme?.statistics?.collect_count) || 0,
      share: Number(aweme?.statistics?.share_count) || 0,
    },
    source: 'sound',
    addedAt: Date.now(),
    status: 'ready',
  };
}

// 从一页响应里取出作品、是否还有下一页、下一页游标
export function extractSoundPage(json: any, kind: SoundKind, fallbackCursor: number): SoundPageResult {
  const rawList: any[] =
    kind === 'trends'
      ? Array.isArray(json?.trends_aweme_list)
        ? json.trends_aweme_list
        : []
      : Array.isArray(json?.aweme_list)
        ? json.aweme_list
        : [];

  const items: VideoItem[] = [];
  for (const entry of rawList) {
    // 趋势接口把 aweme 包在 { aweme: {...} } 里，原声接口直接给 aweme
    const aweme = entry?.aweme || entry;
    if (!aweme?.aweme_id) continue;
    items.push(mapAwemeToItem(aweme));
  }

  const cursor = Number(json?.cursor);
  return {
    items,
    hasMore: Boolean(json?.has_more),
    cursor: Number.isFinite(cursor) ? cursor : fallbackCursor,
  };
}

// 原声信息（music_info）
export function parseSoundInfo(json: any): SoundMeta | null {
  const info = json?.music_info;
  if (!info) return null;
  const cover =
    info.cover_hd?.url_list?.[0] ||
    info.cover_large?.url_list?.[0] ||
    info.cover_medium?.url_list?.[0] ||
    '';
  return {
    musicId: String(info.mid || ''),
    title: info.title || '',
    author: info.author || '',
    cover: normalizeUrl(cover),
    duration: Number(info.duration) || 0,
    userCount: Number(info.user_count) || 0,
  };
}

// 接口层错误：status_code 非 0 时给出可读信息
export function describeApiError(json: any): string | null {
  const code = json?.status_code;
  if (code === undefined || code === null || code === 0) return null;
  const msg = json?.status_msg || json?.status_message || '';
  return `接口返回错误（code=${code}${msg ? `，${msg}` : ''}）`;
}

// 按 vid 去重，保留先出现的
export function dedupeItems(items: VideoItem[]): VideoItem[] {
  const seen = new Set<string>();
  const out: VideoItem[] = [];
  for (const item of items) {
    if (!item.vid || seen.has(item.vid)) continue;
    seen.add(item.vid);
    out.push(item);
  }
  return out;
}

// 采集上限收敛到 [1, SOUND_LIMIT_MAX]
export function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return SOUND_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), 1), SOUND_LIMIT_MAX);
}

// ============================================================
// M4.1：作者信息补全
// 纯原声接口返回的精简 aweme 不含 author，需经详情接口补齐；
// 下列函数只做数据搬运，实际请求由调用方经 DYX_RESOLVE_ITEMS 发起。
// ============================================================

// 详情接口返回的单条结果（与内容脚本 ResolveResultFromCS 同构）
export interface ResolveResult {
  vid: string;
  item?: Partial<VideoItem>;
  error?: string;
}

export interface MergeOutcome {
  items: VideoItem[];
  updated: number;
  failed: number;
}

// 缺作者的 vid 列表（已是空数组说明无需补全）
export function collectMissingAuthorVids(items: VideoItem[]): string[] {
  const vids: string[] = [];
  for (const item of items) {
    if (item.vid && !item.name) vids.push(item.vid);
  }
  return vids;
}

// 切片：用于把补全请求分成多批，避免单条消息通道长时间挂起
export function chunk<T>(arr: T[], size: number): T[][] {
  const n = Math.max(1, Math.trunc(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// 把详情结果并回列表：保留采集时的 source 与 addedAt，其余字段取新值
// 判成功的标准是拿到 item 且带作者昵称；解析出错或无作者均计入 failed
export function mergeResolvedDetails(items: VideoItem[], results: ResolveResult[]): MergeOutcome {
  const byVid = new Map<string, VideoItem>(items.map((i) => [i.vid, i]));
  let updated = 0;
  let failed = 0;

  for (const r of results) {
    const current = byVid.get(r.vid);
    const patch = r.item;
    if (!current || !patch || !patch.name) {
      failed++;
      continue;
    }
    byVid.set(r.vid, {
      ...current,
      ...patch,
      source: current.source,
      addedAt: current.addedAt,
    });
    updated++;
  }

  return { items: items.map((i) => byVid.get(i.vid) || i), updated, failed };
}
