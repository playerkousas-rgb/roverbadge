// 「全站登入不了」端到端回歸測試（在模擬的 Vercel Function 環境內跑真正的 api/*.js）
//
// 重點：這個測試把 api/ 複製進一個空的 lambda 目錄（等同 /var/task），
// 用 child process 以該目錄為 cwd 啟動 server，掛載「真正的」api/proxy.js、
// api/troops.js、api/super.js，上游接 tests/mock-gas.mjs（含 GAS 式 302）。
// 中央管理帳號登入係 vsbadge 同構：proxy 驗證 SUPER_KEY 密碼後簽發 AES-GCM 加密票據
// （rbs1.），mock GAS 回打 /api/super 驗票（一次性防重放）先發「帶標記」session。
// 它驗證：
//   - 每個 /api endpoint 都必須回 JSON（Vercel 未建 function 時會回 HTML 404）
//   - 成員／領袖／旅團管理員都要能拿到 token（一般登入不受中央設定影響）
//   - 中央管理帳號（3A 回歸清單）：
//       1. SUPER_KEY 未設定／空字串／少於 4 字元 → 拒絕，且不呼叫 GAS
//       2. 合格 4 字元設定 + 錯誤密碼 → 拒絕（密碼永不出現在 GAS）
//       3. 正確 4 字元密碼 → 登入成功 + 加密 session 包裝（rbs1.）+ 回打驗票通過
//       4. 普通用戶登入不受中央管理密鑰設定不足影響
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { startMockGas, SUPER_ADMIN_ID_FOR_TESTS } from './mock-gas.mjs';

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

const SU_USER = SUPER_ADMIN_ID_FOR_TESTS;
const SU_KEY = '9876'; // 4 字元測試密碼（政策：最少 4 字元，字串處理）

// ---- 0. api/_super.js 政策＋加密件單元測試（SUPER_KEY 政策／AES-GCM 票據與 session）----
console.log('\n【0】api/_super.js：SUPER_KEY 政策（≥4 字元、字串、完整比對）＋ rbs1. 加密封裝');
{
  const prev = process.env.SUPER_KEY;
  const { superConfigured, checkSuperPassword, sealSuper, openSuper } = await import('../api/_super.js');

  delete process.env.SUPER_KEY;
  check('未設定 SUPER_KEY → superConfigured()=false', superConfigured() === false);
  check('未設定時 checkSuperPassword 一律 false', checkSuperPassword('9876', SU_USER) === false);
  check('未設定時無法簽發票據（sealSuper throw）', (() => { try { sealSuper('login', { t: 1 }, 60); return false; } catch (e) { return true; } })());

  process.env.SUPER_KEY = '';
  check('空字串 → superConfigured()=false', superConfigured() === false);
  process.env.SUPER_KEY = 'abc';
  check('3 字元 → superConfigured()=false', superConfigured() === false);
  process.env.SUPER_KEY = 'abcd';
  check('4 字元 → superConfigured()=true', superConfigured() === true);

  // 字串政策：開頭的 0 不會丟失（不可轉數字）
  process.env.SUPER_KEY = '0076';
  check('SUPER_KEY="0076" 時密碼 "0076" 完整比對成功', checkSuperPassword('0076', SU_USER) === true);
  check('SUPER_KEY="0076" 時密碼 "76"（數字化後）被拒', checkSuperPassword('76', SU_USER) === false);
  process.env.SUPER_KEY = '0000';
  check('SUPER_KEY="0000"（全零）可用', checkSuperPassword('0000', SU_USER) === true);

  // 完整比對：長度合格 ≠ 登入成功
  process.env.SUPER_KEY = SU_KEY;
  check('錯誤密碼被拒（長度合格不代表成功）', checkSuperPassword('9877', SU_USER) === false && checkSuperPassword('', SU_USER) === false);
  check('非字串輸入被拒', checkSuperPassword(undefined, SU_USER) === false && checkSuperPassword(9876, SU_USER) === false);
  check('電郵別名作 login_id 一樣過（完整比對政策）', checkSuperPassword(SU_KEY, SU_USER + '@roverbadge.local') === true);

  // 票據：AES-256-GCM（rbs1.）＋ 旅團綁定 payload ＋ 短時效
  const tk = sealSuper('login', { troopId: '0082', backend: 'https://gas.example/exec', apikey: 'D-key-of-troop-AAAA' }, 60);
  check('票據簽發成功（rbs1. 前綴、不含明文 apikey）', typeof tk === 'string' && tk.startsWith('rbs1.') && !tk.includes('D-key-of-troop-AAAA'));
  const okPayload = openSuper('login', tk);
  check('同一 SUPER_KEY 開封成功（payload 旅團綁定）', okPayload && okPayload.troopId === '0082' && okPayload.apikey === 'D-key-of-troop-AAAA');
  process.env.SUPER_KEY = 'other-key-9999';
  check('不同 SUPER_KEY 開封失敗（AAD＋金鑰綁定）', openSuper('login', tk) === null);
  process.env.SUPER_KEY = SU_KEY;
  check('偽造票據開封失敗', openSuper('login', 'rbs1.deadbeef') === null);
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000; // 快轉 10 分鐘（TTL 60s + 10s 偏差）
  check('過期票據開封失敗', openSuper('login', tk) === null);
  Date.now = realNow;

  // session 包裝：加密 + 旅團綁定
  const wrapped = sealSuper('session', { troopId: '0082', token: 'inner-gas-token-abc' }, 30 * 24 * 60 * 60);
  check('session 包裝有 rbs1. 前綴且不含明文 inner token', wrapped.startsWith('rbs1.') && !wrapped.includes('inner-gas-token-abc'));
  const s = openSuper('session', wrapped);
  check('同一旅團解包成功', !!(s && s.troopId === '0082' && s.token === 'inner-gas-token-abc'), JSON.stringify(s));
  check('竄改包裝解包失敗', openSuper('session', wrapped.slice(0, -4) + 'AAAA') === null);

  if (prev === undefined) delete process.env.SUPER_KEY; else process.env.SUPER_KEY = prev;
}

const MOCK_PORT = await freePort();
const APP_PORT = await freePort();   // 有 SUPER_KEY 的 server
const APP2_PORT = await freePort();  // 沒有 SUPER_KEY 的 server

// ---- 1. mock GAS（旅團 0082 後端；super_ticket 由 mock 本地驗簽，零回傳）----
console.log('\n【1】起 mock GAS（旅團 0082，含 302 跳板；super_ticket 本地驗簽）');
const mock = await startMockGas({
  port: MOCK_PORT,
  name: '旅團0082(lambda測試)',
  apikey: 'KEY_LAMBDA',
  verifyUrl: `http://127.0.0.1:${APP_PORT}/api/super`,
  users: [
    { ymis: '1111111111', name: '旅團管理員', role: 'admin', pass: 'Admin!2345', can_tick: true, email: 'admin@example.org' },
    { ymis: '1234567890', name: '陳大文', role: 'group_leader', pass: 'Leader!123', can_tick: true, email: 'l@example.org' },
    { ymis: '1234560001', name: '成員甲', role: 'member', pass: 'Member!123', can_tick: false },
    // 密碼與 SUPER_KEY 相同的普通用戶（10 位 YMIS → 必須行一般登入，不被中央流程攔截）
    { ymis: '1234560077', name: '撞碼成員', role: 'member', pass: SU_KEY, can_tick: false }
  ]
});
console.log(`  mock GAS: ${mock.url}`);

// ---- 2. 在 lambda-like 目錄內啟動真正的 handlers ----
console.log('\n【2】複製 api/ 到空目錄（沒有 data/troops.json），以該目錄為 cwd 啟動兩個 server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
function makeLambdaDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
    fs.copyFileSync(path.join(ROOT, 'api', f), path.join(dir, 'api', f));
  }
  // api/_super.js 依賴 scripts/runtime-config.mjs（build 時會內嵌；測試照拷）
  // runtime-config.mjs 啟動時會讀 apps-script/Code.gs 解析保留帳號 → 一併拷貝
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
  }
  fs.mkdirSync(path.join(dir, 'apps-script'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), path.join(dir, 'apps-script', 'Code.gs'));
  return dir;
}
const SERVER_SRC = `
import http from 'http';
import { default as proxyHandler } from './api/proxy.js';
import { default as troopsHandler } from './api/troops.js';
import { default as superHandler } from './api/super.js';
const PORT = parseInt(process.env.APP_PORT, 10);
function vercelize(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  return res;
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/proxy') return proxyHandler(req, vercelize(res));
  if (u.pathname === '/api/troops') return troopsHandler(req, vercelize(res));
  if (u.pathname === '/api/super') return superHandler(req, vercelize(res));
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end('<html><body>404: NOT_FOUND</body></html>');
}).listen(PORT, '127.0.0.1', () => console.log('READY ' + PORT));
`;

function startServer(dir, port, extraEnv) {
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER_SRC, 'utf8');
  // 先清走宿主環境嘅 SUPER_KEY／TROOP_*，再套上本 server 指定嘅設定
  const baseEnv = { ...process.env };
  delete baseEnv.SUPER_KEY;
  for (const k of Object.keys(baseEnv)) if (/^TROOP_[0-9A-Za-z]+_/.test(k)) delete baseEnv[k];
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
    cwd: dir, // ← 關鍵：process.cwd() 內沒有 data/
    env: {
      ...baseEnv,
      APP_PORT: String(port),
      ROVERBADGE_PROXY_TEST: '1',
      ROVERBADGE_PROXY_TIMEOUT_MS: '3000',
      TROOP_0082_NAME: '第 82 旅 (樂行)',
      TROOP_0082_EN: 'rover-82',
      TROOP_0082_BACKEND: `http://127.0.0.1:${MOCK_PORT}/exec`,
      TROOP_0082_APIKEY: 'KEY_LAMBDA',
      TROOP_1001_NAME: '第 101 旅（隔離測試）',
      TROOP_1001_EN: 'rover-1001',
      TROOP_1001_BACKEND: `http://127.0.0.1:${MOCK_PORT}/exec`,
      TROOP_1001_APIKEY: 'KEY_TEN',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return child;
}

// server 1：SUPER_KEY 已設定（4 字元）；server 2：完全沒有 SUPER_KEY（3A-1／3A-4 對照組）
const child = startServer(makeLambdaDir('var-task-with-key'), APP_PORT, { SUPER_KEY: SU_KEY });
const child2b = startServer(makeLambdaDir('var-task-no-key'), APP2_PORT, {});
let childLog = '', child2Log = '';
child.stdout.on('data', d => { childLog += d; });
child.stderr.on('data', d => { childLog += d; });
child2b.stdout.on('data', d => { child2Log += d; });
child2b.stderr.on('data', d => { child2Log += d; });

let ready = false, ready2 = false;
for (let i = 0; i < 100; i++) {
  if (childLog.includes('READY')) ready = true;
  if (child2Log.includes('READY')) ready2 = true;
  if (ready && ready2) break;
  await sleep(50);
}
check('兩個 lambda 模擬 server 已就緒（有／無 SUPER_KEY）', ready && ready2, childLog.slice(0, 200) + child2Log.slice(0, 200));
if (!ready || !ready2) { await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

async function req(base, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON = 就是這次 bug 的樣貌 */ }
  return { status: r.status, type: r.headers.get('content-type') || '', json, text };
}
const BASE = `http://127.0.0.1:${APP_PORT}`;
const BASE2 = `http://127.0.0.1:${APP2_PORT}`;
const proxy = (action, data, troopId = '0082', base = BASE) => req(base, 'POST', '/api/proxy', { troopId, action, data });
const isJson = (r) => /application\/json/.test(r.type) && r.json !== null;

// ---- 3. endpoint 存在性（嚴格 4 端點：proxy/troops/portal/super）----
console.log('\n【3】/api endpoint 都要回 JSON（Vercel 沒建 function 時會回 HTML 404）');
{
  const t = await req(BASE, 'GET', '/api/troops');
  check('GET /api/troops → 200 + JSON', t.status === 200 && isJson(t), `${t.status} ${t.type}`);
  check('/api/troops 列出 0082（來自環境變數）', !!(t.json && t.json.troops && t.json.troops['0082'] && t.json.troops['0082'].name === '第 82 旅 (樂行)'), JSON.stringify(t.json || {}).slice(0, 160));
  check('/api/troops 值只出 name/en（冇 apikey/backends）',
    !!(t.json && Object.values(t.json.troops).every(v => Object.keys(v).join(',') === 'name,en') &&
      !/script\.google\.com|\/exec|KEY_LAMBDA/.test(t.text)),
    t.text.slice(0, 160));

  // 嚴格 4 端點：health.js 已收口 → /api/health 變 HTML 404（不再是 JSON endpoint）
  const h = await req(BASE, 'GET', '/api/health');
  check('GET /api/health → HTML 404（端點已收口，api 面嚴格 4 個）', h.status === 404 && !isJson(h), `${h.status} ${h.type}`);

  // /api/super：只收 POST（GET → 405）；錯票 → 非 200
  const gs = await req(BASE, 'GET', '/api/super');
  check('GET /api/super → 405 + JSON（只收 POST）', gs.status === 405 && isJson(gs) && gs.json.ok === false, `${gs.status} ${gs.type}`);
  const bs = await req(BASE, 'POST', '/api/super', { ticket: 'rbs1.garbage', apikey: 'KEY_LAMBDA', backend: `http://127.0.0.1:${MOCK_PORT}/exec` });
  check('POST /api/super 垃圾票據 → 非 200 {ok:false}（唔會誤發）', bs.status !== 200 && isJson(bs) && bs.json.ok === false, `${bs.status} ${bs.text.slice(0, 80)}`);

  const nf = await req(BASE, 'GET', '/api/nope');
  check('未部署的路徑仍是 HTML 404（測試用的對照組）', nf.status === 404 && !isJson(nf));
}

// ---- 4. 3A-1／3A-4：SUPER_KEY 未設定 → 中央登入拒絕、不呼叫 GAS；一般登入不受影響 ----
console.log('\n【4】SUPER_KEY 未設定的 server（3A-1 + 3A-4）');
{
  const before = mock.state.superTicketLogins.length;
  const attempt = await proxy('login', { login_id: SU_USER, password: SU_KEY }, '0082', BASE2);
  check('未設定 SUPER_KEY：中央帳號登入被拒（success:false）', attempt.json && attempt.json.success === false, attempt.text.slice(0, 160));
  check('未設定 SUPER_KEY：不觸發 superTicketLogin（不呼叫 GAS 中央驗票）',
    mock.state.superTicketLogins.length === before, JSON.stringify(mock.state.superTicketLogins.slice(before)));
  check('未設定 SUPER_KEY：錯誤訊息為一般用語（503 細節不外洩）',
    !/SUPER_KEY|環境變數/.test(attempt.text), attempt.text.slice(0, 160));

  const member = await proxy('login', { login_id: '1234560001', password: 'Member!123' }, '0082', BASE2);
  check('3A-4：普通成員登入不受 SUPER_KEY 未設定影響', member.json && member.json.success === true && typeof member.json.token === 'string', member.text.slice(0, 160));
  const leader = await proxy('login', { login_id: 'l@example.org', password: 'Leader!123' }, '0082', BASE2);
  check('3A-4：領袖 Email 登入照舊', leader.json && leader.json.success === true && leader.json.user.role === 'group_leader', leader.text.slice(0, 160));
  const load = await proxy('load', { token: member.json.token }, '0082', BASE2);
  check('3A-4：登入後 load 正常（完整鏈路不受影響）', load.json && load.json.success === true && Array.isArray(load.json.members), JSON.stringify(load.json || {}).slice(0, 120));
}

// ---- 5. 3A-2：合格 4 字元設定 + 錯誤密碼 → 拒絕 ----
console.log('\n【5】SUPER_KEY="9876"（4 字元合格）+ 錯誤密碼（3A-2）');
{
  const wrong = await proxy('login', { login_id: SU_USER, password: '9877' });
  check('錯誤密碼被拒（success:false）', wrong.json && wrong.json.success === false, wrong.text.slice(0, 160));
  const wrong2 = await proxy('login', { login_id: SU_USER, password: '' });
  check('空密碼被拒', wrong2.json && wrong2.json.success === false);
  const wrong3 = await proxy('login', { login_id: SU_USER, password: '98760' });
  check('多一位的密碼被拒（完整比對，不是前綴比對）', wrong3.json && wrong3.json.success === false);
}

// ---- 6. 3A-3：正確 4 字元密碼 → 登入成功 + 加密 session 包裝 ----
console.log('\n【6】正確 4 字元密碼：登入 + 加密 session 包裝（3A-3）');
let wrappedToken = '';
{
  const before = mock.state.superTicketLogins.length;
  const ok = await proxy('login', { login_id: SU_USER, password: SU_KEY });
  check('登入成功（success:true, role=super_admin）',
    ok.status === 200 && isJson(ok) && ok.json.success === true && ok.json.user && ok.json.user.role === 'super_admin',
    ok.text.slice(0, 200));
  check('mock GAS 收到帶 super_ticket 的 login（Vercel 驗證後才簽票轉發）',
    mock.state.superTicketLogins.length === before + 1, JSON.stringify(mock.state.superTicketLogins.slice(before)));
  const lastTicketCall = mock.state.superTicketLogins[mock.state.superTicketLogins.length - 1];
  check('轉發保留 GAS schema：action=login 附 super_ticket', lastTicketCall.hasTicket === true);
  check('密碼永不出現在 GAS（proxy 已剝走 password 欄位）', lastTicketCall.hasPassword === false, JSON.stringify(lastTicketCall));
  const lastVerify = mock.state.verifyCalls[mock.state.verifyCalls.length - 1];
  check('GAS 回打 /api/super 驗票（帶 apikey+backend 綁定核對）', !!lastVerify && lastVerify.hasApikey === true && lastVerify.hasBackend === true, JSON.stringify(lastVerify || {}));

  wrappedToken = (ok.json || {}).token || '';
  check('回傳瀏覽器的 token 有加密包裝前綴（rbs1.）', wrappedToken.startsWith('rbs1.'), wrappedToken.slice(0, 20));
  const innerTokens = Object.keys(mock.state.tokens);
  check('包裝 token 不是 GAS 原始 token（raw token 不出瀏覽器）',
    innerTokens.length > 0 && !innerTokens.includes(wrappedToken));
  check('force_change_password=false', ok.json.force_change_password === false);

  // 包裝 token 可用於後續請求（proxy 解包 → GAS 驗證 inner token）
  const load = await proxy('load', { token: wrappedToken });
  check('包裝 token 可通過 proxy 解包並 load 成功', load.json && load.json.success === true && Array.isArray(load.json.members), JSON.stringify(load.json || {}).slice(0, 120));
  const save = await proxy('save', { token: wrappedToken, changes: [{ ymis: '1234560001', itemId: 'L1-CP', date: '2026-09-20' }] });
  check('包裝 token 可寫入（save 成功）', save.json && save.json.success === true, JSON.stringify(save.json || {}).slice(0, 120));

  // 竄改 / 無效包裝 → 401（token 把關 action 驗包裝真偽）
  const tampered = await proxy('getPendingRequests', { token: wrappedToken.slice(0, -4) + 'AAAA' });
  check('竄改的包裝 token（token 把關 action）→ 401', tampered.status === 401 && isJson(tampered), `${tampered.status}`);

  // 未包裝的 raw inner token 直接打 proxy 仍可用（GAS 真偽把關），但包裝 token 跨旅團會被拒 —— 跨旅團測試在 run-e2e
  const logout = await proxy('logout', { token: wrappedToken });
  check('包裝 token 可正常登出', logout.json && logout.json.success === true, JSON.stringify(logout.json || {}));
  // 注意：load 是 GET（同真實 GAS 一樣只驗 apikey），所以用 token 把關的 action 驗證失效
  const afterLogout = await proxy('getPendingRequests', { token: wrappedToken });
  check('登出後 inner token 已失效（token 把關的 action 被拒）', afterLogout.json && afterLogout.json.success === false, JSON.stringify(afterLogout.json || {}).slice(0, 120));
}

// ---- 7. 一般登入不受中央流程攔截（格式判斷）----
console.log('\n【7】一般帳號格式一律行旅團登入（即使密碼與 SUPER_KEY 相同）');
{
  const collision = await proxy('login', { login_id: '1234560077', password: SU_KEY });
  check('10 位 YMIS + 密碼= SUPER_KEY → 行一般登入成功（不被中央流程攔截）',
    collision.json && collision.json.success === true && collision.json.user.role === 'member', collision.text.slice(0, 160));
  check('一般登入 token 沒有包裝前綴', typeof collision.json.token === 'string' && !collision.json.token.startsWith('rbs1.'));
  const admin = await proxy('login', { login_id: '1111111111', password: 'Admin!2345' });
  check('旅團管理員登入照舊', admin.json && admin.json.success === true, admin.text.slice(0, 160));
  const bad = await proxy('login', { login_id: '1234560001', password: 'wrong-one' });
  check('錯誤密碼 → success:false（不是 404/HTML）', bad.json && bad.json.success === false && /密碼/.test(bad.json.error || ''), bad.text.slice(0, 160));
}

// ---- 8. 超管 session 跨旅團隔離（vs 同構：session 綁 troopId）----
console.log('\n【8】超管 session 跨旅團隔離（rbs1. session 綁 troopId）');
{
  const cross = await proxy('changePassword', { token: wrappedToken, old_password: 'x', new_password: 'yyyy' }, '1001');
  check('0082 嘅超管 session 打去 1001 → 401（session 綁旅團）', cross.status === 401 && isJson(cross) && cross.json.success === false, `${cross.status} ${cross.text.slice(0, 120)}`);
  const same = await proxy('changePassword', { token: wrappedToken, old_password: 'x', new_password: 'yyyy' }, '0082');
  check('同一旅團下超管 changePassword → 403「聯絡管理員」', same.status === 403 && isJson(same) && /管理員/.test(same.json.error || ''), `${same.status} ${same.text.slice(0, 120)}`);
}

// ---- 9. 安全邊界照舊 ----
console.log('\n【9】安全邊界（修復後不應放寬任何驗證）');
{
  const noTok = await proxy('getMembers', {});
  check('無 token 的受保護 action → 401 JSON', noTok.status === 401 && isJson(noTok), `${noTok.status} ${noTok.type}`);

  const unknownAction = await proxy('deleteEverything', {});
  check('非白名單 action → 400 JSON', unknownAction.status === 400 && isJson(unknownAction), `${unknownAction.status}`);

  const ssrf = await req(BASE, 'POST', '/api/proxy', { troopId: 'attacker', action: 'load', data: { backend: 'http://169.254.169.254/latest/meta-data/' } });
  check('企圖用自訂 backend 打內部地址 → 404（只認 registry）', ssrf.status === 404 && isJson(ssrf), `${ssrf.status} ${ssrf.text.slice(0, 80)}`);

  const getOnProxy = await req(BASE, 'GET', '/api/proxy');
  check('GET /api/proxy → 405 + Allow: POST', getOnProxy.status === 405 && /POST/.test(getOnProxy.text), `${getOnProxy.status}`);

  const bigData = await proxy('save', { token: 'tok_0123456789', blob: 'x'.repeat(2097500) });
  check('過大 payload → 413 + JSON', bigData.status === 413 && isJson(bigData), `${bigData.status} ${bigData.type}`);

  // 回傳端點已刪（不做回傳）：垃圾票據唔會再有專門 endpoint 去驗
  const vBad = await req(BASE, 'POST', '/api/verify-super-ticket', { ticket: 'rbs2.garbage', backend: 'https://x/exec' });
  check('verify-super-ticket 已刪（垃圾票據打唔到任何驗證回傳端點）', vBad.status === 404 && !isJson(vBad), vBad.text.slice(0, 120));
}

// ---- 10. 沒有 TROOP_* 環境變數時：/api/troops 空、proxy 404 ----
console.log('\n【10】沒有任何旅團環境變數時（v4.0：沒有檔案／靜態保底）');
{
  const p3 = await freePort();
  const dir3 = path.join(tmp, 'var-task-empty');
  fs.mkdirSync(path.join(dir3, 'api'), { recursive: true });
  fs.mkdirSync(path.join(dir3, 'scripts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'api'))) fs.copyFileSync(path.join(ROOT, 'api', f), path.join(dir3, 'api', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir3, 'scripts', f));
  fs.mkdirSync(path.join(dir3, 'apps-script'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), path.join(dir3, 'apps-script', 'Code.gs'));
  fs.writeFileSync(path.join(dir3, 'server.mjs'), SERVER_SRC, 'utf8');
  const env3 = { ...process.env, APP_PORT: String(p3), ROVERBADGE_PROXY_TEST: '1', ROVERBADGE_PROXY_TIMEOUT_MS: '1500' };
  for (const k of Object.keys(env3)) if (/^TROOP_/.test(k)) delete env3[k];
  const c3 = spawn(process.execPath, [path.join(dir3, 'server.mjs')], { cwd: dir3, env: env3, stdio: ['ignore', 'pipe', 'pipe'] });
  let log3 = '';
  c3.stdout.on('data', d => { log3 += d; });
  c3.stderr.on('data', d => { log3 += d; });
  for (let i = 0; i < 100; i++) { if (log3.includes('READY')) break; await sleep(50); }
  const b3 = `http://127.0.0.1:${p3}`;
  const t3 = await (await fetch(b3 + '/api/troops')).json();
  check('沒有環境變數 → /api/troops 回空清單（沒有寫死旅團）', t3.troops && Object.keys(t3.troops).length === 0, JSON.stringify(t3));
  const r3 = await fetch(b3 + '/api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ troopId: '0082', action: 'login', data: { login_id: 'x', password: 'y' } }) });
  const j3 = await r3.json().catch(() => null);
  check('未登記旅團 → 404 + JSON（不是 HTML）', r3.status === 404 && j3 && j3.success === false, `${r3.status}`);
  c3.kill('SIGKILL');
}

// ---- 11. 前端診斷函數（登入頁提示是否講啱原因）----
console.log('\n【11】index.html 的 apiDiagnose()：區分「function 未部署」與「後端正常」');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const code = (html.match(/async function apiDiagnose\(\)\{[\s\S]*?\n\}/) || [''])[0];
  check('index.html 有 apiDiagnose()（前端會自我診斷部署問題）', code.length > 0);
  const build = (fetchImpl) => new Function('fetch', `let __apiDiag=null,__apiDiagAt=0;\n${code}\nreturn apiDiagnose;`)(fetchImpl);

  const dead = build(async (u) => ({ ok: false, status: 404, json: async () => { throw new Error('not json'); } }));
  const a = await dead();
  check('HTML 404 → deployed:false（前端會提示「後端 API 未部署」而非「密碼錯誤」）', a.deployed === false && a.troopsOk === false, JSON.stringify(a));

  const live = build(async (u, o) => fetch(BASE + u, o));
  const b = await live();
  check('真 server → deployed:true + troopsOk:true', b.deployed === true && b.troopsOk === true, JSON.stringify(b));

  const legacy = build(async (u, o) => (u === '/api/health'
    ? { ok: false, status: 404, json: async () => { throw new Error('no health endpoint yet'); } }
    : fetch(BASE + u, o)));
  const c = await legacy();
  check('舊版冇 /api/health 時唔會誤判「API 未部署」', c.deployed === true && c.troopsOk === true, JSON.stringify(c));
}

// ---- 12. doGet/doPost 路由（scoutbadge 2026-08 的「登入成功但一入面就離線模式」bug 類別）----
console.log('\n【12】method 路由必須同 Code.gs 一致：doGet 只認 load / getLoginMode');
{
  const gm = await proxy('getLoginMode', {});
  check('getLoginMode 通過 proxy 成功（GET → doGet）', gm.json && gm.json.success === true, gm.text.slice(0, 120));

  const recv = mock.state.received || [];
  check('load 用 GET 打去 GAS', recv.some(r => r.action === 'load' && r.method === 'GET'), JSON.stringify(recv.slice(-6)));
  check('load 從未用 POST 打去 GAS', !recv.some(r => r.action === 'load' && r.method === 'POST'), '');
  check('getLoginMode 用 GET', recv.some(r => r.action === 'getLoginMode' && r.method === 'GET'), '');
  check('login / save 用 POST', recv.some(r => r.action === 'login' && r.method === 'POST') && recv.some(r => r.action === 'save' && r.method === 'POST'), JSON.stringify(recv.slice(-6)));
  check('中央登入照用 action=login 轉發（唔另立 action，schema 不變）', recv.some(r => r.action === 'login' && r.method === 'POST'), '');
  check('GAS 全程冇收到 superTicketLogin action（舊回打件已移除）', !recv.some(r => r.action === 'superTicketLogin'), '');

  const badPost = await fetch(mock.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'load' }) });
  const badJson = await badPost.json().catch(() => null);
  check('對照組：直接 POST load 俾 GAS → Unknown action', badJson && badJson.success === false && /Unknown action/.test(badJson.error || ''), JSON.stringify(badJson));
  const goodGet = await fetch(`${mock.url}?action=load&apikey=KEY_LAMBDA`);
  const goodJson = await goodGet.json().catch(() => null);
  check('對照組：GET load（帶 apikey）俾 GAS → 成功', goodJson && goodJson.success === true, JSON.stringify(goodJson || {}).slice(0, 120));
}

// ---- 收尾 ----
console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
child.kill('SIGKILL');
child2b.kill('SIGKILL');
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exit(1);
