// ROVERBOOK 真端到端：真 api/roverbook.js ＋ 真 api/proxy.js ＋ 真 Code.gs（GAS 模擬器）
//
// 為什麼要這一支：tests/roverbook-api.test.mjs 驗的是 `/api/roverbook` 自己，
// 但 ROVERBOOK 實際係打 `/api/proxy`，而且佢的伺服器端會自己做過濾
// （見 ROVERBOOK api/roverbadge.js filterPersonalConfirmedLoad）。所以真正要證明的係：
//
//   BOOK 前端 → BOOK 伺服器 → POST /api/proxy → GAS doGet/doPost → Code.gs 真實 handler
//                                                        ↓
//                                   BOOK 過濾邏輯 → 見到本人進度／其他獎章／待批
//
// 這支測試把 GitHub 上 ROVERBOOK 的 `api/roverbadge.js` 邏輯照抄過來（見 bookHandler），
// 用真實 HTTP 打本系統的 function（Vercel 式 res），上游接真的 Code.gs（gas-harness），
// 所以任何一環改壞（load 回應形狀、10 位補零、requestComplete 契約、403 閘）都會即刻紅。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCodeGs } from './gas-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---------------------------------------------------------------- ROVERBOOK 端（照抄）
// ↓↓ 以下三個 function 與 ROVERBOOK api/roverbadge.js 行為一致 ↓↓
function normalizeScoutIdInFn(id) {
  const raw = String(id === undefined || id === null ? '' : id).trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  if (/^\d{1,10}$/.test(digits)) return digits.padStart(10, '0');
  return digits;
}
function filterPersonalConfirmedLoad(json, scoutId) {
  const sid = String(scoutId || '');
  const out = { progress: {}, otherBadges: {}, pendingRequests: [], ymis: sid };
  const members = Array.isArray(json?.members) ? json.members : [];
  let me = null;
  if (members.length) {
    me = members.find((m) => {
      const msid = normalizeScoutIdInFn(m.scoutId || m.ymis || m.memberNo);
      return msid && msid === sid;
    }) || null;
  }
  if (!me && sid) {
    for (const key of ['progress', 'progress_mock']) {
      const container = json && json[key] && typeof json[key] === 'object' ? json[key] : null;
      if (container && container[sid] && typeof container[sid] === 'object') { me = { scoutId: sid, ...container[sid] }; break; }
    }
  }
  if (!me) return out;
  out.ymis = me.scoutId || me.ymis || me.memberNo || sid;
  const confirmed = me.progress || me.flatProgress || {};
  if (confirmed && typeof confirmed === 'object') {
    Object.entries(confirmed).forEach(([itemId, value]) => {
      const date = typeof value === 'string' ? value : value && value.date ? value.date : '';
      if (date) out.progress[itemId] = date;
    });
  }
  if (me.otherBadges && typeof me.otherBadges === 'object') out.otherBadges = { ...me.otherBadges };
  const pending = Array.isArray(me.pendingRequests) ? me.pendingRequests : [];
  out.pendingRequests = pending.map((p) => ({ itemId: p.itemId || p.id || '', date: p.date || '', status: p.status || 'pending' }));
  return out;
}

// ---------------------------------------------------------------- GAS 模擬（真 Code.gs）
function makeGasServer(env, port) {
  const send = (res, obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname !== '/exec') { res.writeHead(404); return res.end('no'); }
      const parameter = Object.fromEntries(u.searchParams.entries());
      if (req.method === 'GET') return send(res, JSON.parse(env.api.doGet({ parameter }).getContent()));
      const contents = await readBody(req);
      send(res, JSON.parse(env.api.doPost({ postData: { contents } }).getContent()));
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- ROVERBADGE function（Vercel 式）
const SERVER_SRC = `
import http from 'http';
import { Readable } from 'stream';
import proxyHandler from './api/proxy.js';
import roverbookHandler from './api/roverbook.js';
function vercelize(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  return res;
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  req.query = Object.fromEntries(u.searchParams.entries());
  res.setHeader('Cache-Control', 'no-store');
  if (u.pathname === '/api/proxy') {
    // proxy 讀 req.body（Vercel 已解析 JSON 的情況）；把 body 讀出再包一個可再讀的 stream
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    req.body = raw ? JSON.parse(raw) : {};
    return proxyHandler(req, vercelize(res));
  }
  // roverbook 自己由 stream 讀 raw body（與 Vercel 原生一致），所以原樣傳入
  if (u.pathname === '/api/roverbook') return roverbookHandler(req, vercelize(res));
  res.writeHead(404); res.end('no');
}).listen(parseInt(process.env.APP_PORT, 10), '127.0.0.1', () => console.log('READY'));
`;

test('ROVERBOOK 端到端：BOOK → /api/proxy → 真 Code.gs（載入／送交／CONFIRM／403 閘）', async (t) => {
  const env = loadCodeGs();
  env.api.initializeSheets();
  // GAS 的 API Key 必須等於旅團登記的 APIKEY，否則 doGet ?action=load 會被 apikey 檢查擋住
  env.scriptProps.set('API_KEY', 'KEY_E2E');
  const L = env.call({ action: 'login', login_id: '1111111111', password: 'changeme' });
  assert.equal(L.success, true, '初始化管理員登入：' + JSON.stringify(L));
  env.call({ action: 'addUser', token: L.token, ymis: '81420', name: '陳大文', email: 'a@example.org', role: 'member', password: 'Member!1234' });
  env.call({ action: 'addUser', token: L.token, ymis: '2000000002', name: '李小明', email: 'b@example.org', role: 'member', password: 'Member!1234' });
  const M1 = env.call({ action: 'login', login_id: '81420', password: 'Member!1234' });   // 未補零登入
  assert.equal(M1.success, true, JSON.stringify(M1));

  const GAS_PORT = await freePort();
  const gas = await makeGasServer(env, GAS_PORT);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-book-e2e-'));
  fs.mkdirSync(path.join(dir, 'api'));
  for (const f of fs.readdirSync(path.join(ROOT, 'api'))) fs.copyFileSync(path.join(ROOT, 'api', f), path.join(dir, 'api', f));
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
  fs.mkdirSync(path.join(dir, 'apps-script'));
  fs.copyFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), path.join(dir, 'apps-script', 'Code.gs'));
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER_SRC, 'utf8');

  const APP_PORT = await freePort();
  const baseEnv = { ...process.env };
  delete baseEnv.SUPER_KEY;
  for (const k of Object.keys(baseEnv)) if (/^TROOP_[0-9A-Za-z]+_/.test(k)) delete baseEnv[k];
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
    cwd: dir,
    env: {
      ...baseEnv,
      APP_PORT: String(APP_PORT),
      ROVERBADGE_PROXY_TEST: '1',
      ROVERBADGE_PROXY_TIMEOUT_MS: '5000',
      TROOP_0082_NAME: '第 82 旅 (樂行)',
      TROOP_0082_EN: 'rover-82',
      TROOP_0082_BACKEND: `http://127.0.0.1:${GAS_PORT}/exec`,
      TROOP_0082_APIKEY: 'KEY_E2E',
      ROVERBADGE_ORIGIN: `http://127.0.0.1:${APP_PORT}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const BASE = `http://127.0.0.1:${APP_PORT}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server 啟動逾時')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (d) => process.stderr.write(String(d)));
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('server 退出 ' + c)); });
  });

  // ROVERBOOK 的 forwardProxy：POST /api/proxy，body {action,troopId,data}
  const proxy = async (action, data) => {
    const r = await fetch(`${BASE}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ action, troopId: '0082', data })
    });
    return { status: r.status, json: await r.json() };
  };
  // ROVERBOOK handler 的形狀（login / load / submitPending）
  const book = {
    login: async (scoutId, password) => {
      const up = await proxy('login', { login_id: scoutId, password });
      const user = up.json && up.json.user ? up.json.user : {};
      return { success: !!up.json.success, token: up.json.token || null, ymis: user.ymis || scoutId || null, user };
    },
    load: async (scoutId, token) => {
      const up = await proxy('load', { token });
      return { success: true, ...filterPersonalConfirmedLoad(up.json, normalizeScoutIdInFn(scoutId)) };
    },
    submitPending: async (scoutId, token, items) => {
      const results = [];
      for (const it of items) {
        const up = await proxy('requestComplete', { token, itemId: String(it.itemId), date: String(it.date || '') });
        results.push({ itemId: it.itemId, ok: !!up.json.success, status: up.json.status, data: up.json });
      }
      return { success: results.some((r) => r.ok), results };
    }
  };

  t.after(async () => {
    child.kill('SIGKILL');
    gas.close();
    await new Promise((r) => setTimeout(r, 100));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  // ---- 1. 領袖在 BADGE 內簽（正式進度／頒發／其他獎章）----
  const save = env.call({ action: 'save', token: L.token, changes: [{ ymis: '0000081420', itemId: 'L1-ACT-01', date: '2026-03-01' }] });
  assert.equal(save.success, true, JSON.stringify(save));
  const award = env.call({ action: 'bookAward', token: L.token, awards: [{ scoutId: '0000081420', badgeId: 'L1', date: '2026-04-01' }] });
  assert.equal(award.success, true, JSON.stringify(award));
  const ob = env.call({ action: 'saveOtherBadge', token: L.token, records: [{ ymis: '0000081420', badgeId: 'OT-WOSM-SW', date: '2026-01-05' }] });
  assert.equal(ob.success, true, JSON.stringify(ob));

  // ---- 2. BOOK 登入（成員輸入未補零 SCOUT ID）----
  const login = await book.login('81420', 'Member!1234');
  assert.equal(login.success, true, JSON.stringify(login));
  assert.ok(login.token, '要拿到 token');
  // 註：/api/proxy 係本系統自己的前端通道，login 回應照樣帶 user.name（前端需要）；
  //     零個資剝除係由 BOOK 伺服器負責（佢只回 {success, token, ymis}）。
  //     嚴格零個資的回應係 /api/roverbook（見 tests/roverbook-api.test.mjs）。
  assert.equal(login.user.name, '陳大文', 'proxy 通道保持本系統前端契約');
  assert.equal(normalizeScoutIdInFn(login.ymis), '0000081420');

  // ---- 3. BOOK 載入：必須見到本人已核實進度 + 頒發 + 其他獎章 ----
  let view = await book.load('81420', login.token);
  assert.equal(view.ymis, '0000081420');
  assert.deepEqual(view.progress, { 'L1-ACT-01': '2026-03-01' }, '★ BOOK 要見到已核實進度：' + JSON.stringify(view));
  assert.ok(view.otherBadges['OT-WOSM-SW'], '★ BOOK 要見到其他獎章：' + JSON.stringify(view.otherBadges));
  assert.deepEqual(view.pendingRequests, []);
  // 另一位成員唔會見到陳大文的進度（BOOK 只會見到自己，但本系統的回應係全團，靠 BOOK 過濾）
  const other = await book.load('2000000002', login.token);
  assert.deepEqual(other.progress, {}, '★ BOOK 端過濾要阻止他人資料漏出');

  // ---- 4. BOOK 送交待批（逐項 requestComplete）→ 一定 pending ----
  const sub = await book.submitPending('81420', login.token, [{ itemId: 'L1-UND-01', date: '2026-03-02' }]);
  assert.equal(sub.success, true, JSON.stringify(sub));
  assert.equal(sub.results[0].ok, true);
  assert.equal(sub.results[0].status, 'pending', '★ 送交只可以係 pending');
  assert.equal(sub.results[0].data.id, 'L1-UND-01', 'BOOK 逐項記錄會讀 id');
  assert.equal(sub.results[0].data.date, '2026-03-02');

  // 未 CONFIRM：BOOK 只見到「待批」，進度不變
  view = await book.load('81420', login.token);
  assert.deepEqual(view.progress, { 'L1-ACT-01': '2026-03-01' }, '★ 成員送交唔可以令進度增加');
  assert.deepEqual(view.pendingRequests, [{ itemId: 'L1-UND-01', date: '2026-03-02', status: 'pending' }], JSON.stringify(view));
  assert.equal(env.ss.sheets.get('進度追蹤').rows.length, 2, '★ 送交後「進度追蹤」仍然只有 1 筆正式紀錄');

  // ---- 5. 成員想自己扮完成（經 proxy 直接打 save／reviewRequest）→ 一律失敗 ----
  const hack = await proxy('save', { token: login.token, changes: [{ ymis: '0000081420', itemId: 'L1-UND-01', date: '2026-03-02' }] });
  assert.equal(hack.json.success, false, '★ 成員 token 唔可以寫正式進度：' + JSON.stringify(hack.json));
  const hack2 = await proxy('reviewRequest', { token: login.token, request_id: 'ANY', decision: 'approved' });
  assert.equal(hack2.json.success, false, '★ 成員 token 唔可以自我批准：' + JSON.stringify(hack2.json));
  // /api/roverbook 呢條嚴格閘道連 POST 都唔收（login 以外嘅寫入一律 403）
  const strict = await fetch(`${BASE}/api/roverbook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', troopId: '0082', data: { token: login.token } })
  });
  assert.equal(strict.status, 403);

  // ---- 6. 領袖在 BADGE 內 CONFIRM → BOOK 才見到 ----
  const reqs = env.call({ action: 'getPendingRequests', token: L.token });
  const req = (reqs.requests || [])[0];
  assert.ok(req, '要有待批申請：' + JSON.stringify(reqs));
  const rev = env.call({ action: 'reviewRequest', token: L.token, request_id: req.request_id, decision: 'approved', confirmed_date: '2026-03-02' });
  assert.equal(rev.success, true, JSON.stringify(rev));

  view = await book.load('81420', login.token);
  assert.deepEqual(view.progress, { 'L1-ACT-01': '2026-03-01', 'L1-UND-01': '2026-03-02' }, '★ CONFIRM 之後 BOOK 才見到：' + JSON.stringify(view));
  assert.deepEqual(view.pendingRequests, [], '★ 批完要從待批消失，否則 BOOK 會重複送交');

  // ---- 7. GET /api/roverbook?action=troops（BOOK 旅團下拉選單）----
  const troopsRes = await fetch(`${BASE}/api/roverbook?action=troops`);
  assert.equal(troopsRes.status, 200);
  const troops = await troopsRes.json();
  assert.equal(troops.success, true);
  assert.deepEqual(Object.keys(troops.troops['0082']).sort(), ['en', 'name'], '零後端 URL／API Key');
});
