// DOM-level test of the Users page filter in index.html using jsdom
// 重點：v8.5 前端不再寫死任何系統管理帳號名稱，改按 role 與「自己這個 super_admin 帳號」過濾
// 用法（需要 jsdom，非 npm 依賴）：npm i jsdom 後執行 node tests/users-dom-test.mjs
import fs from 'fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過 Users DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i jsdom');
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeDom() {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => { throw new Error('no network in test'); };
    }
  });
  return dom;
}

// 後端若仍回傳殘留的 super_admin 列，前端必須一律不顯示
const LEAKED_USERS = [
  { ymis: '1234567890', name: '陳大文', role: 'group_leader', can_tick: true, email: 'a@example.org' },
  { ymis: 'legacy_sysop', name: '舊版殘留管理員', role: 'super_admin', can_tick: true, email: '' },
  { ymis: 'sysop_rover', name: '現行系統管理帳號', role: 'admin', can_tick: true, email: '' }
];

async function renderUsers(currentUser) {
  const dom = makeDom();
  await sleep(250);
  const w = dom.window;
  w.eval(`apiRequest = async () => ({ success: true, users: ${JSON.stringify(LEAKED_USERS)} });`);
  w.eval(`currentUser = ${JSON.stringify(currentUser)}; currentToken = 'tok_test';`);
  await w.loadUsers();
  await sleep(50);
  const list = dom.window.document.querySelector('#userList');
  const out = { html: list ? list.innerHTML : '', dom };
  return out;
}

// ---------- 情境一：以 super_admin 身分查看（自己那一行也不能出現）----------
console.log('\n【情境一】super_admin 本人查看用戶管理');
{
  const { html: out } = await renderUsers({ ymis: 'sysop_rover', name: '系統管理員', role: 'super_admin' });
  check('一般領袖照常顯示', out.includes('陳大文') && out.includes('1234567890'));
  check('role=super_admin 的殘留列不顯示', !out.includes('legacy_sysop') && !out.includes('舊版殘留管理員'));
  check('自己這個系統管理帳號不顯示', !out.includes('sysop_rover') && !out.includes('現行系統管理帳號'));
  check('清單只渲染 1 個用戶', (out.match(/class="user-item"/g) || []).length === 1, (out.match(/class="user-item"/g) || []).length + ' 個');
}

// ---------- 情境二：以團長身分查看（不靠任何寫死的帳號名稱）----------
console.log('\n【情境二】團長查看用戶管理');
{
  const { html: out } = await renderUsers({ ymis: '1234567890', name: '陳大文', role: 'group_leader' });
  check('團長自己顯示', out.includes('陳大文'));
  check('role=super_admin 的殘留列不顯示', !out.includes('legacy_sysop'));
  check('其他角色不受影響（非 super_admin 照常顯示）', out.includes('sysop_rover'));
}

// ---------- 情境三：前端原始碼不再寫死任何系統管理帳號名稱 ----------
console.log('\n【情境三】index.html 不再寫死系統管理帳號名稱');
{
  check('index.html 不含舊版帳號字串 sheep', !/sheep/i.test(html));
  check('index.html 不含舊版密碼 0728', !html.includes('0728'));
  check('loadUsers() 的過濾條件按 role + 自己的 super_admin 帳號', /selfSuperId/.test(html));
}

console.log('\n========================================');
console.log(`Users DOM 結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
