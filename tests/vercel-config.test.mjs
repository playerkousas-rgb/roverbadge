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
import { spawnSync, execFileSync } from 'child_process';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

// vercel.json 頂層合法欄位（Vercel 官方文件所列；additionalProperties:false）
// 只列 Vercel 官方 schema（https://openapi.vercel.sh/vercel.json，根節點 additionalProperties:false）
// 真係存在嘅根欄位。注意：buildCommand / installCommand / outputDirectory / framework
// **唔係** vercel.json 欄位（佢哋係 Dashboard 嘅 Project Settings）—— 寫入去就會
// 「should NOT have additional properties」令成次 build 失敗（2026-08-28 我踩過两次：
// 第一次 _comment，第二次 buildCommand）。
const ROOT_KEYS = new Set([
  '$schema', 'alias', 'assetIgnore', 'build', 'builds', 'cache', 'cleanUrls', 'crons',
  'decompress', 'deployments', 'env', 'filesystem', 'framework', 'functionFailoverRegions',
  'functions', 'git', 'github', 'headers', 'ignoreCommand', 'mount', 'outputDirectory',
  'passiveRegions', 'public', 'redirects', 'regions', 'rewrites', 'routes', 'skill',
  'skipsDeployment', 'static', 'trailingSlash', 'unlisted', 'version', 'wildcard'
]);
// Project Settings only（絕對唔可以出現喺 vercel.json）
const SETTINGS_ONLY = new Set(['buildCommand', 'installCommand', 'devCommand', 'commandForIgnoringBuildStep']);
// functions["<glob>"] 合法欄位（照官方 schema 節點）
const FUNC_KEYS = new Set([
  'excludeFiles', 'includeFiles', 'maxDuration', 'maxConcurrency', 'memory', 'runtime',
  'regions', 'functionFailoverRegions', 'supportsCancellation', 'experimentalTriggers'
]);
const HEADER_ROUTE_KEYS = new Set(['source', 'regex', 'has', 'missing', 'headers']);
const HEADER_ITEM_KEYS = new Set(['key', 'value']);

let raw, cfg;
const vcPath = path.join(ROOT, 'vercel.json');
if (!fs.existsSync(vcPath)) {
  console.log('  · 冇 vercel.json（純零配置）— 只檢查唔准存在 legacy 欄位，跳過結構驗證');
  console.log('\n========================================');
  console.log('結果：1 通過, 0 失敗（vercel.json 未存在）');
  process.exit(0);
}
try {
  raw = fs.readFileSync(vcPath, 'utf8');
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
  check('functions（若存在）每個 key 都合法', keys.every(k => /^.{1,256}$/.test(k)));
  const globOk = keys.every(k => /^.{1,256}$/.test(k));
  check('每個 key 都係 1-256 字嘅 glob', globOk, keys.join(','));
  for (const k of keys) {
    const entry = fn[k] || {};
    const bad = Object.keys(entry).filter(x => !FUNC_KEYS.has(x));
    check(`functions["${k}"] 冇未知欄位`, bad.length === 0, '未知：' + bad.join(', '));
    if (entry.includeFiles !== undefined) {
      // v4.0：Registry 純環境變數，function 唔再讀檔案 → includeFiles 應該已移除
      check(`functions["${k}"] 不再需要 includeFiles（Registry 純 env）`, false, JSON.stringify(entry.includeFiles));
    }
    if ('maxDuration' in entry) {
      const ok = (typeof entry.maxDuration === 'number' && entry.maxDuration >= 1 && entry.maxDuration <= 1800)
        || entry.maxDuration === 'max';
      check(`functions["${k}"].maxDuration 合法（1-1800 或 "max"）`, ok, String(entry.maxDuration));
      check(`functions["${k}"].maxDuration 唔超過 plan 上限（10-300 之間先安全；唔設就用平台預設）`,
        typeof entry.maxDuration === 'string' || (entry.maxDuration >= 10 && entry.maxDuration <= 300), String(entry.maxDuration));
    }
    if ('memory' in entry) {
      check(`functions["${k}"].memory 喺 128-10240`, entry.memory >= 128 && entry.memory <= 10240, String(entry.memory));
    }
  }
  if (keys.length) check('有 glob 覆蓋到 api/*.js', !!fn['api/*.js'] || !!fn['api/**/*.js'], keys.join(','));
}

console.log('\n【3】headers 區塊結構');
{
  const hs = cfg.headers || [];
  check('headers 係陣列', Array.isArray(hs));
  if (!hs.length) console.log('  · 冇 headers（用平台預設快取控制）');
  hs.forEach((h, i) => {
    const bad = Object.keys(h).filter(k => !HEADER_ROUTE_KEYS.has(k));
    check(`headers[${i}] 冇未知欄位`, bad.length === 0, '未知：' + bad.join(', '));
    check(`headers[${i}].source 有填`, typeof h.source === 'string' && h.source.length > 0);
    check(`headers[${i}].headers 係陣列且每項只有 key/value`,
      Array.isArray(h.headers) && h.headers.every(x => Object.keys(x).every(k => HEADER_ITEM_KEYS.has(k)) && typeof x.key === 'string'),
      JSON.stringify(h.headers || null));
  });
  if (hs.length) check('/api/* 有 no-store（避免 404／旅團名單被 CDN 缓存）',
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

console.log('\n【5】Project Settings 欄位唔准出現喺 vercel.json（會令 build 直接失敗）');
{
  const bad = Object.keys(cfg).filter(k => SETTINGS_ONLY.has(k));
  check('冇 buildCommand/installCommand/devCommand 等 Project Settings 欄位',
    bad.length === 0, '呢啲欄位要喺 Vercel Dashboard → Project Settings 設定，唔屬於 vercel.json：' + bad.join(', '));
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const buildScript = (pk.scripts || {}).build || '';
  check('vercel.json 唔需要存在都唔會壞事（零配置已可建 function）', true);
  // 2026-09-22 旅系統對齊：build script 恢復（對齊 vsbadge）—— Vercel 會將佢當 Build Command 執行，
  // 所以佢必須係 Build Output API 腳本（只寫 .vercel/output、零依賴、零網絡）；
  // 「唔准寫返入來源目錄」嘅底線改由【6】嘅功能檢查守護（跑真 build，比對來源樹快照）
  check('build script 必須係 node scripts/build.mjs（Build Output API；Vercel 會自動把佢當 Build Command 執行）',
    buildScript === 'node scripts/build.mjs', buildScript);
  check('冇 dependencies → npm install 冇副作用、唔會 fail', pk.dependencies === undefined || Object.keys(pk.dependencies).length === 0);
  check('建構／測試工具不入 dependencies（保持極簡依賴）',
    pk.dependencies === undefined || Object.keys(pk.dependencies).length === 0);
}

console.log('\n========================================');
console.log('\n【6】部署瘦身：.vercelignore 排除開發檔，但唔排除前端引用嘅資源');
{
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 2026-08-28 事故底線（postmortem 第 5 節）：build script 會喺 Vercel build 環境自動執行，
  // 2026-09-22 旅系統對齊：恢復 build script（對齊 vsbadge 嘅 Build Output API 模式）——
  // 底線改寫成功能檢查：真跑一次 build，比對來源樹快照，「寫返入來源目錄」即刻紅。
  check('scripts.build 必須係 node scripts/build.mjs（Build Output API；Vercel 會自動把佢當 Build Command 執行）',
    (pk.scripts || {}).build === 'node scripts/build.mjs',
    'build script → Vercel 以「npm run build」做 Build Command；脚本只准寫 .vercel/output（見下方功能檢查）');
  {
    const snapshotSourceTree = () => {
      const out = {};
      const walk = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === '.vercel' || e.name === '.vercel-build' || e.name === '.git' || e.name === 'node_modules') continue;
          const p = path.join(dir, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) walk(p, r);
          else out[r] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        }
      };
      walk(ROOT, '');
      return out;
    };
    const before = snapshotSourceTree();
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'pipe' });
    const after = snapshotSourceTree();
    const changed = Object.keys(after).filter(f => after[f] !== before[f])
      .concat(Object.keys(before).filter(f => !(f in after)));
    check('build 只寫 .vercel/output：來源目錄零改動（2026-08-28 事故底線）',
      changed.length === 0, changed.slice(0, 5).join(', '));
  }
  check('冇 sync:troops script（旅團登記已改純環境變數）', (pk.scripts || {})['sync:troops'] === undefined);
  check('test 鏈唔再包含 sync --check', !/sync-troops/.test((pk.scripts || {}).test || ''));

  const viPath = path.join(ROOT, '.vercelignore');
  check('.vercelignore 存在', fs.existsSync(viPath));
  const vi = fs.existsSync(viPath) ? fs.readFileSync(viPath, 'utf8') : '';
  for (const want of ['.git', 'node_modules', 'tests/', '*.log']) {
    check(`.vercelignore 排除 ${want}`, vi.split('\n').some(l => l.trim() === want), vi);
  }
  // 前端／已部署文件實際引用嘅檔案絕不能被排除（全文搜尋引用後先可以排除）
  const refSources = [fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')];
  for (const d of fs.readdirSync(path.join(ROOT, 'docs'))) {
    if (d.endsWith('.md')) refSources.push(fs.readFileSync(path.join(ROOT, 'docs', d), 'utf8'));
  }
  const referenced = (f) => refSources.some(src => src.includes(f));
  const mustDeploy = ['apps-script/Code.gs', 'assets/ymis-parse.js', 'assets/batch-onboard/Code.gs',
    'assets/bp-award-logo-128.png', 'assets/bp-award-logo-256.png',
    'data/items.json', 'data/items_en.json', 'data/members_template.csv', 'data/mock_members.json',
    'docs/BULK_ONBOARD.md', 'docs/EXEC_GUIDE.md', 'docs/LEADER_GUIDE.md', 'docs/MEMBER_GUIDE.md', 'docs/YMIS_EXPORT.md'];
  const viLines = vi.split('\n').map(l => l.trim()).filter(Boolean);
  for (const f of mustDeploy) {
    check(`${f} 有被 index.html／已部署文件引用（唔可以排除）`, referenced(f), f);
    check(`.vercelignore 冇排除 ${f}`, !viLines.includes(f) && !viLines.some(l => l.endsWith('/') && f.startsWith(l)), vi);
  }
  // 已刪除嘅舊旅團登記檔案唔應該返嚟
  check('troops.json / data/troops.json / api/_troops_static.js / scripts/sync-troops.mjs 已刪除',
    !fs.existsSync(path.join(ROOT, 'troops.json')) &&
    !fs.existsSync(path.join(ROOT, 'data', 'troops.json')) &&
    !fs.existsSync(path.join(ROOT, 'api', '_troops_static.js')) &&
    !fs.existsSync(path.join(ROOT, 'scripts', 'sync-troops.mjs')));
}

console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
