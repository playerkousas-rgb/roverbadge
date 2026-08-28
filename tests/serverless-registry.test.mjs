// Serverless 環境下的旅團 Registry 解析測試（防止 2026-08 全站登入失效重演）
//
// 這個測試刻意「不像」本機 dev：它把 api/ 複製到一個空的 lambda 目錄，
// 用那個目錄當作 process.cwd()（等同 Vercel 的 /var/task），
// 於是 data/troops.json 讀不到 —— 正是正式環境過去的真實狀況。
// 此時 Registry 必須仍能靠 bundle 內的 api/_troops_static.js 解析出旅團，
// 否則 /api/proxy 會回 404「找不到此旅團」，全站沒人登入得到（不論用哪個帳號）。
//
// 另附 vercel.json 規則檢查：legacy builds / routes 一旦回來，function 又會消失。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-lambda-'));
function copyApi(dir) {
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
    fs.copyFileSync(path.join(ROOT, 'api', f), path.join(dir, 'api', f));
  }
}

const PROBE = `
import fs from 'fs';
import path from 'path';
const { getRegistry, getTrustedTroop, listPublicTroops, getRegistryDiagnostics } = await import('./api/_registry.js');
const diag = getRegistryDiagnostics();
console.log(JSON.stringify({
  cwd: process.cwd(),
  dataFileExists: fs.existsSync(path.join(process.cwd(), 'data', 'troops.json')),
  registryIds: Object.keys(getRegistry()).sort(),
  publicIds: Object.keys(listPublicTroops()).sort(),
  trusted0082: (() => { const t = getTrustedTroop('0082'); return t ? { id: t.id, host: (() => { try { return new URL(t.backend).host; } catch (e) { return 'invalid'; } })(), apikey: t.apikey } : null; })(),
  source: diag.source
}));
`;

function runProbe(dir, env = {}) {
  fs.writeFileSync(path.join(dir, 'probe.mjs'), PROBE, 'utf8');
  const cleanEnv = { ...process.env, ...env };
  // 模擬 Vercel 正式環境：沒有測試用後門、也沒有用 env 注入 backend
  delete cleanEnv.ROVERBADGE_PROXY_TEST;
  for (const k of Object.keys(cleanEnv)) if (/^TROOP_[0-9A-Za-z]+_(BACKEND|APIKEY)$/i.test(k)) delete cleanEnv[k];
  const r = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], { cwd: dir, env: cleanEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`probe 失敗：${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

console.log('\n【1】模擬 Vercel lambda：api/ 存在但 data/troops.json 不存在');
{
  const dir = path.join(tmp, 'no-data');
  copyApi(dir); // 刻意不放 data/
  const out = runProbe(dir);
  check('前提成立：function 內讀不到 data/troops.json', out.dataFileExists === false, JSON.stringify(out));
  check('Registry 仍解析出旅團 0082（靜態保底生效）', out.registryIds.includes('0082'), JSON.stringify(out));
  check('/api/troops 會列出 0082', out.publicIds.includes('0082'), JSON.stringify(out));
  check('/api/proxy 能找到可信 backend（不再回 404）', !!out.trusted0082, JSON.stringify(out));
  check('backend 為 script.google.com 的正式 /exec', out.trusted0082 && out.trusted0082.host === 'script.google.com', JSON.stringify(out.trusted0082));
  check('診斷來源為 static bundle', /^static:/.test(out.source || ''), out.source);
  check('不洩漏 apikey（未設環境變數時為空）', out.trusted0082 && out.trusted0082.apikey === '', JSON.stringify(out.trusted0082));
}

console.log('\n【2】includeFiles 生效時：以磁碟 data/troops.json 為準');
{
  const dir = path.join(tmp, 'with-data');
  copyApi(dir);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'troops.json'), JSON.stringify({
    troops: { '0099': { name: '第 99 旅（檔案優先）', backend: 'https://script.google.com/macros/s/AAAABBBBCCCCDDDD0000/exec' } }
  }, null, 2), 'utf8');
  const out = runProbe(dir);
  check('來源為 file:data/troops.json', /^file:/.test(out.source || ''), out.source);
  check('讀到檔案裡的 0099', out.registryIds.includes('0099'), JSON.stringify(out.registryIds));
  check('0099 backend 通過白名單並可列出', out.publicIds.includes('0099'), JSON.stringify(out.publicIds));
}

console.log('\n【3】環境變數永遠優先（TROOP_0082_BACKEND / _APIKEY）');
{
  const dir = path.join(tmp, 'env-override');
  copyApi(dir);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'troops.json'), JSON.stringify({
    troops: { '0082': { name: '第 82 旅', backend: 'https://script.google.com/macros/s/FILEFILEFILE0000/exec' } }
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'probe-env.mjs'), `
    process.env.TROOP_0082_BACKEND = 'https://script.google.com/macros/s/ENVENVENVENV0000/exec';
    process.env.TROOP_0082_APIKEY = 'rover_secret_from_env';
    const { getTrustedTroop } = await import('./api/_registry.js');
    const t = getTrustedTroop('0082');
    console.log(JSON.stringify({ host: new URL(t.backend).pathname, apikey: t.apikey, name: t.name }));
  `, 'utf8');
  const r = spawnSync(process.execPath, [path.join(dir, 'probe-env.mjs')], { cwd: dir, encoding: 'utf8' });
  check('env 覆寫成功且仍保留檔案內名稱', r.status === 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  check('使用 env 的 backend', /ENVENVENVENV0000/.test(out.host), out.host);
  check('使用 env 的 apikey', out.apikey === 'rover_secret_from_env', out.apikey);
  check('name 仍取自 troops.json', out.name === '第 82 旅', out.name);
}

console.log('\n【4】vercel.json 部署設定（legacy builds 是這次 404 的元兇之一）');
{
  const raw = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  const cfg = JSON.parse(raw);
  check('vercel.json 可被解析', !!cfg);
  check('不含 legacy builds', cfg.builds === undefined, 'builds 會令 Vercel 忽略內建 api/ function 偵測');
  check('不含 legacy routes', cfg.routes === undefined, 'routes 屬 legacy 路由表，與 rewrites/functions 互斥');
  check('不含 legacy version 欄位', cfg.version === undefined);
  check('functions 對 api/*.js 設定 includeFiles', !!(cfg.functions && cfg.functions['api/*.js'] && cfg.functions['api/*.js'].includeFiles), JSON.stringify(cfg.functions || {}));
  check('includeFiles 涵蓋 data/*.json', /data\/\*\.json/.test((cfg.functions || {})['api/*.js'] ? cfg.functions['api/*.js'].includeFiles : ''));
  check('/api/* 有 no-store header', Array.isArray(cfg.headers) && JSON.stringify(cfg.headers).includes('no-store'));
  check('没有任何 builds 條目指定 builder（"use"）', !/"use"\s*:/.test(raw));
}

console.log('\n【5】api/ 目錄結構符合 Vercel 零配置約定');
{
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).sort();
  for (const f of ['proxy.js', 'troops.js', 'health.js']) {
    check(`api/${f} 存在且會被建成 function`, apiFiles.includes(f), apiFiles.join(','));
  }
  for (const f of ['_registry.js', '_troops_static.js']) {
    check(`api/${f} 以底線開頭（不會被當成 endpoint）`, apiFiles.includes(f), apiFiles.join(','));
  }
  for (const f of ['proxy.js', 'troops.js', 'health.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'api', f), 'utf8');
    check(`api/${f} 有 export default handler`, /export\s+default\s+(async\s+)?function/.test(src));
  }
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json type=module（api/*.js 用 ESM import）', pk.type === 'module');
  check('package.json 冇 engines（Vercel 會用佢覆寫 Project Settings 嘅 Node 版本；range/被淘汰版本會令 build 失敗）',
    pk.engines === undefined, JSON.stringify(pk.engines || {}));
  // Vercel 將 ESM 編譯成 lambda 時，import.meta 有Chance 爆「outside a module」→ build fail
  for (const f of fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'api', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // 註解提到得唔算
    check(`api/${f} 嘅實際程式碼唔使用 import.meta / __dirname`, !/import\.meta|__dirname/.test(src));
  }
}

console.log('\n【6】_troops_static.js 與 data/troops.json 不可漂移');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-troops.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  check('npm run build 產物與 troops.json 同步（--check）', r.status === 0, (r.stdout || '') + (r.stderr || ''));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
