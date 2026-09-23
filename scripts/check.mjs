// 結構檢查（快、無需起 server）：語法＋測試鏈完整＋部署瘦身底線
// 用法：node scripts/check.mjs（npm test 會先跑佢，fail fast）
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

console.log('\n【1】JS 語法：api／tests／scripts＋Code.gs＋appsscript.json');
{
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js')).map(f => `api/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.mjs')).map(f => `tests/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.mjs')).map(f => `scripts/${f}`)
  ];
  check(`共 ${files.length} 個 JS 檔要檢查`, files.length >= 10);
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
      check(`${f} 語法 OK`, true);
    } catch (e) {
      check(`${f} 語法 OK`, false, String(e.stderr || e.message).slice(0, 200));
    }
  }
  // Code.gs 是 classic script（無 import/export）：用 .cjs 副本過 node --check
  const tmp = path.join(ROOT, '.check-codegs.tmp.cjs');
  try {
    fs.copyFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), tmp);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    check('apps-script/Code.gs 語法 OK', true);
  } catch (e) {
    check('apps-script/Code.gs 語法 OK', false, String(e.stderr || e.message).slice(0, 200));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'apps-script', 'appsscript.json'), 'utf8'));
    check('apps-script/appsscript.json 可解析', true);
  } catch (e) {
    check('apps-script/appsscript.json 可解析', false, String(e.message).slice(0, 120));
  }
}

console.log('\n【2】測試鏈完整：每個測試檔都要喺 npm test 跑到');
{
  const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const chain = pk.scripts.test || '';
  const testFiles = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(f => f.endsWith('.test.mjs') || f === 'run-e2e.mjs')
    .sort();
  check(`共 ${testFiles.length} 個測試檔`, testFiles.length >= 5);
  for (const f of testFiles) {
    check(`npm test 包含 tests/${f}`, chain.includes(`tests/${f}`));
  }
}

console.log('\n【3】部署瘦身底線：Build Output 只出靜態白名單＋內部文件不上線');
{
  check('.vercelignore 唔准存在（Build Output 模式會連 scripts/ 一齊剝走，破壞 build 鏈）',
    !fs.existsSync(path.join(ROOT, '.vercelignore')));
  const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
  for (const pat of ['AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md', 'DEPLOY_GUIDE_V5_DUALTRACK.md', 'MAIN_SYSTEM_INTEGRATION.md', 'VERCEL_API_404_POSTMORTEM.md', 'TROOP_UPGRADE_2026.md']) {
    check(`build.mjs 內部排除清單包含 ${pat}`, buildSrc.includes(pat));
  }
  check('build.mjs 靜態白名單只含 index.html/assets/data/docs/apps-script（tests／字典源碼唔上線）',
    /for \(const file of \['index\.html', 'assets', 'data', 'docs', 'apps-script'\]\)/.test(buildSrc));
}

console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
