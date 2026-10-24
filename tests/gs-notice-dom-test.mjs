// DOM 測試：最新版本公告（首頁／登入頁／登入後主頁）實際渲染三種狀態，並檢查「重新檢查」只呼叫 ecStatus。
// 用法（需要 jsdom，非 npm 依賴）：npm i jsdom 後執行 node tests/gs-notice-dom-test.mjs
// 未安裝 jsdom 時跳過（不影響 npm test）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過 GS 版本公告 DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i jsdom');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vc = new VirtualConsole();
vc.on('jsdomError', () => {}); // 環境雜訊（localStorage、離線 CDN）
const dom = await JSDOM.fromFile(path.join(root, 'index.html'), {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = async (url) => {
      const p = path.join(root, String(url).split('?')[0]);
      if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
      const txt = fs.readFileSync(p, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
    };
    window.scrollTo = () => {};
  },
});
await new Promise(r => setTimeout(r, 1500));
const w = dom.window, d = w.document;
const ev = code => w.eval(code);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message.split('\n')[0]); }
}
const html = id => d.getElementById(id).innerHTML;
const text = id => d.getElementById(id).textContent;
const setInfo = info => { w.__info = info; ev('gsCheckInfo = window.__info; gsCheckState = ""; renderGsNotices();'); };

console.log('\n【GS 版本公告】（實際渲染 index.html）');

await test('三個頁面都有公告區，並帶 Code.gs 下載與「重新檢查」', () => {
  ev('renderGsNotices()');
  for (const id of ['gsNoticeHome', 'gsNoticeLogin', 'gsNoticeMain']) {
    const h = html(id);
    assert.match(h, /最新版本公告/, id);
    assert.match(h, /href="apps-script\/Code\.gs"/, id + ' 缺少 Code.gs 下載');
    assert.match(h, /onclick="gsRecheck\(\)"/, id + ' 缺少重新檢查');
    assert.match(h, /v5\.2\.2/, id + ' 缺少最新版本號');
  }
});

await test('未核對：首頁提示先選擇旅團；登入頁提示按「重新檢查」', () => {
  setInfo(null);
  assert.match(text('gsNoticeHome'), /請先選擇旅團並登入/);
  assert.match(text('gsNoticeLogin'), /尚未核對，請按「重新檢查」/);
});

await test('GS 未更新（舊版無 gsVersion）：提示更新，但不要求本次可選初始化', () => {
  setInfo({ success: false, error: 'Unknown action' });
  assert.match(text('gsNoticeLogin'), /GS 未更新/);
  assert.doesNotMatch(text('gsNoticeMain'), /必須執行一次 initializeSheets\(\)/);
  assert.doesNotMatch(html('gsNoticeMain'), /class="gs-badge gs-ok"/);
});

await test('本版毋須初始化：無標記仍顯示已核對，不偽造初始化標記', () => {
  setInfo({ success: true, gsVersion: '5.2.2', initRequired: false, initializedGsVersion: '' });
  const h = html('gsNoticeMain');
  assert.match(text('gsNoticeMain'), /本次更新毋須重跑初始化/);
  assert.doesNotMatch(h, /gs-must-init|必須執行一次 initializeSheets/);
  assert.match(h, /gs-ok/);
  assert.match(h, /本旅團 GS 版本：v5\.2\.2/);
  assert.match(h, /初始化標記：—/);
});

await test('已存在初始化標記仍原樣展示，不影響可選初始化狀態', () => {
  setInfo({ success: true, gsVersion: '5.2.2', initRequired: false, initializedGsVersion: '5.2.2' });
  const h = html('gsNoticeLogin');
  assert.match(h, /class="gs-badge gs-ok"[^>]*>✅ 已核對/);
  assert.doesNotMatch(h, /gs-must-init/);
  assert.match(h, /初始化標記：5\.2\.2/);
});

await test('資料保全說明出現在公告內（不刪除、不改寫）', () => {
  setInfo(null);
  assert.match(text('gsNoticeHome'), /不會清除既有資料/);
  assert.match(text('gsNoticeHome'), /不刪除、不改寫用戶、進度、紀錄或金鑰/);
});

await test('「重新檢查」沒有選旅團時不發出請求；有旅團時只呼叫 ecStatus', async () => {
  const calls = [];
  w.apiRequest = async (action, data, opts) => { calls.push({ action, data, opts }); return { success: true, gsVersion: '5.2.2', initRequired: false, initializedGsVersion: '' }; };
  ev('currentTroopId = null');
  await w.gsRecheck();
  assert.equal(calls.length, 0, '未選旅團不應發出請求');
  ev("currentTroopId = '1'");
  await w.gsRecheck();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'ecStatus');
  assert.equal(JSON.stringify(calls[0].data), '{}');
  assert.equal(calls[0].opts.troopId, '1');
  assert.match(text('gsNoticeLogin'), /本次更新毋須重跑初始化/);
});

await test('「重新檢查」連線失敗：顯示錯誤提示，不崩潰', async () => {
  w.apiRequest = async () => { throw new Error('network down'); };
  await w.gsRecheck();
  assert.match(text('gsNoticeLogin'), /無法連線核對/);
});

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
dom.window.close();
process.exit(failed ? 1 : 0);
