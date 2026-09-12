// 按 PRD §4.8 定义消息常量与类型安全封装

// 页面桥 ↔ 内容脚本（window.postMessage）
export const DYX_CAPTURED = 'DYX_CAPTURED';
export const DYX_FETCH = 'DYX_FETCH';
export const DYX_FETCH_RES = 'DYX_FETCH_RES';
// 页面桥 → 内容脚本：SPA 路由变化（bs.js 在页面世界 patch history 后通知）
export const DYX_ROUTE_CHANGE = 'DYX_ROUTE_CHANGE';
// 内容脚本 → 页面桥：就绪信号（window message 监听器已注册，桥可开始回放缓冲队列）
export const DYX_READY = 'DYX_READY';

// 内容脚本 → Service Worker（chrome.runtime.sendMessage）
export const DYX_ADD_ITEMS = 'DYX_ADD_ITEMS';
export const DYX_GET_LIST = 'DYX_GET_LIST';
export const DYX_REMOVE_ITEMS = 'DYX_REMOVE_ITEMS';
export const DYX_CLEAR_LIST = 'DYX_CLEAR_LIST';
export const DYX_RESOLVE_ITEMS = 'DYX_RESOLVE_ITEMS';
export const DYX_OPEN_BATCH = 'DYX_OPEN_BATCH';
export const DYX_SETTINGS_CHANGED = 'DYX_SETTINGS_CHANGED';

// SW → 内容脚本：批量页请求刷新直链（经 SW 转发）
export const DYX_RESOLVE_FROM_BATCH = 'DYX_RESOLVE_FROM_BATCH';

// 内容脚本 → SW：请求注入 bs.js 到 MAIN world（绕过页面 CSP）
export const DYX_INJECT_BRIDGE = 'DYX_INJECT_BRIDGE';

// 内容脚本 ↔ 页面桥（window.postMessage）：读取页面 localStorage 中的 webid
export const DYX_GET_WEBID = 'DYX_GET_WEBID';
export const DYX_GET_WEBID_RES = 'DYX_GET_WEBID_RES';

// 捕获响应的 kind
export type CapturedKind = 'detail' | 'search' | 'post';

export interface CapturedPayload {
  kind: CapturedKind;
  res: unknown;
}

export interface FetchPayload {
  url: string;
  options?: RequestInit;
}

export interface FetchResPayload {
  res?: unknown;
  error?: string;
  // 第七轮修复：NON_JSON 结构化错误附带 HTTP 状态码和内容类型
  status?: number;
  contentType?: string;
}

// 类型安全的 sendMessage 封装
export function sendMessage<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(resp as T);
      });
    } catch (e) {
      reject(e);
    }
  });
}
