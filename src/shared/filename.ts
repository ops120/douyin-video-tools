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

// 渲染文件名（不含扩展名）
export function renderFilename(ctx: FilenameContext, format: FileNameFormat = DEFAULT_FORMAT): string {
  const title = sanitizeName(ctx.title ?? '');
  const date = compactDate(ctx.date);
  const vid = ctx.vid || '';
  const name = ctx.name ? ctx.name.replace(/-/g, '') : '';

  let result = '';
  const parts = format.split('_');

  for (const p of parts) {
    switch (p) {
      case 'vid':
        if (vid) result += '_' + vid;
        break;
      case 'date':
        result += '_' + date;
        break;
      case 'title':
        result += '_' + title;
        break;
      case 'name':
        if (name) result += '_' + name;
        break;
      case 'uniqueId':
        if (ctx.uniqueId) result += '_' + ctx.uniqueId;
        break;
      case 'productId':
        if (ctx.goods?.productId) result += '_' + ctx.goods.productId;
        break;
      case 'digg':
        if (ctx.statistics?.digg != null) result += '_' + ctx.statistics.digg;
        break;
      case 'collect':
        if (ctx.statistics?.collect != null) result += '_' + ctx.statistics.collect;
        break;
      case 'share':
        if (ctx.statistics?.share != null) result += '_' + ctx.statistics.share;
        break;
      case 'comment':
        if (ctx.statistics?.comment != null) result += '_' + ctx.statistics.comment;
        break;
    }
  }

  result = result.replace(/^_+/, '').replace(/_+/g, '_');
  if (!result) result = '抖音视频';
  return result;
}
