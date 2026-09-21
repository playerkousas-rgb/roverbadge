// 輕量 lint（grep 式，零依賴）：攔截常見意外，不做風格審查
// 用法：node scripts/lint.mjs（npm run lint；唔入 npm test 鏈，避免風格問題擋功能測試）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function walk(dir, exts) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some(e => f.name.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p);

console.log('\n【1】無 TODO／FIXME／XXX 殘留標記');
{
  const files = [
    ...walk(path.join(ROOT, 'api'), ['.js']),
    ...walk(path.join(ROOT, 'apps-script'), ['.gs']),
    ...walk(path.join(ROOT, 'tests'), ['.mjs']),
    ...walk(path.join(ROOT, 'scripts'), ['.mjs']),
    path.join(ROOT, 'index.html')
  ].filter(f => path.basename(f) !== 'lint.mjs'); // linter 自身含關鍵字樣本，豁免
  let dirty = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (/\b(TODO|FIXME|XXX)\b/.test(src)) dirty.push(rel(f));
  }
  check('無殘留標記', dirty.length === 0, dirty.join(','));
}

console.log('\n【2】無行尾空格（api／tests／scripts；Code.gs＋index.html 歷史包袱豁免）');
{
  const files = [
    ...walk(path.join(ROOT, 'api'), ['.js']),
    ...walk(path.join(ROOT, 'tests'), ['.mjs']),
    ...walk(path.join(ROOT, 'scripts'), ['.mjs'])
  ];
  let dirty = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const bad = lines.map((l, i) => (/[ \t]+$/.test(l) ? i + 1 : 0)).filter(Boolean);
    if (bad.length) dirty.push(`${rel(f)}:L${bad.slice(0, 3).join(',')}`);
  }
  check('無行尾空格', dirty.length === 0, dirty.join(' '));
}

console.log('\n【3】api／內無直接 console.log 密碼類變數（要用 safeLog／metadata 模式）');
{
  const files = walk(path.join(ROOT, 'api'), ['.js']);
  let dirty = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // 註解唔算
    if (/console\.(log|error|warn)\s*\([^)]*(password|passwd|apikey|api_key|secret|token)[^)]*\)/i.test(src)) {
      dirty.push(rel(f));
    }
  }
  check('無可疑 log', dirty.length === 0, dirty.join(','));
}

console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
