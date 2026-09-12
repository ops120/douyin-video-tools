// 第十轮修复：分块流式响应解析（纯函数，可独立测试）
// 抖音新版搜索接口 /aweme/v1/web/general/search/stream/ 返回分块传输编码格式：
//   每块以十六进制长度行开头（如 117dd），后跟完整 JSON 对象，以 \r\n 分隔
// 此函数解析该格式，返回所有可解析的 JSON 对象数组

// 判断一行是否为纯十六进制长度行（如 "117dd"、"1a2b"）
function isHexChunkLength(line: string): boolean {
  if (line.length === 0 || line.length > 10) return false;
  // 每个字符必须是 0-9 或 a-f（小写）
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) {
      return false;
    }
  }
  return true;
}

/**
 * 解析分块流式响应体，返回所有可解析的 JSON 对象数组。
 *
 * 解析规则：
 * - 按行拆分（兼容 \r\n 与 \n）
 * - 跳过空行
 * - 跳过纯十六进制长度行（如 117dd）
 * - 跳过无法 JSON.parse 的行
 * - 若整段文本本身就是单个合法 JSON（无分块），返回 [该对象]
 *
 * 防御式：任何异常都不外抛，解析失败返回空数组。
 */
export function parseStreamBody(text: string): unknown[] {
  if (!text || typeof text !== 'string') return [];

  const trimmed = text.trim();
  if (!trimmed) return [];

  // 快速路径：尝试整体 JSON.parse（非分块格式）
  try {
    const whole = JSON.parse(trimmed);
    // 仅当解析结果为对象或数组时走快速路径（排除 "117dd" 被误解析为数字的情况）
    if (whole !== null && typeof whole === 'object') {
      return [whole];
    }
  } catch {
    // 非整体 JSON，继续走分行解析
  }

  // 分行解析：兼容 \r\n 和 \n
  const lines = trimmed.split(/\r?\n/);
  const results: unknown[] = [];

  for (const line of lines) {
    const l = line.trim();
    // 跳过空行
    if (l.length === 0) continue;
    // 跳过纯十六进制长度行
    if (isHexChunkLength(l)) continue;
    // 尝试 JSON.parse
    try {
      const parsed = JSON.parse(l);
      if (parsed !== null && typeof parsed === 'object') {
        results.push(parsed);
      }
    } catch {
      // 无法解析的行，静默跳过
    }
  }

  return results;
}
