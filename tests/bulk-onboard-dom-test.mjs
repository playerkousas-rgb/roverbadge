// DOM-level functional test of the 批量開戶 (bulk onboarding) modal in index.html
// 覆蓋：YMIS 貼上文字解析 → 預覽表格 → 勾選/編輯/補零 → 狀態顯示；EN 模式翻譯
// 用法（需要 jsdom，非 npm 依賴）：npm i jsdom 後執行
//   node tests/bulk-onboard-dom-test.mjs
// 註：index.html 的全域變數（members / ymisImportRows 等）以 let 宣告，
//     不在 window 物件上，須用 w.eval() 於全域 lexical scope 存取。
import fs from 'fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  console.log('⚠️  jsdom 未安裝，跳過批量開戶 DOM 測試（不影響 npm test）');
  console.log('   安裝：npm i jsdom');
  process.exit(0);
}

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ymisParseSrc = fs.readFileSync(new URL('../assets/ymis-parse.js', import.meta.url), 'utf8');

function makeDom(lang) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem('roverbadge_lang', lang);
      window.fetch = async () => { throw new Error('no network in test'); };
    }
  });
  // index.html 以 <script src> 載入 assets/ymis-parse.js，jsdom 不會抓外部資源 → 手動注入同名全域
  dom.window.eval(ymisParseSrc);
  return dom;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

// ---------- ZH 模式：互動流程 ----------
console.log('\n【批量開戶 modal】ZH 互動流程');
{
  const dom = makeDom('zh');
  await sleep(300);
  const w = dom.window, d = w.document;

  check('頁面含 ymis-parse <script src>', html.includes('assets/ymis-parse.js'));
  check('window.YmisParse 已載入', typeof w.YmisParse === 'object');

  w.openBulkOnboardModal();
  check('openBulkOnboardModal → modal active', d.getElementById('bulkOnboardModal').classList.contains('active'));

  // 貼上文字 → 解析
  d.getElementById('ymisPasteText').value = [
    '童軍成員編號  中文姓名  電郵地址',
    '1234560001\t陳大文\tchan@example.org',
    '1234560002   李小明',      // 缺電郵
    '1234560003 王志強 wong@example.org',
    'junk line no number'
  ].join('\n');
  w.importYmisPastedText();
  check('解析出 3 位成員', w.eval('ymisImportRows.length') === 3, `got ${w.eval('ymisImportRows.length')}`);
  check('缺電郵者照樣入列', w.eval("ymisImportRows[1].ymis")==='1234560002' && w.eval("ymisImportRows[1].email")==='');

  const preview = d.getElementById('ymisPreview');
  check('預覽表格已渲染', preview && preview.querySelectorAll('tbody tr').length === 3);
  check('預設角色下拉含 roverbadge 五種角色', ['member','exec_committee','branch_leader','group_leader','admin']
    .every(r => preview.querySelector(`#ymisDefRole option[value="${r}"]`)));
  check('狀態顯示（可匯入／缺電郵）', preview.textContent.includes('✅ 可匯入') && preview.textContent.includes('ℹ️ 缺電郵'));

  // 全不選 → 全選
  w.ymisSelectAll(false);
  check('全不選 → 已選 0', preview.textContent.includes('已選 0'));
  w.ymisSelectAll(true);
  check('全選 → 已選 3', preview.textContent.includes('已選 3'));

  // 編輯 ymis 至無效值 → 狀態更新
  w.ymisEdit(0, 'ymis', '12345');
  check('改壞編號 → 狀態 ⚠️ 編號非10位', preview.querySelectorAll('tbody tr')[0].children[4].textContent.includes('編號非10位'));
  // 補零修復
  w.ymisPadAll();
  check('全部補零至10位 → 0000012345', w.eval('ymisImportRows[0].ymis') === '0000012345');

  // 成員已存在 → 標記 exists，全選時自動不勾
  w.eval("members = [{ ymis: '1234560002', name: '李小明' }]");
  w.ymisEdit(1, 'ymis', '1234560002');
  check('已存在 → exists=true', w.eval("ymisImportRows[1].exists")===true);
  w.ymisSelectAll(true);
  check('全選時已存在者仍不勾（use=false）', w.eval("ymisImportRows[1].use")===false);

  // 清除預覽
  w.ymisClearPreview();
  check('清除預覽 → 表格清空', d.getElementById('ymisPreview').innerHTML === '');
}

// ---------- EN 模式：翻譯 ----------
console.log('\n【批量開戶 modal】EN 翻譯');
{
  const dom = makeDom('en');
  await sleep(300);
  const w = dom.window, d = w.document;

  w.openBulkOnboardModal();
  const modalText = d.getElementById('bulkOnboardModal').textContent;
  check('modal 標題已翻譯', modalText.includes('Bulk Onboarding - Leaders only'));
  check('YMIS 上載按鈕已翻譯', modalText.includes('Upload YMIS PDF report'));
  check('方法一（YMIS）已翻譯', modalText.includes('YMIS report import'));
  check('貼上文字按鈕已翻譯', modalText.includes('Parse pasted text'));

  d.getElementById('ymisPasteText').value = '1234560009\t張美玲\tcheung@example.org';
  w.importYmisPastedText();
  await sleep(120);   // 等待 i18n MutationObserver 翻譯注入的 DOM
  const preview = d.getElementById('ymisPreview');
  check('預覽標題已翻譯', preview.textContent.includes('Import preview'));
  check('狀態已翻譯（Ready to import）', preview.textContent.includes('Ready to import'));
  check('初始密碼標籤已翻譯', preview.textContent.includes('Initial password'));
  check('確認按鈕已翻譯', preview.textContent.includes('Confirm bulk onboarding'));
}

console.log(`\n=== 結果：${passed} 通過，${failed} 失敗 ===`);
process.exit(failed ? 1 : 0);
