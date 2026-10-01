import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac } from 'node:crypto';
import { getRegistry, getTrustedTroop, listPublicTroops, isTrustedExecUrl } from '../api/_registry.js';
import { accountId, checkSuperPassword, sealSuper, openSuper } from '../api/_super.js';
import proxy from '../api/proxy.js';
import verify from '../api/super.js';
const backend = 'https://script.google.com/macros/s/TEST_DEPLOYMENT_0082/exec';
process.env.TROOP_0082_NAME = '第 82 旅 <測試>';
process.env.TROOP_0082_BACKEND = backend;
process.env.TROOP_0082_APIKEY = 'secret-api-key';
process.env.SUPER_KEY = 'test-only-random-secret-123456789';
function response() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
}
async function call(handler, body, method = 'POST') {
  const res = response(); await handler({ method, body }, res); return res;
}
const request = (action, data, troopId = '0082') => ({ troopId, action, data });

test('Registry only lists complete trusted env entries; preserves IDs and never exposes secrets', () => {
  process.env.TROOP_82_NAME = 'Incomplete';
  process.env.TROOP_BAD_NAME = 'Invalid'; process.env.TROOP_BAD_BACKEND = 'https://evil.example/'; process.env.TROOP_BAD_APIKEY = 'bad';
  assert.equal(getRegistry()['0082'].name, '第 82 旅 <測試>');
  assert.equal(getTrustedTroop('82'), null);
  assert.equal(getTrustedTroop('BAD'), null);
  assert.equal(getTrustedTroop('toString'), null);
  const list = listPublicTroops();
  assert.equal(list['0082'].name, '第 82 旅 <測試>');
  assert(!list.BAD && !list['82']);
  assert(!JSON.stringify(list).includes('secret-api-key'));
  assert(!JSON.stringify(list).includes('script.google'));
  const saved = process.env.TROOP_0082_NAME; delete process.env.TROOP_0082_NAME;
  assert.equal(getTrustedTroop('0082'), null); // no file/default fallback
  process.env.TROOP_0082_NAME = saved;
});

test('Local URL test override is disabled on Vercel', () => {
  process.env.ROVERBADGE_PROXY_TEST = '1'; process.env.VERCEL = '1';
  assert.equal(isTrustedExecUrl('http://localhost:1234/exec'), false);
  delete process.env.VERCEL; delete process.env.ROVERBADGE_PROXY_TEST;
});

test('Missing configuration fails closed; tickets are encrypted, purpose-bound, expire and rotate', () => {
  const key = process.env.SUPER_KEY;
  assert(checkSuperPassword(key, accountId)); assert(!checkSuperPassword('wrong', accountId));
  const ticket = sealSuper('login', { troopId: '0082' }, 60);
  assert.equal(openSuper('login', ticket).troopId, '0082');
  assert.equal(openSuper('session', ticket), null);
  assert.equal(openSuper('login', ticket.slice(0, -8) + 'abcdefgh'), null);
  assert.equal(openSuper('login', sealSuper('login', {}, -1)), null);
  process.env.SUPER_KEY = 'another-long-random-secret'; assert.equal(openSuper('login', ticket), null);
  delete process.env.SUPER_KEY; assert(!checkSuperPassword('', accountId)); assert.equal(openSuper('login', ticket), null);
  process.env.SUPER_KEY = key;
});

test('Proxy rejects missing or sub-four-character key before fetch; four-character and ordinary login work', async () => {
  const savedKey = process.env.SUPER_KEY;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = []; let calls = 0;
  console.log = line => logs.push(JSON.parse(line));
  globalThis.fetch = async () => {
    calls++;
    return { status: 200, text: async () => JSON.stringify({ success: true, token: 'rbs-super-v1-short-key-test', user: { role: 'super_admin' } }) };
  };
  try {
    for (const key of [undefined, '', 'x'.repeat(3)]) {
      if (key === undefined) delete process.env.SUPER_KEY;
      else process.env.SUPER_KEY = key;
      const result = await call(proxy, request('login', { login_id: accountId, password: 'private-input-password' }));
      assert.equal(result.code, 503);
      assert.deepEqual(result.body, { success: false, error: '登入服務暫時無法使用，請聯絡管理員' });
      assert.equal(result.headers['Cache-Control'], 'no-store');
    }
    assert.equal(calls, 0);
    assert.equal(logs.length, 3);
    for (const log of logs) {
      assert.equal(log.result, 'super_auth_misconfig');
      assert.deepEqual(Object.keys(log).sort(), ['ms', 'result', 'svc', 'troopId']);
    }
    assert(!JSON.stringify(logs).includes('private-input-password'));
    assert.equal((await call(proxy, request('login', { login_id: 'member', password: 'ordinary-password' }))).code, 200);
    assert.equal(calls, 1);
    process.env.SUPER_KEY = 'x'.repeat(4);
    assert(checkSuperPassword(process.env.SUPER_KEY, accountId));
    assert.equal((await call(proxy, request('login', { login_id: accountId, password: 'wrong' }))).code, 401);
    assert.equal(calls, 1);
    const login = await call(proxy, request('login', { login_id: accountId, password: process.env.SUPER_KEY }));
    assert.equal(login.code, 200);
    assert.equal(login.body.success, true);
    assert.equal(calls, 2);
    assert.equal(openSuper('session', login.body.token).token, 'rbs-super-v1-short-key-test');
  } finally {
    if (savedKey === undefined) delete process.env.SUPER_KEY;
    else process.env.SUPER_KEY = savedKey;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('Verification endpoint binds ticket to registered backend and API key; returns no secrets', async () => {
  const ticket = sealSuper('login', { troopId: '0082', backend, apikey: 'secret-api-key' }, 60);
  const good = await call(verify, { ticket, backend, apikey: 'secret-api-key' });
  assert.deepEqual(good.body, { ok: true }); assert.equal(good.headers['Cache-Control'], 'no-store');
  for (const body of [{ ticket, backend, apikey: 'wrong' }, { ticket, backend: backend + 'x', apikey: 'secret-api-key' }, { ticket: 'forged' }, {}]) assert.equal((await call(verify, body)).body.ok, false);
  assert.equal((await call(verify, {}, 'GET')).code, 405);
});

test('Proxy blocks incorrect password before fetch; never forwards password; wraps session and isolates troops', async () => {
  const originalFetch = globalThis.fetch; let calls = 0; let sent;
  globalThis.fetch = async (url, init) => {
    calls++; sent = JSON.parse(init.body);
    assert(!init.body.includes(process.env.SUPER_KEY));
    return { status: 200, text: async () => JSON.stringify({ success: true, token: 'rbs-super-v1-test-token', user: { role: 'super_admin' } }) };
  };
  try {
    for (const login_id of [accountId, ` ${accountId.toUpperCase()} `, `${accountId.toUpperCase()}@roverbadge.local`]) {
      assert.equal((await call(proxy, request('login', { login_id, password: 'wrong', super_ticket: 'forged' }))).code, 401);
    }
    assert.equal(calls, 0);
    const login = await call(proxy, request('login', { login_id: accountId, password: process.env.SUPER_KEY, action: 'deleteUser' }));
    assert.equal(login.body.success, true); assert.equal(sent.action, 'login'); assert(!('password' in sent));
    const ticket = openSuper('login', sent.super_ticket); assert.equal(ticket.troopId, '0082');
    const token = login.body.token;
    assert.equal(openSuper('session', token).token, 'rbs-super-v1-test-token');
    await call(proxy, request('getAllUsers', { token })); assert.equal(sent.token, 'rbs-super-v1-test-token');
    const count = calls;
    assert.equal((await call(proxy, request('changePassword', { token, old_password: process.env.SUPER_KEY }))).code, 403);
    process.env.TROOP_1001_NAME = 'B'; process.env.TROOP_1001_APIKEY = 'B-key'; process.env.TROOP_1001_BACKEND = backend.replace('0082', '1001');
    assert.equal((await call(proxy, request('getAllUsers', { token }, '1001'))).code, 401);
    assert.equal(calls, count);
    await call(proxy, request('login', { login_id: 'member', password: 'normal', action: 'deleteUser', super_ticket: 'forged' }));
    assert.equal(sent.action, 'login'); assert.equal(sent.password, 'normal'); assert(!sent.super_ticket);
  } finally { globalThis.fetch = originalFetch; }
});

function gasContext() {
  const used = new Map(); let verified = false; let fetches = 0;
  const context = vm.createContext({
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
      computeHmacSha256Signature: (value, key) => Array.from(createHmac('sha256', String(key)).update(String(value), 'utf8').digest())
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => used.get(k), put: (k, v) => used.set(k, v) }) },
    ScriptApp: { getService: () => ({ getUrl: () => backend }) },
    UrlFetchApp: { fetch(url, opts) {
      fetches++; assert.equal(url, 'https://roverbadge.vercel.app/api/super');
      const body = JSON.parse(opts.payload); assert.equal(body.backend, backend); assert.equal(body.apikey, 'secret-api-key');
      return { getResponseCode: () => verified ? 200 : 401, getContentText: () => JSON.stringify({ ok: verified }) };
    } }
  });
  vm.runInContext(fs.readFileSync('apps-script/Code.gs', 'utf8'), context);
  context.jsonResponse = obj => obj;
  context.getApiKey = () => 'secret-api-key';
  context.hashPassword = value => createHash('sha256').update(String(value)).digest('hex');
  context.createToken = () => 'rbs-super-v1-test-token';
  return { context, accept: () => { verified = true; }, fetches: () => fetches };
}

test('Actual Code.gs credential validation rejects direct password, verifies ticket and blocks replay', () => {
  const gas = gasContext(); const g = gas.context;
  assert.equal(g.handleLogin(accountId, 'old-password').success, false); assert.equal(gas.fetches(), 0);
  assert.equal(g.handleLogin(accountId, null, 'bad-ticket').success, false);
  gas.accept();
  const login = g.handleLogin(`${accountId.toUpperCase()}@roverbadge.local`, null, 'valid-ticket');
  assert.equal(login.success, true); assert.equal(login.user.role, 'super_admin');
  assert.equal(g.handleLogin(accountId, null, 'valid-ticket').success, false);
  assert.equal(g.handleChangePassword(accountId, 'old', 'new-password').success, false);
});

test('Actual Code.gs invalidates legacy sessions without deleting or migrating Sheet rows', () => {
  const { context: g } = gasContext();
  g.getSheet = () => ({ getSheetByName: () => ({ getDataRange: () => ({ getValues: () => [
    ['token', 'ymis', 'created', 'expiry'], ['old-token', accountId, '', '2099-01-01'], ['member-token', '1234567890', '', '2099-01-01'], ['rbs-super-v1-new', accountId, '', '2099-01-01']
  ] }) }) });
  assert.equal(g.validateToken('old-token'), null);
  assert.equal(g.validateToken('member-token'), '1234567890');
  // 無狀態 super session：Sheet 行唔會令一條「值唔啱」嘅 rbs-super-v1- token 生效（偽造／舊殘留一律無效）
  assert.equal(g.validateToken('rbs-super-v1-new'), null);
  // 真正嘅無狀態 token 唔使任何 Sheet 行都驗到（登入零 Sheet 紀錄）
  assert.equal(g.validateToken(g.superAdminSessionToken()), accountId);
});

test('Feedback relay confirms delivery only after inbox receipt and distinguishes rejected from unknown', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = []; let upstream = { status: 200, body: { status: 'success' } }; let sent = null;
  console.log = line => logs.push(JSON.parse(line));
  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
    sent = JSON.parse(init.body);
    return { status: upstream.status, text: async () => typeof upstream.body === 'string' ? upstream.body : JSON.stringify(upstream.body) };
  };
  try {
    const ok = await call(proxy, request('submitFeedback', {
      type: 'issue', title: 'Page freezes', desc: 'The progress page freezes after saving.', contact: '',
      troopId: '0082', name: '=malicious'
    }, ''));
    assert.equal(ok.code, 200);
    assert.equal(ok.body.deliveryStatus, 'confirmed');
    assert.equal(sent.sourceApp, 'roverbadge');
    assert.equal(sent.troopId, '0082');
    assert.equal(sent.name, "'=malicious");
    assert.equal(sent.contact, '', 'anonymous feedback remains supported');
    assert.equal(sent.type, 'issue');

    upstream = { status: 200, body: { status: 'rejected' } };
    const rejected = await call(proxy, request('submitFeedback', {
      type: 'feedback', content: 'Please improve the page.', fbType: '建議', contact: 'leader@example.org'
    }, ''));
    assert.equal(rejected.code, 502);
    assert.equal(rejected.body.deliveryStatus, 'rejected');

    upstream = { status: 200, body: 'not-json' };
    const uncertainResponse = await call(proxy, request('submitFeedback', {
      type: 'issue', title: 'Network issue', desc: 'Cannot load my progress', contact: '12345678'
    }, ''));
    assert.equal(uncertainResponse.body.deliveryStatus, 'unknown');

    globalThis.fetch = async () => { throw new Error('connection reset after request'); };
    const uncertainNetwork = await call(proxy, request('submitFeedback', {
      type: 'issue', title: 'Network issue', desc: 'Cannot load my progress', contact: '12345678'
    }, ''));
    assert.equal(uncertainNetwork.body.deliveryStatus, 'unknown');

    const invalid = await call(proxy, request('submitFeedback', { type: 'other', contact: '' }, ''));
    assert.equal(invalid.body.deliveryStatus, 'not_sent');
    assert.ok(logs.some(row => row.result === 'feedback_received'));
    assert(!JSON.stringify(logs).includes('Page freezes'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('Super admin bypasses Sheet ALLOW_LOCAL_LOGIN=false gate on both login and subsequent actions via sig fallback', async () => {
  const originalFetch = globalThis.fetch;
  const gas = gasContext();
  const g = gas.context;
  const closedError = action => ({
    success: false,
    local_login: false,
    upstream_only: true,
    error: `此後端的直接入口已閂（ALLOW_LOCAL_LOGIN=false），只接受上游簽名（sig）請求；請由上游（旅／支部系統）入口登入。（已拒絕：${action}）`
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams.entries());
    const rawBody = init.method === 'POST' ? String(init.body || '{}') : '';
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    requests.push({ method: init.method, params, parsed, rawBody });

    // Simulate a Sheet whose direct entry gate is closed (ALLOW_LOCAL_LOGIN=false)
    // and only accepts valid sig-signed POST requests via Code.gs verifyLinkSig
    if (init.method === 'POST' && g.verifyLinkSig({ parameter: params }, parsed, rawBody)) {
      if (parsed.action === 'load') {
        return { status: 200, text: async () => JSON.stringify({ success: true, members: [{ ymis: '1234567890', name: '陳大文' }], progress: {} }) };
      }
      if (parsed.action === 'getAllUsers') {
        return { status: 200, text: async () => JSON.stringify({ success: true, users: [{ ymis: '1234567890', name: '陳大文', role: 'member' }] }) };
      }
      if (parsed.action === 'save') {
        return { status: 200, text: async () => JSON.stringify({ success: true, confirmer: parsed.confirmer, on_behalf: parsed.on_behalf }) };
      }
      if (parsed.action === 'getLinkState') {
        return { status: 200, text: async () => JSON.stringify({ success: true, allow_local_login: false }) };
      }
      if (parsed.action === 'setLocalLogin') {
        const allow = ['1', 'true', 'yes', 'on', 'open'].includes(String(parsed.allow || '').trim().toLowerCase());
        return { status: 200, text: async () => JSON.stringify({ success: true, allow_local_login: allow }) };
      }
    }
    const act = params.action || parsed.action || 'unknown';
    return { status: 200, text: async () => JSON.stringify(closedError(act)) };
  };
  try {
    // 1. Super admin login succeeds even though Sheet rejected login with ALLOW_LOCAL_LOGIN=false
    const login = await call(proxy, request('login', { login_id: accountId, password: process.env.SUPER_KEY }));
    assert.equal(login.code, 200);
    assert.equal(login.body.success, true);
    assert.equal(login.body.user.role, 'super_admin');
    assert.match(String(login.body.token || ''), /^rbs1\./);
    const sessionToken = login.body.token;

    // 2. Subsequent load (normally GET) automatically falls back to sig-signed POST and succeeds
    const loadRes = await call(proxy, request('load', { token: sessionToken }));
    assert.equal(loadRes.code, 200);
    assert.equal(loadRes.body.success, true);
    assert.equal(loadRes.body.members.length, 1);

    // 3. Subsequent getAllUsers, save, getAllowLocalLogin, setAllowLocalLogin also succeed via sig-signed POST
    const usersRes = await call(proxy, request('getAllUsers', { token: sessionToken }));
    assert.equal(usersRes.code, 200);
    assert.equal(usersRes.body.success, true);

    const saveRes = await call(proxy, request('save', { token: sessionToken, changes: [{ ymis: '1234567890', itemId: 'L1', date: '2026-10-01' }], confirmer: '系統管理員' }));
    assert.equal(saveRes.code, 200);
    assert.equal(saveRes.body.success, true);
    assert.equal(saveRes.body.confirmer, 'system');
    assert.equal(saveRes.body.on_behalf, 'system');

    const gateStatus = await call(proxy, request('getAllowLocalLogin', { token: sessionToken }));
    assert.equal(gateStatus.code, 200);
    assert.equal(gateStatus.body.success, true);
    assert.equal(gateStatus.body.allow_local_login, false);

    const gateReopen = await call(proxy, request('setAllowLocalLogin', { token: sessionToken, allow: true }));
    assert.equal(gateReopen.code, 200);
    assert.equal(gateReopen.body.success, true);
    assert.equal(gateReopen.body.allow_local_login, true);

    // 4. Ordinary member login is still rejected when ALLOW_LOCAL_LOGIN=false
    const memberLogin = await call(proxy, request('login', { login_id: '1234567890', password: 'changeme' }));
    assert.equal(memberLogin.code, 200);
    assert.equal(memberLogin.body.success, false);
    assert.equal(memberLogin.body.upstream_only, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Frontend guards prevent empty/invalid troopId from triggering staleBanner 旅團編號格式不正確', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /function doLogout\(\)\{\s*clearStaleBanner\(\);/, 'doLogout must clear staleBanner');
  assert.match(html, /function backToHome\(\)\{\s*clearStaleBanner\(\);/, 'backToHome must clear staleBanner');
  assert.match(html, /async function loadItemsAndProgress\(\)\{\s*const tid=String\(currentTroopId\|\|''\)\.trim\(\);\s*if\(!tid \|\| tid==='DEMO' \|\| !\/\^\[0-9A-Za-z_-\]\{1,32\}\$\/\.test\(tid\) \|\| !currentUser\)\{\s*clearStaleBanner\(\);\s*return;\s*\}/, 'loadItemsAndProgress must guard troopId and clear staleBanner');
});
