// Service Worker：消息路由 + webRequest 参数捕获（按 PRD §4.1/4.7/4.8）
// M2：新增 DYX_ADD_ITEMS、DYX_REMOVE_ITEMS、DYX_RESOLVE_ITEMS 处理
// 第七轮修复：registerContentScripts 常驻注入 bs.js 到 document_start + MAIN world

import {
  DYX_ADD_ITEMS,
  DYX_GET_LIST,
  DYX_REMOVE_ITEMS,
  DYX_CLEAR_LIST,
  DYX_OPEN_BATCH,
  DYX_OPEN_SOUND,
  DYX_RESOLVE_ITEMS,
  DYX_SETTINGS_CHANGED,
  DYX_INJECT_BRIDGE,
} from '../shared/protocol.js';
import type { VideoItem } from '../shared/types.js';

// ============================================================
// 第七轮修复：常驻注入 bs.js 到页面世界（document_start, MAIN world）
// 目标：页面首个搜索/列表请求即被 hook，不漏捕获
// ============================================================
const BRIDGE_SCRIPT_ID = 'dyx-bridge';

async function registerBridgeScript(): Promise<void> {
  try {
    // 先检查是否已注册，避免重复注册报错
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
    if (existing && existing.length > 0) {
      // 已注册，更新（确保配置最新）
      await chrome.scripting.updateContentScripts([{
        id: BRIDGE_SCRIPT_ID,
        matches: ['*://www.douyin.com/*'],
        js: ['bs.js'],
        runAt: 'document_start' as any,
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        allFrames: false,
      }]);
      // 注册成功，清除旧的错误记录
      chrome.storage.local.remove('dyx:bridgeRegError');
      console.log('[抖存] bs.js 常驻脚本已更新（document_start, MAIN world）');
    } else {
      throw new Error('not_registered'); // 走 catch 分支注册
    }
  } catch {
    // 未注册或 getRegisteredContentScripts 不可用，尝试注册
    try {
      await chrome.scripting.registerContentScripts([{
        id: BRIDGE_SCRIPT_ID,
        matches: ['*://www.douyin.com/*'],
        js: ['bs.js'],
        runAt: 'document_start' as any,
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        allFrames: false,
      }]);
      // 注册成功，清除旧的错误记录
      chrome.storage.local.remove('dyx:bridgeRegError');
      console.log('[抖存] bs.js 常驻脚本已注册（document_start, MAIN world）');
    } catch (regErr) {
      // 若因"已存在"报错，尝试 update
      const errMsg = regErr instanceof Error ? regErr.message : String(regErr);
      if (errMsg.indexOf('Duplicate') !== -1 || errMsg.indexOf('already') !== -1) {
        try {
          await chrome.scripting.updateContentScripts([{
            id: BRIDGE_SCRIPT_ID,
            matches: ['*://www.douyin.com/*'],
            js: ['bs.js'],
            runAt: 'document_start' as any,
            world: 'MAIN' as chrome.scripting.ExecutionWorld,
            allFrames: false,
          }]);
          chrome.storage.local.remove('dyx:bridgeRegError');
          console.log('[抖存] bs.js 常驻脚本已更新（重复注册后 update）');
        } catch (updateErr) {
          const updateErrMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
          // 写入 storage 供诊断读取
          chrome.storage.local.set({ 'dyx:bridgeRegError': updateErrMsg.slice(0, 120) });
          console.warn(`[抖存] bs.js 常驻脚本更新失败: ${updateErrMsg}，将依赖内容脚本兜底注入`);
        }
      } else {
        // 写入 storage 供诊断读取
        chrome.storage.local.set({ 'dyx:bridgeRegError': errMsg.slice(0, 120) });
        console.warn(`[抖存] bs.js 常驻脚本注册失败: ${errMsg}，将依赖内容脚本兜底注入`);
      }
    }
  }
}

// 第九轮修复：SW 每次启动都确保常驻注册生效（幂等）
// 之前只在 onInstalled/onStartup 调用，chrome://extensions 点重新加载时不保证触发
registerBridgeScript();

// 安装/启动时注册常驻桥脚本
chrome.runtime.onInstalled.addListener(() => {
  registerBridgeScript();
});

chrome.runtime.onStartup.addListener(() => {
  registerBridgeScript();
});

// webRequest 参数捕获：监听抖音 API 请求，存最近一次 query 到 dyx:requestParams
const DOUYIN_API_URLS = [
  'https://www.douyin.com/aweme/v1/web/aweme/detail/*',
  'https://www.douyin.com/aweme/v1/web/general/search/single/*',
  'https://www.douyin.com/aweme/v1/web/aweme/post/*',
  'https://www.douyin.com/aweme/v1/web/social/*',
  'https://www.douyin.com/aweme/v1/web/module/feed/*',
];

chrome.webRequest.onCompleted.addListener(
  (details) => {
    try {
      const url = new URL(details.url);
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) {
        params[k] = v;
      }
      chrome.storage.local.set({ 'dyx:requestParams': params });
    } catch {
      // 忽略解析失败
    }
  },
  { urls: DOUYIN_API_URLS, types: ['xmlhttprequest'] as chrome.webRequest.ResourceType[] }
);

// 消息路由
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    // M2：合并写入批量列表，回执总数
    case DYX_ADD_ITEMS: {
      const list = msg.list || 'batch';
      const items: VideoItem[] = msg.items || [];
      const key = `dyx:${list}List`;
      chrome.storage.local.get([key], (result) => {
        const map: Record<string, VideoItem> = result[key] || {};
        for (const item of items) {
          if (item.vid) {
            // 合并：新条目覆盖旧条目（允许刷新直链等）
            map[item.vid] = item;
          }
        }
        chrome.storage.local.set({ [key]: map }, () => {
          sendResponse({ total: Object.keys(map).length });
        });
      });
      return true; // 异步
    }

    case DYX_GET_LIST: {
      const list = msg.list || 'batch';
      chrome.storage.local.get([`dyx:${list}List`], (result) => {
        sendResponse(result[`dyx:${list}List`] || {});
      });
      return true;
    }

    // M2：按 vids[] 删除
    case DYX_REMOVE_ITEMS: {
      const list = msg.list || 'batch';
      const vids: string[] = msg.vids || [];
      const key = `dyx:${list}List`;
      chrome.storage.local.get([key], (result) => {
        const map: Record<string, VideoItem> = result[key] || {};
        for (const vid of vids) {
          delete map[vid];
        }
        chrome.storage.local.set({ [key]: map }, () => {
          sendResponse({ total: Object.keys(map).length });
        });
      });
      return true;
    }

    case DYX_CLEAR_LIST: {
      const list = msg.list || 'batch';
      chrome.storage.local.set({ [`dyx:${list}List`]: {} }, () => {
        sendResponse(true);
      });
      return true;
    }

    case DYX_OPEN_BATCH: {
      chrome.tabs.create({ url: chrome.runtime.getURL('batch.html') }, (tab) => {
        sendResponse({ tabId: tab?.id });
      });
      return true;
    }

    // M4：打开原声采集页
    case DYX_OPEN_SOUND: {
      chrome.tabs.create({ url: chrome.runtime.getURL('sound.html') }, (tab) => {
        sendResponse({ tabId: tab?.id });
      });
      return true;
    }

    // M2：失效链接刷新 — SW 找到抖音标签页，转发给内容脚本解析
    case DYX_RESOLVE_ITEMS: {
      const vids: string[] = msg.vids || [];
      if (vids.length === 0) {
        sendResponse({ results: [] });
        return false;
      }
      // 找到一个 douyin.com 标签页用于解析
      chrome.tabs.query({ url: 'https://www.douyin.com/*' }, (tabs) => {
        if (!tabs.length) {
          sendResponse({ error: '未找到抖音标签页，请先打开抖音页面' });
          return;
        }
        // 用第一个匹配的标签页
        const tab = tabs[0];
        if (!tab.id) {
          sendResponse({ error: '标签页无效' });
          return;
        }
        chrome.tabs.sendMessage(
          tab.id,
          { type: 'DYX_RESOLVE_FROM_BATCH', vids },
          (resp) => {
            const err = chrome.runtime.lastError;
            if (err) {
              sendResponse({ error: err.message });
            } else {
              sendResponse(resp);
            }
          }
        );
      });
      return true;
    }

    case DYX_SETTINGS_CHANGED: {
      // 可广播到所有抖音标签页的内容脚本
      sendResponse(true);
      return false;
    }

    // 内容脚本请求注入 bs.js 到 MAIN world（绕过页面 CSP）
    case DYX_INJECT_BRIDGE: {
      const tabId = sender.tab?.id;
      if (!tabId) {
        console.warn('[抖存] DYX_INJECT_BRIDGE: 无 tabId');
        sendResponse({ success: false, error: 'no_tab_id' });
        return false;
      }
      chrome.scripting.executeScript(
        { target: { tabId }, files: ['bs.js'], world: 'MAIN' as chrome.scripting.ExecutionWorld }
      ).then(() => {
        console.log(`[抖存] bs.js 注入成功 (tabId=${tabId})`);
        sendResponse({ success: true });
      }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[抖存] bs.js 注入失败 (tabId=${tabId}): ${errMsg}`);
        sendResponse({ success: false, error: errMsg });
      });
      return true; // 异步
    }

    default:
      return false;
  }
});
