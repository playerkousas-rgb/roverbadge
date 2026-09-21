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

console.log(`\n結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
