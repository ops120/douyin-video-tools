// 页内 UI 注入：视频卡片右下角圆形下载按钮 + 「加入列表」按钮 + 页内 toast
// M2：新增 createAddToListButton、setAddToListState
// M3：新增 createSelectButton、setSelectState、initFloatingBar、updateFloatingBarCount

export type ButtonState = 'idle' | 'resolving' | 'downloading' | 'done' | 'failed';
export type AddToListState = 'idle' | 'added';

const INJECTED_ATTR = 'data-dyx-injected';

// 创建按钮容器（纵向排列，避免按钮各自 absolute 定位导致重叠）
// fixed=true 时用于详情页，采用 fixed 定位避开抖音右侧操作栏与底部栏
export function createButtonContainer(fixed = false): HTMLDivElement {
  const container = document.createElement('div');
  container.className = fixed ? 'dyx-btn-stack dyx-btn-stack--fixed' : 'dyx-btn-stack';
  return container;
}

// 创建下载按钮
export function createDownloadButton(vid: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'dyx-download-btn';
  btn.setAttribute('data-dyx-btn', vid);
  btn.setAttribute('data-dyx-state', 'idle');
  btn.title = '下载此视频';
  btn.innerHTML = '<span class="dyx-btn-icon">↓</span>';
  return btn;
}

// M2：创建「加入列表」按钮（在下载按钮左侧，不重叠、不遮挡原页面元素）
export function createAddToListButton(vid: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'dyx-addlist-btn';
  btn.setAttribute('data-dyx-addlist', vid);
  btn.setAttribute('data-dyx-addlist-state', 'idle');
  btn.title = '加入批量下载列表';
  btn.innerHTML = '<span class="dyx-btn-icon">+</span>';
  return btn;
}

// M2：设置「加入列表」按钮状态
export function setAddToListState(btn: HTMLButtonElement, state: AddToListState): void {
  btn.setAttribute('data-dyx-addlist-state', state);
  const icon = btn.querySelector('.dyx-btn-icon');
  if (!icon) return;
  if (state === 'added') {
    icon.textContent = '✓';
    btn.title = '已在批量下载列表';
  } else {
    icon.textContent = '+';
    btn.title = '加入批量下载列表';
  }
}

// 设置按钮状态
export function setButtonState(btn: HTMLButtonElement, state: ButtonState, progress?: number): void {
  btn.setAttribute('data-dyx-state', state);
  const icon = btn.querySelector('.dyx-btn-icon');
  if (!icon) return;
  switch (state) {
    case 'idle':
      icon.textContent = '↓';
      btn.title = '下载此视频';
      break;
    case 'resolving':
      icon.textContent = '…';
      btn.title = '解析中…';
      break;
    case 'downloading':
      // 第三轮修复 #5：percent<0 表示 content-length 未知，显示"下载中"
      if (progress != null && progress < 0) {
        icon.textContent = '↓';
        btn.title = '下载中…';
      } else {
        icon.textContent = `${progress ?? 0}%`;
        btn.title = `下载中 ${progress ?? 0}%`;
      }
      break;
    case 'done':
      icon.textContent = '✓';
      btn.title = '下载完成';
      break;
    case 'failed':
      icon.textContent = '✗';
      btn.title = '下载失败，点击重试';
      break;
  }
}

// 防重复注入标记
export function markInjected(el: Element): void {
  el.setAttribute(INJECTED_ATTR, '1');
}

export function isInjected(el: Element): boolean {
  return el.hasAttribute(INJECTED_ATTR);
}

// Toast 系统
type ToastKind = 'success' | 'error' | 'warning';

let toastContainer: HTMLDivElement | null = null;

function getToastContainer(): HTMLDivElement {
  if (toastContainer) return toastContainer;
  toastContainer = document.createElement('div');
  toastContainer.className = 'dyx-toast-container';
  document.body.appendChild(toastContainer);
  return toastContainer;
}

export function showToast(message: string, kind: ToastKind = 'success', duration = 3000): void {
  const container = getToastContainer();
  const toast = document.createElement('div');
  toast.className = `dyx-toast dyx-toast--${kind}`;
  toast.textContent = message;
  container.appendChild(toast);

  // 每个 toast 独立定时器，避免连续弹 toast 时前一个被清掉导致 DOM 泄漏
  window.setTimeout(() => {
    toast.remove();
  }, duration);
}

// M3：搜索页「选择」按钮（data-dyx-select 标记）
export function createSelectButton(vid: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'dyx-select-btn';
  btn.setAttribute('data-dyx-select', vid);
  btn.setAttribute('data-dyx-select-state', 'idle');
  btn.title = '勾选用于导出表格';
  btn.textContent = '选择';
  return btn;
}

// M3：设置「选择」按钮状态
export type SelectState = 'idle' | 'selected';
export function setSelectState(btn: HTMLButtonElement, state: SelectState): void {
  btn.setAttribute('data-dyx-select-state', state);
  if (state === 'selected') {
    btn.textContent = '已选 ✓';
    btn.title = '取消勾选';
  } else {
    btn.textContent = '选择';
    btn.title = '勾选用于导出表格';
  }
}

// M3：搜索页计数浮条（吸顶）
const FLOATING_BAR_ID = 'dyx-search-bar';

// 初始化浮条，返回计数元素（若已存在则复用）
export function initFloatingBar(
  anchorBefore: Element,
  onClear: () => void,
  onCopy: () => void,
  onExport: () => void,
): HTMLElement {
  const existing = document.getElementById(FLOATING_BAR_ID);
  if (existing) return existing;

  const bar = document.createElement('div');
  bar.id = FLOATING_BAR_ID;
  bar.className = 'dyx-search-bar';

  const countSpan = document.createElement('span');
  countSpan.className = 'dyx-search-bar-count';
  countSpan.textContent = '已选 0 条';
  bar.appendChild(countSpan);

  bar.appendChild(document.createTextNode(' · '));

  const clearBtn = document.createElement('button');
  clearBtn.className = 'dyx-search-bar-btn';
  clearBtn.textContent = '清空';
  clearBtn.addEventListener('click', onClear);
  bar.appendChild(clearBtn);

  bar.appendChild(document.createTextNode(' · '));

  const copyBtn = document.createElement('button');
  copyBtn.className = 'dyx-search-bar-btn';
  copyBtn.textContent = '复制';
  copyBtn.addEventListener('click', onCopy);
  bar.appendChild(copyBtn);

  bar.appendChild(document.createTextNode(' · '));

  const exportBtn = document.createElement('button');
  exportBtn.className = 'dyx-search-bar-btn';
  exportBtn.textContent = '导出 CSV';
  exportBtn.addEventListener('click', onExport);
  bar.appendChild(exportBtn);

  anchorBefore.parentElement?.insertBefore(bar, anchorBefore);
  return bar;
}

// M3：更新浮条计数
export function updateFloatingBarCount(count: number): void {
  const bar = document.getElementById(FLOATING_BAR_ID);
  if (!bar) return;
  const countSpan = bar.querySelector('.dyx-search-bar-count');
  if (countSpan) countSpan.textContent = `已选 ${count} 条`;
}
