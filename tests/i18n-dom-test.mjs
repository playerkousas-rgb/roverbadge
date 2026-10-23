// DOM-level test of the i18n layer in index.html using jsdom
// 用法（需要 jsdom，非 npm 依賴）：npm i -g jsdom 或放到 node_modules 後執行
//   node tests/i18n-dom-test.mjs
import fs from 'fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過 i18n DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i -g jsdom 或 npm i jsdom');
  process.exit(0);
}

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function makeDom(lang) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem('roverbadge_lang', lang);
      window.fetch = async (url) => {
        // minimal stub: fail gracefully (app catches errors)
        throw new Error('no network in test');
      };
    }
  });
  return dom;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

// ---------- EN mode ----------
const domEn = makeDom('en');
await sleep(300); // let DOMContentLoaded run

const doc = domEn.window.document;
check('html lang = en', doc.documentElement.lang === 'en', doc.documentElement.lang);
check('title translated', doc.title.startsWith('Rover Scout Progress Tracker'), doc.title);
check('h1 translated', doc.querySelector('.logo-row h1').textContent.trim() === 'Rover Scout Progress Tracker');
const nav = [...doc.querySelectorAll('.welcome-nav button')].map(b => b.textContent.trim());
check('welcome nav translated', nav.join('|') === '🏠 Enter System|📋 New Group Deployment|📖 User Guide|🐛💬 Report · Feedback', nav.join('|'));
check('lang toggle shows 中文', doc.querySelector('.lang-toggle').textContent.trim() === '🌐 中文');
const loginH2 = doc.querySelector('#loginPage h2')?.textContent.trim();
check('login title translated', loginH2 === '🔐 Login', loginH2);
const tabs = [...doc.querySelectorAll('#mainNavTabs .nav-tab')].map(b => b.textContent.trim());
check('main tabs translated', tabs[0] === '📊 My Progress' && tabs[1] === '👥 Group Overview', tabs.join('|'));
check('footer translated', doc.querySelector('footer').textContent.includes('Rover Scout Progress Tracker v5.2'));
check('footer unofficial notice translated', doc.querySelector('footer').textContent.includes('Unofficial notice'), doc.querySelector('footer').textContent.slice(0, 200));
check('home subtitle version translated', doc.querySelector('.logo-row p').textContent.trim().startsWith('Rover Scout Progress Tracker v5.2'), doc.querySelector('.logo-row p').textContent);
check('login header version translated', doc.querySelector('#loginPage h1').textContent.trim() === 'Rover Scout Progress Tracker v5.2', doc.querySelector('#loginPage h1').textContent);
check('login 回報 link translated', [...doc.querySelectorAll('#loginPage a')].some(a => a.textContent.trim() === '🐛💬 Report · Feedback'));
check('itemsDataUrl() = en json', domEn.window.itemsDataUrl() === 'data/items_en.json');

// ---------- 部署頁（2026-10：首次登入步驟 + 主系統暫時隱藏） ----------
const setupSteps = [...doc.querySelectorAll('#welcome-setup .steps .step')];
check('部署頁顯示 5 個步驟（軌道B 已隱藏）', setupSteps.length === 5, `實際 ${setupSteps.length}`);
const setupH4 = setupSteps.map(s => s.querySelector('h4').textContent.trim());
check('部署頁步驟標題已全數翻譯（無中文夾雜）',
  setupH4.join('|') === 'Common: download the backend code (single-file version)|Common: create a Google Sheet and deploy|Submit to the roverbadge admin|First sign-in (default admin account)|Privacy choice',
  setupH4.join('|'));
check('部署頁冇顯示軌道B步驟', ![...doc.querySelectorAll('#welcome-setup h4')].some(h => h.textContent.includes('軌道B') || h.textContent.includes('Track B')));
const setupText = doc.querySelector('#welcome-setup').textContent;
check('首次登入步驟顯示預設管理員帳密', setupText.includes('1111111111') && setupText.includes('changeme'));
check('部署頁步驟區英文化（無殘留中文字）', !/[\u4e00-\u9fff]/.test(setupText), setupText.match(/[\u4e00-\u9fff][^\n<>]{0,20}/)?.[0] || '');

// ---------- 強制改密 modal（2026-10：取代 window.prompt） ----------
const fc = doc.querySelector('#forceChangeModal');
check('forceChangeModal 存在', !!fc);
check('forceChangeModal 標題已翻譯', fc && fc.querySelector('h3').textContent.trim() === '🔒 Set a New Password', fc && fc.querySelector('h3').textContent);
check('forceChangeModal 全文英文化（無殘留中文字）', fc && !/[\u4e00-\u9fff]/.test(fc.textContent), fc && (fc.textContent.match(/[\u4e00-\u9fff][^\n<>]{0,20}/)?.[0] || ''));
check('forceChangeModal 兩個密碼欄 placeholder 已翻譯',
  fc && fc.querySelector('#fcNew1').placeholder === 'at least 4 characters' && fc.querySelector('#fcNew2').placeholder === 'enter again',
  fc && (fc.querySelector('#fcNew1').placeholder + '|' + fc.querySelector('#fcNew2').placeholder));
check('forceChangeModal 按鈕已翻譯',
  fc && fc.querySelector('#btnCancelForceChange').textContent.trim() === 'Cancel (back to sign-in)' && fc.querySelector('#btnForceChange').textContent.trim() === 'Confirm Change');

// 靜態源碼層：被隱藏段落仍然保留喺註解入面（重啟用）
check('源碼保留 [主系統暫時隱藏] 標記', html.includes('[主系統暫時隱藏 2026-10]'));
check('軌道B步驟仍喺源碼註解內（未刪）', /<!--[\s\S]*?軌道B：有主系統並想接上[\s\S]*?-->/.test(html));
check('主系統介紹卡仍喺源碼註解內（未刪）', /<!--[\s\S]*?主系統平台是什麼[\s\S]*?-->/.test(html));

// observer test: dynamically inject Chinese into a container
const probe = doc.createElement('div');
probe.innerHTML = '<p>📅 活動履歷</p><input placeholder="搜尋成員姓名/ YMIS">';
doc.body.appendChild(probe);
await sleep(50);
check('observer translates innerHTML text', probe.querySelector('p').textContent.trim() === '📅 Activity Log', probe.querySelector('p').textContent);
check('observer translates placeholder attr', probe.querySelector('input').placeholder === 'Search member name / YMIS', probe.querySelector('input').placeholder);

// textContent mutation
const probe2 = doc.createElement('span');
doc.body.appendChild(probe2);
probe2.textContent = '載入中...';
await sleep(50);
check('observer translates textContent', probe2.textContent === 'Loading...', probe2.textContent);

// ---------- ZH mode ----------
const domZh = makeDom('zh');
await sleep(300);
const doc2 = domZh.window.document;
check('zh: html lang = zh-Hant', doc2.documentElement.lang === 'zh-Hant', doc2.documentElement.lang);
check('zh: h1 stays Chinese', doc2.querySelector('.logo-row h1').textContent.includes('樂行童軍進度追蹤系統'));
check('zh: lang toggle shows English', doc2.querySelector('.lang-toggle').textContent.trim() === '🌐 English');
check('zh: itemsDataUrl() = zh json', domZh.window.itemsDataUrl() === 'data/items.json');
const probe3 = doc2.createElement('p');
doc2.body.appendChild(probe3);
probe3.textContent = '我的進度';
await sleep(50);
check('zh: no translation applied', probe3.textContent === '我的進度', probe3.textContent);

// zh: 部署頁結構（步驟 4 首次登入、步驟 5 私隱、軌道B 唔顯示）
const zhSteps = [...doc2.querySelectorAll('#welcome-setup .steps .step')];
const zhH4 = zhSteps.map(s => s.querySelector('h4').textContent.trim());
check('zh: 部署頁 5 步、第4步係首次登入、第5步係私隱',
  zhSteps.length === 5 && zhH4[3] === '首次登入（預設管理員帳號）' && zhH4[4] === '私隱選擇', zhH4.join('|'));
check('zh: 部署頁冇顯示軌道B（但註解保留喺源碼）', !zhH4.some(h => h.includes('軌道B')));
const zhSetupText = doc2.querySelector('#welcome-setup').textContent;
check('zh: 首次登入步驟顯示 YMIS 1111111111 同 changeme',
  zhSetupText.includes('YMIS 1111111111') && zhSetupText.includes('changeme'));
check('zh: forceChangeModal 顯示中文標題', doc2.querySelector('#forceChangeModal h3').textContent.trim() === '🔒 請設定新密碼');

console.log(`\n結果：${passed} 通過, ${failed} 失敗`);
process.exit(failed ? 1 : 0);
