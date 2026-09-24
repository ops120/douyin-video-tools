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

// ============================================================
// M4.2：临时代理标签页
// 详情接口要求真实页面上下文（实测仅改写 Origin/Referer 会被安全插件拦下，
// 返回 403 Blocked by ArgusSecurityPlugin），所以没有可用抖音页面时，
// 由扩展自己开一个后台标签页来代跑，用完即关，不需要用户手动开页面。
// ============================================================

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };

    timer = setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// 开一个后台标签页跑解析，无论成败都关掉它
async function resolveInTempTab(vids: string[]): Promise<unknown> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: 'https://www.douyin.com/', active: false });
    tabId = tab.id;
    if (tabId == null) throw new Error('标签页创建失败');

    await waitForTabComplete(tabId, 25000);
    // 内容脚本在 document_end 注入，complete 之后再留一点余量
    await new Promise((r) => setTimeout(r, 1000));

    // await 会一直等到内容脚本 sendResponse，此时才能安全关闭标签页
    return await chrome.tabs.sendMessage(tabId, {
      type: 'DYX_RESOLVE_FROM_BATCH',
      vids,
    });
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // 用户可能已手动关闭，忽略
      }
    }
  }
}

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
    // M4.2：遍历候选标签页；都没有可用页面时自动开后台标签页代跑
    case DYX_RESOLVE_ITEMS: {
      const vids: string[] = msg.vids || [];
      if (vids.length === 0) {
        sendResponse({ results: [] });
        return false;
      }

      // 兜底：没有可用的抖音页面，扩展自己开一个后台标签页，跑完即关
      const useTempTab = (): void => {
        resolveInTempTab(vids)
          .then((resp) => sendResponse(resp))
          .catch((e: unknown) => {
            sendResponse({
              error: `自动打开抖音页面失败：${e instanceof Error ? e.message : String(e)}`,
              code: 'auto_tab_failed',
            });
          });
      };

      // 可能有多个抖音标签页，其中一部分的内容脚本已失效（典型场景：扩展重载后，
      // 早先打开的页面里脚本成为孤儿，消息发不过去），故逐个尝试直到有人响应
      chrome.tabs.query({ url: 'https://www.douyin.com/*' }, (tabs) => {
        const candidates = tabs.filter((t) => t.id != null && !t.discarded);
        if (candidates.length === 0) {
          useTempTab();
          return;
        }

        let i = 0;
        const tryNext = (): void => {
          if (i >= candidates.length) {
            // 已有页面全部联系不上（多为扩展重载后的旧页面），交给临时标签页
            useTempTab();
            return;
          }
          const tab = candidates[i++];
          chrome.tabs.sendMessage(
            tab.id as number,
            { type: 'DYX_RESOLVE_FROM_BATCH', vids },
            (resp) => {
              // 必须在此读取 lastError，否则控制台会报 Unchecked runtime.lastError
              if (chrome.runtime.lastError) {
                tryNext(); // 这个标签页联系不上，换下一个
                return;
              }
              sendResponse(resp);
            }
          );
        };
        tryNext();
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
