// DOM 測試：「可勾選」（can_tick）撤銷後，index.html 不可勾選、審批或直接編輯。
// 用法（需要 jsdom，非 npm 依賴）：npm i jsdom 後執行 node tests/can-tick-dom-test.mjs
// 未安裝 jsdom 時跳過（不影響 npm test）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過可勾選 DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i jsdom');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(fs.readFileSync(path.join(root, 'data/items.json'), 'utf8'));
const MEMBER = { ymis: '2222222222', name: '成員乙', role: 'member', can_tick: false, allowed_badges: '' };
const LEADER_ON = { ymis: '1111111111', name: '領袖甲', role: 'group_leader', can_tick: true, allowed_badges: '*' };
const LEADER_OFF = { ymis: '1111111112', name: '領袖丙', role: 'group_leader', can_tick: false, allowed_badges: '*' };
const EXEC_OFF = { ymis: '1111111113', name: '管委丁', role: 'exec_committee', can_tick: false, allowed_badges: '' };
const L1_ITEM = items.badges.find(b => b.id === 'L1').segments[0].items[0].id;

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
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message.split('\n')[0]); }
}

// 以指定身分初始化（每次重置進度與待儲存狀態）
function as(user) {
  ev(`itemsData=${JSON.stringify(items)}`);
  ev(`members=[${JSON.stringify(LEADER_ON)},${JSON.stringify(MEMBER)}]`);
  ev(`progressFlat={'1111111111':{},'1111111112':{},'1111111113':{},'2222222222':{}}`);
  ev('progressRich={}; schemeMap={}; schemeDefault="new"; selectedProgressYmis=null');
  ev('pendingChanges=[]');
  ev(`currentUser=${JSON.stringify(user)}`);
  ev("currentToken='tok'");
}
const enabledTicks = () => d.querySelectorAll('#tab-progress input[type=checkbox]:not([disabled])').length;

console.log('\n📋 可勾選（can_tick）DOM 測試');

test('撤銷勾選的領袖：canTickNow 為 false；canCurrentUserTickItem 對所有項目皆為 false', () => {
  as(LEADER_OFF);
  assert.equal(ev('canTickNow()'), false);
  assert.equal(ev(`canCurrentUserTickItem(${JSON.stringify(L1_ITEM)})`), false);
  assert.equal(ev("canCurrentUserTickItem('OTHER')"), false);
});

test('撤銷勾選的管委：同樣不可勾選 L1', () => {
  as(EXEC_OFF);
  assert.equal(ev(`canCurrentUserTickItem(${JSON.stringify(L1_ITEM)})`), false);
});

test('可勾選的領袖：canTickNow 為 true，可勾選 L1', () => {
  as(LEADER_ON);
  assert.equal(ev('canTickNow()'), true);
  assert.equal(ev(`canCurrentUserTickItem(${JSON.stringify(L1_ITEM)})`), true);
});

test('撤銷勾選的領袖：進度頁（查看成員）沒有任何可勾選的核取框', () => {
  as(LEADER_OFF);
  ev(`selectedProgressYmis='${MEMBER.ymis}'`);
  ev('renderProgressTab()');
  assert.ok(d.querySelectorAll('#tab-progress input[type=checkbox]').length > 0, '應有核取框（只讀）');
  assert.equal(enabledTicks(), 0, '所有核取框皆應為 disabled');
});

test('可勾選的領袖：進度頁有可勾選的核取框（對照組）', () => {
  as(LEADER_ON);
  ev(`selectedProgressYmis='${MEMBER.ymis}'`);
  ev('renderProgressTab()');
  assert.ok(enabledTicks() > 0, '可勾選領袖應有可勾選項目');
});

test('撤銷勾選的領袖：勾選 L1（toggleMemberItem）不改動畫面，亦不加入待儲存', () => {
  as(LEADER_OFF);
  ev(`selectedProgressYmis='${MEMBER.ymis}'`);
  ev('renderProgressTab()');
  ev(`toggleMemberItem('${MEMBER.ymis}',${JSON.stringify(L1_ITEM)},{textContent:'',style:{}})`);
  assert.equal(ev('pendingChanges.length'), 0, '撤銷後不可加入待儲存');
});

test('對照：可勾選的領袖勾選 L1 會加入待儲存', () => {
  as(LEADER_ON);
  ev(`selectedProgressYmis='${MEMBER.ymis}'`);
  ev('renderProgressTab()');
  ev(`toggleMemberItem('${MEMBER.ymis}',${JSON.stringify(L1_ITEM)},{textContent:'',style:{}})`);
  assert.equal(ev('pendingChanges.length'), 1, '可勾選領袖應加入待儲存');
});

test('撤銷勾選的領袖：OT 其他獎章編輯按鈕不出現（僅可查看）', () => {
  as(LEADER_OFF);
  ev(`selectedProgressYmis='${MEMBER.ymis}'`);
  ev('renderOtherBadgesTab()');
  const html = d.getElementById('tab-other').innerHTML;
  assert.match(html, /OT-|其他獎章|ob-|item-row/, '應有其他獎章列（只讀）');
  assert.doesNotMatch(html, /onclick="toggleOtherBadge\(/, '不可出現可勾選按鈕');
  assert.equal(d.querySelectorAll('#tab-other input[type=checkbox]:not([disabled])').length, 0, '核取框皆 disabled');
});

console.log(`\n結果：${passed} 通過, ${failed} 失敗`);
if (failed) process.exit(1);
