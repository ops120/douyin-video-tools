// 按 PRD §3.3 FR-C2/C4：导出字段映射（纯函数，可单测）
// 13 个字段定义 key→中文表头→取值函数；TSV/CSV 生成

import type { VideoItem } from './types.js';

// 单个字段定义
export interface ExportField {
  key: string;
  header: string;
  getValue: (item: VideoItem) => string;
}

// 13 个导出字段（按 PRD §3.3 表格顺序）
export const EXPORT_FIELDS: ExportField[] = [
  {
    key: 'nickName',
    header: '用户昵称',
    getValue: (item) => item.name || '',
  },
  {
    key: 'secUid',
    header: '用户链接',
    getValue: (item) => item.secUid ? `https://www.douyin.com/user/${item.secUid}` : '',
  },
  {
    key: 'videoDetail',
    header: '视频详情',
    getValue: (item) => item.vid ? `https://www.douyin.com/video/${item.vid}` : '',
  },
  {
    key: 'desc',
    header: '视频描述',
    getValue: (item) => item.title || '',
  },
  {
    key: 'digg',
    header: '点赞',
    getValue: (item) => String(item.statistics?.digg ?? ''),
  },
  {
    key: 'collect',
    header: '收藏',
    getValue: (item) => String(item.statistics?.collect ?? ''),
  },
  {
    key: 'comment',
    header: '评论',
    getValue: (item) => String(item.statistics?.comment ?? ''),
  },
  {
    key: 'share',
    header: '分享',
    getValue: (item) => String(item.statistics?.share ?? ''),
  },
  {
    key: 'productId',
    header: '商品ID',
    getValue: (item) => item.goods?.productId || '',
  },
  {
    key: 'title',
    header: '商品标题',
    getValue: (item) => item.goods?.title || '',
  },
  {
    key: 'price',
    header: '价格',
    getValue: (item) => item.goods?.price || '',
  },
  {
    key: 'sales',
    header: '销量',
    getValue: (item) => item.goods?.sales || '',
  },
  {
    key: 'url',
    header: '商品链接',
    getValue: (item) => item.goods?.url || '',
  },
];

// 默认全选的 key 列表
export const ALL_EXPORT_KEYS: string[] = EXPORT_FIELDS.map((f) => f.key);

// 按 selectedKeys 过滤并保持 PRD 表格顺序
export function getSelectedFields(selectedKeys: string[]): ExportField[] {
  const set = new Set(selectedKeys);
  return EXPORT_FIELDS.filter((f) => set.has(f.key));
}

// TSV 转义：制表符/换行替换为空格
export function escapeTsv(value: string): string {
  return value.replace(/[\t\n\r]/g, ' ');
}

// CSV 转义（RFC4180）：含逗号/引号/换行时双引号包裹，内部引号翻倍
// 第三轮修复 #11：公式注入防护——以 = + - @ 或制表符开头的值前置单引号
export function escapeCsv(value: string): string {
  // 公式注入防护：CSV 打开器可能将这些前缀解释为公式
  let safe = value;
  if (/^[=+\-\@\t]/.test(safe)) {
    safe = "'" + safe;
  }
  if (/[",\r\n]/.test(safe)) {
    return '"' + safe.replace(/"/g, '""') + '"';
  }
  return safe;
}

// 生成 TSV 内容（表头 + 数据行，\t 分隔，\n 分隔行）
export function generateTsv(items: VideoItem[], selectedKeys: string[]): string {
  const fields = getSelectedFields(selectedKeys);
  if (fields.length === 0) return '';
  const header = fields.map((f) => escapeTsv(f.header)).join('\t');
  const rows = items.map((item) =>
    fields.map((f) => escapeTsv(f.getValue(item))).join('\t')
  );
  return [header, ...rows].join('\n');
}

// 生成 CSV 内容（RFC4180，行尾 \r\n，前置 UTF-8 BOM）
export function generateCsv(items: VideoItem[], selectedKeys: string[]): string {
  const fields = getSelectedFields(selectedKeys);
  if (fields.length === 0) return '';
  const BOM = '\uFEFF';
  const header = fields.map((f) => escapeCsv(f.header)).join(',');
  const rows = items.map((item) =>
    fields.map((f) => escapeCsv(f.getValue(item))).join(',')
  );
  return BOM + [header, ...rows].join('\r\n');
}

// 生成 CSV 文件名：dyx_导出_yyyyMMdd_HHmmss.csv
export function buildExportFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `dyx_导出_${ts}.csv`;
}
