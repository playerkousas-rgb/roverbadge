// /api/portal 伺服器端驗證測試（vsbadge 同結構：Referer/Origin + src 雙重來源驗證，角色白名單）
//
// 嚴格分支在本進程直接測（先設 env 再動態 import，避開模組級 PORTAL_TEST 常數）；
// 依賴進程級 env 開關的分支（ROVERBADGE_PORTAL_TEST / VERCEL / 全域預設有無）
// 各自 spawn 一個乾淨子進程測，避免互相污染。
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

// ---------- 嚴格模式主進程 env（0082 自帶 portal 設定；1001 繼承全域；0083 停用）----------
Object.assign(process.env, {
  TROOP_0082_NAME: '第 82 旅 (樂行)',
  TROOP_0082_BACKEND: 'https://script.google.com/macros/s/PORTALPORTAL0000/exec',
  TROOP_0082_APIKEY: 'portal_test_secret_key',
  TROOP_0082_PORTALORIGIN: 'https://hub.example.org/dashboard/?x=1',
  TROOP_0082_PORTALROLES: 'member,group_leader,admin',
  TROOP_0083_BACKEND: 'https://script.google.com/macros/s/PORTAL2PORTAL2000/exec',
  TROOP_0083_PORTALDISABLED: '1',
  TROOP_1001_BACKEND: 'https://script.google.com/macros/s/PORTAL3PORTAL3000/exec',
  PORTAL_DEFAULT_ORIGIN: 'https://hub.example.org',
  PORTAL_DEFAULT_ROLES: 'member,group_leader'
});
delete process.env.ROVERBADGE_PORTAL_TEST;
delete process.env.VERCEL;

const handler = (await import('../api/portal.js')).default;

function mockReq({ method = 'GET', query = null, url = null, headers = {} } = {}) {
  const req = { method, headers };
  if (query) req.query = query;
  else req.url = url || '/api/portal';
  return req;
}
function mockRes() {
  const headers = {};
  return {
    headers, statusCode: 0, body: null,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

// 收集 safeLog 輸出，驗證不洩漏機密
const capturedLogs = [];
const origLog = console.log;
function call(opts) {
  const req = mockReq(opts), res = mockRes();
  console.log = (...a) => { capturedLogs.push(a.join(' ')); };
  try { handler(req, res); } finally { console.log = origLog; }
  return res;
}
const HUB = 'https://hub.example.org';

console.log('\n【A】驗證通過：Referer + src 雙重對上（path/query 被正規化）');
{
  const r = call({ query: { u: '0082', role: 'member', src: HUB + '/deep/link?x=1' }, headers: { referer: HUB + '/app' } });
  check('200 ok:true，role/troop/name 回傳', r.statusCode === 200 && r.body.ok === true && r.body.role === 'member' && r.body.troop === '0082' && r.body.name === '第 82 旅 (樂行)', JSON.stringify(r.body));
  const s = JSON.stringify(r.body);
  check('成功回應不含機密（無 apikey/backend/portal 設定）',
    !s.includes('portal_test_secret_key') && !s.includes('script.google') && !/portal/i.test(s), s);
  check('成功回應只含 ok/role/troop/name 四個欄位',
    JSON.stringify(Object.keys(r.body).sort()) === '["name","ok","role","troop"]', JSON.stringify(Object.keys(r.body)));
}

console.log('\n【B】單邊來源亦可：只有 src / 只有 Referer');
{
  const r1 = call({ query: { u: '0082', role: 'group_leader', src: HUB }, headers: {} });
  check('只有 src（無 Referer）→ 200', r1.statusCode === 200 && r1.body.ok === true, JSON.stringify(r1.body));
  const r2 = call({ query: { u: '0082', role: 'admin' }, headers: { referer: HUB + '/' } });
  check('只有 Referer（無 src）→ 200（admin 來自旅團級角色覆寫）', r2.statusCode === 200 && r2.body.role === 'admin', JSON.stringify(r2.body));
  const r3 = call({ query: { u: '1001', role: 'group_leader', src: HUB }, headers: {} });
  check('1001 繼承全域 origin＋roles → 200', r3.statusCode === 200 && r3.body.ok === true, JSON.stringify(r3.body));
  const r4 = call({ query: { u: '1001', role: 'member', src: HUB }, headers: {} });
  check('member 係合法 Portal 身份（唔可以用「可勾選角色」擋）→ 200', r4.statusCode === 200 && r4.body.role === 'member', JSON.stringify(r4.body));
}

console.log('\n【C】本機 dev server 相容：無 req.query 時從 req.url 解析');
{
  const r = call({ url: '/api/portal?u=0082&role=member&src=' + encodeURIComponent(HUB), headers: {} });
  check('req.url 解析 → 200', r.statusCode === 200 && r.body.ok === true, JSON.stringify(r.body));
  const r2 = call({ query: { u: ['0082', '9999'], role: 'member', src: HUB }, headers: {} });
  check('陣列參數取第一個（firstStr）→ 200', r2.statusCode === 200 && r2.body.troop === '0082', JSON.stringify(r2.body));
}

console.log('\n【D】未知旅團 → 404 unknown_troop');
{
  const r1 = call({ query: { u: '9999', role: 'member', src: HUB }, headers: {} });
  check('未登記旅團 404', r1.statusCode === 404 && r1.body.reason === 'unknown_troop', JSON.stringify(r1.body));
  const r2 = call({ query: { u: '0082!', role: 'member', src: HUB }, headers: {} });
  check('非法旅團編號字元 404（唔會誤中大小寫後備）', r2.statusCode === 404 && r2.body.reason === 'unknown_troop', JSON.stringify(r2.body));
  const r3 = call({ query: { u: '', role: 'member', src: HUB }, headers: {} });
  check('缺少 u 參數 404', r3.statusCode === 404 && r3.body.reason === 'unknown_troop', JSON.stringify(r3.body));
}

console.log('\n【E】旅團停用 portal → 403 troop_not_portal_enabled');
{
  const r = call({ query: { u: '0083', role: 'member', src: HUB }, headers: { referer: HUB } });
  check('PORTALDISABLED=1 即使來源正確都拒絕', r.statusCode === 403 && r.body.reason === 'troop_not_portal_enabled', JSON.stringify(r.body));
}

console.log('\n【F】來源驗證：referer_mismatch / origin_not_allowed / no_origin');
{
  const r1 = call({ query: { u: '0082', role: 'member', src: HUB }, headers: { referer: 'https://evil.example/' } });
  check('Referer 唔啱 → referer_mismatch（含 expected 方便管理員對設定）',
    r1.statusCode === 403 && r1.body.reason === 'referer_mismatch' && r1.body.expected === HUB, JSON.stringify(r1.body));
  const r2 = call({ query: { u: '0082', role: 'member', src: 'https://evil.example/' }, headers: {} });
  check('src 唔啱 → origin_not_allowed', r2.statusCode === 403 && r2.body.reason === 'origin_not_allowed', JSON.stringify(r2.body));
  const r3 = call({ query: { u: '0082', role: 'member' }, headers: {} });
  check('兩者都無（curl/直接打 URL）→ no_origin', r3.statusCode === 403 && r3.body.reason === 'no_origin', JSON.stringify(r3.body));
  const r4 = call({ query: { u: '0082', role: 'member', src: HUB }, headers: { origin: 'https://evil.example' } });
  check('Origin header 唔啱一樣擋（referer 缺席時驗 origin）', r4.statusCode === 403 && r4.body.reason === 'referer_mismatch', JSON.stringify(r4.body));
}

console.log('\n【G】角色白名單：旅團 roles ∩ 系統 TICK_ROLES');
{
  const r1 = call({ query: { u: '1001', role: 'admin', src: HUB }, headers: {} });
  check('1001 admin 唔喺全域 roles → role_not_allowed（含 allowed 方便除錯）',
    r1.statusCode === 403 && r1.body.reason === 'role_not_allowed' && JSON.stringify(r1.body.allowed) === '["member","group_leader"]', JSON.stringify(r1.body));
  const r2 = call({ query: { u: '1001', role: 'super_admin', src: HUB }, headers: {} });
  check('super_admin 就算係系統角色，唔喺旅團白名單一樣拒絕', r2.statusCode === 403 && r2.body.reason === 'role_not_allowed', JSON.stringify(r2.body));
  const r3 = call({ query: { u: '0082', role: 'viewer', src: HUB }, headers: {} });
  check('亂填角色拒絕', r3.statusCode === 403 && r3.body.reason === 'role_not_allowed', JSON.stringify(r3.body));
  const r4 = call({ query: { u: '0082', role: '', src: HUB }, headers: {} });
  check('缺少 role 參數拒絕', r4.statusCode === 403 && r4.body.reason === 'role_not_allowed', JSON.stringify(r4.body));
}

console.log('\n【H】只接受 GET/HEAD；唔加 CORS header；no-store');
{
  const r1 = call({ method: 'POST', query: { u: '0082', role: 'member', src: HUB }, headers: {} });
  check('POST → 405 method_not_allowed', r1.statusCode === 405 && r1.body.reason === 'method_not_allowed', JSON.stringify(r1.body));
  check('405 帶 Allow: GET, HEAD', r1.headers.allow === 'GET, HEAD', JSON.stringify(r1.headers));
  const r2 = call({ method: 'HEAD', query: { u: '0082', role: 'member', src: HUB }, headers: {} });
  check('HEAD 當 GET 處理 → 200', r2.statusCode === 200 && r2.body.ok === true, JSON.stringify(r2.body));
  const r3 = call({ query: { u: '0082', role: 'member', src: HUB }, headers: {} });
  check('無 Access-Control-Allow-Origin（只給同源前端用）', !('access-control-allow-origin' in r3.headers), JSON.stringify(r3.headers));
  check('Cache-Control: no-store', r3.headers['cache-control'] === 'no-store', JSON.stringify(r3.headers));
  check('Content-Type JSON', String(r3.headers['content-type']).includes('application/json'), JSON.stringify(r3.headers));
}

console.log('\n【I】log 只記 metadata，唔洩漏 apikey/backend');
{
  const all = capturedLogs.join('\n');
  check('所有 log 唔含測試 apikey', !all.includes('portal_test_secret_key'), all.slice(0, 200));
  check('所有 log 唔含 backend URL', !all.includes('script.google'), all.slice(0, 200));
  check('log 有 svc 標籤方便過濾', capturedLogs.some(l => l.includes('roverbadge-portal')), capturedLogs[0] || '(no logs)');
}

// ---------- 子進程：進程級 env 開關分支 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-portal-'));
const CHILD_PROBE = `
import { pathToFileURL } from 'url';
const handler = (await import(pathToFileURL(process.env.PROBE_PORTAL_FILE).href)).default;
function mockRes() {
  const headers = {};
  return { headers, statusCode: 0, body: null,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; } };
}
const q = JSON.parse(process.env.PROBE_REQ || '{}');
const req = { method: q.method || 'GET', headers: q.headers || {} };
if (q.url) req.url = q.url; else req.query = q.query || {};
const res = mockRes();
console.log = () => {};
handler(req, res);
process.stdout.write(JSON.stringify({ status: res.statusCode, body: res.body }));
`;
const probeFile = path.join(tmp, 'portal-probe.mjs');
fs.writeFileSync(probeFile, CHILD_PROBE, 'utf8');

const BASE_ENV = {
  TROOP_0082_NAME: '第 82 旅 (樂行)',
  TROOP_0082_BACKEND: 'https://script.google.com/macros/s/PORTALPORTAL0000/exec',
  TROOP_0082_APIKEY: 'portal_test_secret_key',
  TROOP_0082_PORTALORIGIN: 'https://hub.example.org/dashboard/?x=1',
  TROOP_0082_PORTALROLES: 'member,group_leader,admin',
  TROOP_0083_BACKEND: 'https://script.google.com/macros/s/PORTAL2PORTAL2000/exec',
  TROOP_0083_PORTALDISABLED: '1',
  TROOP_1001_BACKEND: 'https://script.google.com/macros/s/PORTAL3PORTAL3000/exec',
  PORTAL_DEFAULT_ORIGIN: 'https://hub.example.org',
  PORTAL_DEFAULT_ROLES: 'member,group_leader'
};
function runChild(env, req) {
  const cleanEnv = { ...process.env, PROBE_PORTAL_FILE: path.join(ROOT, 'api', 'portal.js'), PROBE_REQ: JSON.stringify(req) };
  delete cleanEnv.VERCEL;
  delete cleanEnv.ROVERBADGE_PORTAL_TEST;
  delete cleanEnv.ROVERBADGE_PROXY_TEST;
  for (const k of Object.keys(cleanEnv)) if (/^TROOP_[0-9A-Za-z]+_/i.test(k) || /^PORTAL_DEFAULT_/.test(k)) delete cleanEnv[k];
  Object.assign(cleanEnv, env);
  const r = spawnSync(process.execPath, [probeFile], { cwd: tmp, env: cleanEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`portal 子進程失敗：${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const EVIL_REQ = { query: { u: '0082', role: 'member', src: 'https://anything.example/' }, headers: { referer: 'https://other.example/' } };

console.log('\n【J】ROVERBADGE_PORTAL_TEST=1 放寬來源檢查（本機試流程用），但角色照驗');
{
  const r1 = runChild({ ...BASE_ENV, ROVERBADGE_PORTAL_TEST: '1' }, EVIL_REQ);
  check('測試開關下任何來源都放行 → 200', r1.status === 200 && r1.body.ok === true, JSON.stringify(r1.body));
  const r2 = runChild({ ...BASE_ENV, ROVERBADGE_PORTAL_TEST: '1' },
    { query: { u: '0082', role: 'bogus', src: 'https://anything.example/' }, headers: {} });
  check('測試開關下亂填角色照樣拒絕', r2.status === 403 && r2.body.reason === 'role_not_allowed', JSON.stringify(r2.body));
}

console.log('\n【K】VERCEL=1 時測試開關必定失效（雙重保護，唔會喺生產環境開洞）');
{
  const r = runChild({ ...BASE_ENV, ROVERBADGE_PORTAL_TEST: '1', VERCEL: '1' }, EVIL_REQ);
  check('Vercel 上開關失效 → 嚴格擋 referer_mismatch', r.status === 403 && r.body.reason === 'referer_mismatch', JSON.stringify(r.body));
}

console.log('\n【L】無全域預設時：有個別設定的旅團可用、無設定的 fail closed');
{
  const noGlobal = { ...BASE_ENV };
  delete noGlobal.PORTAL_DEFAULT_ORIGIN;
  delete noGlobal.PORTAL_DEFAULT_ROLES;
  const r1 = runChild(noGlobal, { query: { u: '1001', role: 'member', src: HUB }, headers: { referer: HUB } });
  check('1001 無 portalOrigin → troop_not_portal_enabled（fail closed）', r1.status === 403 && r1.body.reason === 'troop_not_portal_enabled', JSON.stringify(r1.body));
  const r2 = runChild(noGlobal, { query: { u: '0082', role: 'member', src: HUB }, headers: {} });
  check('0082 自帶 PORTALORIGIN/ROLES → 無全域預設照樣 200', r2.status === 200 && r2.body.ok === true, JSON.stringify(r2.body));
}

console.log('\n【M】有 origin 無 roles 時用最小預設（只放行 exec_committee）');
{
  const originOnly = { ...BASE_ENV };
  delete originOnly.PORTAL_DEFAULT_ROLES;
  const r1 = runChild(originOnly, { query: { u: '1001', role: 'member', src: HUB }, headers: {} });
  check('1001 member → role_not_allowed，allowed 係預設 [exec_committee]',
    r1.status === 403 && r1.body.reason === 'role_not_allowed' && JSON.stringify(r1.body.allowed) === '["exec_committee"]', JSON.stringify(r1.body));
  const r2 = runChild(originOnly, { query: { u: '1001', role: 'exec_committee', src: HUB }, headers: {} });
  check('1001 exec_committee → 200', r2.status === 200 && r2.body.ok === true, JSON.stringify(r2.body));
}

// ---------- 前端靜態斷言：index.html 強制驗證＋錯誤頁＋中英對照 ----------
console.log('\n【N】前端：handlePortalParams 強制經 /api/portal 驗證，失敗留喺錯誤頁');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('前端有打 /api/portal', html.includes('/api/portal?'));
  check('showPortalError / hidePortalError / goHomeFromPortalError 齊全',
    html.includes('function showPortalError(') && html.includes('function hidePortalError(') && html.includes('function goHomeFromPortalError('));
  for (const code of ['unknown_troop', 'troop_not_portal_enabled', 'referer_mismatch', 'origin_not_allowed', 'no_origin', 'role_not_allowed', 'method_not_allowed']) {
    check(`錯誤頁識得解 reason code：${code}`, html.includes(`'${code}'`));
  }
  check('相容後端 reason 欄位（pv.reason 優先）', html.includes('pv.reason'));
  check('舊前端軟檢查已刪除（無 portalCfg／portalDefaults／getPortalDefaults）',
    !html.includes('portalCfg') && !html.includes('portalDefaults') && !html.includes('getPortalDefaults'));
  check('驗證失敗唔再 fallback 普通登入（錯誤分支無 checkSavedSession）',
    !/showPortalError[\s\S]{0,400}checkSavedSession/.test(html));

  const NEW_KEYS = [
    '🚫 未能以主系統身份進入',
    '為保障旅團資料，Portal 免登入身份必須由伺服器核實來源及角色。以下原因導致未能進入：',
    '錯誤代碼：',
    '此旅團未在伺服器登記',
    '，請聯絡管理員開通旅團',
    '入口來源網址與登記不符，已被拒絕',
    '，請由主系統 Dashboard 卡片進入',
    '未能確認入口來源',
    '不支援的請求方式',
    '未能連接驗證服務，請重試或聯絡管理員',
    '伺服器驗證來源及角色後直接用（ymis 可省略）',
    '經伺服器驗證來源及角色後免密碼進入'
  ];
  const tsv = fs.readFileSync(path.join(ROOT, 'i18n_dict.tsv'), 'utf8');
  for (const k of NEW_KEYS) {
    check(`LANG_DICT 有鍵：${k.slice(0, 18)}…`, html.includes(`"${k}"`) || html.includes(`'${k}'`) || html.includes(`>${k}<`) || html.includes(k));
  }
  for (const k of NEW_KEYS) {
    const row = tsv.split('\n').find(l => l.includes(k) && l.includes('\t'));
    check(`TSV 有對應列（含英文翻譯）：${k.slice(0, 18)}…`, !!row && row.split('\t')[1].trim() !== '');
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
