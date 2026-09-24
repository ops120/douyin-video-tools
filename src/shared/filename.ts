// 按 PRD §3.1 FR-A3 与附录 B：文件名模板渲染 + 清洗（纯函数，可单测）

export type FileNameFormat =
  | 'title'
  | 'date_title'
  | 'vid_title'
  | 'title_vid'
  | 'name_date_title'
  | 'date_title_vid';

export const PRESET_FORMATS: { value: FileNameFormat; label: string }[] = [
  { value: 'title', label: 'title（标题）' },
  { value: 'date_title', label: 'date_title（日期_标题，默认）' },
  { value: 'vid_title', label: 'vid_title（视频ID_标题）' },
  { value: 'title_vid', label: 'title_vid（标题_视频ID）' },
  { value: 'name_date_title', label: 'name_date_title（作者_日期_标题）' },
  { value: 'date_title_vid', label: 'date_title_vid（日期_标题_视频ID）' },
];

export const DEFAULT_FORMAT: FileNameFormat = 'date_title';

export interface FilenameContext {
  vid: string;
  title?: string;
  name?: string;
  date?: string; // YYYY-MM-DD
  uniqueId?: string;
  goods?: { productId?: string };
  statistics?: { digg?: number; collect?: number; share?: number; comment?: number };
}

// 清洗：移除非法字符、去"展开"、截断 50 字、空则回退"抖音视频"
export function sanitizeName(raw: string): string {
  if (!raw || typeof raw !== 'string') return '抖音视频';
  let s = raw
    // 移除指定非法字符
    .replace(/\\|\/|？|\?|\*|\.|,|，|"|'|‘|’|\||<|>|\{|\}|\[|\]|【|】|：|:|、|\^|\$|!|~|`/g, '')
    // 去掉"展开"字样
    .replace(/展开/g, '')
    .trim();
  if (!s) s = '抖音视频';
  // 最终替换空白与控制字符为下划线
  s = s.replace(/[<>:"/\\|?*\s]/g, '_');
  // 截断 50 字（Array.from 正确处理 emoji 代理对，避免截断半个字符）
  if (Array.from(s).length > 50) s = Array.from(s).slice(0, 50).join('');
  return s;
}

// 日期格式化：YYYY-MM-DD → YYYYMMDD
export function compactDate(date?: string): string {
  if (!date) {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }
  return date.replace(/-/g, '');
}

// 用户名净化：只保留中英文与数字，其余字符（emoji、标点、符号、空白等）一律去除。
// 必要性：昵称里的 \ / : * ? " < > | 是 Windows 非法文件名字符，直接拼进文件名会导致
// 「保存到文件夹」时 getFileHandle 抛错、该条静默失败。
// 注意：只作用于文件名，导出的 CSV 仍保留完整原始昵称。
const USER_NAME_KEEP = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFFA-Za-z0-9]/gu;
const USER_NAME_MAX = 30;

export function sanitizeUserName(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const kept = (raw.match(USER_NAME_KEEP) || []).join('');
  // 截断，避免超长昵称把文件名撑爆
  return Array.from(kept).slice(0, USER_NAME_MAX).join('');
}

// 文件名主干（不含扩展名）的长度上限。
// 各字段单独有上限（标题 50、作者 30），但拼起来最长可达 90（作者_日期_标题），故此闸兜底。
export const FILENAME_MAX = 70;

// 超长被截断时追加的随机数字位数
const RAND_DIGITS = 4;

function randomDigits(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// 渲染文件名（不含扩展名）
export function renderFilename(ctx: FilenameContext, format: FileNameFormat = DEFAULT_FORMAT): string {
  const title = sanitizeName(ctx.title ?? '');
  const date = compactDate(ctx.date);
  const vid = ctx.vid || '';
  const name = sanitizeUserName(ctx.name ?? '');

  // 按模板顺序收集各段，并记住哪一段是标题（超长时优先截它）
  const segs: { key: string; value: string }[] = [];

  for (const p of format.split('_')) {
    switch (p) {
      case 'vid':
        if (vid) segs.push({ key: 'vid', value: vid });
        break;
      case 'date':
        segs.push({ key: 'date', value: date });
        break;
      case 'title':
        segs.push({ key: 'title', value: title });
        break;
      case 'name':
        if (name) segs.push({ key: 'name', value: name });
        break;
      case 'uniqueId':
        if (ctx.uniqueId) segs.push({ key: 'uniqueId', value: ctx.uniqueId });
        break;
      case 'productId':
        if (ctx.goods?.productId) segs.push({ key: 'productId', value: ctx.goods.productId });
        break;
      case 'digg':
        if (ctx.statistics?.digg != null) segs.push({ key: 'digg', value: String(ctx.statistics.digg) });
        break;
      case 'collect':
        if (ctx.statistics?.collect != null) segs.push({ key: 'collect', value: String(ctx.statistics.collect) });
        break;
      case 'share':
        if (ctx.statistics?.share != null) segs.push({ key: 'share', value: String(ctx.statistics.share) });
        break;
      case 'comment':
        if (ctx.statistics?.comment != null) segs.push({ key: 'comment', value: String(ctx.statistics.comment) });
        break;
    }
  }

  let result = segs.map((s) => s.value).join('_');

  // 超长：截断标题，并在末尾追加随机数字 —— 截断后长标题容易撞成同一个名字
  if (Array.from(result).length > FILENAME_MAX) {
    const rand = randomDigits(RAND_DIGITS);
    const othersLen = segs
      .filter((s) => s.key !== 'title')
      .reduce((n, s) => n + Array.from(s.value).length, 0);
    // 分隔符最多 segs.length 个（标题被截空时实际更少，只会更短）
    const budget = FILENAME_MAX - othersLen - rand.length - segs.length;
    const clipped = budget > 0 ? Array.from(title).slice(0, budget).join('') : '';
    result = [...segs.map((s) => (s.key === 'title' ? clipped : s.value)), rand]
      .filter(Boolean)
      .join('_');
  }

  result = result.replace(/^_+/, '').replace(/_+/g, '_');
  if (!result) result = '抖音视频';
  return result;
}
