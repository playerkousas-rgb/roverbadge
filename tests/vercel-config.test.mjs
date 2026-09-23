// vercel.json / 部署設定規則檢查（Build Output API 時代）
//
// 約定（vsbadge 同構）：
//   - vercel.json 只准 version/framework/buildCommand 三個頂層欄位（多一個就 build 失敗）
//   - buildCommand 指向 npm run build（scripts/build.mjs → .vercel/output）
//   - legacy builds/routes/functions 欄位一旦回來，Build Output 部署就會出事
//   - .vercelignore 唔准存在（會剝走 scripts/，build.mjs → runtime-config.mjs → Code.gs 讀唔到）
//   - api/proxy.js 以 export const config 管理執行時限（maxDuration）
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

console.log('\n【1】頂層欄位必須全部係 Vercel 認得嘅（additionalProperties:false → 多一個欄位就 build 失敗）');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const allowed = new Set(['version', 'framework', 'buildCommand']);
  const unknown = Object.keys(cfg).filter(k => !allowed.has(k));
  check('冇未知頂層欄位', unknown.length === 0, `未知：${unknown.join(', ')}`);
  check('version=2（Build Output API）', cfg.version === 2, JSON.stringify(cfg.version));
  check('framework=null（靜態＋自管 function）', cfg.framework === null, JSON.stringify(cfg.framework));
  check('buildCommand 指向 npm run build', cfg.buildCommand === 'npm run build', JSON.stringify(cfg.buildCommand));
}

console.log('\n【2】legacy 欄位唔准回來（builds/routes/functions 會同 Build Output 打交）');
{
  const raw = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  const cfg = JSON.parse(raw);
  check('冇 legacy `builds`', !('builds' in cfg));
  check('冇 legacy `routes`', !('routes' in cfg));
  check('冇 legacy `functions`（時限由 api 內 export config 管）', !('functions' in cfg));
  check('冇 legacy `outputDirectory`／`installCommand` 等 Project Settings 欄位',
    !('outputDirectory' in cfg) && !('installCommand' in cfg) && !('devCommand' in cfg) && !('regions' in cfg) && !('env' in cfg) && !('build' in cfg) && !('rewrites' in cfg) && !('redirects' in cfg) && !('headers' in cfg));
}

console.log('\n【3】Build Output 部署鏈（scripts/build.mjs → .vercel/output）');
{
  check('scripts/build.mjs 存在', fs.existsSync(path.join(ROOT, 'scripts', 'build.mjs')));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json build script 指向 scripts/build.mjs', /build\.mjs/.test(pkg.scripts && pkg.scripts.build || ''), JSON.stringify(pkg.scripts || {}));
  check('.vercelignore 唔准存在（會剝走 scripts/ 引致 accountId 解析失敗）', !fs.existsSync(path.join(ROOT, '.vercelignore')));
}

console.log('\n【4】function 執行時限由 api 內 export config 管理');
{
  const proxy = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');
  check('api/proxy.js export const config（maxDuration 60）', /export const config = \{ maxDuration: 60 \};/.test(proxy), '找不到 export const config');
  for (const f of ['troops.js', 'portal.js', 'super.js', '_super.js', '_registry.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'api', f), 'utf8');
    check(`api/${f} 冇硬寫 maxDuration（統一由 proxy config／平台預設管）`, !/maxDuration/.test(src));
  }
}

console.log('\n【5】既有靜態資源檢查（troops.json／靜態保底唔准翻嚟）');
{
  check('data/troops.json 已刪除', !fs.existsSync(path.join(ROOT, 'data', 'troops.json')));
  check('api/_troops_static.js 已刪除', !fs.existsSync(path.join(ROOT, 'api', '_troops_static.js')));
  check('scripts/sync-troops.mjs 已刪除', !fs.existsSync(path.join(ROOT, 'scripts', 'sync-troops.mjs')));
}

console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
