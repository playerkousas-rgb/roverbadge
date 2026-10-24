// Regression coverage for the Rover onboarding credential display and system introduction.
// This runs the real Code.gs in gas-harness; it does not touch an online Sheet or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadCodeGs } from './gas-harness.mjs';

const URLS = [
  'https://script.google.com/macros/s/WRONG_INITIALIZER_NODE/exec',
  'https://script.google.com/a/example.org/macros/s/WRONG_MENU_NODE/exec',
  'https://script.google.com/macros/s/WRONG_CACHED_NODE/exec'
];
const KEY = 'rover_display_test_existing_key';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const gas = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function setup() {
  const env = loadCodeGs({ serviceUrls: URLS });
  env.scriptProps.set('API_KEY', KEY);
  env.scriptProps.set('WEBAPP_URL', URLS[2]);
  env.scriptProps.set('BACKEND_EXEC_URL', URLS[1]);
  return env;
}
function noUrl(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const url of URLS) assert.ok(!text.includes(url), `credential display leaked ${url}`);
  assert.doesNotMatch(text, /https?:\/\//, 'credential display must not contain a URL');
}

test('initializeSheets keeps API Key and first-login notice but never reads/displays/returns a deployment URL', () => {
  const env = setup();
  const result = env.api.initializeSheets();
  assert.equal(result.success, true);
  assert.equal(result.apiKey, KEY);
  assert.equal(Object.hasOwn(result, 'scriptUrl'), false);
  assert.equal(Object.hasOwn(result, 'backend'), false);
  assert.deepEqual(env.ui.prompts, [], 'fresh setup must not ask for troop ID, name, or URL');
  assert.equal(env.scriptProps.has('TROOP_ID'), false, 'initialization must not require or add a troop ID');
  assert.equal(env.scriptServiceCalls.getUrl, 0, 'display flow must not call getService().getUrl()');
  assert.equal(env.ui.alerts.length, 1);
  const alert = `${env.ui.alerts[0].title}\n${env.ui.alerts[0].msg}`;
  assert.match(alert, /初始化完成/);
  assert.match(alert, /Sheets：/);
  assert.match(alert, /API Key = rover_display_test_existing_key/);
  assert.match(alert, /旅團管理員 YMIS/);
  assert.match(alert, /初始密碼/);
  assert.match(alert, /Google「部署」視窗/);
  noUrl(alert);
  noUrl(result);
  assert.equal(env.scriptProps.get('WEBAPP_URL'), URLS[2], 'old URL cache is retained, not used or rewritten');
  assert.equal(env.scriptProps.get('BACKEND_EXEC_URL'), URLS[1]);
});

test('all Sheet credential entry points return only the API Key and add no URL setting menu', () => {
  const env = setup();
  env.api.onOpen();
  const credential = env.menuItems.find(item => item.handler === 'menuShowLinkCredentials');
  assert.ok(credential);
  assert.equal(credential.label, '🔑 顯示 API KEY（交 ADMIN）');
  assert.equal(env.menuItems.some(item => /設定旅團編號|設定 BACKEND|顯示 BACKEND/.test(item.label)), false);
  assert.equal(env.api.showApiKey(), KEY);
  const menuResult = env.api.menuShowLinkCredentials();
  assert.match(menuResult, /API Key = rover_display_test_existing_key/);
  assert.match(menuResult, /Google「部署」視窗/);
  assert.doesNotMatch(menuResult, /TROOP_<|TROOP_.*_APIKEY|未設定旅團編號/);
  for (const value of [env.ui.alerts, menuResult, env.api.showApiKey()]) noUrl(value);
  assert.deepEqual(env.ui.prompts, []);
  assert.equal(env.scriptServiceCalls.getUrl, 0);
});

test('fresh key generation and safe reinitialization preserve existing key, data, and old URL properties', () => {
  const env = loadCodeGs({ serviceUrls: URLS });
  assert.equal(env.scriptProps.has('TROOP_ID'), false);
  const first = env.api.initializeSheets();
  assert.equal(first.success, true);
  assert.ok(first.apiKey);
  assert.equal(env.scriptProps.get('API_KEY'), first.apiKey);
  assert.equal(env.scriptProps.has('TROOP_ID'), false);
  env.scriptProps.set('WEBAPP_URL', URLS[0]);
  env.scriptProps.set('BACKEND_EXEC_URL', URLS[2]);
  env.ss.getSheetByName('成員名單').appendRow(['9876543210', '保留成員', '2025-01-01', 'b4', '備註']);
  env.ss.getSheetByName('進度追蹤').appendRow(['9876543210', 'OLD-ROVER-ID', '2025-02-03', '2025-02-03', '舊領袖', '保留歷史']);
  const beforeSheets = JSON.stringify(Object.fromEntries([...env.ss.sheets].map(([name, sh]) => [name, sh.rows])));
  const beforeProps = JSON.stringify(Object.fromEntries(env.scriptProps));
  env.api.initializeSheets();
  env.api.initializeSheets();
  assert.equal(env.api.getApiKey(), first.apiKey);
  assert.equal(JSON.stringify(Object.fromEntries([...env.ss.sheets].map(([name, sh]) => [name, sh.rows]))), beforeSheets);
  assert.equal(JSON.stringify(Object.fromEntries(env.scriptProps)), beforeProps);
  assert.equal(env.scriptProps.has('TROOP_ID'), false);
  assert.equal(env.scriptServiceCalls.getUrl, 0);
});

test('system introduction is bilingual, linked both ways, privacy-bounded, and uses the deployable shared image', () => {
  assert.match(html, /data-tab="intro"[^>]*showWelcomeTab\('intro'/);
  assert.match(html, /id="welcome-intro"/);
  assert.match(html, /onclick="showWelcomeTab\('intro'\)"/);
  assert.match(html, /onclick="showWelcomeTab\('setup'\)"/);
  for (const phrase of ['使用者 → 網站／伺服器轉接 → 本團 Apps Script → 本團 Google Sheet', 'Google Sheet 已公開分享', '首次登入後須更改臨時密碼', 'API Key 是系統與後端的接入憑證，不是個人登入驗證', '私人 Google Sheet 不代表所有資料 API 自動安全', '不代表所有資料讀取都已受登入保護']) assert.ok(html.includes(phrase), `missing system-intro safety copy: ${phrase}`);
  assert.match(html, /<img[^>]*src="assets\/system-introduction-zh-hant\.webp"[^>]*width="768" height="1376"[^>]*loading="lazy"/);
  assert.match(html, /href="assets\/system-introduction-zh-hant\.webp"[^>]*download=/);
  assert.match(html, /href="assets\/system-introduction-zh-hant\.webp" target="_blank"/);
  assert.ok(fs.statSync(new URL('../assets/system-introduction-zh-hant.webp', import.meta.url)).size > 100_000);
  for (const server of ['dev-server.mjs', 'demo-server.mjs']) assert.match(fs.readFileSync(new URL('./' + server, import.meta.url), 'utf8'), /'\.webp': 'image\/webp'/, `${server} must serve the illustration as image/webp`);
  assert.match(html, /User → website\/server proxy → this Group’s Apps Script/);
  assert.match(html, /A private Google Sheet does not automatically secure every data API/);
  for (const prohibited of ['TROOP_<', 'SUPER_ADMIN_ID', 'SUPER_ADMIN_EMAIL']) assert.equal(html.includes(prohibited), false, `public introduction must not reveal ${prohibited}`);

  // Run the actual tab switcher in isolation to prove both cross-links select the target tab.
  const fn = html.match(/function showWelcomeTab\(name, btn\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const sections = ['enter', 'intro', 'setup', 'guide'].map(name => ({ id: 'welcome-' + name, active: name === 'enter' }));
  const buttons = ['enter', 'intro', 'setup', 'guide'].map(name => { const button={dataset:{tab:name},active:name==='enter'}; button.classList={add(){button.active=true;},remove(){button.active=false;}}; return button; });
  const context = { document: {
    querySelectorAll(selector) { return selector === '.welcome-section' ? sections : buttons; },
    getElementById(id) { return sections.find(section => section.id === id); },
    querySelector(selector) { const tab = /data-tab="([^"]+)/.exec(selector)?.[1]; return buttons.find(button => button.dataset.tab === tab); }
  } };
  for (const section of sections) section.classList = { add(){ section.active=true; }, remove(){ section.active=false; } };
  vm.runInNewContext(fn + `\nshowWelcomeTab('intro');`, context);
  assert.equal(sections.find(x => x.id === 'welcome-intro').active, true);
  assert.equal(buttons.find(x => x.dataset.tab === 'intro').active, true);
  vm.runInNewContext(`showWelcomeTab('setup');`, context);
  assert.equal(sections.find(x => x.id === 'welcome-setup').active, true);
  assert.equal(buttons.find(x => x.dataset.tab === 'setup').active, true);
});

test('front-end deployment instructions use Google dialog URL and the existing ADMIN FORM; no new GS URL setter', () => {
  assert.match(html, /從 Google 部署視窗複製正式 URL/);
  assert.match(html, /原有 ADMIN FORM/);
  assert.match(html, /只從 initializeSheets／旅系統選單取得 API Key/);
  assert.doesNotMatch(html, /初始化要求旅團編號|設定旅團編號|setBackendUrl|貼上部署 URL 到 GS/);
  assert.match(gas, /function verifySuperTicket\(ticket\)/, 'internal login verification remains in place');
  assert.match(gas, /backend:ScriptApp\.getService\(\)\.getUrl\(\)/, 'do not change the internal signed-login binding');
  assert.match(gas, /function initializeSheets\(\)/);
  assert.doesNotMatch(gas.slice(gas.indexOf('function initializeSheets()'), gas.indexOf('// removeSuperAdminTokenRows')), /ScriptApp\.getService\(\)\.getUrl\(\)|scriptUrl\s*:/);
  assert.doesNotMatch(gas.slice(gas.indexOf('function menuShowLinkCredentials()'), gas.indexOf('function menuRegisterDownstream()')), /ScriptApp\.getService\(\)\.getUrl\(\)/);
});
