// index.html 完整性測試 —— 防「登入頁出怪獸字」事故（2026-09）
//
// 背景：index.html 喺 `</html>` 之後被貼上一段殘缺重複嘅 JS（`inalRole=...`、
// 多個 `</script></body></html>` 殘骸）。瀏覽器會將 `</html>` 後嘅文字當成
// body 內容照樣 render —— 登入頁就出現一大嚿「怪獸字」，但頁面功能照常，
// 冇任何 console error，好難察覺點解。
// 本測試守住三條底線：
//   1) 檔案必須以 `</html>` 結尾，之後不可有任何內容
//   2) `<script>` / `</script>`、`<body>` / `</body>`、`<html>` / `</html>` 數量平衡
//   3) 每個 inline `<script>` block 都要過 node --check（語法完整，防半截貼上）
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

console.log('\n【1】檔案結尾：`</html>` 之後不可有任何殘留內容');
const lastEnd = html.lastIndexOf('</html>');
check('找到 `</html>`', lastEnd >= 0);
const tail = html.slice(lastEnd + '</html>'.length);
check('`</html>` 之後只有空白（無怪獸字）', tail.trim() === '', tail.trim() ? `殘留 ${tail.trim().length} 字：${JSON.stringify(tail.trim().slice(0, 80))}` : '');
check('檔案以 `</html>` 結尾（允許結尾換行）', /^\n?$/.test(tail));

console.log('\n【2】標籤平衡：html / body / script 開閉數量一致');
const count = (re) => (html.match(re) || []).length;
check('`<script` 開啟 = `</script>` 關閉', count(/<script\b/g) === count(/<\/script>/g), `open=${count(/<script\b/g)} close=${count(/<\/script>/g)}`);
check('`<body` 開啟 = `</body>` 關閉', count(/<body\b/g) === count(/<\/body>/g), `open=${count(/<body\b/g)} close=${count(/<\/body>/g)}`);
check('`<html` 開啟 = `</html>` 關閉', count(/<html\b/g) === count(/<\/html>/g), `open=${count(/<html\b/g)} close=${count(/<\/html>/g)}`);
check('`</html>` 只出現一次', count(/<\/html>/g) === 1);

console.log('\n【3】inline script 語法：每個 block 都要係完整 JS');
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).filter(b => b.trim() !== '');
check(`共 ${blocks.length} 個 inline script block`, blocks.length >= 1);
blocks.forEach((b, i) => {
  // .cjs：瀏覽器 inline script 係 classic script，用 CJS 語法檢查最接近
  //（repo package.json 有 "type":"module"，用 .js 會被當 ESM 檢查而誤報）
  const tmp = path.join(ROOT, `.html-integrity-blk${i}.js.tmp.cjs`);
  try {
    fs.writeFileSync(tmp, b);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    check(`script block #${i} 通過 node --check`, true);
  } catch (e) {
    check(`script block #${i} 通過 node --check`, false, String(e.stderr || e.message).split('\n')[0]);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
});

console.log('\n【4】版號對齊：UI 各處版本必須一致，且等於 package.json 版本');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const m = /^(\d+)\.(\d+)\./.exec(pkg.version);
  check(`package.json version 可解析（${pkg.version}）`, !!m);
  const pkgVer = m ? `v${m[1]}.${m[2]}` : '';

  const spots = [
    ['<title> 標題', /<title>樂行童軍進度追蹤系統 (v\d+\.\d+) - /.exec(html)],
    ['首頁 header 副標題', /<p>Rover Scout Progress Tracker (v\d+\.\d+) • /.exec(html)],
    ['登入頁 h1', />樂行童軍進度追蹤 (v\d+\.\d+)<\/h1>/.exec(html)],
    ['頁尾 COPYRIGHT', />COPYRIGHT 2026 Scout System • 樂行童軍進度追蹤系統 (v\d+\.\d+)<\/div>/.exec(html)],
    ['版本更新紀錄「最新」', />最新：(v\d+(?:\.\d+)?)</.exec(html)],
  ];
  const seen = new Set();
  for (const [name, mm] of spots) {
    check(`${name} 有版號`, !!mm, '未找到版號字串');
    if (mm) seen.add(mm[1]);
  }
  check(`UI 版號全部一致（${[...seen].join(' vs ')}）`, seen.size === 1);
  check(`UI 版號＝package.json 版號（${[...seen][0] || '?'} vs ${pkgVer}）`, seen.size === 1 && [...seen][0] === pkgVer);
  check('無舊版號殘留（v4.0／v4.2 UI 字串）', !/進度追蹤(系統)? v4\.\d/.test(html) && !/Tracker v4\.\d/.test(html));
  check('版號鍵有對應 i18n 英文翻譯（TSV 與 LANG_DICT 同步）', (() => {
    const tsv = fs.readFileSync(path.join(ROOT, 'i18n_dict.tsv'), 'utf8');
    const need = [`樂行童軍進度追蹤系統 ${pkgVer} - `, `樂行童軍進度追蹤 ${pkgVer}\t`, `COPYRIGHT 2026 Scout System • 樂行童軍進度追蹤系統 ${pkgVer}`];
    return need.every(s => tsv.includes(s)) && html.includes(`"COPYRIGHT 2026 Scout System • 樂行童軍進度追蹤系統 ${pkgVer}"`);
  })());
}

console.log('\n【5】Scout Admin 回報 · 意見按鈕 ＋ 非官方聲明');
{
  check('引入 scout-admin widget.js（統一回報格式 v1）',
    html.includes('<script src="https://scout-admin-blue.vercel.app/widget.js" data-app="進度追蹤"></script>'));
  check('openScoutReport() 已定義（開 widget modal，fallback report.html）',
    /function openScoutReport\(\)/.test(html) && html.includes("report.html?app='+encodeURIComponent('進度追蹤')"));
  check('widget 預設 FAB 已隱藏（改用本 APP 上方按鈕）', html.includes('#scoutw-fab{display:none!important}'));
  check('登入前（首頁 welcome-nav）有回報 · 意見按鈕', /<button class="welcome-feedback" onclick="openScoutReport\(\)"/.test(html));
  check('登入頁有回報 · 意見連結', /onclick="openScoutReport\(\);return false"/.test(html));
  check('登入後 header 常駐回報 · 意見按鈕', /class="lang-toggle btn-feedback-top" onclick="openScoutReport\(\)"/.test(html));
  check('頁尾有非官方聲明（並非香港童軍總會官方產品）', html.includes('⚠️ 非官方聲明：本系統為獨立開發的非官方工具，並非香港童軍總會官方產品'));
  check('頁尾已移除 All rights reserved／總會連結', !/All rights reserved/.test(html) && !/href="https:\/\/www\.scout\.org\.hk" target="_blank">香港童軍總會<\/a>/.test(html));
}

console.log('\n【6】下游 UI 已移除 ALLOW_LOCAL_LOGIN 直接入口掣（掣只由上游選單／sig／GAS 操作）');
{
  check('無 allowLocalLoginChk 開關', !html.includes('allowLocalLoginChk'));
  check('無 toggleAllowLocalLogin／refreshAllowLocalLogin 前端函數',
    !/function (toggleAllowLocalLogin|refreshAllowLocalLogin)/.test(html) && !html.includes('setTimeout(refreshAllowLocalLogin'));
  check('無「🔐 上下游控管：ALLOW_LOCAL_LOGIN」卡片', !html.includes('上下游控管：ALLOW_LOCAL_LOGIN'));
  check('前端不再呼叫 getAllowLocalLogin／setAllowLocalLogin',
    !html.includes("apiRequest('getAllowLocalLogin'") && !html.includes("apiRequest('setAllowLocalLogin'"));
  check('私隱設定卡片保留（allowMemberViewOthers 開關仍在）', html.includes('allowMemberViewOthers') && html.includes('🔒 私隱設定'));
  check('旅系統接駁資訊卡保留（講明掣由上游操作）', html.includes('直接入口開關（ALLOW_LOCAL_LOGIN）只由上游'));
}

console.log(`\n結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
