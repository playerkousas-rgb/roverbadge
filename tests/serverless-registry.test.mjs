// 旅團 Registry 解析測試（v4.0：唯一來源 = Vercel 環境變數；登記嚴格化）
//
// 這個測試刻意「不像」本機 dev：它把 api/ 複製到一個空的 lambda 目錄，
// 用那個目錄當作 process.cwd()（等同 Vercel 的 /var/task），並在該目錄放一份
// data/troops.json —— Registry 必須完全忽略檔案，只認環境變數。
//
// 嚴格登記（vsbadge 同構）：NAME／BACKEND／APIKEY 三項必填，缺一不登記；
// listPublicTroops 只出 {name,en}；getTrustedTroop 支持 (undefined, apikey, backend)
// 反查（/api/super 驗票受信核對用）。
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
const { getRegistry, getTrustedTroop, listPublicTroops, normalizeOrigin } = await import('./api/_registry.js');
console.log(JSON.stringify({
  cwd: process.cwd(),
  exportsClean: !('getRegistryDiagnostics' in await import('./api/_registry.js')),
  registryIds: Object.keys(getRegistry()).sort(),
  publicIds: Object.keys(listPublicTroops()).sort(),
  public: listPublicTroops(),
  trusted0082: (() => { const t = getTrustedTroop('0082'); return t ? { id: t.id, name: t.name, en: t.en, host: (() => { try { return new URL(t.backend).host; } catch (e) { return 'invalid'; } })(), backend: t.backend, apikey: t.apikey, portalOrigin: t.portalOrigin, portalRoles: t.portalRoles, portalEnabled: t.portalEnabled } : null; })(),
  evilTrusted: (() => { const t = getTrustedTroop('0055'); return t ? t.backend : null; })(),
  trusted0099: (() => { const t = getTrustedTroop('0099'); return t ? t.id : null; })(),
  trusted0077: (() => { const t = getTrustedTroop('0077'); return t ? t.id : null; })(),
  trusted0066: (() => { const t = getTrustedTroop('0066'); return t ? t.id : null; })(),
  trusted0083portal: (() => { const t = getTrustedTroop('0083'); return t ? { portalOrigin: t.portalOrigin, portalRoles: t.portalRoles, portalEnabled: t.portalEnabled } : null; })(),
  normalizeOriginSamples: [normalizeOrigin('https://hub.example.org/dashboard/?x=1'), normalizeOrigin('bad url'), normalizeOrigin('')],
  publicShapeClean: Object.values(listPublicTroops()).every(v => Object.keys(v).sort().join(',') === 'en,name')
}));
`;

function runProbe(dir, env = {}) {
  fs.writeFileSync(path.join(dir, 'probe.mjs'), PROBE, 'utf8');
  // 先清走宿主環境的旅團／Portal／測試變數，再套上本 case 指定嘅 env
  const cleanEnv = { ...process.env };
  delete cleanEnv.ROVERBADGE_PROXY_TEST;
  delete cleanEnv.ROVERBADGE_PORTAL_TEST;
  delete cleanEnv.SUPER_KEY;
  delete cleanEnv.VERCEL;
  for (const k of Object.keys(cleanEnv)) if (/^TROOP_[0-9A-Za-z]+_/i.test(k) || /^PORTAL_DEFAULT_/.test(k) || /^ROVERBADGE_/.test(k)) delete cleanEnv[k];
  Object.assign(cleanEnv, env);
  const r = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], { cwd: dir, env: cleanEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`probe 失敗：${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

console.log('\n【1】模擬 Vercel lambda：只有環境變數，沒有任何 troops JSON');
{
  const dir = path.join(tmp, 'env-only');
  copyApi(dir);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  // 敵對檔案：Registry 必須完全忽略
  fs.writeFileSync(path.join(dir, 'data', 'troops.json'), JSON.stringify({ '6666': { name: '假旅團', backend: 'https://evil.example.com/exec', apikey: 'evil' } }), 'utf8');

  const out = runProbe(dir, {
    TROOP_0082_NAME: '第 82 旅 (樂行)',
    TROOP_0082_EN: 'Group 82 (Rover)',
    TROOP_0082_BACKEND: 'https://script.google.com/macros/s/AAAABBBBCCCCDDDD0000/exec',
    TROOP_0082_APIKEY: 'rover_secret_from_env',
    TROOP_0099_BACKEND: 'https://script.google.com/macros/s/NOnameNOname00/exec',
    TROOP_0099_APIKEY: 'has-key-but-no-name',
    TROOP_0077_NAME: '冇鎖匙旅團',
    TROOP_0077_BACKEND: 'https://script.google.com/macros/s/NoKeyNoKeyNoKey/exec',
    TROOP_0066_NAME: '冇後端旅團',
    TROOP_0066_APIKEY: 'key-without-backend',
    TROOP_0055_NAME: '內網旅團（SSRF 測試）',
    TROOP_0055_BACKEND: 'https://evil.example.com/exec',
    TROOP_0055_APIKEY: 'evil-internal-key'
  });

  check('Registry 完全忽略 data/troops.json（冇 6666）', !out.registryIds.includes('6666') && !out.publicIds.includes('6666'), JSON.stringify(out.registryIds));
  check('cwd 係 lambda 目錄（真係模擬 /var/task）', out.cwd === dir, out.cwd);
  check('exports 乾淨：冇 getRegistryDiagnostics 殘留', out.exportsClean === true);
  check('name 來自 TROOP_0082_NAME', out.trusted0082 && out.trusted0082.name === '第 82 旅 (樂行)');
  check('en 來自 TROOP_0082_EN（公開清單＋可信旅團一致）', out.public['0082'].en === 'Group 82 (Rover)' && out.trusted0082.en === 'Group 82 (Rover)', JSON.stringify({ pub: out.public['0082'], trusted: out.trusted0082.en }));
  check('公開清單值只出 name/en（冇 backend/apikey/id/backends）', out.publicShapeClean === true, JSON.stringify(out.public).slice(0, 160));
  check('可信旅團帶齊 backend/apikey', out.trusted0082.host === 'script.google.com' && out.trusted0082.apikey === 'rover_secret_from_env' && out.trusted0082.backend === 'https://script.google.com/macros/s/AAAABBBBCCCCDDDD0000/exec', JSON.stringify({ host: out.trusted0082.host, apikey: out.trusted0082.apikey, backend: out.trusted0082.backend }));

  console.log('\n【2】嚴格登記：NAME／BACKEND／APIKEY 缺一「唔算有效登記」（public/trusted 一律排除）');
  check('缺 NAME（0099）→ 公開清單排除、getTrustedTroop null', !out.publicIds.includes('0099') && out.public['0099'] === undefined && out.trusted0099 === null, JSON.stringify(out.publicIds));
  check('缺 APIKEY（0077）→ 唔算有效登記（缺咗唔算有效登記）', !out.publicIds.includes('0077') && out.trusted0077 === null, JSON.stringify(out.publicIds));
  check('缺 BACKEND（0066）→ 唔算有效登記', !out.publicIds.includes('0066') && out.trusted0066 === null, JSON.stringify(out.publicIds));
  check('公開清單淨係得有效登記（0082）', out.publicIds.join(',') === '0082', JSON.stringify(out.publicIds));

  console.log('\n【3】SSRF 閘（isTrustedExecUrl）：非 Google Apps Script 網域唔放行');
  check('evil.example.com backend（齊三必填）都唔放行（getTrustedTroop null＋公開排除）', out.evilTrusted === null && !out.publicIds.includes('0055'), JSON.stringify({ evil: out.evilTrusted, pub: out.publicIds }));

  console.log('\n【4】normalizeOrigin 行為');
  check('正規 origin 取 origin（去 path＋query）', out.normalizeOriginSamples[0] === 'https://hub.example.org', JSON.stringify(out.normalizeOriginSamples));
  check('壞 URL／空值 → 空字串', out.normalizeOriginSamples[1] === '' && out.normalizeOriginSamples[2] === '', JSON.stringify(out.normalizeOriginSamples));
}

console.log('\n【5】ROVERBADGE_PROXY_TEST=1（非 VERCEL）→ 本地 mock 放行（只限測試）');
{
  const dir = path.join(tmp, 'proxy-test-override');
  copyApi(dir);
  const evilEnv = {
    ROVERBADGE_PROXY_TEST: '1',
    TROOP_0055_NAME: '內網旅團（SSRF 測試）',
    TROOP_0055_BACKEND: 'http://127.0.0.1:18082/exec',
    TROOP_0055_APIKEY: 'evil-internal-key'
  };
  const out = runProbe(dir, evilEnv);
  check('測試旗開：127.0.0.1 mock backend 獲放行登記', out.evilTrusted === 'http://127.0.0.1:18082/exec', String(out.evilTrusted));

  const out2 = runProbe(dir, { ...evilEnv, ROVERBADGE_PROXY_TEST: '1', VERCEL: '1' });
  check('VERCEL=1 時唔做測試放行（線上唔會中招）', out2.evilTrusted === null, String(out2.evilTrusted));

  const out3 = runProbe(dir, {
    TROOP_0055_NAME: '內網旅團（SSRF 測試）',
    TROOP_0055_BACKEND: 'http://127.0.0.1:18082/exec',
    TROOP_0055_APIKEY: 'evil-internal-key'
  });
  check('冇測試旗：127.0.0.1 一律唔放行（fail-closed）', out3.evilTrusted === null, String(out3.evilTrusted));
}

console.log('\n【6】package.json 約定（Build Output 時代：engines.node 必須存在）');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('engines.node = 22.x（function runtime 對齊）', pkg.engines && pkg.engines.node === '22.x', JSON.stringify(pkg.engines || {}));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
