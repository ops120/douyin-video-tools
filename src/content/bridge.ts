// 把页面桥的 postMessage 封装成 Promise（超时 8s）

import { DYX_FETCH, DYX_FETCH_RES, DYX_GET_WEBID, DYX_GET_WEBID_RES } from '../shared/protocol.js';

const DEFAULT_TIMEOUT = 8000;

// 生成唯一 reqId
let reqCounter = 0;
function nextReqId(): string {
  return `dyx-${Date.now()}-${++reqCounter}`;
}

// 第七轮修复：构建带诊断信息的错误消息（仅日志用，inferError 仍匹配 NON_JSON 关键词）
function buildFetchErrorMsg(error: string, status?: number, contentType?: string): string {
  // 保留 NON_JSON 关键词以便 inferError 识别，附加诊断信息
  const parts = [error];
  if (status != null) parts.push(`status=${status}`);
  if (contentType) parts.push(`ct=${contentType}`);
  return parts.join('|');
}

// 经页面桥代发 fetch，返回解析后的 JSON
export function dyxFetch(url: string, options?: RequestInit, timeout = DEFAULT_TIMEOUT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reqId = nextReqId();
    let settled = false;

    const onMessage = (event: MessageEvent) => {
      // 第三轮修复 #13：安全校验——只接受来自自身窗口的消息
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== DYX_FETCH_RES || data.reqId !== reqId) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (data.error) {
        const errMsg = buildFetchErrorMsg(data.error, data.status, data.contentType);
        console.warn(`[抖存] 桥请求失败: ${errMsg} url=${url}`);
        reject(new Error(errMsg));
      } else {
        resolve(data.res);
      }
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      reject(new Error('DYX_FETCH_TIMEOUT'));
    }, timeout);

    window.addEventListener('message', onMessage);
    window.postMessage({ type: DYX_FETCH, url, options, reqId }, '*');
  });
}

// 经页面桥读取页面 localStorage 中的 webid（__tea_cache_tokens_6383 / 7497）
export function getWebId(timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;

    const onMessage = (event: MessageEvent) => {
      // 第三轮修复 #13：安全校验——只接受来自自身窗口的消息
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== DYX_GET_WEBID_RES) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(data.webid || '');
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve('');
    }, timeout);

    window.addEventListener('message', onMessage);
    window.postMessage({ type: DYX_GET_WEBID }, '*');
  });
}
