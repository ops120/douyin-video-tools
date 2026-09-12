// 按 PRD §3.1 FR-A1：三级兜底定位，覆盖 4 类页面。
// 所有页面选择器集中于此，页面改版只改这一处。
// 第四轮修复：路径归一化——抖音新版搜索页带 /root 前缀（/root/search/...），分类前先剥离。
// 第六轮修复：新版搜索页 vid 解析——从父元素 waterfall_item_* id 取 vid；图文帖用 .videoImage innerText 排除；封面文件 ID 匹配兜底。

import type { PageType } from '../shared/types.js';

// ① 一级：data-e2e 属性（最稳）
const DATA_E2E_SELECTORS = {
  // 首页推荐流：当前活跃视频卡片
  feed: '[data-e2e="feed-active-video"]',
  // 用户主页作品列表容器
  userPostList: '[data-e2e="user-post-list"]',
  // 搜索页结果卡片
  searchCard: '.search-result-card',
  // 用户主页「作品」tab 下的视频卡片
  userVideoCard: '[data-e2e="user-post-list"] a[href*="/video/"]',
};

// ③ 三级：data-e2e-vid 属性兜底
const VID_ATTR = 'data-e2e-vid';

export interface CardInfo {
  el: Element;
  vid: string | null;
}

// 搜索页 vid 解析策略
export type SearchVidStrategy = 'waterfall-id' | 'anchor' | 'cover-match' | 'none';

export interface SearchCardInfo {
  el: Element;
  vid: string | null;
  strategy: SearchVidStrategy;
}

/**
 * 归一化路径：剥离 /root 前缀。
 * /root/search/x → /search/x；/root/ → /；/root/video/1 → /video/1
 * 仅剥离位于开头且后跟 / 或结尾的 /root。
 */
export function normalizePathname(pathname: string): string {
  return pathname.replace(/^\/root(?=\/|$)/, '');
}

/**
 * 纯函数：根据 pathname 判断页面类型（可单测）。
 * 归一化 /root 前缀后，按路径段匹配。
 */
export function classifyPath(pathname: string): PageType {
  const p = normalizePathname(pathname);
  if (/^\/video\//.test(p)) return 'detail';
  if (/\/search/.test(p)) return 'search';
  if (/^\/user\//.test(p)) return 'user';
  if (p === '/' || p === '/home' || p.startsWith('/follow') || p.startsWith('/hot')) return 'feed';
  return 'unknown';
}

// 薄封装：读取当前 location.pathname 并调用 classifyPath（保留向后兼容）
export function getCurrentPageType(): PageType {
  return classifyPath(location.pathname);
}

/**
 * 第六轮修复：从封面图 URL 提取文件 ID。
 * 抖音封面 URL 形如：
 *   https://p-pc-weboff.douyinpic.com/.../<fileId>~tplv-dy-cropcenter:323:430.jpeg?...
 *   https://p-pc-weboff.douyinpic.com/.../<fileId>~tplv-dy-360p.jpeg?...
 * 提取 ~tplv- 前的最后一段路径名作为文件 ID。
 */
export function extractCoverFileId(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/([^/~?]+)~tplv-/);
  return m ? m[1] : null;
}

/**
 * 第六轮修复：用封面文件 ID 在已捕获的 aweme 条目中匹配。
 * 唯一命中返回 aweme_id，多命中或 0 命中返回 null（避免误配）。
 */
export function matchAwemeByCoverFileId(
  fileId: string,
  items: Array<{ vid: string; aweme: any }>,
): string | null {
  if (!fileId || !items.length) return null;
  let matchedVid: string | null = null;
  for (const { vid, aweme } of items) {
    const urls: string[] = [
      aweme?.video?.cover?.url_list,
      aweme?.video?.origin_cover?.url_list,
      aweme?.video?.dynamic_cover?.url_list,
    ]
      .filter(Array.isArray)
      .flat();
    for (const u of urls) {
      if (extractCoverFileId(u) === fileId) {
        if (matchedVid && matchedVid !== vid) return null; // 多命中
        matchedVid = vid;
      }
    }
  }
  return matchedVid;
}

/**
 * 第六轮修复：检查元素自身及最多 2 层祖先，匹配 waterfall_item_<digits> 格式的 id。
 * 抖音新版搜索页：.search-result-card 的父元素带 id="waterfall_item_<aweme_id>"。
 */
function extractVidFromWaterfallId(el: Element): string | null {
  let cur: Element | null = el;
  for (let i = 0; i < 3 && cur; i++) {
    const id = cur.id;
    const m = id && id.match(/^waterfall_item_(\d+)$/);
    if (m) return m[1];
    cur = cur.parentElement;
  }
  return null;
}

// 从元素提取 aweme_id（四种策略：waterfall-id → data-e2e-vid → a[href] → data-*）
export function extractVid(el: Element): string | null {
  // 第六轮修复：策略 0（最高优先级）——父元素 waterfall_item_* id
  const fromWaterfall = extractVidFromWaterfallId(el);
  if (fromWaterfall) return fromWaterfall;

  // 策略 1：data-e2e-vid 属性
  const vidAttr = el.getAttribute(VID_ATTR);
  if (vidAttr) return vidAttr;

  // 策略 2：自身或子元素 a[href*="/video/"]
  const link = el.tagName === 'A' ? el : el.querySelector('a[href*="/video/"]');
  if (link) {
    const href = (link as HTMLAnchorElement).href || link.getAttribute('href') || '';
    const m = href.match(/\/video\/(\d+)/);
    if (m) return m[1];
  }

  // 策略 3：任意 data-* 属性含数字 ID
  const allAttrs = el.getAttributeNames();
  for (const name of allAttrs) {
    if (/^data-/i.test(name)) {
      const v = el.getAttribute(name) || '';
      if (/^\d{15,25}$/.test(v.trim())) return v.trim();
    }
  }
  return null;
}

/**
 * 第六轮修复：检查 .videoImage 的 innerText 是否含"图文"（图文帖排除，对齐原产品）。
 */
function isImageTextPost(card: Element): boolean {
  const vi = card.querySelector('.videoImage');
  return !!(vi && (vi.textContent || '').includes('图文'));
}

/**
 * 从锚点元素向上遍历，找到恰好只含 1 个视频链接的最大祖先容器（即卡片容器）。
 * 不变式：返回的容器内 a[href*="/video/"] 的数量 === 1，确保 extractVid 必然取到正确 vid。
 * 算法：从 a.parentElement 起向上走，只要当前元素内视频链接数恰好为 1 就继续向上并记录；
 *       遇到数量 >1 的容器立即停止，返回"仍只含 1 个视频链接的最大祖先"；
 *       若从未满足则回退 a.parentElement。
 */
function findCardContainer(a: HTMLAnchorElement): Element {
  let best: Element = a.parentElement!;
  let cur: Element | null = a.parentElement;
  while (cur) {
    const count = cur.querySelectorAll('a[href*="/video/"]').length;
    if (count === 1) {
      best = cur;
      cur = cur.parentElement;
    } else {
      // count > 1（或 0，但 0 不应发生因为 a 本身在 cur 内），停止上溯
      break;
    }
  }
  return best;
}

// 第四轮修复：诊断日志——每次扫描后打印汇总，避免高频刷屏（仅在数量变化时打印）
let _lastCardCount = -1;
let _lastInjectCount = -1;

/**
 * 打印扫描注入汇总日志（非搜索页）。
 * @param pageType 页面类型
 * @param cardCount 扫描到的卡片数
 * @param injectCount 实际注入数（可选，由调用方计算）
 */
export function logInjectSummary(pageType: PageType, cardCount: number, injectCount?: number): void {
  const inj = injectCount ?? cardCount;
  if (cardCount === _lastCardCount && inj === _lastInjectCount) return;
  _lastCardCount = cardCount;
  _lastInjectCount = inj;
  console.log(`[抖存] 页面类型=${pageType} 卡片=${cardCount} 注入=${inj}`);
  if (pageType === 'unknown') {
    console.log(`[抖存] 未知页面类型 path=${location.pathname} 兜底扫描到 ${cardCount} 个视频链接`);
  }
}

// 第六轮修复：搜索页诊断日志独立跟踪（避免与非搜索页日志互相覆盖）
let _lastSearchCardCount = -1;
let _lastSearchInjectCount = -1;
let _lastSearchStrategy = '';

/**
 * 第六轮修复：打印搜索页注入汇总日志（含策略信息）。
 * 仅在数值变化时打印，避免 MutationObserver 高频刷屏。
 */
export function logSearchInjectSummary(
  cardCount: number,
  injectCount: number,
  strategy: string,
): void {
  if (
    cardCount === _lastSearchCardCount
    && injectCount === _lastSearchInjectCount
    && strategy === _lastSearchStrategy
  ) return;
  _lastSearchCardCount = cardCount;
  _lastSearchInjectCount = injectCount;
  _lastSearchStrategy = strategy;
  console.log(`[抖存] 搜索页注入 卡片=${cardCount} 注入=${injectCount} 策略=${strategy}`);
}

// 查找视频卡片（三级兜底 + 第四轮修复：unknown 兜底分支）
export function findVideoCards(): CardInfo[] {
  const pageType = getCurrentPageType();
  const seen = new Set<Element>();
  const result: CardInfo[] = [];

  const addCard = (el: Element) => {
    if (seen.has(el)) return;
    seen.add(el);
    result.push({ el, vid: extractVid(el) });
  };

  // 通用兜底扫描：所有 /video/ 链接向上找到只含 1 个视频链接的卡片容器，排除 /note/
  const scanAllVideoLinks = () => {
    document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
      const href = (a as HTMLAnchorElement).getAttribute('href') || '';
      if (href.includes('/note/')) return;
      const card = findCardContainer(a as HTMLAnchorElement);
      if (card) addCard(card);
    });
  };

  if (pageType === 'feed') {
    // 推荐流：优先 data-e2e，否则 a[href*="/video/"] 向上找卡片容器
    const active = document.querySelector(DATA_E2E_SELECTORS.feed);
    if (active) addCard(active);
    // 兜底：所有 /video/ 链接向上找到只含 1 个视频链接的卡片容器
    scanAllVideoLinks();
  } else if (pageType === 'detail') {
    // 详情页：直接从 pathname 取 vid，绝不扫 DOM（避免命中侧边推荐位导致下错视频）
    // 不走 addCard/extractVid，直接把 pathname 解析出的 vid 推入结果，保证 vid 正确
    // /root/video/123 也能正确匹配（正则不锚定开头）
    const vid = location.pathname.match(/\/video\/(\d+)/)?.[1];
    if (vid) {
      result.push({ el: document.body, vid });
    }
    // pathname 无 vid 则返回空，不兜底扫 DOM
    return result;
  } else if (pageType === 'search') {
    // 搜索页：.search-result-card
    document.querySelectorAll(DATA_E2E_SELECTORS.searchCard).forEach(addCard);
    // 兜底：所有 /video/ 链接向上找到只含 1 个视频链接的卡片容器
    if (result.length === 0) {
      scanAllVideoLinks();
    }
  } else if (pageType === 'user') {
    // 用户主页作品列表
    const list = document.querySelector(DATA_E2E_SELECTORS.userPostList);
    if (list) {
      list.querySelectorAll('a[href*="/video/"]').forEach((a) => {
        const card = findCardContainer(a as HTMLAnchorElement);
        if (card) addCard(card);
      });
    }
    // 兜底：全页 /video/ 链接向上找到只含 1 个视频链接的卡片容器
    if (result.length === 0) {
      scanAllVideoLinks();
    }
  } else {
    // 第四轮修复：unknown 页面兜底——扫描所有 /video/ 链接，排除 /note/
    scanAllVideoLinks();
  }

  return result;
}

// 第六轮修复：封面匹配所需的缓存条目类型（由 index.ts 传入，避免循环依赖）
export interface CoverMatchEntry {
  vid: string;
  aweme: any;
}

// M3：搜索页结果卡片（含 /video/ 链接的 .search-result-card），排除图文作品（/note/）
// 第四轮修复：主选择器为 .search-result-card；若匹配数为 0，退化为扫描 /video/ 链接 + findCardContainer
// 第六轮修复：删除"必须含 /video/ 链接"过滤（新版搜索页 0 个 /video/ 链接）；
//   图文帖排除改为 .videoImage innerText 含"图文"；新增 waterfall_item_* id 策略与封面文件 ID 匹配兜底
export function findSearchCards(cacheEntries: CoverMatchEntry[] = []): SearchCardInfo[] {
  const result: SearchCardInfo[] = [];
  const seen = new Set<Element>();

  // 主路径：.search-result-card（不再要求含 /video/ 链接）
  document.querySelectorAll('.search-result-card').forEach((card) => {
    if (seen.has(card)) return;
    // /note/ 链接检查保留为次要条件
    if (card.querySelector('a[href*="/note/"]')) return;
    // 第六轮修复：图文帖排除——.videoImage innerText 含"图文"则跳过（对齐原产品）
    if (isImageTextPost(card)) return;
    seen.add(card);

    // 第六轮修复：vid 提取策略链
    // 策略 1（最高优先级）：waterfall_item_* 父元素 id
    const wfId = extractVidFromWaterfallId(card);
    if (wfId) {
      result.push({ el: card, vid: wfId, strategy: 'waterfall-id' });
      return;
    }

    // 策略 2：a[href*="/video/"] 提取 vid
    const videoLink = card.querySelector('a[href*="/video/"]');
    if (videoLink) {
      const href = (videoLink as HTMLAnchorElement).href || videoLink.getAttribute('href') || '';
      const m = href.match(/\/video\/(\d+)/);
      if (m) {
        result.push({ el: card, vid: m[1], strategy: 'anchor' });
        return;
      }
    }

    // 策略 2 兜底：data-e2e-vid / data-* 数字
    const fromAttr = extractVid(card);
    if (fromAttr) {
      result.push({ el: card, vid: fromAttr, strategy: 'anchor' });
      return;
    }

    // 策略 3：封面图文件 ID 匹配已捕获的接口响应
    const img = card.querySelector('img');
    const imgSrc = img ? ((img as HTMLImageElement).src || img.getAttribute('src') || '') : '';
    const coverFileId = extractCoverFileId(imgSrc);
    if (coverFileId) {
      const matched = matchAwemeByCoverFileId(coverFileId, cacheEntries);
      if (matched) {
        result.push({ el: card, vid: matched, strategy: 'cover-match' });
        return;
      }
    }

    // 无策略命中：仍然注入（vid=null），由调用方决定是否跳过
    result.push({ el: card, vid: null, strategy: 'none' });
  });

  // 第四轮修复兜底：主选择器无匹配时，扫描 /video/ 链接 + findCardContainer
  if (result.length === 0) {
    document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
      const href = (a as HTMLAnchorElement).getAttribute('href') || '';
      if (href.includes('/note/')) return;
      const card = findCardContainer(a as HTMLAnchorElement);
      if (!card || seen.has(card)) return;
      // 二次检查：卡片内不应含 /note/ 链接
      if (card.querySelector('a[href*="/note/"]')) return;
      // 第六轮修复：图文帖排除
      if (isImageTextPost(card)) return;
      seen.add(card);
      const vid = extractVid(card);
      result.push({ el: card, vid, strategy: vid ? 'anchor' : 'none' });
    });
  }

  return result;
}

export { DATA_E2E_SELECTORS };
