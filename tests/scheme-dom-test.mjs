// DOM 測試：學制（新制／舊制／舊制過渡新制）在 index.html 進度頁與表格頁的呈現
// 用法（需要 jsdom，非 npm 依賴）：npm i jsdom 後執行 node tests/scheme-dom-test.mjs
// 未安裝 jsdom 時跳過（不影響 npm test）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過學制 DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i jsdom');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(fs.readFileSync(path.join(root, 'data/items.json'), 'utf8'));
const LEADER = { ymis: '1111111111', name: '領袖甲', role: 'group_leader', can_tick: true, allowed_badges: '*' };
const MEMBER = { ymis: '2222222222', name: '成員乙', role: 'member' };
const OLD_FLAT = { 'S4-AWARD-CORE-01': '2025-01-10', 'L1-ACT-01': '2025-02-01' };

const vc = new VirtualConsole();
const pageErrors = [];
vc.on('jsdomError', e => pageErrors.push(String((e && e.message) || e)));

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

ev(`itemsData=${JSON.stringify(items)}`);
ev(`members=[${JSON.stringify(LEADER)},${JSON.stringify(MEMBER)}]`);
ev(`progressFlat={'1111111111':{},'2222222222':${JSON.stringify(OLD_FLAT)}}`);
ev('progressRich={}');
ev(`currentUser=${JSON.stringify(LEADER)}`);
ev("currentToken='tok'");
ev("pendingChanges=[]");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message.split('\n')[0]); }
}
const selectValue = id => { const el = d.getElementById(id); return el ? el.value : undefined; };

console.log('\n📋 學制 DOM 測試');

test('過渡成員：進度頁顯示學制選擇器（選中「過渡」）、過渡對照面板、舊版紀錄卡', () => {
  ev("schemeMap={'2222222222':'transition'}; schemeDefault='new'; selectedProgressYmis='2222222222'");
  ev('renderProgressTab()');
  const html = d.getElementById('tab-progress').innerHTML;
  assert.ok(d.getElementById('schemeSelect'), '應有 #schemeSelect');
  assert.equal(selectValue('schemeSelect'), 'transition');
  assert.match(html, /過渡對照/);
  assert.match(html, /舊版紀錄／不計完成度|舊版紀錄/);
  assert.match(html, /addTransitionPending\(/, '單一或全部對應時應有加入待儲存按鈕');
});

test('舊制成員：學制選擇器為「舊制」，顯示舊制獎章與選修「須選 N 項」，無過渡面板', () => {
  ev("schemeMap={'2222222222':'old'}; selectedProgressYmis='2222222222'");
  ev('renderProgressTab()');
  const html = d.getElementById('tab-progress').innerHTML;
  assert.equal(selectValue('schemeSelect'), 'old');
  assert.match(html, /獎章（舊制/);
  assert.match(html, /須選 1 項/);
  assert.match(html, /須選 2 項/);
  assert.doesNotMatch(html, /過渡對照/);
});

test('新制成員：不顯示過渡面板；頁面以 items.json 的新制獎章渲染', () => {
  ev("schemeMap={'2222222222':'new'}; selectedProgressYmis='2222222222'");
  ev('renderProgressTab()');
  const html = d.getElementById('tab-progress').innerHTML;
  assert.equal(selectValue('schemeSelect'), 'new');
  assert.doesNotMatch(html, /過渡對照/);
  // 學制選擇器的下拉選項本身會列出所有學制，故只檢查獎章標題
  assert.doesNotMatch(html, /獎章（舊制/);
});

test('成員本人：學制選擇器可用，且只顯示自己的學制', () => {
  ev(`currentUser=${JSON.stringify(MEMBER)}`);
  ev("selectedProgressYmis=null; schemeMap={'2222222222':'old'}");
  ev('renderProgressTab()');
  const sel = d.getElementById('schemeSelect');
  assert.ok(sel, '成員應可見自己的學制選擇器');
  assert.equal(sel.value, 'old');
  assert.equal(sel.disabled, false, '成員可改自己的學制');
  ev(`currentUser=${JSON.stringify(LEADER)}`);
});

test('表格頁：依選定成員學制顯示；選擇成員後不重置（onFormMemberChange）', () => {
  ev("schemeMap={'2222222222':'old'}; selectedProgressYmis='2222222222'");
  ev('renderFormsTab()');
  assert.equal(selectValue('formMemberSelect'), '2222222222');
  const oldHtml = d.getElementById('tab-forms').innerHTML;
  assert.match(oldHtml, /舊制（第四版）/);
  ev("onFormMemberChange('1111111111')");
  assert.equal(selectValue('formMemberSelect'), '1111111111');
  assert.equal(ev('selectedProgressYmis'), '1111111111', '選擇應寫入 selectedProgressYmis');
  ev('renderFormsTab()');
  assert.equal(selectValue('formMemberSelect'), '1111111111', '重新渲染後選擇不得被重置');
});

test('表格頁：新制三個表格按鈕；按鈕來自 items.json（無寫死清單）', () => {
  ev("schemeMap={'1111111111':'new'}; selectedProgressYmis='1111111111'");
  ev('renderFormsTab()');
  const html = d.getElementById('tab-forms').innerHTML;
  const n = (html.match(/<button/g) || []).length;
  assert.equal(n, 3, '新制應有 PT/21、PT/22、PT/69 三個按鈕');
});

test('表格頁舊制卡片：不再寫「只提供連結」', () => {
  ev("schemeMap={'2222222222':'old'}; selectedProgressYmis='2222222222'");
  ev('renderFormsTab()');
  const html = d.getElementById('tab-forms').innerHTML;
  assert.doesNotMatch(html, /僅提供連結|只提供連結/);
  assert.match(html, /舊制（第四版）表格/);
});

test('頁面載入無未處理的腳本錯誤（不計 CDN 與 localStorage 的環境噪音）', () => {
  const real = pageErrors.filter(e => !/vercel-insights|localStorage|Could not load script/.test(e));
  assert.deepEqual(real, []);
});

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
dom.window.close();
if (failed) process.exit(1);
