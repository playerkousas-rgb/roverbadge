// Scout Admin GS「新旅團接入申請」契約測試（與 ScoutBadge / vsbadge / cubsbadge 對齊）
//
// 守住：
//   1) 收件匣 URL 動態 helper：四個環境變數名稱＋trim＋空白視同未設＋內建預設
//   2) payload：type=apply、appType、scriptUrl → backendUrl 映射（永不送 scriptUrl）
//   3) 必填 troopId / backendUrl / apiKey → 缺漏 400 且唔呼叫上游
//   4) note 加 `[roverbadge]` 標記（唔重複）、空白 troopName 補「第 {id} 旅」
//   5) 上游成功判斷：HTTP 2xx 且 status=success 或 success=true；其餘 502
//   6) 公開申請路徑唔需要 SUPER_KEY，亦保證唔會將 SUPER_KEY／superKey 送上去
//   7) submitFeedback 與 submitRegistration 共用同一個 helper
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_API_ENV_NAMES,
  APP_TYPE,
  DEFAULT_ADMIN_API,
  buildRegistrationPayload,
  getAdminApiUrl,
  isAdminSuccess,
  taggedNote
} from '../api/_admin.js';
import proxy from '../api/proxy.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX_A = 'https://script.google.com/macros/s/ADMININBOXTEST0001/exec';
const INBOX_B = 'https://script.google.com/macros/s/ADMININBOXTEST0002/exec';
const BACKEND = 'https://script.google.com/macros/s/TROOPBACKEND0001/exec';

function clearAdminEnv() {
  for (const name of ADMIN_API_ENV_NAMES) delete process.env[name];
}

function mockRes() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

async function call(body) {
  const res = mockRes();
  await proxy({ method: 'POST', body }, res);
  return res;
}

const registration = (data, troopId = '') => call({ troopId, action: 'submitRegistration', data });

async function withFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : null });
    return handler(calls.length, url, init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const jsonUpstream = (status, value) => ({
  status,
  text: async () => (typeof value === 'string' ? value : JSON.stringify(value))
});

// 每個測試自行控制 env；跑完回復原狀，避免污染其他測試
function withEnv(vars, fn) {
  const saved = new Map(ADMIN_API_ENV_NAMES.map(name => [name, process.env[name]]));
  const savedSuper = process.env.SUPER_KEY;
  clearAdminEnv();
  for (const [name, value] of Object.entries(vars || {})) process.env[name] = value;
  return Promise.resolve().then(fn).finally(() => {
    clearAdminEnv();
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    if (savedSuper === undefined) delete process.env.SUPER_KEY;
    else process.env.SUPER_KEY = savedSuper;
  });
}

test('收件匣 URL helper：四個名稱依序、trim、空白視同未設、全部未設用內建預設', () => withEnv({}, () => {
  assert.equal(getAdminApiUrl(), DEFAULT_ADMIN_API);
  // 空白／只有空格 → 當未設定，唔會用空白 URL
  process.env.SCOUT_ADMIN_API = '   ';
  assert.equal(getAdminApiUrl(), DEFAULT_ADMIN_API);
  // 只設最後一個名稱亦可（用家 Vercel 命名為 SCOUTBADGE_ADMIN_API 的情境）
  process.env.SCOUTBADGE_ADMIN_API = `  ${INBOX_B}  `;
  assert.equal(getAdminApiUrl(), INBOX_B);
  // 優先次序：CUBS > SCOUTBADGE、ROVER > CUBS、SCOUT > ROVER
  process.env.CUBSBADGE_ADMIN_API = INBOX_A;
  assert.equal(getAdminApiUrl(), INBOX_A);
  process.env.ROVERBADGE_ADMIN_API = INBOX_B;
  assert.equal(getAdminApiUrl(), INBOX_B);
  process.env.SCOUT_ADMIN_API = INBOX_A;
  assert.equal(getAdminApiUrl(), INBOX_A);
  // 動態讀取：import 之後改 env 一樣即時生效
  process.env.SCOUT_ADMIN_API = INBOX_B;
  assert.equal(getAdminApiUrl(), INBOX_B);
}));

test('申請 payload：type=apply、appType、scriptUrl 映射為 backendUrl、補名稱、加備註標記', () => {
  const built = buildRegistrationPayload({
    troopId: ' 0082 ',
    troopName: '   ',
    scriptUrl: ` ${BACKEND} `,
    apiKey: ' rover_key_123 ',
    note: '  請盡快開通  ',
    // 惡意／多餘欄位一律不可進入上游 payload
    superKey: 'leaked-super-key',
    token: 'leaked-token'
  }, { appType: 'roverbadge' });

  assert.equal(built.ok, true);
  assert.deepEqual(built.missing, []);
  assert.deepEqual(built.payload, {
    type: 'apply',
    appType: 'roverbadge',
    troopId: '0082',
    troopName: '第 0082 旅',
    backendUrl: BACKEND,
    apiKey: 'rover_key_123',
    note: '[roverbadge] 請盡快開通'
  });
  assert.equal('scriptUrl' in built.payload, false, '上游只認 backendUrl，唔准再送 scriptUrl');
  assert.equal('superKey' in built.payload, false);
  assert.equal('token' in built.payload, false);

  // 已帶相同標記（大小寫不拘）唔會重複加
  assert.equal(taggedNote('[roverbadge] 已有備註'), '[roverbadge] 已有備註');
  assert.equal(taggedNote('[ROVERBADGE] 已有備註'), '[ROVERBADGE] 已有備註');
  assert.equal(taggedNote(''), '[roverbadge]');
  assert.equal(taggedNote('   '), '[roverbadge]');
  assert.equal(taggedNote('備註', 'cubsbadge'), '[cubsbadge] 備註');
  // 備註上限 500 字（含標記）
  const longNote = buildRegistrationPayload({ troopId: '0091', scriptUrl: BACKEND, apiKey: 'k', note: 'x'.repeat(900) });
  assert.equal(longNote.payload.note.length, '[roverbadge] '.length + 500);
  assert(longNote.payload.note.startsWith('[roverbadge] '));
  assert.equal(taggedNote('', 'cubsbadge'), '[cubsbadge]');

  // backendUrl 優先於 scriptUrl（姊妹 APP 直接送 backendUrl 亦得）
  const direct = buildRegistrationPayload({ troopId: '0083', backendUrl: BACKEND, scriptUrl: INBOX_A, apiKey: 'k' });
  assert.equal(direct.payload.backendUrl, BACKEND);
  assert.equal(direct.payload.troopName, '第 0083 旅');
  assert.equal(direct.payload.appType, APP_TYPE);

  // 缺漏：只回 missing，唔會自行補 troopId / key
  const missing = buildRegistrationPayload({});
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['troopId', 'backendUrl', 'apiKey']);
  assert.equal(missing.payload.note, '[roverbadge]');
  assert.equal(missing.payload.troopName, '第 ? 旅');
});

test('成功判斷：HTTP 2xx + status=success 或 success=true；其餘一律失敗', () => {
  assert.equal(isAdminSuccess(200, { status: 'success', message: 'ok' }), true);
  assert.equal(isAdminSuccess(201, { status: ' success ' }), true);
  assert.equal(isAdminSuccess(200, { success: true }), true);
  assert.equal(isAdminSuccess(200, { status: 'error', message: 'bad' }), false);
  assert.equal(isAdminSuccess(200, { status: 'success' }), true);
  assert.equal(isAdminSuccess(200, {}), false);
  assert.equal(isAdminSuccess(200, null), false);
  assert.equal(isAdminSuccess(500, { status: 'success' }), false);
  assert.equal(isAdminSuccess(302, { status: 'success' }), false);
  assert.equal(isAdminSuccess(undefined, { status: 'success' }), false);
});

test('Proxy 400：必填缺漏直接拒絕，完全唔呼叫上游', () => withEnv({ SCOUTBADGE_ADMIN_API: INBOX_A }, async () => {
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return jsonUpstream(200, { status: 'success' }); };
  try {
    for (const data of [
      { scriptUrl: BACKEND, apiKey: 'k' },                 // 欠 troopId
      { troopId: '0082', apiKey: 'k' },                    // 欠 URL
      { troopId: '0082', scriptUrl: BACKEND },             // 欠 API Key
      { troopId: '   ', scriptUrl: '  ', apiKey: '   ' }   // 全部空白
    ]) {
      const res = await registration(data);
      assert.equal(res.statusCode, 400, JSON.stringify(data));
      assert.equal(res.body.success, false);
      assert.match(res.body.error, /旅團編號、Apps Script URL 及 API Key/);
      assert.ok(Array.isArray(res.body.missing) && res.body.missing.length > 0);
    }
    assert.equal(fetched, 0, '缺漏時不得呼叫上游');
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test('Proxy 成功：映射 backendUrl、固定 type/appType、唔外洩 SUPER_KEY；上游 status=success 才回 200', () => withEnv({
  SCOUTBADGE_ADMIN_API: `  ${INBOX_A}  `,
  SUPER_KEY: 'server-only-super-secret'
}, async () => {
  await withFetch(() => jsonUpstream(200, { status: 'success', message: 'received' }), async calls => {
    const res = await registration({
      troopId: '0082',
      troopName: '   ',
      scriptUrl: BACKEND,
      apiKey: 'rover_key_123',
      note: '需要開通',
      superKey: 'client-supplied-super-key',
      password: 'should-never-be-forwarded'
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: '申請已提交' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, INBOX_A, 'env 值必須 trim 後使用');
    assert.match(calls[0].url, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
    assert.deepEqual(calls[0].body, {
      type: 'apply',
      appType: 'roverbadge',
      troopId: '0082',
      troopName: '第 0082 旅',
      backendUrl: BACKEND,
      apiKey: 'rover_key_123',
      note: '[roverbadge] 需要開通'
    });
    const raw = JSON.stringify(calls[0].body);
    assert.equal(raw.includes('scriptUrl'), false);
    assert.equal(/superKey|super_key|password|SUPER_KEY/.test(raw), false);
    assert.equal(raw.includes(process.env.SUPER_KEY), false, '伺服器端密鑰永不送上游');
  });

  // 兼容姊妹版本回 { success: true }
  await withFetch(() => jsonUpstream(200, { success: true }), async () => {
    const res = await registration({ troopId: '0082', scriptUrl: BACKEND, apiKey: 'k' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: '申請已提交' });
  });

  // 未設定 SUPER_KEY 一樣申請得（公開路徑唔需要密鑰）
  delete process.env.SUPER_KEY;
  await withFetch(() => jsonUpstream(200, { status: 'success' }), async () => {
    const res = await registration({ troopId: '0082', scriptUrl: BACKEND, apiKey: 'k' });
    assert.equal(res.statusCode, 200);
  });
}));

test('Proxy 502：上游 error／非 2xx／非 JSON／空回應一律唔可以回報成功', () => withEnv({
  SCOUT_ADMIN_API: INBOX_A
}, async () => {
  const cases = [
    { status: 200, value: { status: 'error', message: 'sheet full' } },
    { status: 200, value: {} },
    { status: 200, value: 'not-json' },
    { status: 500, value: { status: 'success' } },
    { status: 404, value: { success: true } },
    { status: 502, value: { status: 'success' } }
  ];
  for (const item of cases) {
    await withFetch(() => jsonUpstream(item.status, item.value), async () => {
      const res = await registration({ troopId: '0082', scriptUrl: BACKEND, apiKey: 'k' });
      assert.equal(res.statusCode, 502, JSON.stringify(item));
      assert.equal(res.body.success, false);
      assert.equal(typeof res.body.error, 'string');
      assert.equal(res.body.message, undefined, '失敗時不得回「申請已提交」');
    });
  }
  // 網絡錯誤／逾時亦係 502（唔會假成功）
  await withFetch(() => { throw new Error('connection reset'); }, async () => {
    const res = await registration({ troopId: '0082', scriptUrl: BACKEND, apiKey: 'k' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
  });
  await withFetch(() => { const err = new Error('aborted'); err.name = 'TimeoutError'; throw err; }, async () => {
    const res = await registration({ troopId: '0082', scriptUrl: BACKEND, apiKey: 'k' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /逾時/);
  });
}));

test('submitFeedback 與 submitRegistration 共用同一個收件匣 helper', () => withEnv({
  CUBSBADGE_ADMIN_API: INBOX_B
}, async () => {
  await withFetch(() => jsonUpstream(200, { status: 'success' }), async calls => {
    // 申請：SCOUT/ROVER 未設，應落到 CUBSBADGE_ADMIN_API
    const reg = await registration({ troopId: '0082', scriptUrl: BACKEND, apiKey: 'k' });
    assert.equal(reg.statusCode, 200);
    assert.equal(calls[0].url, INBOX_B);
    // 回報：同一個 helper
    const fb = await call({
      troopId: '',
      action: 'submitFeedback',
      data: { type: 'issue', title: '打不開', desc: '登入後畫面空白', contact: 'leader@example.org' }
    });
    assert.equal(fb.statusCode, 200);
    assert.equal(fb.body.deliveryStatus, 'confirmed');
    assert.equal(calls[1].url, INBOX_B);
    assert.equal(calls[1].body.sourceApp, 'roverbadge');
    assert.equal(JSON.stringify(calls[1].body).includes(process.env.SUPER_KEY || '__none__'), false);
  });
  // 回報亦唔可以只憑 { status: 'error' } 當成功
  await withFetch(() => jsonUpstream(200, { status: 'error' }), async () => {
    const fb = await call({ troopId: '', action: 'submitFeedback', data: { type: 'issue', title: 't', desc: 'dddd' } });
    assert.equal(fb.statusCode, 502);
    assert.equal(fb.body.deliveryStatus, 'rejected');
  });
}));

test('前端呼叫路徑：格式不變（scriptUrl）、成功與失敗都依伺服器結果顯示', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /apiRequest\('submitRegistration',\{troopId:ti,troopName:tn,scriptUrl:su,apiKey:ak,note:nt\}/);
  assert.match(html, /if\(!d\|\|d\.success!==true\) throw new Error/);
  assert.equal(/SUPER_KEY|superKey|super_key/.test(html), false, '公開申請表單／前端不得出現伺服器密鑰');
  // 本 APP 冇 api/register.js：公開申請唯一入口係 /api/proxy 的 submitRegistration
  assert.equal(fs.existsSync(path.join(ROOT, 'api', 'register.js')), false);
  const proxySource = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');
  assert.match(proxySource, /action === 'submitRegistration'/);
  assert.equal(/register\.js/.test(proxySource), false);
});
