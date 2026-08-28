// vercel.json 結構驗證 —— 防止「部署直接 Error」呢類事故
//
// 背景（2026-08-28）：為咺把 legacy 註解寫入 config，我喺 vercel.json 加咗一個 `_comment` 欄位，
// Vercel 官方 schema（https://openapi.vercel.sh/vercel.json）根節點係
//   { "type": "object", "additionalProperties": false, ... }
// 即「唔准任何未知欄位」→ 整次 build 直接失败（Preview: Error，function 一個都冇）。
// 所以：vercel.json 裡嘅註解要嘛用不到（JSON 冇註解），要嘛就係炸彈。
// 本測試用同一份「已知合法欄位」清單做檢查，註解一律放呢個檔／docs。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

// vercel.json 頂層合法欄位（Vercel 官方文件所列；additionalProperties:false）
const ROOT_KEYS = new Set([
  '$schema', 'alias', 'buildCommand', 'builds', 'cache', 'cleanUrls', 'crons', 'decompress',
  'deployments', 'env', 'filesystem', 'framework', 'functionFailoverRegions', 'functions',
  'git', 'headers', 'ignoreCommand', 'installCommand', 'mount', 'outputDirectory', 'passiveRegions',
  'public', 'redirects', 'regions', 'rewrites', 'routes', 'skill', 'skipsDeployment',
  'static', 'trailingSlash', 'unlisted', 'version', 'wildcard'
]);
// functions["<glob>"] 合法欄位（照官方 schema 節點）
const FUNC_KEYS = new Set([
  'excludeFiles', 'includeFiles', 'maxDuration', 'maxConcurrency', 'memory', 'runtime',
  'regions', 'functionFailoverRegions', 'supportsCancellation', 'experimentalTriggers'
]);
const HEADER_ROUTE_KEYS = new Set(['source', 'regex', 'has', 'missing', 'headers']);
const HEADER_ITEM_KEYS = new Set(['key', 'value']);

let raw, cfg;
try {
  raw = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  cfg = JSON.parse(raw);
  check('vercel.json 係有效 JSON', true);
} catch (e) {
  check('vercel.json 係有效 JSON', false, e.message);
  console.log('\n結果：0 通過, 1 失敗');
  process.exit(1);
}

console.log('\n【1】頂層欄位必須全部係 Vercel 認得嘅（additionalProperties:false → 多一個欄位就 build 失敗）');
{
  const unknown = Object.keys(cfg).filter(k => !ROOT_KEYS.has(k));
  check('冇未知頂層欄位（例如 _comment / _note / 自訂說明）', unknown.length === 0, '未知：' + unknown.join(', '));
  check('冇 deprecated `builds`', cfg.builds === undefined);
  check('冇 legacy `routes`', cfg.routes === undefined);
  check('冇 legacy `version`', cfg.version === undefined);
  check('冇 deprecated `env`（環境變數放 Vercel Dashboard）', cfg.env === undefined);
  check('冇 deprecated `build.env`', cfg.build === undefined);
}

console.log('\n【2】functions 區塊');
{
  const fn = cfg.functions || {};
  const keys = Object.keys(fn);
  check('有 functions 設定', keys.length > 0);
  const globOk = keys.every(k => /^.{1,256}$/.test(k));
  check('每個 key 都係 1-256 字嘅 glob', globOk, keys.join(','));
  for (const k of keys) {
    const entry = fn[k] || {};
    const bad = Object.keys(entry).filter(x => !FUNC_KEYS.has(x));
    check(`functions["${k}"] 冇未知欄位`, bad.length === 0, '未知：' + bad.join(', '));
    if (typeof entry.includeFiles === 'string') {
      check(`functions["${k}"].includeFiles 長度 ≤256 且涵蓋 data/*.json`,
        entry.includeFiles.length <= 256 && /data\/\*\.json/.test(entry.includeFiles), entry.includeFiles);
      check(`functions["${k}"].includeFiles 係單一 glob 字串（唔係陣列）`, typeof entry.includeFiles === 'string');
    }
    if ('maxDuration' in entry) {
      const ok = (typeof entry.maxDuration === 'number' && entry.maxDuration >= 1 && entry.maxDuration <= 1800)
        || entry.maxDuration === 'max';
      check(`functions["${k}"].maxDuration 合法（1-1800 或 "max"）`, ok, String(entry.maxDuration));
      const num = typeof entry.maxDuration === 'number' ? entry.maxDuration : 1800;
      check(`functions["${k}"].maxDuration 足夠長（≥60s，GAS 批量寫入需要）`, num >= 60, String(num));
    }
    if ('memory' in entry) {
      check(`functions["${k}"].memory 喺 128-10240`, entry.memory >= 128 && entry.memory <= 10240, String(entry.memory));
    }
  }
  check('api/*.js 有被 glob 覆蓋到（Vercel 先會 apply includeFiles）', !!fn['api/*.js'] || !!fn['api/**/*.js'], keys.join(','));
}

console.log('\n【3】headers 區塊結構');
{
  const hs = cfg.headers || [];
  check('headers 係陣列', Array.isArray(hs));
  hs.forEach((h, i) => {
    const bad = Object.keys(h).filter(k => !HEADER_ROUTE_KEYS.has(k));
    check(`headers[${i}] 冇未知欄位`, bad.length === 0, '未知：' + bad.join(', '));
    check(`headers[${i}].source 有填`, typeof h.source === 'string' && h.source.length > 0);
    check(`headers[${i}].headers 係陣列且每項只有 key/value`,
      Array.isArray(h.headers) && h.headers.every(x => Object.keys(x).every(k => HEADER_ITEM_KEYS.has(k)) && typeof x.key === 'string'),
      JSON.stringify(h.headers || null));
  });
  check('/api/* 有 no-store（避免 404／旅團名單被 CDN 缓存）',
    JSON.stringify(hs).includes('/api/') && JSON.stringify(hs).includes('no-store'));
}

console.log('\n【4】設定來源唯一：maxDuration 只可以喺 vercel.json 出現一次');
{
  const apiDir = path.join(ROOT, 'api');
  for (const f of fs.readdirSync(apiDir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(apiDir, f), 'utf8');
    check('api/' + f + ' 冇 export const config（同 vercel.json 重複會互相覆蓋）',
      !/export\s+const\s+config\s*=/.test(src));
  }
  const hasTimeoutInCode = fs.readdirSync(path.join(ROOT, 'api'))
    .some(f => f.endsWith('.js') && /maxDuration/.test(fs.readFileSync(path.join(ROOT, 'api', f), 'utf8').replace(/\/\/.*$/gm, '')));
  check('api/ 無任何地方硬寫 maxDuration（全部由 vercel.json 管）', hasTimeoutInCode === false);
}

console.log('\n【5】buildCommand 一定要存在且只依賴 node（Vercel 會跑佢產生 _troops_static.js）');
{
  check('buildCommand = npm run build', cfg.buildCommand === 'npm run build', String(cfg.buildCommand));
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json 有 build script', typeof (pk.scripts || {}).build === 'string' && /sync-troops/.test(pk.scripts.build), (pk.scripts || {}).build || '');
  const buildScript = (pk.scripts || {}).build || '';
  check('build 唔依賴 devDependencies（Vercel build 環境未必裝 devDeps）', !/(vite|next|webpack|tsc|eslint|jest)/.test(buildScript), buildScript);
  check('冇 dependencies 都唔會 fail（冇 install 副作用）', pk.dependencies === undefined || Object.keys(pk.dependencies).length === 0);
}

console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
