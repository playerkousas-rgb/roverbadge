// DOM-level test：ROVERBOOK 對接 → 📱 4 · 匯出 QR（用 jsdom 真跑 index.html）
// 用法（需要 jsdom，非 npm 依賴）：npm i jsdom 後執行 node tests/roverbook-card-dom-test.mjs
//
// 這條測試回答一個產品問題：「領袖按下按鈕之後，畫面真係出到一個掃得到的 QR 嗎？」
// 所以它不只看原始碼，而是真跑：
//   注入成員／進度 → renderBookTab() → 產生 QR → 檢查 SVG、連結、JSON、列印區、私隱。
import fs from 'node:fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過 QR 匯出 DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i jsdom');
  process.exit(0);
}

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const items = JSON.parse(read('data/items.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ev = (w, expr) => w.eval(expr);
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const MEMBERS = [
  { ymis: '0000081420', name: '陳大文', squad: '海狸', badges: { L1: '2026-04-01' }, otherBadges: {} },
  { ymis: '0000081421', name: '李小明', squad: '海狸', badges: {}, otherBadges: {} }
];
const PROGRESS = {
  '0000081420': { 'L1-ACT-01': '2026-03-01', 'L1-UND-01': '2026-03-02', 'L3-INT-01': '2026-05-05' },
  '0000081421': {}
};

function makeDom() {
  return new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => { throw new Error('no network in test'); };
      window.print = () => { window.__printed = true; };
    }
  });
}

async function renderAs(user) {
  const dom = makeDom();
  await sleep(250);
  const w = dom.window;
  w.eval(`itemsData = ${JSON.stringify(items)};`);
  for (const a of ['assets/roverbook-bridge.js', 'assets/roverbook-qr.js']) w.eval(read(a));
  w.eval(`members = ${JSON.stringify(MEMBERS)}; progressFlat = ${JSON.stringify(PROGRESS)};`);
  w.eval(`currentUser = ${JSON.stringify(user)}; currentToken = 'tok_test'; currentTroopId = '0082';`);
  w.eval("bookState.tab = 'card'; renderBookTab();");
  await sleep(30);
  return { dom, w, doc: w.document };
}

console.log('\n【1】領袖：產生一個成員的 QR');
const { w, doc } = await renderAs({ ymis: '0000081420', name: '陳大文', role: 'group_leader', can_tick: true });
const pane = doc.querySelector('#tab-book');
check('ROVERBOOK 分頁有第 4 步（📱 匯出 QR）', !!pane && pane.textContent.includes('匯出 QR'));
const select = doc.querySelector('#bookCardMember');
check('有成員下拉選單', !!select);
check('選單列出全團成員', !!select && select.options.length === 2, select ? select.options.length : 0);
const optionTexts = select ? [...select.options].map((o) => o.textContent) : [];
check('選單顯示姓名＋SCOUT ID', optionTexts.some((t) => t.includes('陳大文') && t.includes('0000081420')), optionTexts.join(' | '));
check('有 ROVERBOOK 網址欄（預設官方網址）', doc.querySelector('#bookCardBase') && doc.querySelector('#bookCardBase').value === 'https://roverbook.vercel.app');

// 揀第一位成員 → 產生
w.eval("document.getElementById('bookCardMember').value = '0000081420'; bookCardGenerate();");
await sleep(30);
const svg = doc.querySelector('#bookCardResult .book-card-qr svg');
check('畫面出到 QR（SVG）', !!svg);
check('QR 有模組 path', !!svg && svg.querySelector('path') && svg.querySelector('path').getAttribute('d').length > 500);
const url = ev(w, 'bookState.card ? bookState.card.url : ""');
const cardInfo = JSON.parse(ev(w, 'JSON.stringify(bookState.card ? { size: bookState.card.qr.size, items: bookState.card.items, awards: bookState.card.awards } : null)'));
check('連結用 ROVERBOOK 網址 + hash', !!url && url.startsWith('https://roverbook.vercel.app/#rb=RBC1.'), url);
check('連結唔會把資料放喺 query（唔會送去伺服器）', !!url && url.indexOf('?') < 0);
check('QR 版本／格數合理（手機相機友善）', !!cardInfo && cardInfo.size <= 73, cardInfo && String(cardInfo.size));
check('畫面顯示進度／獎章數目', pane.textContent.includes('3') && pane.textContent.includes('SCOUT ID 0000081420'));
check('有列印區（A4 .print-area）', !!doc.querySelector('#bookCardResult .print-area'));

// 私隱：QR 內容／連結／JSON 都唔可以有姓名或電話
const json = (doc.querySelector('#bookCardJson') || {}).value || '';
check('有「複製 JSON」（舊版 ROVERBOOK 用）', json.length > 50);
let parsed = null;
try { parsed = JSON.parse(json); } catch (e) { /* 下面 check 會 fail */ }
check('JSON 可以解析且標明領袖已核實', !!parsed && parsed.verified === true && parsed.verifiedBy === 'ROVERBADGE');
check('卡內進度與畫面一致', !!parsed && Object.keys(parsed.progress).length === 3 && parsed.awards.L1 === '2026-04-01', parsed && JSON.stringify(parsed.progress));
const whole = url + svg.outerHTML + json;
check('QR／連結／JSON 都沒有姓名', !whole.includes('陳大文'));
check('QR／連結／JSON 都沒有其他個人資料欄位', !/"name"|phone|email|address|photo|signature/.test(json));
check('JSON 內沒有任何未核實項目', !!parsed && (parsed.signoffs || []).every((s) => s.verified === true));

// 空白成員：一樣要有卡（綁定 SCOUT ID）
w.eval("document.getElementById('bookCardMember').value = '0000081421'; bookCardGenerate();");
await sleep(20);
check('未有進度的成員一樣產生到 QR（空白紀錄冊）', JSON.parse(ev(w, 'JSON.stringify(bookState.card ? { items: bookState.card.items } : null)')).items === 0);
check('空白卡會提示「暫時未有進度」', doc.querySelector('#tab-book').textContent.includes('暫時未有進度'));

// 自訂 ROVERBOOK 網址（會記住）
w.eval("document.getElementById('bookCardBase').value = 'https://example.org/book/'; bookCardGenerate();");
await sleep(20);
const customUrl = ev(w, 'bookState.card ? bookState.card.url : ""');
check('自訂網址會清理結尾斜線', customUrl.startsWith('https://example.org/book/#rb=RBC1.'), customUrl);
check('自訂網址會記入 localStorage', w.localStorage.getItem('roverbadge_book_qr_base') === 'https://example.org/book/', w.localStorage.getItem('roverbadge_book_qr_base'));

// 列印掣存在
check('有列印按鈕', pane.textContent.includes('列印'));

console.log('\n【2】成員（非領袖）：見唔到產生器');
const memberView = await renderAs({ ymis: '0000081420', name: '陳大文', role: 'member', can_tick: false });
check('成員見到「只限領袖使用」', memberView.doc.querySelector('#tab-book').textContent.includes('只限領袖使用'));
check('成員見唔到產生 QR 按鈕', !memberView.doc.querySelector('#bookCardMember'));

console.log('\n【3】英文介面：新字串有翻譯（唔會漏翻做中文）');
const enDom = new JSDOM(html, {
  url: 'http://localhost/?lang=en',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.localStorage.setItem('roverbadge_lang', 'en');
    window.fetch = async () => { throw new Error('no network in test'); };
  }
});
await sleep(250);
{
  const ew = enDom.window;
  ew.eval(`members = ${JSON.stringify(MEMBERS)}; progressFlat = ${JSON.stringify(PROGRESS)};`);
  ew.eval("currentUser = { ymis: '0000081420', name: 'Chan', role: 'group_leader', can_tick: true }; currentToken = 'tok'; currentTroopId = '0082';");
  ew.eval("bookState.tab = 'card'; renderBookTab();");
  await sleep(20);
  const text = enDom.window.document.querySelector('#tab-book').textContent;
  check('英文介面有 Export QR', text.includes('Export QR'));
  check('英文介面沒有未翻譯的中文步驟標題', !/步驟 4：把成員的紀錄變成一個 QR/.test(text));
}

console.log(`\n結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
