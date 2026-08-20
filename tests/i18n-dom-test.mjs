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
check('welcome nav translated', nav.join('|') === '🏠 Enter System|📋 New Group Deployment|📖 User Guide', nav.join('|'));
check('lang toggle shows 中文', doc.querySelector('.lang-toggle').textContent.trim() === '🌐 中文');
const loginH2 = doc.querySelector('#loginPage h2')?.textContent.trim();
check('login title translated', loginH2 === '🔐 Login', loginH2);
const tabs = [...doc.querySelectorAll('#mainNavTabs .nav-tab')].map(b => b.textContent.trim());
check('main tabs translated', tabs[0] === '📊 My Progress' && tabs[1] === '👥 Group Overview', tabs.join('|'));
check('footer translated', doc.querySelector('footer').textContent.includes('Rover Scout Progress Tracker v5.0'));
check('itemsDataUrl() = en json', domEn.window.itemsDataUrl() === 'data/items_en.json');

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

console.log(`\n結果：${passed} 通過, ${failed} 失敗`);
process.exit(failed ? 1 : 0);
