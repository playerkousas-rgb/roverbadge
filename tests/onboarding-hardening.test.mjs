// 接入四項硬化（GS 5.3.0；對齊 ScoutBadge GS 6.3.0 PR #50）：
//   【1】單一更新入口：選單「🔧 初始化／更新（執行 initializeSheets）」＝唯一面向用戶嘅更新步驟
//   【2】/exec 網址正規化：登記字串同 GAS 回報字串形式唔同時都要驗票成功（fail-closed 不變）
//   【3】未初始化時唔可以扮完成：顯示 API Key 前必須警告「暫時未可用」＋指向選單掣
//   【4】新旅團申請初始化閘：後端未初始化 → 422 且唔送管理員收件匣；探測唔到＝未知照樣轉交
// 執行：node --test tests/onboarding-hardening.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCodeGs } from './gas-harness.mjs';
import { canonicalBackendUrl, backendForms, backendMatches, isTrustedExecUrl } from '../api/_registry.js';
import { sealSuper } from '../api/_super.js';
import proxy from '../api/proxy.js';
import verify from '../api/super.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeSrc = read('apps-script/Code.gs');
const indexHtml = read('index.html');
const proxySrc = read('api/proxy.js');

const REGISTERED = 'https://script.google.com/macros/s/ONBOARDHARDEN0001/exec';
const WORKSPACE_FORM = 'https://script.google.com/a/macros/example.org/s/ONBOARDHARDEN0001/exec';
const LEGACY_FORM = 'https://script.google.com/a/example.org/macros/s/ONBOARDHARDEN0001/exec';
const MENU_LABEL = '🔧 初始化／更新（執行 initializeSheets）';

// ================== 【1】單一更新入口 ==================
test('選單有「🔧 初始化／更新（執行 initializeSheets）」，handler 只呼叫 initializeSheets()', () => {
  const env = loadCodeGs();
  env.api.onOpen();
  const item = env.menuItems.find((i) => i.handler === 'menuInitializeSheets');
  assert.ok(item, '選單缺少初始化／更新項目');
  assert.equal(item.label, MENU_LABEL);
  assert.equal(env.menuItems.filter((i) => i.handler === 'menuInitializeSheets').length, 1, '只准有一個更新入口');

  const src = codeSrc.slice(codeSrc.indexOf('function menuInitializeSheets()'), codeSrc.indexOf('function menuExportUsersJson()'));
  assert.match(src, /initializeSheets\(\)/, 'handler 必須呼叫 initializeSheets()');
  // 唔可以喺更新入口偷偷做其他維護動作（刪列／清 Token／改設定）
  assert.doesNotMatch(src, /removeSuperAdminRows|removeSuperAdminTokenRows|deleteRow|deleteProperty|\.setValue\(|resetPassword/);
});

test('選單掣跑完寫入初始化標記，完成彈窗講明「唯一更新步驟／只補缺失／不刪改／不換 API Key」', () => {
  const env = loadCodeGs();
  env.scriptProps.set('API_KEY', 'rover_onboarding_gate_existing_key');
  assert.equal(env.scriptProps.get('INITIALIZED_GS_VERSION'), undefined);
  const msg = env.api.menuInitializeSheets();
  assert.match(msg, /已完成初始化／更新/);
  assert.match(msg, /呢個掣就係唯一嘅更新步驟/);
  assert.match(msg, /重跑只會補建缺少的工作表、表頭欄與預設管理員/);
  assert.match(msg, /不會刪除或改寫任何既有帳號、進度、徽章、活動履歷、系統設定/);
  assert.match(msg, /不會更換 API Key/);
  assert.equal(env.scriptProps.get('INITIALIZED_GS_VERSION'), env.api.gsVersionInfo_().gsVersion);
  assert.equal(env.api.getApiKey(), 'rover_onboarding_gate_existing_key', '初始化不可更換 API Key');
});

test('選單掣可以安心重跑：資料與 API Key 一個 byte 都不變；失敗時不寫入標記', () => {
  const env = loadCodeGs();
  env.api.menuInitializeSheets();
  env.ss.getSheetByName('Users').appendRow(['1234567890', '張小明', 'a@x.hk', 'member', 'x', 'b4', false, 'admin', '', '', '', 'active', '', false]);
  env.ss.getSheetByName('進度追蹤').appendRow(['1234567890', 'KEEP-ID-01', '2026-03-01', '2026-03-01', '李大文', '']);
  const beforeSheets = JSON.stringify(Object.fromEntries([...env.ss.sheets].map(([n, sh]) => [n, sh.rows])));
  const beforeProps = JSON.stringify(Object.fromEntries(env.scriptProps));
  env.api.menuInitializeSheets();
  env.api.menuInitializeSheets();
  assert.equal(JSON.stringify(Object.fromEntries([...env.ss.sheets].map(([n, sh]) => [n, sh.rows]))), beforeSheets);
  assert.equal(JSON.stringify(Object.fromEntries(env.scriptProps)), beforeProps);

  const failing = loadCodeGs();
  const origInsert = failing.ss.insertSheet;
  failing.ss.insertSheet = (name) => { if (name === '活動履歷') throw new Error('模擬失敗'); return origInsert(name); };
  const msg = failing.api.menuInitializeSheets();
  assert.match(msg, /未完成/, msg);
  assert.equal(failing.scriptProps.get('INITIALIZED_GS_VERSION'), undefined, '失敗時不可寫入標記');
});

test('面向用戶嘅文案只提「🔧 初始化／更新」呢個選單掣，唔叫用戶去搵其他函式', () => {
  // repo 完全冇 repairSheets／diagnoseSheets 呢類「要用戶自己搵」嘅維護函式
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.vercel' || e.name === 'output') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|html|gs|js|mjs|tsv)$/.test(e.name)) files.push(p);
    }
  })(ROOT);
  assert.ok(files.length > 20);
  // CHANGE_LOG.md 係歷史紀錄（本次正正記錄咗「本 repo 冇呢兩個函式」）；本測試檔自身含比對用字面 —— 兩者都唔屬面向用戶嘅指引
  const scanned = files.filter((f) => !/(^|\/)(CHANGE_LOG\.md|onboarding-hardening\.test\.mjs)$/.test(f));
  assert.ok(scanned.length > 20);
  for (const f of scanned) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /repairSheets|diagnoseSheets/, path.relative(ROOT, f) + ' 不可要求用戶去搵其他維護函式');
  }
  assert.doesNotMatch(codeSrc, /function (repairSheets|diagnoseSheets)/, 'Code.gs 唔應該有用戶要自己搵嘅維護函式');
  // 首頁公告嘅更新步驟指向選單掣，唔再叫用戶去 Apps Script 函式選單揀函式
  assert.match(indexHtml, /🔗 旅系統 → 🔧 初始化／更新/);
  assert.doesNotMatch(indexHtml, /在 Apps Script 函式選單選 initializeSheets/);
  for (const doc of ['README.md', 'docs/LEADER_GUIDE.md', 'docs/DEPLOY_GUIDE_V5_DUALTRACK.md', 'docs/TROOP_UPGRADE_2026.md']) {
    assert.match(read(doc), /🔧 初始化／更新/, doc + ' 要提呢個選單掣');
  }
});

// ================== 【2】/exec 網址正規化 ==================
test('canonicalBackendUrl：兩種 /a/ 寫法都正規化到標準形式；其他 host／解唔到原樣回傳', () => {
  assert.equal(canonicalBackendUrl(REGISTERED), REGISTERED);
  assert.equal(canonicalBackendUrl(WORKSPACE_FORM), REGISTERED);
  assert.equal(canonicalBackendUrl(LEGACY_FORM), REGISTERED);
  assert.equal(canonicalBackendUrl(REGISTERED + '/'), REGISTERED + '/'); // 只改形式，尾斜線由比對端處理
  // 唔係 script.google.com 一律原樣回傳（唔可以「幫手」改寫第三方網址）
  for (const other of ['https://evil.example/a/macros/x/s/ID/exec', 'https://script.google.com.evil.example/a/macros/x/s/ID/exec', 'http://script.google.com/a/macros/x/s/ID/exec']) {
    assert.equal(canonicalBackendUrl(other), other);
  }
  assert.equal(canonicalBackendUrl('not a url'), 'not a url');
  assert.equal(canonicalBackendUrl(''), '');
  assert.equal(canonicalBackendUrl(undefined), '');
  // 正規化唔會改部署 ID
  assert.equal(canonicalBackendUrl('https://script.google.com/a/macros/example.org/s/OTHERDEPLOY0002/exec'), 'https://script.google.com/macros/s/OTHERDEPLOY0002/exec');
});

test('backendMatches：接受登記字串或正規化字串；改一個 byte／換部署／空字串一律拒絕', () => {
  for (const form of [REGISTERED, WORKSPACE_FORM, LEGACY_FORM, REGISTERED + '/']) {
    assert.equal(backendMatches(REGISTERED, form), true, '應接受等價形式：' + form);
  }
  assert.deepEqual(backendForms(REGISTERED), [REGISTERED]);
  assert.equal(backendMatches(REGISTERED, REGISTERED + 'x'), false);
  assert.equal(backendMatches(REGISTERED, 'https://script.google.com/macros/s/OTHERDEPLOY0002/exec'), false);
  assert.equal(backendMatches(REGISTERED, ''), false);
  assert.equal(backendMatches(REGISTERED, undefined), false);
  assert.equal(backendMatches('', REGISTERED), false);
});

function resMock() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
}
async function callVerify(body) {
  const res = resMock();
  await verify({ method: 'POST', body }, res);
  return res;
}

test('/api/super：GAS 回報 Workspace／舊寫法都驗票成功；探測回應唔洩漏網址或 KEY', async () => {
  process.env.TROOP_9101_NAME = '第 9101 旅';
  process.env.TROOP_9101_BACKEND = REGISTERED;
  process.env.TROOP_9101_APIKEY = 'onboarding-harden-key';
  process.env.SUPER_KEY = process.env.SUPER_KEY || 'onboarding-hardening-secret';
  const ticket = sealSuper('login', { troopId: '9101', backend: REGISTERED, apikey: 'onboarding-harden-key' }, 60);
  for (const form of [REGISTERED, WORKSPACE_FORM, LEGACY_FORM, REGISTERED + '/']) {
    const r = await callVerify({ ticket, apikey: 'onboarding-harden-key', backend: form });
    assert.equal(r.code, 200, '應接受：' + form + ' → ' + JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.deepEqual(Object.keys(r.body), ['ok'], '探測回應只准回 booleans');
  }
  // backendCanonical 欄位（GS 5.3.0 一併送出）都可以用嚟比對
  const viaCanonical = await callVerify({ ticket, apikey: 'onboarding-harden-key', backend: 'https://script.google.com/macros/s/WRONG/exec', backendCanonical: WORKSPACE_FORM });
  assert.equal(viaCanonical.body.ok, true);
});

test('/api/super fail-closed 不變：換 KEY／改一個 byte／換部署／票據綁錯字串一律拒絕', async () => {
  process.env.TROOP_9101_NAME = '第 9101 旅';
  process.env.TROOP_9101_BACKEND = REGISTERED;
  process.env.TROOP_9101_APIKEY = 'onboarding-harden-key';
  process.env.SUPER_KEY = process.env.SUPER_KEY || 'onboarding-hardening-secret';
  const ticket = sealSuper('login', { troopId: '9101', backend: REGISTERED, apikey: 'onboarding-harden-key' }, 60);
  const bad = [
    { ticket, apikey: 'wrong-key', backend: WORKSPACE_FORM },
    { ticket, apikey: 'onboarding-harden-key', backend: WORKSPACE_FORM + 'x' },
    { ticket, apikey: 'onboarding-harden-key', backend: 'https://script.google.com/macros/s/OTHERDEPLOY0002/exec' },
    { ticket, apikey: 'onboarding-harden-key' },
    // 票據仍然綁死「登記字串」：用 Workspace 寫法簽嘅票唔可以當登記字串用
    { ticket: sealSuper('login', { troopId: '9101', backend: WORKSPACE_FORM, apikey: 'onboarding-harden-key' }, 60), apikey: 'onboarding-harden-key', backend: WORKSPACE_FORM },
    { ticket: 'rbs1.forged', apikey: 'onboarding-harden-key', backend: WORKSPACE_FORM }
  ];
  for (const body of bad) {
    const r = await callVerify(body);
    assert.equal(r.body.ok, false, '必須拒絕：' + JSON.stringify(body).slice(0, 120));
    assert.notEqual(r.code, 200);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('script.google.com'), '回應不可洩漏後端網址');
    assert.ok(!text.includes('onboarding-harden-key'), '回應不可洩漏 API Key');
  }
});

test('Code.gs：verifySuperTicket 同時送登記字串與正規化字串，canonicalServiceUrl_ 三種寫法一致', () => {
  const probe = loadCodeGs();
  const canonical = (u) => probe.api.canonicalServiceUrl_(u);
  assert.equal(canonical('https://script.google.com/macros/s/ABC123/exec'), 'https://script.google.com/macros/s/ABC123/exec');
  assert.equal(canonical('https://script.google.com/a/macros/example.org/s/ABC123/exec'), 'https://script.google.com/macros/s/ABC123/exec');
  assert.equal(canonical('https://script.google.com/a/example.org/macros/s/ABC123/exec'), 'https://script.google.com/macros/s/ABC123/exec');
  assert.equal(canonical('https://other.example/a/macros/x/s/ABC123/exec'), 'https://other.example/a/macros/x/s/ABC123/exec');
  assert.equal(canonical(''), '');

  // 真跑 verifySuperTicket：觀察回打 /api/super 嘅 payload
  const VERIFY_URL = 'https://roverbadge.vercel.app/api/super';
  const seen = [];
  const env = loadCodeGs({
    serviceUrls: [WORKSPACE_FORM],
    urlFetchHandler: (url, opts) => {
      const body = JSON.parse(String((opts && opts.payload) || '{}'));
      seen.push(body);
      return { code: 200, content: JSON.stringify({ ok: true }) };
    }
  });
  assert.equal(env.api.verifySuperTicket('ticket-' + Math.random().toString(36).slice(2)), true);
  assert.equal(env.urlFetchLog.length, 1);
  assert.equal(env.urlFetchLog[0].url, VERIFY_URL);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].backend, WORKSPACE_FORM, '登記綁定仍然用原回報字串');
  assert.equal(seen[0].backendCanonical, REGISTERED, '正規化形式要係標準 /macros/s/<id>/exec');
  // 票據綁定仍然由 proxy 以「登記字串」簽發（唔可以放寬成請求自帶值）
  assert.match(proxySrc, /sealSuper\('login', \{ troopId, backend: troop\.backend, apikey: troop\.apikey \}, 60\)/);
});

// ================== 【3】未初始化時唔可以扮完成 ==================
test('未初始化：顯示 API Key 前警告「暫時未可用」並指向選單掣；初始化後警告消失、Key 不變', () => {
  const env = loadCodeGs();
  env.scriptProps.set('API_KEY', 'rover_init_warning_key');
  assert.ok(env.api.initStatusWarningLines_().length > 0, '未初始化時必須有警告');
  assert.match(env.api.initStatusWarningLines_().join('\n'), /initializeSheets/);

  const cred = env.api.menuShowLinkCredentials();
  assert.match(cred, /尚未完成初始化／更新（此 API Key 暫時未可用）/);
  assert.match(cred, /🔧 初始化／更新/);
  assert.match(cred, /不會刪改任何既有資料/);
  assert.match(cred, /API Key = rover_init_warning_key/, '警告唔可以遮住 API Key');
  assert.ok(cred.indexOf('尚未完成初始化') < cred.indexOf('API Key ='), '警告要喺 Key 之前');

  env.api.showApiKey();
  const alert = env.ui.alerts.map((a) => a.title + '\n' + a.msg).join('\n');
  assert.match(alert, /尚未完成初始化／更新/);
  assert.match(alert, /rover_init_warning_key/);

  // ecStatus 同時反映「未初始化」
  const status = env.get({ action: 'ecStatus' });
  assert.equal(status.initRequired, true);
  assert.equal(status.initializedGsVersion, '');

  // 跑一次「🔧 初始化／更新」之後：警告消失，Key 完全不變
  env.api.menuInitializeSheets();
  assert.equal(env.api.initStatusWarningLines_().length, 0, '初始化後唔應該再有警告');
  assert.equal(env.api.getApiKey(), 'rover_init_warning_key');
  const after = env.api.menuShowLinkCredentials();
  assert.doesNotMatch(after, /尚未完成初始化／更新/);
  assert.match(after, /API Key = rover_init_warning_key/);
  assert.equal(env.get({ action: 'ecStatus' }).initializedGsVersion, env.api.gsVersionInfo_().gsVersion);
});

// ================== 【4】新旅團申請時的初始化閘 ==================
const ADMIN_INBOX = 'https://script.google.com/macros/s/ONBOARDINBOX0001/exec';
const NEW_BACKEND = 'https://script.google.com/macros/s/ONBOARDNEW0009/exec';

function mockRes() {
  return { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: String((init && init.method) || 'get'), body: init && init.body ? String(init.body) : null });
    return handler(calls.length, String(url), init);
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}
const jsonResponse = (obj, status = 200) => ({ status, text: async () => JSON.stringify(obj) });
const registrationData = (extra = {}) => ({ troopId: '9109', troopName: '第 9109 旅', backendUrl: NEW_BACKEND, apiKey: 'new-troop-key', ...extra });

async function submit(data) {
  const res = mockRes();
  await proxy({ method: 'POST', body: { troopId: '', action: 'submitRegistration', data } }, res);
  return res;
}

test('後端未初始化（initRequired 且冇標記）→ 422，申請唔會送到管理員收件匣', async () => {
  process.env.SCOUT_ADMIN_API = ADMIN_INBOX;
  const res = await withFetch((n, url) => {
    if (url.startsWith(NEW_BACKEND)) return jsonResponse({ success: true, gsVersion: '5.3.0', gsReleaseDate: '2026-11-03', initRequired: true, initializedGsVersion: '' });
    return jsonResponse({ status: 'success', message: 'ok' });
  }, () => submit(registrationData()));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.success, false);
  assert.equal(res.body.deliveryStatus, 'not_sent');
  // 可行動嘅訊息：講明按哪個選單掣、只會補建、不會刪改、之後用同一條網址重新提交
  assert.match(res.body.error, /🔗 旅系統 → 🔧 初始化／更新（執行 initializeSheets）/);
  assert.match(res.body.error, /只會補建缺少的工作表及預設管理員/);
  assert.match(res.body.error, /不會刪改任何既有資料/);
  assert.match(res.body.error, /不會更換 API Key/);
  assert.match(res.body.error, /同一條網址重新提交/);
  // 唔可以回顯後端網址／API Key
  assert.ok(!res.body.error.includes(NEW_BACKEND), '錯誤訊息不可回顯後端網址');
  assert.ok(!JSON.stringify(res.body).includes('script.google.com'), '回應不可回顯任何 /exec 網址');
  assert.ok(!JSON.stringify(res.body).includes('new-troop-key'));
});

test('初始化閘：探測只發一次匿名 GET ecStatus（唔帶密鑰），未初始化時管理員收件匣零請求', async () => {
  process.env.SCOUT_ADMIN_API = ADMIN_INBOX;
  assert.equal(isTrustedExecUrl(NEW_BACKEND), true);
  const seen = [];
  const res = await withFetch((n, url, init) => {
    seen.push({ url, method: String((init && init.method) || 'get'), body: init && init.body ? String(init.body) : null });
    if (url.startsWith(NEW_BACKEND)) return jsonResponse({ success: true, gsVersion: '5.3.0', initRequired: true, initializedGsVersion: '' });
    return jsonResponse({ status: 'success' });
  }, () => submit(registrationData()));
  assert.equal(res.statusCode, 422);
  const probes = seen.filter((c) => c.url.startsWith(NEW_BACKEND));
  assert.equal(probes.length, 1, '只探測一次');
  assert.equal(probes[0].method.toUpperCase(), 'GET');
  assert.match(probes[0].url, /action=ecStatus/);
  assert.ok(!probes[0].url.includes('apikey'), '探測唔可以帶 API Key');
  assert.equal(probes[0].body, null);
  assert.equal(seen.some((c) => c.url === ADMIN_INBOX), false, '未初始化時唔可以送管理員收件匣');
});

test('初始化閘：已初始化／舊版後端／探測失敗／非白名單 URL 一律照樣轉交（唔誤殺合法申請）', async () => {
  process.env.SCOUT_ADMIN_API = ADMIN_INBOX;
  const scenarios = [
    ['已初始化', () => jsonResponse({ success: true, gsVersion: '5.3.0', initRequired: true, initializedGsVersion: '5.3.0' })],
    ['舊版後端（冇 ecStatus）', () => jsonResponse({ success: false, error: 'Unknown action' })],
    ['舊版後端（有 ecStatus 但冇兩個欄位）', () => jsonResponse({ success: true, gsVersion: '5.2.0' })],
    ['本版但 initRequired=false', () => jsonResponse({ success: true, gsVersion: '5.3.0', initRequired: false, initializedGsVersion: '' })],
    ['探測逾時／斷線', () => { throw new Error('TimeoutError'); }],
    ['探測回非 JSON', () => ({ status: 200, text: async () => '<html>login</html>' })]
  ];
  for (const [name, handler] of scenarios) {
    const seen = [];
    const res = await withFetch((n, url, init) => {
      seen.push(String(url));
      if (url.startsWith(NEW_BACKEND)) return handler();
      return jsonResponse({ status: 'success', message: 'ok' });
    }, () => submit(registrationData()));
    assert.equal(res.statusCode, 200, name + ' 應該轉交：' + JSON.stringify(res.body));
    assert.equal(res.body.success, true, name);
    assert.ok(seen.includes(ADMIN_INBOX), name + ' 申請必須送到管理員收件匣');
  }
  // 非白名單 URL：根本唔探測（防 SSRF），照樣轉交由管理員人手核對
  const odd = 'https://not-whitelisted.example/exec';
  const seen2 = [];
  const res2 = await withFetch((n, url) => { seen2.push(String(url)); return jsonResponse({ status: 'success' }); }, () => submit(registrationData({ backendUrl: odd })));
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.success, true);
  assert.equal(seen2.some((u) => u.startsWith(odd)), false, '非白名單 URL 唔可以被探測');
  assert.ok(seen2.includes(ADMIN_INBOX));
});
