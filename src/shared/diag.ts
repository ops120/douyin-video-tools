// 第九轮修复：诊断镜像字段拼装纯函数（从 content/index.ts 抽出，便于单测）
// 所有字段均在此定义，content/index.ts 和测试文件共用

export interface DiagState {
  captures: number;     // 捕获总条数
  lastKind: string;     // 最近一次捕获的 kind
  lastPath: string;     // 第十轮修复：最近一次捕获的请求路径（便于诊断接口变更）
  cachedItems: number;  // 缓存条目数
  cards: number;        // 上次扫描卡片数
  injected: number;     // 上次注入数
  strategy: string;     // 主导策略
  lastError: string;    // 最近一次解析/下载错误码
  bridgeReady: string;  // 桥执行时的 document.readyState（loading=正确，interactive/complete=晚注入）
  bridgeRegErr: string; // 常驻注册失败原因（空串=无错误）
}

export function createDefaultDiagState(): DiagState {
  return {
    captures: 0,
    lastKind: '',
    lastPath: '',
    cachedItems: 0,
    cards: 0,
    injected: 0,
    strategy: 'none',
    lastError: '',
    bridgeReady: '',
    bridgeRegErr: '',
  };
}

// 诊断镜像 JSON 组装纯函数（长度受限）
export function buildDiagJson(state: DiagState, maxLen: number = 1024): string {
  const json = JSON.stringify(state);
  return json.length > maxLen ? json.slice(0, maxLen) : json;
}
