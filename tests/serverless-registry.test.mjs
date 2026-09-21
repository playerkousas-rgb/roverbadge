// 旅團 Registry 解析測試（v4.0：唯一來源 = Vercel 環境變數）
//
// 這個測試刻意「不像」本機 dev：它把 api/ 複製到一個空的 lambda 目錄，
// 用那個目錄當作 process.cwd()（等同 Vercel 的 /var/task），並在該目錄放一份
// data/troops.json —— Registry 必須完全忽略檔案，只認環境變數。
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
const { getRegistry, getTrustedTroop, listPublicTroops, getRegistryDiagnostics, getPortalDefaults } = await import('./api/_registry.js');
const diag = getRegistryDiagnostics();
console.log(JSON.stringify({
  cwd: process.cwd(),
  registryIds: Object.keys(getRegistry()).sort(),
  publicIds: Object.keys(listPublicTroops()).sort(),
  public: listPublicTroops(),
  trusted0082: (() => { const t = getTrustedTroop('0082'); return t ? { id: t.id, name: t.name, host: (() => { try { return new URL(t.backend).host; } catch (e) { return 'invalid'; } })(), apikey: t.apikey } : null; })(),
  trusted0082Lower: (() => { const t = getTrustedTroop('0082'); return !!t; })(),
  source: diag.source,
  portalDefaults: getPortalDefaults()
}));
`;

function runProbe(dir, env = {}) {
  fs.writeFileSync(path.join(dir, 'probe.mjs'), PROBE, 'utf8');
  // 先清走宿主環境的旅團／Portal／測試變數，再套上本 case 指定嘅 env
  const cleanEnv = { ...process.env };
  delete cleanEnv.ROVERBADGE_PROXY_TEST;
  delete cleanEnv.SUPER_KEY;
  for (const k of Object.keys(cleanEnv)) if (/^TROOP_[0-9A-Za-z]+_/i.test(k) || /^PORTAL_DEFAULT_/.test(k)) delete cleanEnv[k];
  Object.assign(cleanEnv, env);
  const r = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], { cwd: dir, env: cleanEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`probe 失敗：${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

console.log('\n【1】模擬 Vercel lambda：只有環境變數，沒有任何 troops JSON');
{
  const dir = path.join(tmp, 'env-only');
  copyApi(dir);
  const out = runProbe(dir, {
    TROOP_0082_NAME: '第 82 旅 (樂行)',
    TROOP_0082_BACKEND: 'https://script.google.com/macros/s/AAAABBBBCCCCDDDD0000/exec',
    TROOP_0082_APIKEY: 'rover_secret_from_env'
  });
  check('Registry 只從環境變數解析出旅團 0082', JSON.stringify(out.registryIds) === '["0082"]', JSON.stringify(out.registryIds));
  check('/api/troops 會列出 0082', out.publicIds.includes('0082'));
  check('前導零原樣保留（id 是 "0082" 不是 "82"）', out.publicIds.includes('0082') && !out.publicIds.includes('82'));
  check('backend 通過白名單（script.google.com /exec）', out.trusted0082 && out.trusted0082.host === 'script.google.com', JSON.stringify(out.trusted0082));
  check('name 來自 TROOP_0082_NAME', out.trusted0082 && out.trusted0082.name === '第 82 旅 (樂行)');
  check('apikey 只在伺服器端（getTrustedTroop 有，listPublicTroops 無）',
    out.trusted0082.apikey === 'rover_secret_from_env' && !JSON.stringify(out.public).includes('rover_secret_from_env') &&
    out.public['0082'].backend === undefined && out.public['0082'].apikey === undefined,
    JSON.stringify(out.public));
  check('診斷來源為 env', out.source === 'env', out.source);
}

console.log('\n【2】磁碟上的 troops.json 一律被忽略（v4.0 移除檔案來源）');
{
  const dir = path.join(tmp, 'with-stale-json');
  copyApi(dir);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'troops.json'), JSON.stringify({
    troops: { '0099': { name: '舊檔案旅團', backend: 'https://script.google.com/macros/s/STALESTALESTALE0/exec' } }
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'troops.json'), JSON.stringify({
    troops: { '0077': { name: '舊根檔案旅團', backend: 'https://script.google.com/macros/s/STALE2STALE2STA0/exec' } }
  }), 'utf8');
  const out = runProbe(dir, {
    TROOP_0082_BACKEND: 'https://script.google.com/macros/s/ENVONLYENVONLY00/exec'
  });
  check('data/troops.json 的 0099 不會出現', !out.registryIds.includes('0099'), JSON.stringify(out.registryIds));
  check('根 troops.json 的 0077 不會出現', !out.registryIds.includes('0077'), JSON.stringify(out.registryIds));
  check('只有 env 的 0082 被解析', JSON.stringify(out.registryIds) === '["0082"]', JSON.stringify(out.registryIds));
  const regSrc = fs.readFileSync(path.join(ROOT, 'api', '_registry.js'), 'utf8');
  check('_registry.js 不再 import fs（無檔案讀取路徑）', !/^import fs/m.test(regSrc) && !/readFileSync/.test(regSrc));
  check('api/_troops_static.js（寫死旅團登記）已刪除', !fs.existsSync(path.join(ROOT, 'api', '_troops_static.js')));
  check('data/troops.json / troops.json 已從 repo 刪除',
    !fs.existsSync(path.join(ROOT, 'data', 'troops.json')) && !fs.existsSync(path.join(ROOT, 'troops.json')));
}

console.log('\n【3】0082 與 82 是兩個不同旅團（前導零不混淆）');
{
  const dir = path.join(tmp, 'leading-zero');
  copyApi(dir);
  const out = runProbe(dir, {
    TROOP_0082_NAME: '零填充旅團',
    TROOP_0082_BACKEND: 'https://script.google.com/macros/s/ZEROZEROZERO0000/exec',
    TROOP_82_NAME: '無零旅團',
    TROOP_82_BACKEND: 'https://script.google.com/macros/s/NOZERONOZERO0000/exec'
  });
  check('兩個旅團同時存在', out.registryIds.includes('0082') && out.registryIds.includes('82'), JSON.stringify(out.registryIds));
  check('0082 與 82 名稱各自獨立',
    out.public['0082'].name === '零填充旅團' && out.public['82'].name === '無零旅團', JSON.stringify(out.public));
}

console.log('\n【4】未通過白名單的 backend 視為未登記');
{
  const dir = path.join(tmp, 'untrusted');
  copyApi(dir);
  const out = runProbe(dir, {
    TROOP_6001_BACKEND: 'https://evil.example.com/exec',
    TROOP_6002_BACKEND: 'https://script.google.com/macros/s/GOODGOODGOOD0000/dev',
    TROOP_6003_BACKEND: 'https://script.google.com/macros/s/OKOKOKOKOKOK0000/exec'
  });
  check('任意外部 URL 不列出', !out.publicIds.includes('6001'), JSON.stringify(out.publicIds));
  check('GAS /dev URL 不列出', !out.publicIds.includes('6002'), JSON.stringify(out.publicIds));
  check('正式 /exec URL 列出', out.publicIds.includes('6003'), JSON.stringify(out.publicIds));
}

console.log('\n【5】Portal 接入設定（PORTAL_* / TROOP_*_PORTAL*）');
{
  const dir = path.join(tmp, 'portal');
  copyApi(dir);
  const out = runProbe(dir, {
    TROOP_0082_BACKEND: 'https://script.google.com/macros/s/PORTALPORTAL0000/exec',
    PORTAL_DEFAULT_ORIGIN: 'https://main-system.example.org',
    PORTAL_DEFAULT_ROLES: 'member,group_leader',
    TROOP_0082_PORTALROLES: 'member,group_leader,admin',
    TROOP_0083_BACKEND: 'https://script.google.com/macros/s/PORTAL2PORTAL2000/exec',
    TROOP_0083_PORTALDISABLED: '1'
  });
  check('全域 PORTAL_DEFAULT_ORIGIN / ROLES 解析', out.portalDefaults.origin === 'https://main-system.example.org' && out.portalDefaults.roles === 'member,group_leader', JSON.stringify(out.portalDefaults));
  check('旅團級 PORTALROLES 覆寫', out.public['0082'].portal && out.public['0082'].portal.roles === 'member,group_leader,admin', JSON.stringify(out.public['0082']));
  check('TROOP_0083_PORTALDISABLED=1 → portal.disabled', out.public['0083'] && out.public['0083'].portal && out.public['0083'].portal.disabled === true, JSON.stringify(out.public['0083']));
  check('portal 設定不含任何機密（無 apikey/backend 欄位）', !JSON.stringify(out.public).includes('apikey'));
}

console.log('\n【6】vercel.json 部署設定（legacy builds 是 2026-08 404 的元兇之一）');
{
  const vcPath = path.join(ROOT, 'vercel.json');
  const raw = fs.existsSync(vcPath) ? fs.readFileSync(vcPath, 'utf8') : '{}';
  const cfg = JSON.parse(raw);
  check('vercel.json 可被解析', !!cfg);
  check('不含 legacy builds', cfg.builds === undefined);
  check('不含 legacy routes', cfg.routes === undefined);
  check('不含 legacy version 欄位', cfg.version === undefined);
  // v4.0：Registry 不再讀檔案，function 不需要 includeFiles
  const fn = (cfg.functions && cfg.functions['api/*.js']) || {};
  check('functions 不再需要 includeFiles（Registry 純 env）', fn.includeFiles === undefined, JSON.stringify(fn));
  if (Array.isArray(cfg.headers) && cfg.headers.length) {
    check('/api/* 有 no-store header', JSON.stringify(cfg.headers).includes('no-store'));
  }
  check('没有任何 builds 條目指定 builder（"use"）', !/"use"\s*:/.test(raw));
}

console.log('\n【7】api/ 目錄結構符合 Vercel 零配置約定');
{
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).sort();
  for (const f of ['proxy.js', 'troops.js', 'health.js', 'verify-super-ticket.js']) {
    check(`api/${f} 存在且會被建成 function`, apiFiles.includes(f), apiFiles.join(','));
  }
  for (const f of ['_registry.js', '_super.js']) {
    check(`api/${f} 以底線開頭（不會被當成 endpoint）`, apiFiles.includes(f), apiFiles.join(','));
  }
  for (const f of ['proxy.js', 'troops.js', 'health.js', 'verify-super-ticket.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'api', f), 'utf8');
    check(`api/${f} 有 export default handler`, /export\s+default\s+(async\s+)?function/.test(src));
  }
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json type=module（api/*.js 用 ESM import）', pk.type === 'module');
  check('package.json 冇 engines（避免 Vercel 覆寫 Node 版本）', pk.engines === undefined, JSON.stringify(pk.engines || {}));
  // Vercel 將 ESM 編譯成 lambda 時，import.meta 有機會爆「outside a module」→ build fail
  for (const f of apiFiles.filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'api', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // 註解提到嘅唔算
    check(`api/${f} 嘅實際程式碼唔使用 import.meta / __dirname`, !/import\.meta|__dirname/.test(src));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
