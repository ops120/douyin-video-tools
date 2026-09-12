// esbuild 多入口构建脚本。按 PRD §4.2 退化方案：esbuild 多入口 + 脚本拷贝 manifest/rules。
// M2：新增 batch 入口与静态拷贝
// 第三轮修复：--watch 改用 esbuild.context + watch()，静态文件用 fs.watch 重拷
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = resolve(root, 'dist');
const watchMode = process.argv.includes('--watch');

// 入口定义：esbuild entryPoints 使用 {in, out} 对；每入口独立 format
const entries = [
  { in: 'src/background/index.ts', out: 'background', format: 'esm', outfile: 'sw.js' },
  { in: 'src/content/index.ts', out: 'content', format: 'esm', outfile: 'cs.js' },
  { in: 'src/page-bridge/bs.ts', out: 'page-bridge', format: 'iife', outfile: 'bs.js' },
  { in: 'src/popup/main.ts', out: 'popup', format: 'iife', outfile: 'popup.js' },
  // M2：批量页入口
  { in: 'src/batch/main.ts', out: 'batch', format: 'iife', outfile: 'batch.js' },
];

const STATIC_MAP = [
  ['src/manifest.json', 'manifest.json'],
  ['src/rules/rules.json', 'rules/rules.json'],
  ['src/popup/index.html', 'popup.html'],
  ['src/popup/style.css', 'popup.css'],
  ['src/batch/index.html', 'batch.html'],
  ['src/batch/style.css', 'batch.css'],
  ['src/content/content.css', 'content.css'],
];

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  for (const [src, dst] of STATIC_MAP) {
    await cp(resolve(root, src), resolve(dist, dst));
  }
  const iconsSrc = resolve(root, 'public/icons');
  if (existsSync(iconsSrc)) {
    await mkdir(resolve(dist, 'icons'), { recursive: true });
    for (const size of ['16', '32', '48', '128']) {
      const p = resolve(iconsSrc, `${size}.png`);
      if (existsSync(p)) await cp(p, resolve(dist, `icons/${size}.png`));
    }
  }
}

// 构建 esbuild 选项（每个入口独立）
function buildOptions(e, minify) {
  return {
    entryPoints: [{ in: resolve(root, e.in), out: e.out }],
    bundle: true,
    format: e.format,
    target: ['es2020'],
    platform: 'browser',
    outfile: resolve(dist, e.outfile),
    logLevel: 'info',
    legalComments: 'none',
    minify,
  };
}

async function fullBuild(minify) {
  for (const e of entries) {
    await esbuild.build(buildOptions(e, minify));
  }
  await copyStatic();
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  if (watchMode) {
    // 真实 watch 模式：用 esbuild.context + watch()
    // watch 时不做 minify，便于调试
    for (const e of entries) {
      const ctx = await esbuild.context(buildOptions(e, false));
      await ctx.watch();
      console.log(`[build] 监听中: ${e.in}`);
    }
    await copyStatic();
    console.log('[build] JS 入口监听已启动，dist/ 已生成');

    // 静态文件变更：fs.watch 监听源目录，有变更时重拷
    const watchDirs = new Set(STATIC_MAP.map(([src]) => resolve(root, dirname(src))));
    for (const dir of watchDirs) {
      if (existsSync(dir)) {
        watch(dir, { recursive: false }, async (_event, filename) => {
          if (!filename) return;
          const matched = STATIC_MAP.find(([src]) => src.endsWith(filename));
          if (matched) {
            try {
              await cp(resolve(root, matched[0]), resolve(dist, matched[1]));
              console.log(`[build] 静态文件已重拷: ${matched[1]}`);
            } catch {
              // 文件可能已被删除，忽略
            }
          }
        });
      }
    }
    console.log('[build] 静态文件监听已启动（仅覆盖 JS 入口，静态文件需 source 同目录变更触发）');
  } else {
    await fullBuild(true);
    console.log('[build] dist/ 已生成');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
