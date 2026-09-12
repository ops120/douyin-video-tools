// 页面桥：IIFE，作为 web_accessible_resource 注入页面世界。
// 职责：hook XHR + fetch 捕获 detail/search/post 响应；代发 fetch 请求。
// 安全：校验 event.source === window；防重复注入。

(function () {
  // 防重复注入标记
  if ((window as any).__DYX_BRIDGE__) return;
  (window as any).__DYX_BRIDGE__ = true;

  // 第九轮修复：记录桥执行时机（用于诊断注册是否生效）
  // bridgeReady === 'loading' 说明桥在 document_start 就位（正确）
  // 若为 'interactive'/'complete' 说明仍在晚注入（注册未生效）
  (window as any).__DYX_BRIDGE_META__ = { readyState: document.readyState, ts: Date.now() };

  // 命中路径（按 PRD §6.1 研究报告）
  const DETAIL_PATH = '/aweme/v1/web/aweme/detail/';
  const SEARCH_PATH = '/aweme/v1/web/general/search/single/';
  // 第十轮修复：抖音新版搜索首屏接口（stream 分块流式格式）
  const SEARCH_STREAM_PATH = '/aweme/v1/web/general/search/stream/';
  const POST_PATH = '/aweme/v1/web/aweme/post/';

  function classifyUrl(url: string): 'detail' | 'search' | 'post' | null {
    if (url.indexOf(DETAIL_PATH) !== -1) return 'detail';
    // 第十轮修复：stream 路径优先匹配（kind 仍为 'search'）
    if (url.indexOf(SEARCH_STREAM_PATH) !== -1) return 'search';
    if (url.indexOf(SEARCH_PATH) !== -1) return 'search';
    if (url.indexOf(POST_PATH) !== -1) return 'post';
    return null;
  }

  // 判断 URL 是否命中 stream 分块流式搜索路径
  function isStreamPath(url: string): boolean {
    return url.indexOf(SEARCH_STREAM_PATH) !== -1;
  }

  // 安全解析 JSON，失败返回 null
  function safeParse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // 第十轮修复：判断一行是否为纯十六进制长度行（如 "117dd"、"1a2b"）
  function isHexChunkLength(line: string): boolean {
    if (line.length === 0 || line.length > 10) return false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) {
        return false;
      }
    }
    return true;
  }

  // 第十轮修复：解析分块流式响应体
  // 抖音新版搜索接口返回分块传输编码格式，每块以十六进制长度行开头
  // 此函数按行拆分，跳过空行/hex行/不可解析行，返回所有 JSON 对象
  // 防御式：任何异常都不外抛
  function parseStreamBody(text: string): unknown[] {
    if (!text || typeof text !== 'string') return [];
    const trimmed = text.trim();
    if (!trimmed) return [];

    // 快速路径：尝试整体 JSON.parse（非分块格式）
    try {
      const whole = JSON.parse(trimmed);
      if (whole !== null && typeof whole === 'object') {
        return [whole];
      }
    } catch {
      // 非整体 JSON，继续走分行解析
    }

    const lines = trimmed.split(/\r?\n/);
    const results: unknown[] = [];
    for (const line of lines) {
      const l = line.trim();
      if (l.length === 0) continue;
      if (isHexChunkLength(l)) continue;
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

  // ============================================================
  // 第八轮修复：缓冲队列 + 就绪握手
  // 桥（document_start）比内容脚本（document_end）更早捕获首屏 API 响应，
  // 若内容脚本尚未注册 window message 监听器，postMessage 会被丢弃。
  // 解决方案：捕获的响应先入队缓冲，收到 DYX_READY 后按序回放。
  // ============================================================
  const DYX_PENDING_LIMIT = 50;
  // 一次性初始化缓冲队列（与 __DYX_BRIDGE__ 一样只初始化一次）
  if (!(window as any).__DYX_PENDING__) {
    (window as any).__DYX_PENDING__ = [];
  }
  const pendingQueue: Array<{ kind: string; res: unknown; path: string }> = (window as any).__DYX_PENDING__;
  let contentScriptReady = false;

  // 直接发送捕获结果（第十轮修复：附带请求路径供诊断）
  function sendCaptured(kind: string, parsed: unknown, path: string): void {
    window.postMessage({ type: 'DYX_CAPTURED', kind, res: parsed, path }, '*');
  }

  // 统一上报捕获结果（XHR 和 fetch 共用）：未就绪则入队，已就绪则直发
  function emitCaptured(kind: 'detail' | 'search' | 'post', parsed: unknown, path: string): void {
    if (parsed == null) return;
    if (contentScriptReady) {
      sendCaptured(kind, parsed, path);
    } else {
      // 超出上限丢弃最旧
      if (pendingQueue.length >= DYX_PENDING_LIMIT) {
        pendingQueue.shift();
      }
      pendingQueue.push({ kind, res: parsed, path });
    }
  }

  // 回放缓冲队列并清空
  function flushPending(): void {
    for (const item of pendingQueue) {
      sendCaptured(item.kind, item.res, item.path);
    }
    pendingQueue.length = 0;
  }

  // 判断响应内容是否为 JSON（基于 content-type 或内容首字符）
  function isJsonResponse(contentType: string | null, text: string): boolean {
    if (contentType && contentType.indexOf('application/json') !== -1) return true;
    // 兜底：trim 后以 { 或 [ 开头视为 JSON
    const trimmed = text.trimStart();
    return trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[';
  }

  // hook XMLHttpRequest.open：记录 URL
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: any[]) {
    (this as any)._dyx_url = typeof args[1] === 'string' ? args[1] : '';
    return (origOpen as any).apply(this, args);
  };

  // hook XMLHttpRequest.send：监听响应
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: any) {
    const url: string = (this as any)._dyx_url || '';
    const kind = classifyUrl(url);
    if (!kind) return (origSend as any).call(this, body);

    this.addEventListener('readystatechange', () => {
      try {
        if (this.readyState === 4 && this.status === 200) {
          // responseType 分支：'' / 'text' 用 responseText；'json' 直接用 response（已是对象）；其它类型跳过
          const rt = this.responseType;
          if (rt === '' || rt === 'text') {
            const raw = this.responseText;
            // 第十轮修复：stream 路径走分块解析
            if (isStreamPath(url)) {
              const items = parseStreamBody(raw);
              for (const obj of items) {
                emitCaptured(kind, obj, url);
              }
            } else {
              const parsed = safeParse(raw);
              emitCaptured(kind, parsed, url);
            }
          } else if (rt === 'json') {
            emitCaptured(kind, this.response, url);
          } else {
            // blob / arraybuffer 等其它类型，跳过
            return;
          }
        }
      } catch (err) {
        console.warn('[抖存] XHR 捕获响应失败', kind, err);
      }
    });
    return (origSend as any).call(this, body);
  };

  // 第七轮修复：hook window.fetch，捕获 detail/search/post 响应
  // 抖音页面可能用 fetch 而非 XHR 发请求，不 hook 会漏掉初始搜索响应
  const origFetch = window.fetch;
  window.fetch = function (input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
    }
    const kind = classifyUrl(url);

    // 非命中路径：直接透传
    if (!kind) return origFetch.call(window, input, init);

    return origFetch.call(window, input, init).then((response) => {
      try {
        // clone 一份用于读取 body，原 response 透传给页面
        const cloned = response.clone();
        const ct = cloned.headers.get('content-type');
        // 只处理 200 且可能是 JSON 的响应
        if (response.status === 200) {
          cloned.text().then((text) => {
            try {
              // 第十轮修复：stream 路径走分块解析（不走 isJsonResponse 检查，因为分块编码会导致整体 parse 失败）
              if (isStreamPath(url)) {
                const items = parseStreamBody(text);
                for (const obj of items) {
                  emitCaptured(kind, obj, url);
                }
              } else if (isJsonResponse(ct, text)) {
                const parsed = safeParse(text);
                emitCaptured(kind, parsed, url);
              } else {
                console.warn(`[抖存] fetch 捕获: 非 JSON 响应 kind=${kind} content-type=${ct}`);
              }
            } catch {
              // 解析失败，静默忽略
            }
          }).catch(() => {
            // 读取 body 失败，静默忽略
          });
        }
      } catch {
        // clone/读取失败不影响主流程
      }
      return response;
    });
  };

  // SPA 路由监听：patch history（在页面世界生效），变化后通知内容脚本
  const notifyRouteChange = () => {
    window.postMessage({ type: 'DYX_ROUTE_CHANGE' }, '*');
  };
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args: any[]) {
    const r = (origPush as any).apply(this, args);
    notifyRouteChange();
    return r;
  };
  history.replaceState = function (...args: any[]) {
    const r = (origReplace as any).apply(this, args);
    notifyRouteChange();
    return r;
  };
  window.addEventListener('popstate', notifyRouteChange);

  // 读取页面 localStorage 中的 webid（__tea_cache_tokens_6383 / 7497）
  function readWebId(): string {
    try {
      let raw = localStorage.getItem('__tea_cache_tokens_6383');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.user_unique_id) return parsed.user_unique_id;
      }
      raw = localStorage.getItem('__tea_cache_tokens_7497');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.user_unique_id) return parsed.user_unique_id;
      }
    } catch {
      // 读取失败，返回空
    }
    return '';
  }

  // 监听 DYX_FETCH / DYX_GET_WEBID：代发 fetch 请求 / 读取 webid
  window.addEventListener('message', (event: MessageEvent) => {
    // 安全校验：只接受来自自身窗口的消息（内容脚本与页面同 window）
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data.type === 'DYX_FETCH') {
      const { url, options, reqId } = data;
      if (typeof url !== 'string') return;

      // 第三轮修复 #13：URL 白名单——仅允许 douyin.com 前缀，其余回传 error
      if (!url.startsWith('https://www.douyin.com/')) {
        window.postMessage(
          { type: 'DYX_FETCH_RES', reqId, error: 'URL not in whitelist (only douyin.com allowed)' },
          '*'
        );
        return;
      }

      // 第七轮修复：先检查 content-type，非 JSON 响应返回结构化 NON_JSON 错误
      fetch(url, options || { credentials: 'include' })
        .then((r) => {
          const ct = r.headers.get('content-type') || '';
          if (r.status !== 200) {
            // 非 200 状态码，返回结构化错误
            return r.text().then((text) => {
              const snippet = text.slice(0, 200);
              console.warn(`[抖存] 代发请求非 200: status=${r.status} content-type=${ct} body_snippet=${snippet}`);
              window.postMessage(
                { type: 'DYX_FETCH_RES', reqId, error: `NON_JSON`, status: r.status, contentType: ct },
                '*'
              );
              return null; // 已处理，跳过后续
            });
          }
          // 200 但 content-type 不含 json：尝试 text 判断
          if (ct.indexOf('application/json') === -1) {
            return r.text().then((text) => {
              const trimmed = text.trimStart();
              const looksLikeJson = trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[';
              if (looksLikeJson) {
                // content-type 误标但内容是 JSON，继续解析
                try {
                  const parsed = JSON.parse(text);
                  window.postMessage({ type: 'DYX_FETCH_RES', reqId, res: parsed }, '*');
                } catch {
                  window.postMessage(
                    { type: 'DYX_FETCH_RES', reqId, error: 'NON_JSON', status: r.status, contentType: ct },
                    '*'
                  );
                }
              } else {
                console.warn(`[抖存] 代发请求返回非 JSON: status=${r.status} content-type=${ct} body_start=${trimmed.slice(0, 100)}`);
                window.postMessage(
                  { type: 'DYX_FETCH_RES', reqId, error: 'NON_JSON', status: r.status, contentType: ct },
                  '*'
                );
              }
            });
          }
          // content-type 为 JSON，正常解析
          return r.json().then((res) => {
            window.postMessage({ type: 'DYX_FETCH_RES', reqId, res }, '*');
          });
        })
        .catch((err: Error) => {
          window.postMessage(
            { type: 'DYX_FETCH_RES', reqId, error: err.message || 'fetch failed' },
            '*'
          );
        });
    } else if (data.type === 'DYX_GET_WEBID') {
      const webid = readWebId();
      window.postMessage(
        { type: 'DYX_GET_WEBID_RES', webid },
        '*'
      );
    } else if (data.type === 'DYX_READY') {
      // 第八轮修复：内容脚本就绪信号——回放缓冲队列
      if (!contentScriptReady) {
        contentScriptReady = true;
        flushPending();
        console.log(`[抖存] 桥收到 DYX_READY，已回放缓冲队列`);
      }
    }
  });
})();
