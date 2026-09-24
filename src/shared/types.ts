// 按 PRD §4.6 定义核心数据结构

export interface VideoStatistics {
  digg: number;
  comment: number;
  collect: number;
  share: number;
}

export interface VideoGoods {
  productId: string;
  title: string;
  price: string;
  sales: string;
  url: string;
  goodsImage: string;
}

export interface VideoItem {
  vid: string;
  title: string;
  name: string;
  uniqueId: string;
  secUid: string;
  date: string; // YYYY-MM-DD
  duration: number; // ms
  cover: string;
  url: string; // 最高码率直链（带时效）
  images?: string[];
  mixId?: string;
  mixName?: string;
  statistics: VideoStatistics;
  goods?: VideoGoods;
  source: 'feed' | 'detail' | 'search' | 'user' | 'paste' | 'sound';
  addedAt: number;
  status?: 'ready' | 'stale' | 'done' | 'failed';
}

export type PageType = 'feed' | 'detail' | 'search' | 'user' | 'unknown';
