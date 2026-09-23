// v8.9 手機導覽分層 DOM 測試：常用功能排上、領袖／管委（進階）功能排下 —— 只影響外觀，不改權限
// 用法（需要 jsdom，非 npm 依賴）：npm i jsdom 或 npm i -g jsdom 後執行
//   node tests/nav-layout-dom-test.mjs
import fs from 'fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過導覽分層 DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i -g jsdom 或 npm i jsdom');
  process.exit(0);
}

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.localStorage.setItem('roverbadge_lang', 'zh');
    window.fetch = async () => { throw new Error('no network in test'); };
  }
});
await sleep(300);
const win = dom.window, doc = win.document;

// 模擬登入後的角色／設定（inline script 的頂層 let 綁定 → 用 window.eval 設定）
function setUser(role, cfg = {}) {
  win.eval(`currentUser={role:${JSON.stringify(role)},name:'測試',ymis:'T1'}; appConfig=${JSON.stringify(cfg)};`);
  win.eval('setupTabsByRole()');
}
const btn = (id) => doc.getElementById('btn-tab-' + id);
const hidden = (id) => btn(id).classList.contains('nav-hidden');
const elevated = (id) => btn(id).classList.contains('nav-elevated');

console.log('\n【1】成員（預設）：常用功能在上方，領袖／進階功能隱藏');
{
  setUser('member');
  check('我的進度：顯示、屬常用（上方）', !hidden('progress') && !elevated('progress'));
  check('審批中心：顯示、屬常用（上方）', !hidden('requests') && !elevated('requests'));
  for (const id of ['logs', 'forms', 'help', 'info']) {
    check(`${id}：顯示、屬常用（上方）`, !hidden(id) && !elevated(id));
  }
  check('全團總覽：未開放 → 隱藏', hidden('overview'));
  check('用戶管理：成員無權 → 隱藏', hidden('users'));
}

console.log('\n【2】成員 + 團長開放「允許成員互相查看進度」：全團總覽自動升返上方');
{
  setUser('member', { allow_member_view_others: 'true' });
  check('全團總覽：顯示', !hidden('overview'));
  check('全團總覽：開放後屬常用（上方）', !elevated('overview'));
  check('用戶管理：仍然隱藏', hidden('users'));
}

console.log('\n【3】管委 exec_committee：成員功能在上、全團總覽（進階）排下');
{
  setUser('exec_committee');
  check('我的進度：顯示、屬常用（上方）', !hidden('progress') && !elevated('progress'));
  check('審批中心：顯示、屬常用（上方）', !hidden('requests') && !elevated('requests'));
  check('全團總覽：顯示、屬進階（下方）', !hidden('overview') && elevated('overview'));
  check('用戶管理：無管理權 → 隱藏', hidden('users'));
}

console.log('\n【4】領袖 group_leader：常用在上，全團總覽＋用戶管理排下（半半一行）');
{
  setUser('group_leader');
  check('我的進度：顯示、屬常用（上方）', !hidden('progress') && !elevated('progress'));
  check('審批中心：顯示、屬常用（上方）', !hidden('requests') && !elevated('requests'));
  check('全團總覽：顯示、屬進階（下方）', !hidden('overview') && elevated('overview'));
  check('用戶管理：顯示、屬進階（下方）', !hidden('users') && elevated('users'));
  check('方塊內只有 2 個進階按鈕（會平分一行）',
    [...doc.querySelectorAll('#mainNavTabs .nav-tab.nav-elevated')].filter(b => !b.classList.contains('nav-hidden')).length === 2);
}

console.log('\n【5】桌機外觀不變：按鈕 DOM 順序相同、無殘留 inline display');
{
  const ids = [...doc.querySelectorAll('#mainNavTabs .nav-tab')].map(b => b.id);
  check('第一個＝我的進度，第二個＝全團總覽（桌機一行順序不變）',
    ids[0] === 'btn-tab-progress' && ids[1] === 'btn-tab-overview', ids.join('|'));
  check('已無任何 inline style.display（統一由 .nav-hidden 控制）',
    doc.querySelectorAll('#mainNavTabs .nav-tab[style*="display"]').length === 0);
  check('已隱藏的舊分頁有 nav-hidden（apps／byitem／other）',
    ['apps', 'byitem', 'other'].every(hidden));
}

console.log('\n【6】CSS：手機換行分層、桌機不受影響');
{
  const mqStart = html.indexOf('@media(max-width:768px){');
  const mqEnd = html.indexOf('@media', mqStart + 20);
  const mobileCss = html.slice(mqStart, mqEnd > 0 ? mqEnd : html.length);
  check('手機 .nav-tabs 用 flex-wrap 換行（唔再左右滑）',
    mobileCss.includes('.nav-tabs{top:0;z-index:120;flex-wrap:wrap;overflow:visible}'));
  check('手機 .nav-tab 三等分格狀（平分）', mobileCss.includes('.nav-tab{flex:0 0 33.333%'));
  check('手機進階按鈕 order:100（排到最後一行）', mobileCss.includes('.nav-tab.nav-elevated{order:100'));
  check('手機進階按鈕有分隔線 border-top', mobileCss.includes('border-top:1px solid var(--border)}'));
  check('桌機 .nav-tab 一行寫法未改', html.includes('.nav-tab{flex:0 0 auto;min-width:100px;padding:14px 16px;'));
  check('進階排最後一行只限手機（桌機 CSS 冇 order）',
    !html.slice(0, mqStart).includes('.nav-tab.nav-elevated'));
}

console.log(`\n結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
