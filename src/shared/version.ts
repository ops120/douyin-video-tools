// 版本号的单一来源：manifest.json 的 version。
// 各页面标题里的版本标签由这里在运行时填充 —— HTML 里不再硬编码，
// 否则升版本时容易漏掉某几处，出现「清单是 0.2.0、界面还写着 0.1.0」的脱节。
export function applyVersionLabel(selector: string): void {
  const el = document.querySelector(selector);
  if (!el) return;
  try {
    el.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    // 非扩展环境（例如单测）下静默跳过
  }
}
