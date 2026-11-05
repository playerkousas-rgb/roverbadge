// ============================================================
// ROVERBOOK 用戶端 API 契約測試（api/roverbook.js）
//
// 對接規格（ROVERBOOK 已合併到 main）：
//   GET  /api/roverbook?action=troops → { troops: { id: { name, en } } }（只 id＋名稱）
//   POST /api/roverbook               只准 login／logout／load／requestComplete
//   save／saveOtherBadge／reviewRequest… 一律 403
//   零個資；SCOUT ID 十位數前導零正規化（81420 ⇄ 0000081420）
//
// 執行：node --test tests/roverbook-api.test.mjs
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCodeGs } from './gas-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handlerModule = await import('../api/roverbook.js');
const handler = handlerModule.default;
const I = handlerModule.__internal;
const proxySrc = fs.readFileSync(path.join(ROOT, 'api/proxy.js'), 'utf8');
const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts/build.mjs'), 'utf8');

// ---- 以真 HTTP server 跑 handler（同 Vercel 一樣 req/res）----
async function startServer(env) {
  // 用 gas-harness 的 mock Sheet 直接當上游：把 getTrustedTroop 換成假旅團，
  // 並用一張「假 fetch」把 upstream 請求轉去真 Code.gs。
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// 直接測「內部 sanitizer／normaliser」— 唔需要網絡，最穩定
test('SCOUT ID 正規化：81420 ⇄ 0000081420，領袖內部編號原樣', () => {
  assert.equal(I.scoutNorm('81420'), '0000081420');
  assert.equal(I.scoutNorm('0000081420'), '0000081420');
  assert.equal(I.scoutNorm(' 81420 '), '0000081420');
  assert.equal(I.scoutNorm('1234567890'), '1234567890');
  assert.equal(I.scoutNorm('L12345'), 'L12345');
  assert.equal(I.scoutNorm(''), '');
  assert.equal(I.scoutNorm(null), '');
  // 超過 10 位數字唔會補零（保持原樣，交由目錄／成員檢查把關）
  assert.equal(I.scoutNorm('12345678901'), '12345678901');
});

test('login 回應剝除姓名／電郵，只留 token＋scoutId（＋ymis 兼容）', () => {
  const out = I.sanitizeLogin({
    success: true, token: 'abc.def',
    user: { ymis: '81420', name: '陳大文', email: 'taiman@example.org', role: 'member', branch: '第82旅', phone: '91234567' }
  });
  assert.equal(out.success, true);
  assert.equal(out.token, 'abc.def');
  assert.equal(out.scoutId, '0000081420');
  assert.equal(out.ymis, '0000081420');
  assert.equal(out.force_change_password, false);
  const json = JSON.stringify(out);
  for (const v of ['陳大文', 'taiman@example.org', '91234567', '第82旅', 'member']) {
    assert.ok(!json.includes(v), 'login 回應不可含 ' + v);
  }
  // 失敗時要回 error
  assert.equal(I.sanitizeLogin({ success: false, error: '帳號或密碼錯誤' }).error, '帳號或密碼錯誤');
});

test('load 回應零個資：冇姓名／電郵／證據，只留進度、其他獎章、待批申請', () => {
  const out = I.sanitizeLoad({
    success: true,
    members: [{ ymis: '81420', name: '陳大文', email: 'a@b.c' }],
    progress: {
      '81420': { 'L1-ACT-01': { date: '2026-03-01', confirmer: '團長甲' }, 'bad-id': { date: '2026-01-01' } },
      '9999999999': { 'L1-UND-01': { date: '2026-02-02' } }
    },
    otherBadges: { '81420': { 'OT-WOSM-SW': { name: '世界童軍徽', date: '2026-01-01', cert: 'CERT-123' } } },
    pendingRequests: [
      { request_id: 'REQ1', ymis: '81420', name: '陳大文', item_id: 'L1-UND-01', evidence: 'data:image/png;base64,PHOTO', status: 'pending', requested_date: '2026-03-02' },
      { request_id: 'REQ2', ymis: '81420', name: '陳大文', item_id: 'not-an-item', status: 'pending' }
    ],
    schemes: { '81420': 'new' }, schemeDefault: 'new', gsVersion: '5.4.0',
    logs: [{ note: '內部審計紀錄' }]
  });
  const json = JSON.stringify(out);
  for (const v of ['陳大文', 'a@b.c', 'PHOTO', 'CERT-123', '內部審計紀錄', 'not-an-item']) {
    assert.ok(!json.includes(v), 'load 回應不可含 ' + v);
  }
  // key 一律用正規化後的 SCOUT ID（81420 → 0000081420），其他成員的進度要保留（由 BOOK 過濾自己）
  assert.deepEqual(Object.keys(out.progress), ['0000081420', '9999999999']);
  assert.deepEqual(out.progress['0000081420'], { 'L1-ACT-01': { date: '2026-03-01', confirmer: '團長甲' } });
  assert.deepEqual(out.otherBadges['0000081420'], { 'OT-WOSM-SW': { date: '2026-01-01' } });
  assert.equal(out.pendingRequests.length, 1, '壞項目要被丟棄');
  assert.deepEqual(out.pendingRequests[0], {
    request_id: 'REQ1', scoutId: '0000081420', item_id: 'L1-UND-01', requested_date: '2026-03-02', status: 'pending'
  });
  assert.equal(out.privacy.personalData, 'none');
});

test('requestComplete 回應：一律 status=pending，唔可以自稱完成', () => {
  const ok = I.sanitizeRequestComplete({ success: true, request_id: 'REQ9', status: 'approved' });
  assert.equal(ok.success, true);
  assert.equal(ok.status, 'pending', '就算上游回 approved 都要變 pending');
  assert.equal(ok.request_id, 'REQ9');
  const bad = I.sanitizeRequestComplete({ success: false, error: '項目不屬於學制' });
  assert.equal(bad.success, false);
  assert.equal(bad.status, 'rejected');
});

test('stripNever：就算上游多回個資欄位，最後一道都會剝走', () => {
  const out = I.stripNever({
    success: true,
    progress: { '0000081420': { 'L1-ACT-01': { date: '2026-03-01' } } },
    member: { nameZh: '陳大文', phone: '91234567', photo: 'x', signature: { png: 'y' } },
    nested: { deep: { email: 'a@b.c' } }
  });
  const json = JSON.stringify(out);
  for (const v of ['陳大文', '91234567', 'a@b.c']) assert.ok(!json.includes(v), '不可含 ' + v);
  assert.equal(I.hasNeverField({ a: { b: { phone: '1' } } }), true);
  assert.equal(I.hasNeverField({ a: { b: { date: '1' } } }), false);
});

// ---- 真 HTTP：白名單 / 403 / GET troops ----
test('HTTP：GET 只回旅團 id＋名稱；非 troops 的 GET 400；其他 method 405', async () => {
  const { server, base } = await startServer();
  try {
    const t = await fetch(base + '/api/roverbook?action=troops');
    assert.equal(t.status, 200);
    const tj = await t.json();
    assert.equal(tj.success, true);
    assert.equal(typeof tj.troops, 'object');
    assert.ok(!JSON.stringify(tj.troops).match(/apikey|backend|exec|script\.google/i), '不可洩漏 backend／apikey');
    for (const v of Object.values(tj.troops)) {
      assert.deepEqual(Object.keys(v).sort().filter(k => k !== 'en'), ['name'], '每個旅團只回 name（＋可選 en）');
    }
    const bad = await fetch(base + '/api/roverbook?action=login');
    assert.equal(bad.status, 400);
    const put = await fetch(base + '/api/roverbook', { method: 'PUT' });
    assert.equal(put.status, 405);
  } finally { await new Promise((r) => server.close(r)); }
});

test('HTTP：寫入類 action 一律 403 Forbidden（save／saveOtherBadge／reviewRequest／addUser…）', async () => {
  const { server, base } = await startServer();
  try {
    const forbidden = ['save', 'saveOtherBadge', 'reviewRequest', 'reviewApplication', 'addUser',
      'upsertUser', 'exportUsers', 'resetPassword', 'deleteUser', 'updateConfig', 'setScheme',
      'bookSync', 'bookConfirm', 'bookAward', 'apply', 'forgotPassword', 'submitRegistration'];
    for (const action of forbidden) {
      const r = await fetch(base + '/api/roverbook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, troopId: '0082', data: {} })
      });
      assert.equal(r.status, 403, action + ' 應回 403，實際 ' + r.status);
      const j = await r.json();
      assert.equal(j.success, false);
      assert.match(j.error, /ROVERBOOK/);
    }
    // 未知 action → 400（唔係 403）
    const unknown = await fetch(base + '/api/roverbook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'whatever', troopId: '0082', data: {} })
    });
    assert.equal(unknown.status, 400);
  } finally { await new Promise((r) => server.close(r)); }
});

test('HTTP：login 缺密碼／缺 SCOUT ID 會 400；沒有旅團 404；payload 過大 413', async () => {
  const { server, base } = await startServer();
  const post = (body) => fetch(base + '/api/roverbook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  try {
    assert.equal((await post({ action: 'login', troopId: '0082', data: { password: 'x' } })).status, 400);
    assert.equal((await post({ action: 'login', troopId: '0082', data: { login_id: '81420' } })).status, 400);
    assert.equal((await post({ action: 'login', troopId: 'nope', data: { login_id: '81420', password: 'x' } })).status, 404);
    assert.equal((await post({ action: 'requestComplete', troopId: '0082', data: {} })).status, 401, '缺 token');
    assert.equal((await post({ action: 'load', troopId: '0082', data: {} })).status, 401, '缺 token');
    assert.equal((await post({ action: 'requestComplete', troopId: '0082', data: { token: 't', item_id: 'hack' } })).status, 400, '壞項目代號');
    const big = await post({ action: 'load', troopId: '0082', data: { token: 't', junk: 'x'.repeat(300 * 1024) } });
    assert.equal(big.status, 413);
  } finally { await new Promise((r) => server.close(r)); }
});

// ---- 必須同 /api/proxy 分離（避免誤開後門）----
test('權限面分離：/api/proxy 未加入 BOOK 白名單；build 有打包 roverbook function', () => {
  for (const a of ['login', 'load', 'logout', 'requestComplete']) {
    assert.ok(proxySrc.includes(`'${a}'`), 'proxy 本身仍要有 ' + a);
  }
  assert.match(buildSrc, /roverbook: \['_registry'\]/, 'build 要打包 roverbook function（只依賴 _registry）');
  assert.match(buildSrc, /proxy\|troops\|portal\|super\|roverbook/, 'legacy .js alias 要 route 去 bundled function');
});

// ---- 與 GAS 的 SCOUT ID 正規化一致 ----
test('GAS 端同一套正規化：81420 同 0000081420 係同一個人（登入、待批、取回）', () => {
  const env = loadCodeGs();
  env.api.initializeSheets();
  const L = env.call({ action: 'login', login_id: '1111111111', password: 'changeme' });
  assert.equal(L.success, true);
  // 成員用「未補零」的 YMIS 建立
  // 先用 10 位正規化值建立（addUser 會把 81420 補零成 0000081420），再測試兩種寫法都登入得
  const add = env.call({ action: 'addUser', token: L.token, ymis: '0000081420', name: '陳大文', email: 't@example.org', role: 'member', password: 'Member!1234' });
  assert.equal(add.success, true, JSON.stringify(add));
  // 用補零寫法登入
  const m1 = env.call({ action: 'login', login_id: '0000081420', password: 'Member!1234' });
  assert.equal(m1.success, true, '補零寫法要入得：' + JSON.stringify(m1));
  // 用原本寫法都入得
  const m2 = env.call({ action: 'login', login_id: '81420', password: 'Member!1234' });
  assert.equal(m2.success, true);
  // 待批：用補零寫法提交、用原寫法確認 → 應該係同一批
  const sync = env.call({ action: 'bookSync', token: L.token, scoutId: '0000081420', progress: { 'L1-ACT-01': '2026-03-01' } });
  assert.equal(sync.success, true, JSON.stringify(sync));
  assert.equal(sync.staged, 1);
  const pend = env.call({ action: 'bookPending', token: L.token, scoutId: '81420' });
  assert.equal(pend.count, 1, '兩種寫法要對得上：' + JSON.stringify(pend));
  const conf = env.call({ action: 'bookConfirm', token: L.token, scoutId: '81420' });
  assert.equal(conf.approved, 1, JSON.stringify(conf));
  // 取回：用補零 token 亦要見到
  const pull = env.call({ action: 'bookPull', token: m1.token });
  assert.equal(pull.progress['L1-ACT-01'], '2026-03-01', JSON.stringify(pull));
  // 進度表只會有一行（唔會一人兩份）
  const rows = env.ss.sheets.get('進度追蹤').rows.filter(r => String(r[1]) === 'L1-ACT-01');
  assert.equal(rows.length, 1, '唔可以一人兩份：' + JSON.stringify(rows));
});
