// 按 PRD 附录 C：错误码枚举与用户文案映射

export enum DyxError {
  E1001 = 'E1001', // 未登录 / Cookie 失效
  E1002 = 'E1002', // 详情接口被拒绝（风控）
  E1003 = 'E1003', // 直链已过期
  E1004 = 'E1004', // CDN 下载失败
  E1005 = 'E1005', // 页面桥未就绪（超时）
  E1006 = 'E1006', // 详情接口返回无数据
  E1007 = 'E1007', // 视频已删除或不可用（404）
  E2001 = 'E2001', // 用户取消保存对话框
  E2002 = 'E2002', // 磁盘写入失败
  E2008 = 'E2008', // 手势超时：showSaveFilePicker/showDirectoryPicker 需在用户手势内调用
  E3001 = 'E3001', // 列表为空
}

export const ERROR_MESSAGES: Record<DyxError, string> = {
  [DyxError.E1001]: '请先在抖音网页版登录后再下载',
  [DyxError.E1002]: '请求被拒绝，请刷新页面后重试',
  [DyxError.E1003]: '链接已过期，请点击「刷新链接」',
  [DyxError.E1004]: '下载失败，请重试',
  [DyxError.E1005]: '页面桥未就绪，请刷新页面后重试',
  [DyxError.E1006]: '未获取到视频信息，请先在页面上点开该视频（或刷新页面）后重试',
  [DyxError.E1007]: '视频已删除或不可用',
  [DyxError.E2001]: '',
  [DyxError.E2002]: '保存失败，请检查磁盘空间或权限',
  [DyxError.E2008]: '浏览器要求先选择保存位置再开始下载，请重新点击按钮并立即在弹窗中选择保存位置',
  [DyxError.E3001]: '请先添加视频到列表',
};

export function errorMessage(code: DyxError): string {
  return ERROR_MESSAGES[code] || '发生未知错误';
}

// 保存操作错误分类：将 FSA（File System Access API）异常映射为用户可理解的错误码
// 纯函数，可单测
export function classifySaveError(e: unknown): DyxError {
  // 用户主动取消保存对话框 → 静默
  if (e instanceof DOMException && e.name === 'AbortError') {
    return DyxError.E2001;
  }
  // 手势超时：SecurityError 且 message 含 user gesture / user activation 关键词
  if (e instanceof DOMException && e.name === 'SecurityError') {
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('user gesture') || msg.includes('user activation')) {
      return DyxError.E2008;
    }
  }
  // 非 AbortError 的 SecurityError 但无 user gesture 关键词也归入手势超时（兜底）
  if (e instanceof DOMException && e.name === 'SecurityError') {
    return DyxError.E2008;
  }
  // 权限拒绝（用户拒绝授权 / 浏览器策略阻止）
  if (e instanceof DOMException && e.name === 'NotAllowedError') {
    return DyxError.E2002;
  }
  // 存储配额已满
  if (e instanceof DOMException && e.name === 'QuotaExceededError') {
    return DyxError.E2002;
  }
  // 普通 Error 且 message 含磁盘相关关键词
  if (e instanceof Error) {
    const msg = e.message.toLowerCase();
    if (msg.includes('disk') || msg.includes('space') || msg.includes('quota') || msg.includes('permission')) {
      return DyxError.E2002;
    }
  }
  // 其余异常兜底 → 磁盘写入失败
  return DyxError.E2002;
}

// 根据异常推断错误码：优先识别 downloader 抛出的字面量错误码（E1001–E3001）
export function inferError(e: unknown): DyxError {
  const msg = e instanceof Error ? e.message : String(e);
  // 字面量错误码优先（如 new Error('E1003')）
  const codeMatch = msg.match(/^E\d{4}$/);
  if (codeMatch) {
    const code = codeMatch[0] as DyxError;
    if (Object.values(DyxError).includes(code)) return code;
  }
  // 第七轮修复：非 JSON 响应（抖音返回 HTML 页面）→ E1006
  if (/NON_JSON/i.test(msg)) return DyxError.E1006;
  // 页面桥超时：DYX_FETCH_TIMEOUT → E1005
  if (/DYX_FETCH_TIMEOUT/i.test(msg)) return DyxError.E1005;
  // 详情接口返回无数据（主动请求 200 但无 aweme_detail）→ E1006
  if (/no_data|no.?aweme/i.test(msg)) return DyxError.E1006;
  // 关键词兜底（404 在 403 之前匹配，避免 404 落到 E1003）
  if (/login|auth|cookie|401/i.test(msg)) return DyxError.E1001;
  if (/deleted|unavailable|404/i.test(msg)) return DyxError.E1007;
  if (/expired|stale|invalid|403/i.test(msg)) return DyxError.E1003;
  if (/network|fetch|timeout|abort/i.test(msg)) return DyxError.E1004;
  return DyxError.E1004;
}
