// 统一捕获提取：从任意已拦截的 API 响应中抽取 aweme 条目
// 纯函数，不依赖浏览器 API，可独立测试
// 支持三种结构：
//   - res.aweme_detail（detail 响应）
//   - res.aweme_list[]（post 响应，博主主页作品/喜欢列表）
//   - res.data[].aweme_info（search 响应）

export interface AwemeEntry {
  vid: string;
  aweme: any;
}

export function extractAwemeEntries(res: any): AwemeEntry[] {
  if (!res) return [];
  const entries: AwemeEntry[] = [];

  // 结构 1：res.aweme_detail（详情接口）
  const detail = res.aweme_detail;
  if (detail && detail.aweme_id) {
    entries.push({ vid: String(detail.aweme_id), aweme: detail });
  }

  // 结构 2：res.aweme_list[]（博主主页作品/喜欢列表接口）
  if (Array.isArray(res.aweme_list)) {
    for (const info of res.aweme_list) {
      if (info && info.aweme_id) {
        entries.push({ vid: String(info.aweme_id), aweme: info });
      }
    }
  }

  // 结构 3：res.data[].aweme_info（搜索接口）
  if (Array.isArray(res.data)) {
    for (const item of res.data) {
      const info = item?.aweme_info;
      if (info && info.aweme_id) {
        entries.push({ vid: String(info.aweme_id), aweme: info });
      }
    }
  }

  return entries;
}
