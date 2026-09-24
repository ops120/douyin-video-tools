// 校验 dist/manifest.json 是合法 JSON，且其中引用的每个文件都真实存在
// M2：扩展为同时校验 batch.html/batch.js/batch.css 等新引用
// 第三轮修复 #12：解析 popup.html / batch.html 中 src/href 相对引用并逐个校验存在
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, '..', 'dist');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log('OK:', msg);
}

// 1. 合法 JSON
let manifest;
try {
  const raw = readFileSync(resolve(dist, 'manifest.json'), 'utf8');
  manifest = JSON.parse(raw);
  ok('dist/manifest.json 是合法 JSON');
} catch (e) {
  fail(`dist/manifest.json 解析失败: ${e.message}`);
  process.exit(1);
}

// 2. 引用文件存在性
const refs = [];
// background.service_worker
if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
// content_scripts[].js / css
for (const cs of manifest.content_scripts || []) {
  for (const f of [...(cs.js || []), ...(cs.css || [])]) refs.push(f);
}
// web_accessible_resources[].resources[]
for (const war of manifest.web_accessible_resources || []) {
  for (const r of war.resources || []) {
    if (!r.includes('*')) refs.push(r);
  }
}
// action.default_popup
if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
// icons
for (const v of Object.values(manifest.icons || {})) refs.push(v);
// declarative_net_request rule_resources path
for (const rr of manifest.declarative_net_request?.rule_resources || []) {
  if (rr.path) refs.push(rr.path);
}

let allOk = true;
for (const ref of refs) {
  const p = resolve(dist, ref);
  if (existsSync(p)) {
    const stat = statSync(p);
    ok(`引用文件存在: ${ref} (${stat.size} 字节)`);
  } else {
    fail(`引用文件缺失: ${ref}`);
    allOk = false;
  }
}

// 3. M2/M4 额外校验：批量页与原声采集页的产物文件
const m2Files = ['batch.html', 'batch.js', 'batch.css', 'sound.html', 'sound.js', 'sound.css'];
for (const f of m2Files) {
  const p = resolve(dist, f);
  if (existsSync(p)) {
    const stat = statSync(p);
    ok(`M2 文件存在: ${f} (${stat.size} 字节)`);
  } else {
    fail(`M2 文件缺失: ${f}`);
    allOk = false;
  }
}

// 4. 第三轮修复 #12：解析 HTML 中 src/href 相对引用并校验存在
const htmlFiles = ['popup.html', 'batch.html', 'sound.html'];
const srcHrefRe = /\b(?:src|href)=["']([^"'#?]+)["']/g;
for (const htmlFile of htmlFiles) {
  const htmlPath = resolve(dist, htmlFile);
  if (!existsSync(htmlPath)) {
    fail(`${htmlFile} 不存在，跳过引用校验`);
    allOk = false;
    continue;
  }
  const htmlContent = readFileSync(htmlPath, 'utf8');
  let match;
  const htmlDir = dirname(htmlPath);
  while ((match = srcHrefRe.exec(htmlContent)) !== null) {
    const ref = match[1];
    // 跳过协议绝对 URL 和 data: URI
    if (/^(https?:|data:|mailto:|javascript:)/.test(ref)) continue;
    const refPath = resolve(htmlDir, ref);
    if (existsSync(refPath)) {
      const stat = statSync(refPath);
      ok(`${htmlFile} 引用存在: ${ref} (${stat.size} 字节)`);
    } else {
      fail(`${htmlFile} 引用缺失: ${ref}`);
      allOk = false;
    }
  }
}

console.log(allOk ? '\n全部校验通过' : '\n存在缺失文件');
