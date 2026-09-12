# 抖存 DouCun

> ⚠️ 本扩展只做「下载与采集」，不提供任何绕过登录、付费或权限控制的能力；请仅用于个人学习、研究与合法备份，并遵守平台服务条款与著作权法。

> 实测环境：Chrome 153 / Manifest V3（Windows）；抖音网页版需处于登录状态。

抖音网页版的视频下载、批量打包与搜索页数据采集工具：在你已登录的真实浏览器里完成全部操作，数据只在本机流转，不经过任何自建服务器，不需要账号，不构造接口签名。

## 功能特性

- 📥 **单视频下载**：首页推荐流 / 视频详情页 / 搜索页 / 博主主页四类页面自动注入下载按钮，按最高码率解析直链，带实时进度
- 📦 **批量打包**：卡片「+」加入批量下载列表 → 批量页多选 → 打包 ZIP（流式写盘）或保存到指定文件夹
- 📊 **搜索页采集导出**：搜索结果逐条勾选 → 13 个字段结构化 → 导出 CSV / 复制到剪贴板，字段可自由配置
- 🔒 **复用页面真实请求**：解析走页面自身的登录态，请求参数严格白名单，不逆向、不伪造签名，风控暴露面最小
- 🩺 **自带诊断**：`<html data-dyx-diag>` 实时暴露捕获数、来源路径、缓存条目、注入数量、错误码，出问题不必翻控制台
- 🧩 **纯本地**：无后端、无账号、无遥测；除 `douyin.com` 与 `douyinvod.com` 外零外联

## 环境要求

- Chrome / Edge **114+**（依赖 File System Access API 实现流式落盘与文件夹保存）
- Node.js **18+** 与 npm（仅构建与开发需要；使用者只需 `dist/` 产物）
- 已登录的抖音网页版账号（页面自身的接口请求需要登录态）

## 界面预览

**页面注入按钮** — 卡片右上角依次为 `↓` 下载、`+` 加入批量下载列表、「选择」勾选用于导出表格

![页面注入按钮](demo/page-buttons.png)

**弹窗 · 列表** — 批量下载清单与批量页入口

![弹窗列表](demo/popup-list.png)

**弹窗 · 导出** — 13 个字段可自由勾选，支持复制到剪贴板与导出 CSV

![弹窗导出](demo/popup-export.png)

**扩展信息** — 加载后的扩展卡片，可从此处进入 Service Worker 控制台排查问题

![扩展信息](demo/extension-card.png)

## 一键构建并加载

1. 获取源码并构建

   ```bash
   git clone https://github.com/ops120/douyin-video-tools.git
   cd douyin-video-tools
   npm install
   npm run build
   ```

2. 在浏览器加载

   - 打开 `chrome://extensions`，开启右上角「开发者模式」
   - 点「加载已解压的扩展程序」，选择项目下的 **`dist/`** 目录（不是项目根目录）
   - 打开并刷新 `https://www.douyin.com`；若未生效，先到扩展页点一次「重新加载」再刷新页面

3. 开发调试

   ```bash
   npm run dev          # esbuild 监听模式，源码变更自动重建（静态文件走 fs.watch 重拷）
   ```

### 构建产物

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单（权限见「安全」） |
| `sw.js` | Service Worker：消息路由、参数捕获、页面桥常驻注册 |
| `cs.js` | 内容脚本：按钮注入、解析编排、下载执行 |
| `bs.js` | 页面桥：注入页面世界，捕获接口响应、代发请求 |
| `popup.html/js/css` | 弹窗：列表 / 导出 / 设置 |
| `batch.html/js/css` | 批量页：选择、ZIP 打包、文件夹保存 |
| `content.css` | 注入到抖音页面的样式（`dyx-` 前缀） |
| `rules/rules.json` | declarativeNetRequest 规则：改写 CDN 的 CORS 与 Referer 头 |
| `icons/` | 占位图标（纯色，发布前请替换） |

## 手动构建

```bash
npm install                  # 安装构建依赖
npm run typecheck            # TypeScript strict 类型检查
npm run build                # esbuild 多入口构建 → dist/
node scripts/verify-dist.mjs # 校验产物与 manifest / HTML 引用完整性
node scripts/gen-icons.mjs   # 重新生成占位图标
```

## 目录结构

```
douyin-video-tools/
├─ src/
│  ├─ manifest.json              MV3 清单
│  ├─ rules/rules.json           DNR 规则（CDN CORS / Referer）
│  ├─ page-bridge/bs.ts          页面桥：XHR/fetch 捕获、代发请求、读 webid
│  ├─ content/
│  │  ├─ index.ts                入口：桥注入、观察器、SPA 路由、三类按钮
│  │  ├─ selectors.ts            页面与卡片选择器（集中管理，含降级策略）
│  │  ├─ inject-ui.ts            按钮容器 / 计数浮条 / toast
│  │  ├─ bridge.ts               postMessage → Promise 封装
│  │  ├─ downloader.ts           直链解析（参数白名单）与流式下载
│  │  └─ content.css             注入样式
│  ├─ background/index.ts        SW：消息路由、参数捕获、常驻注册
│  ├─ shared/                    types / protocol / capture / stream-parser
│  │                             filename / fields / settings / errors
│  │                             queue / zip / pending-queue / diag
│  ├─ popup/                     弹窗（列表 / 导出 / 设置）
│  └─ batch/                     批量页
├─ scripts/                      gen-icons.mjs、verify-dist.mjs
├─ demo/                         界面预览截图
├─ build.mjs                     esbuild 多入口构建脚本
├─ dist/                         构建产物（加载到浏览器）
└─ .doc/                         研发文档（PRD、里程碑实现说明、实测修复记录，不入版本库）
```

## 系统架构

```
抖音页面（页面世界）                扩展（隔离世界 / 后台）
┌──────────────────────┐ postMessage ┌──────────────────────────────┐
│ bs.js 页面桥          │◄───────────►│ cs.js 内容脚本                │
│ · XHR / fetch 捕获    │             │ · 按钮 / 浮条 / toast         │
│ · 代发请求（带登录态）│             │ · 直链解析 + 下载执行         │
│ · 读 localStorage     │             └───────────┬──────────────────┘
└──────────────────────┘                         │ chrome.runtime
                                                 ▼
                                   ┌──────────────────────────────┐
                                   │ sw.js Service Worker          │
                                   │ · 列表与设置（唯一数据源）     │
                                   │ · webRequest 参数捕获          │
                                   │ · 页面桥常驻注册（MAIN world）  │
                                   └───────┬──────────────┬────────┘
                                           ▼              ▼
                                   popup（列表/导出/设置）  batch（批量页）
                                           │
                                           ▼
                          DNR 改写 CDN 头 · File System Access 流式落盘
```

## 工作原理

三条链路都不需要构造 `X-Bogus` / `a_bogus` 签名：

1. **数据优先复用页面响应**：内容脚本按 `vid` 查缓存，缓存来自页面自身发起的接口响应（详情 / 博主作品列表 / 搜索流式接口），命中即零额外请求
2. **缺失时才自建请求**：请求参数按**严格白名单**输出（设备与浏览器指纹 + 从页面 `localStorage.__tea_cache_tokens_6383` 读取的 `webid`），**绝不携带签名参数**——签名与具体 URL 绑定，挪用必然验签失败
3. **CDN 直链拉取**：`declarativeNetRequest` 改写 `*.douyinvod.com` 的响应头 `Access-Control-Allow-Origin` 与请求头 `Referer` / `Origin`，使扩展侧可直接拉取视频文件

页面适配要点（均经真机验证）：

- 页面路径可能带 `/root` 前缀，分类前先归一
- 新版搜索卡片既无 `<a href="/video/...">` 也无 `data-e2e-vid`，视频 ID 取自父元素 `id="waterfall_item_<aweme_id>"`
- 搜索首屏数据来自 `/aweme/v1/web/general/search/stream/`（`fetch` + 分块流式响应），需按块解析
- 页面桥以 `chrome.scripting.registerContentScripts` 常驻注入 `document_start` + MAIN world，早于页面首个请求；捕获结果先入缓冲队列，等内容脚本就绪后回放，避免早到消息丢失

### 只读 / 写操作矩阵

| 操作 | 是否产生 | 说明 |
|---|---|---|
| 读取页面数据（列表 / 详情 / 搜索响应） | 只读 | 仅解析页面已加载内容 |
| 调用详情接口 | 只读 | 页面登录态、白名单参数、默认串行限频 |
| 点赞 / 评论 / 关注 / 私信 / 发布 | **不产生** | 代码中不存在任何写接口 |
| 写入 | 仅本地 | 保存 mp4 / zip / csv 到你的磁盘 |

## 验证步骤

1. 加载扩展后打开抖音，确认卡片右上角出现按钮组（`↓` 下载 / `+` 加入批量下载列表 / 搜索页额外有「选择」）

2. 查看扩展诊断镜像（页面控制台执行）：

   ```js
   document.documentElement.getAttribute('data-dyx-diag')
   // {"captures":12,"lastKind":"search","lastPath":"search/stream","cachedItems":12,
   //  "cards":20,"injected":20,"strategy":"waterfall-id","lastError":"",
   //  "bridgeReady":"loading","bridgeRegErr":""}
   ```

   判据：`bridgeReady` 应为 `loading`（桥在 document_start 就位）；`captures > 0` 且 `lastPath` 指向首屏接口；`lastError` 为空

3. 页面控制台过滤 `[抖存]`，可看到注入、捕获、解析、下载四条链路的日志

4. 搜索页勾选若干条 → 浮条「复制」→ 粘贴进 Excel 应能自动分列；「导出 CSV」用 Excel 打开中文不乱码

5. 批量页选择「下载 ZIP」，应**立即**弹出保存对话框（先取文件句柄，再开始下载）

## 配置概览

设置统一存放于 `chrome.storage.local`，键前缀 `dyx:`。

| 键 | 含义 | 默认值 |
|---|---|---|
| `dyx:settings` | `fileNameFormat` 文件名模板 | `date_title` |
| | `concurrency` 并发数（1–10） | `4` |
| | `retry` 失败重试次数（0–3） | `1` |
| | `requestInterval` 请求间隔（ms） | `300` |
| | `exportFields` 导出字段 key 列表 | 13 项全选 |
| `dyx:batchList` | 批量下载列表（`vid` → 视频对象） | `{}` |
| `dyx:searchList` | 搜索页已勾选（`vid` → 视频对象） | `{}` |
| `dyx:requestParams` | 最近一次接口请求参数（指纹字段兜底） | — |

文件名模板可选：`title` / `date_title` / `vid_title` / `title_vid` / `name_date_title` / `date_title_vid`。

导出字段（13 项）：用户昵称、用户链接、视频详情、视频描述、点赞、收藏、评论、分享、商品 ID、商品标题、价格、销量、商品链接。

## 安全

**权限最小化**，每一项都有明确用途：

| 权限 | 用途 |
|---|---|
| `storage` / `unlimitedStorage` | 批量列表、已选列表与设置（均在本机） |
| `declarativeNetRequest` | 改写 CDN 的 CORS 与 Referer 头，使直链可拉取 |
| `webRequest` | 观察模式捕获页面接口参数（指纹字段兜底） |
| `scripting` | 以 MAIN world 注入页面桥（页面 CSP 会拦截 script 标签注入） |
| `tabs` | 跨标签页定位抖音页面以刷新失效直链 |

**数据流向**：不采集、不上报任何数据；无账号体系、无遥测、无自建服务器；网络请求仅发往 `douyin.com`（页面接口）与 `douyinvod.com`（视频 CDN）。

**代码安全**：页面数据一律以 `textContent` / DOM API 渲染；页面桥代发请求限定 `https://www.douyin.com/` 前缀；桥与内容脚本的消息均校验 `event.source === window`。

## 约束

- **内存**：ZIP 打包需把所有待打包视频的原始数据同时驻留内存（峰值 ≈ 选中视频总量 + 压缩工作集）；大批量（> 500MB）建议分批，或改用「保存到文件夹」逐条写盘
- **接口与页面变更**：抖音改版会同时影响选择器与接口路径；已内置多级降级（路径归一 → 未知页面兜底 → 父元素 ID / 封面文件 ID 匹配 → 新旧接口双匹配），仍失败时以 `data-dyx-diag` 的 `lastPath` / `captures` 定位
- **风控**：默认串行解析、间隔 ≥300ms（可在设置调整）；请勿改造为高频批量抓取
- **图文作品**：搜索页的图文帖不注入按钮（仅支持视频）
- **保存对话框**：ZIP / 文件夹保存依赖浏览器用户手势，必须在点击后立即在弹窗中选择位置

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。

## 致谢 / 第三方组件

- [JSZip](https://stuk.github.io/jszip/) — ZIP 打包（MIT）
- [TypeScript](https://www.typescriptlang.org/) / [esbuild](https://esbuild.github.io/) — 构建工具链
- 页面结构与接口路径的适配参考了《抖霸扩展研究报告》中的公开技术事实分析；本项目为洁净室实现，未复制其代码

**作者**：你们喜爱的老王 — [B 站 @你们喜爱的老王](https://space.bilibili.com/97727630) · [GitHub](https://github.com/ops120)
