// ZIP 文件名生成、重名去重等纯函数（按 PRD §4.3 链路 3 与 FR-B4）

/**
 * 生成 ZIP 文件名：dyx_{yyyyMMdd_HHmmss}[_备注].zip
 * @param remark 可选备注（会做文件名清洗）
 */
export function buildZipFilename(remark?: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let name = `dyx_${ts}`;
  if (remark && remark.trim()) {
    const clean = sanitizeForFilename(remark.trim());
    if (clean) name += `_${clean}`;
  }
  return `${name}.zip`;
}

/**
 * 文件名清洗（针对备注/文件夹写入场景）：移除文件系统不允许的字符，截断 80 字。
 * 与 shared/filename.ts 的 sanitizeName 不同：这里仅处理文件系统非法字符，
 * 不做"展开"替换等业务逻辑。
 */
export function sanitizeForFilename(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

/**
 * 重名去重：给定已有文件名集合，生成不重复的文件名。
 * 策略：原名.mp4 → 原名_vid.mp4（若仍冲突则 _vid_2, _vid_3 ...）
 */
export function deduplicateFilename(
  baseName: string,
  existing: Set<string>,
  vid?: string
): string {
  if (!existing.has(baseName)) return baseName;

  // 去掉扩展名
  const dotIdx = baseName.lastIndexOf('.');
  const stem = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
  const ext = dotIdx > 0 ? baseName.slice(dotIdx) : '';

  const suffix = vid || 'dup';
  let candidate = `${stem}_${suffix}${ext}`;
  if (!existing.has(candidate)) return candidate;

  // 仍冲突：递增编号
  for (let i = 2; i < 1000; i++) {
    candidate = `${stem}_${suffix}_${i}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }

  // 极端兜底：加时间戳
  return `${stem}_${suffix}_${Date.now()}${ext}`;
}

/**
 * 从 VideoItem 的文件名模板结果 + .mp4 扩展名构建完整文件名，
 * 并在已有集合中去重，返回最终文件名并注册到集合。
 */
export function buildUniqueFilename(
  baseName: string,
  existing: Set<string>,
  vid?: string
): string {
  const unique = deduplicateFilename(baseName, existing, vid);
  existing.add(unique);
  return unique;
}
