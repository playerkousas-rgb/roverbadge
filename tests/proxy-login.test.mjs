// 「全站登入不了」端到端回歸測試（在模擬的 Vercel Function 環境內跑真正的 api/*.js）
//
// 重點：這個測試把 api/ 複製進一個空的 lambda 目錄（等同 /var/task，沒有 data/），
// 用 child process 以該目錄為 cwd 啟動 server，掛載「真正的」api/proxy.js、
// api/troops.js、api/health.js，上游接 tests/mock-gas.mjs（含 GAS 式 302）。
// 於是它能驗證真正出事的那一环：
//   - 三個 /api endpoint 都必須回 JSON（Vercel 未建 function 時會回 HTML 404 → 前端顯示「格式異常 (404)」）
//   - 成員／領袖/超管 sheep 都要能拿到 token
//   - Registry 完全讀不到 troops.json 時，仍能靠 bundle 內靜態來源把 request 轉發出去
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { startMockGas } from './mock-gas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const MOCK_PORT = await freePort();
const APP_PORT = await freePort();

// ---- 1. mock GAS（旅團 0082 後端）----
console.log('\n【1】起 mock GAS（旅團 0082，含 302 跳板）');
const mock = await startMockGas({
  port: MOCK_PORT,
  name: '旅團0082(lambda測試)',
  apikey: 'KEY_LAMBDA',
  users: [
    { ymis: '1111111111', name: '旅團管理員', role: 'admin', pass: 'Admin!2345', can_tick: true, email: 'admin@example.org' },
    { ymis: '1234567890', name: '陳大文', role: 'group_leader', pass: 'Leader!123', can_tick: true, email: 'l@example.org' },
    { ymis: '1234560001', name: '成員甲', role: 'member', pass: 'Member!123', can_tick: false }
  ]
});
console.log(`  mock GAS: ${mock.url}`);

// ---- 2. 在 lambda-like 目錄內啟動真正的 handlers ----
console.log('\n【2】複製 api/ 到空目錄（沒有 data/troops.json），以該目錄為 cwd 啟動 server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
const LAMBDA = path.join(tmp, 'var-task');
fs.mkdirSync(path.join(LAMBDA, 'api'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
  fs.copyFileSync(path.join(ROOT, 'api', f), path.join(LAMBDA, 'api', f));
}
fs.writeFileSync(path.join(LAMBDA, 'server.mjs'), `
import http from 'http';
import { default as proxyHandler } from './api/proxy.js';
import { default as troopsHandler } from './api/troops.js';
import { default as healthHandler } from './api/health.js';
const PORT = parseInt(process.env.APP_PORT, 10);
function vercelize(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  return res;
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/proxy') return proxyHandler(req, vercelize(res));
  if (u.pathname === '/api/troops') return troopsHandler(req, vercelize(res));
  if (u.pathname === '/api/health') return healthHandler(req, vercelize(res));
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end('<html><body>404: NOT_FOUND</body></html>');
}).listen(PORT, '127.0.0.1', () => console.log('READY ' + PORT));
`, 'utf8');

const child = spawn(process.execPath, [path.join(LAMBDA, 'server.mjs')], {
  cwd: LAMBDA, // ← 關鍵：process.cwd() 內沒有 data/
  env: {
    ...process.env,
    APP_PORT: String(APP_PORT),
    ROVERBADGE_PROXY_TEST: '1',
    ROVERBADGE_PROXY_TIMEOUT_MS: '3000',
    // 只注入 backend 位置（因為 mock 在 localhost）；不注入 troops 名單本身
    TROOP_0082_BACKEND: `http://127.0.0.1:${MOCK_PORT}/exec`,
    TROOP_0082_APIKEY: 'KEY_LAMBDA'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let childLog = '';
child.stdout.on('data', d => { childLog += d; });
child.stderr.on('data', d => { childLog += d; });

const BASE = `http://127.0.0.1:${APP_PORT}`;
let ready = false;
for (let i = 0; i < 100; i++) {
  if (childLog.includes('READY')) { ready = true; break; }
  await sleep(50);
}
check('lambda 模擬 server 已就緒', ready, childLog.slice(0, 300));
if (!ready) { await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON = 就是這次 bug 的樣貌 */ }
  return { status: r.status, type: r.headers.get('content-type') || '', json, text };
}
async function proxy(action, data, troopId = '0082') {
  return req('POST', '/api/proxy', { troopId, action, data });
}
const isJson = (r) => /application\/json/.test(r.type) && r.json !== null;

// ---- 3. endpoint 存在性（與 404 HTML 的分別）----
console.log('\n【3】三個 /api endpoint 都要回 JSON（Vercel 沒建 function 時會回 HTML 404）');
{
  const h = await req('GET', '/api/health');
  check('GET /api/health → 200 + JSON', h.status === 200 && isJson(h), `${h.status} ${h.type}`);
  check('/api/health 回報 registry 已解析到旅團', !!(h.json && Array.isArray(h.json.troops) && h.json.troops.length > 0), JSON.stringify(h.json || {}));
  check('/api/health 不含 GAS 完整 URL / apikey', !/\/exec/.test(h.text) && !/KEY_LAMBDA/.test(h.text));

  const t = await req('GET', '/api/troops');
  check('GET /api/troops → 200 + JSON', t.status === 200 && isJson(t), `${t.status} ${t.type}`);
  check('/api/troops 列出 0082', !!(t.json && t.json.troops && t.json.troops['0082']), JSON.stringify(t.json || {}));
  check('/api/troops 不洩漏 backend/apikey（無欄位、無 GAS URL）',
    !!(t.json && Object.values(t.json.troops).every(v => v.backend === undefined && v.apikey === undefined) &&
      !/script\.google\.com|\/exec/.test(t.text)),
    t.text.slice(0, 160));

  const nf = await req('GET', '/api/nope');
  check('未部署的路徑仍是 HTML 404（測試用的對照組）', nf.status === 404 && !isJson(nf));
}

// ---- 4. 登入（使用者回報「完全登入不了」的核心場景）----
console.log('\n【4】登入：成員 / 領袖 / 旅團管理員 / 超管 sheep 都要成功');
{
  const member = await proxy('login', { login_id: '1234560001', password: 'Member!123' });
  check('成員 YMIS + 密碼登入成功', member.status === 200 && isJson(member) && member.json.success === true && typeof member.json.token === 'string', member.text.slice(0, 160));

  const leader = await proxy('login', { login_id: 'l@example.org', password: 'Leader!123' });
  check('領袖 Email + 密碼登入成功', leader.json && leader.json.success === true && leader.json.user.role === 'group_leader', leader.text.slice(0, 160));

  const admin = await proxy('login', { login_id: '1111111111', password: 'Admin!2345' });
  check('旅團管理員 1111111111 登入成功', admin.json && admin.json.success === true, admin.text.slice(0, 160));

  const sheep = await proxy('login', { login_id: 'sheep', password: '0728' });
  check('超管 sheep 登入成功（不靠 Sheet，純後門）', sheep.json && sheep.json.success === true && sheep.json.user.role === 'super_admin', sheep.text.slice(0, 160));

  const bad = await proxy('login', { login_id: '1234560001', password: 'wrong-one' });
  check('錯誤密碼 → success:false（不是 404/HTML）', bad.json && bad.json.success === false && /密碼/.test(bad.json.error || ''), bad.text.slice(0, 160));
}

// ---- 5. 帶 token 的後續動作真的能打到 GAS ----
console.log('\n【5】登入後的資料讀寫（驗證 proxy → GAS 完整鏈路）');
{
  const login = await proxy('login', { login_id: '1234567890', password: 'Leader!123' });
  const token = login.json.token;
  const load = await proxy('load', { token });
  check('load 成功且含成員名單', load.json && load.json.success === true && Array.isArray(load.json.members), JSON.stringify(load.json || {}).slice(0, 160));

  const save = await proxy('save', { token, changes: [{ ymis: '1234560001', itemId: 'L1-CP', date: '2026-08-28' }] });
  check('save 寫入成功', save.json && save.json.success === true, JSON.stringify(save.json || {}).slice(0, 160));

  const reload = await proxy('load', { token });
  check('重新載入後進度已落盤（flatProgress）',
    !!(reload.json && reload.json.flatProgress && reload.json.flatProgress['1234560001'] &&
      String(reload.json.flatProgress['1234560001']['L1-CP'] || '').startsWith('2026-08-28')),
    JSON.stringify((reload.json || {}).flatProgress || {}).slice(0, 200));
}

// ---- 6. 安全與錯誤處理照舊 ----
console.log('\n【6】安全邊界（修復後不應放寬任何驗證）');
{
  const noTok = await proxy('getMembers', {});
  check('無 token 的受保護 action → 401 JSON', noTok.status === 401 && isJson(noTok), `${noTok.status} ${noTok.type}`);

  const unknownAction = await proxy('deleteEverything', {});
  check('非白名單 action → 400 JSON', unknownAction.status === 400 && isJson(unknownAction), `${unknownAction.status}`);

  const ssrf = await req('POST', '/api/proxy', { troopId: 'attacker', action: 'load', data: { backend: 'http://169.254.169.254/latest/meta-data/' } });
  check('企圖用自訂 backend 打內部地址 → 404（只認 registry）', ssrf.status === 404 && isJson(ssrf), `${ssrf.status} ${ssrf.text.slice(0, 80)}`);

  const getOnProxy = await req('GET', '/api/proxy');
  check('GET /api/proxy → 405 + Allow: POST', getOnProxy.status === 405 && /POST/.test(getOnProxy.text), `${getOnProxy.status}`);

  // data 序列化後 > 2MB，但整體 body 仍小於 readRawBody 的防護上限 → 兩端都應走到 413
  const bigData = await proxy('save', { token: 'tok_0123456789', blob: 'x'.repeat(2097500) });
  check('過大 payload → 413 + JSON', bigData.status === 413 && isJson(bigData), `${bigData.status} ${bigData.type}`);
}

// ---- 7. 靜態來源保底：即使 env 沒注入 backend，Troops 仍來自 bundle ----
console.log('\n【7】沒有 TROOP_*_BACKEND 環境變數時（正式環境的真實狀態）');
{
  const p2 = await freePort();
  const L2 = path.join(tmp, 'var-task-2');
  fs.mkdirSync(path.join(L2, 'api'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'api'))) fs.copyFileSync(path.join(ROOT, 'api', f), path.join(L2, 'api', f));
  fs.copyFileSync(path.join(LAMBDA, 'server.mjs'), path.join(L2, 'server.mjs'));
  const c2 = spawn(process.execPath, [path.join(L2, 'server.mjs')], {
    cwd: L2,
    env: (() => { const e = { ...process.env, APP_PORT: String(p2), ROVERBADGE_PROXY_TEST: '1', ROVERBADGE_PROXY_TIMEOUT_MS: '1500' }; for (const k of Object.keys(e)) if (/^TROOP_/.test(k)) delete e[k]; return e; })(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log2 = '';
  c2.stdout.on('data', d => { log2 += d; });
  c2.stderr.on('data', d => { log2 += d; });
  for (let i = 0; i < 100; i++) { if (log2.includes('READY')) break; await sleep(50); }
  const b2 = `http://127.0.0.1:${p2}`;
  const t2 = await (await fetch(b2 + '/api/troops')).json();
  check('旅團名單來自 bundle 內靜態來源（0082 仍在）', !!(t2.troops && t2.troops['0082']), JSON.stringify(t2));
  const h2 = await (await fetch(b2 + '/api/health')).json();
  check('/api/health 標明來源為 static bundle', /^static:/.test((h2.registry || {}).source || ''), JSON.stringify(h2.registry || {}));
  // 只驗證「旅團有被解析到」：404 找不到此旅團 = registry 空 = 這次 bug 的指紋。
  // （沙箱可能無外網，故上游成敗不計；超時 1.5s 內一定有 JSON 回應。）
  const r2 = await fetch(b2 + '/api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ troopId: '0082', action: 'login', data: { login_id: 'x', password: 'y' } }) });
  const t2b = await r2.text();
  let j2 = null; try { j2 = JSON.parse(t2b); } catch (e) { /* ignore */ }
  check('旅團 0082 由靜態來源解析成功（不是「找不到此旅團」404）',
    r2.status !== 404 && j2 !== null && !/找不到此旅團/.test(j2.error || ''),
    `${r2.status} ${t2b.slice(0, 120)}`);
  const r9 = await fetch(b2 + '/api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ troopId: '9999', action: 'login', data: {} }) });
  const j9 = await r9.json().catch(() => null);
  check('未登記旅團 9999 仍是 404 + JSON 訊息', r9.status === 404 && j9 && j9.success === false, `${r9.status}`);
  c2.kill('SIGKILL');
}

// ---- 8. 前端診斷函數（登入頁提示是否講啱原因）----
console.log('\n【8】index.html 的 apiDiagnose()：區分「function 未部署」與「後端正常」');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const code = (html.match(/async function apiDiagnose\(\)\{[\s\S]*?\n\}/) || [''])[0];
  check('index.html 有 apiDiagnose()（前端會自我診斷部署問題）', code.length > 0);
  const build = (fetchImpl) => new Function('fetch', `let __apiDiag=null,__apiDiagAt=0;\n${code}\nreturn apiDiagnose;`)(fetchImpl);

  // 情況 A：Vercel 未建成 function → /api/* 全部回 HTML 404（這次事故的樣貌）
  const dead = build(async (u) => ({ ok: false, status: 404, json: async () => { throw new Error('not json'); } }));
  const a = await dead();
  check('HTML 404 → deployed:false（前端會提示「後端 API 未部署」而非「密碼錯誤」）', a.deployed === false && a.troopsOk === false, JSON.stringify(a));

  // 情況 B：function 正常
  const live = build(async (u, o) => fetch(BASE + u, o));
  const b = await live();
  check('真 server → deployed:true + troopsOk:true', b.deployed === true && b.troopsOk === true, JSON.stringify(b));

  // 情況 C：只有 /api/troops（舊版冇 health）→ 唔應該誤報「未部署」
  const legacy = build(async (u, o) => (u === '/api/health'
    ? { ok: false, status: 404, json: async () => { throw new Error('no health endpoint yet'); } }
    : fetch(BASE + u, o)));
  const c = await legacy();
  check('舊版冇 /api/health 時唔會誤判「API 未部署」', c.deployed === true && c.troopsOk === true, JSON.stringify(c));
}

// ---- 9. doGet/doPost 路由（scoutbadge 2026-08 的「登入成功但一入面就離線模式」bug 類別）----
console.log('\n【9】method 路由必須同 Code.gs 一致：doGet 只認 load / getLoginMode');
{
  const gm = await proxy('getLoginMode', {});
  check('getLoginMode 通過 proxy 成功（GET → doGet）', gm.json && gm.json.success === true, gm.text.slice(0, 120));

  const recv = mock.state.received || [];
  check('load 用 GET 打去 GAS（用 POST 會上 doPost → Unknown action → 「離線模式」）',
    recv.some(r => r.action === 'load' && r.method === 'GET'), JSON.stringify(recv.slice(-6)));
  check('load 從未用 POST 打去 GAS', !recv.some(r => r.action === 'load' && r.method === 'POST'), '');
  check('getLoginMode 用 GET', recv.some(r => r.action === 'getLoginMode' && r.method === 'GET'), '');
  check('login / save 用 POST（doPost 先有呢兩條分支）',
    recv.some(r => r.action === 'login' && r.method === 'POST') && recv.some(r => r.action === 'save' && r.method === 'POST'),
    JSON.stringify(recv.slice(-6)));
  check('mock 有記錄 received（無則上面啲斷言會空轉）', recv.length > 0, String(recv.length));

  // 對照組：證明 mock 真係模擬咗 doGet/doPost 嘅分工（否則上面嘅綠燈冇意義）
  const badPost = await fetch(mock.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'load' }) });
  const badJson = await badPost.json().catch(() => null);
  check('對照組：直接 POST load 俾 GAS → Unknown action（mock 有 enforce 方法分工）',
    badJson && badJson.success === false && /Unknown action/.test(badJson.error || ''), JSON.stringify(badJson));
  // GET load 要帶 apikey（mock 同一樣嘢）；正式環境由 proxy 喺伺服器端注入，前端永遠唔使帶
  const goodGet = await fetch(`${mock.url}?action=load&apikey=KEY_LAMBDA`);
  const goodJson = await goodGet.json().catch(() => null);
  check('對照組：GET load（帶 apikey）俾 GAS → 成功', goodJson && goodJson.success === true, JSON.stringify(goodJson || {}).slice(0, 120));
}

// ---- 收尾 ----
console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
child.kill('SIGKILL');
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exit(1);
