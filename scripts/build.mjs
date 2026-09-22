// Vercel 部署產物包裝器（本地驗證用）：把「.vercelignore 之後真正會上 Vercel 的靜態檔」＋ 5 個
// serverless function 原樣組裝成 Build Output 結構，零打包依賴（function bundle 只複製 api/*.js
// 原檔，與 vercel.json 的部署行為一致）。
// 注意：產物寫入本地 .vercel-build/（gitignored）而唔係 .vercel/output —— Vercel 部署維持
// 傳統模式（vercel.json + .vercelignore，同 2026-09 前所有部署一致）；本腳本只係本地驗證
// 「呢個產物結構係咪正確、function 係咪獨立可運行」。若日後要改用 Build Output API 部署，
// 把 OUTPUT_DIR 改返 .vercel/output 前先喺 Preview 分支實測 Vercel 接受先。
// 用法：node scripts/build.mjs（npm run build）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.vercel-build');

// ---- .vercelignore 解釋（支援：dir/ 目錄、精確路徑、* glob）----
function loadIgnoreRules(rootDir) {
  const raw = fs.readFileSync(path.join(rootDir, '.vercelignore'), 'utf8');
  const rules = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.endsWith('/')) {
      rules.push({ type: 'dir', name: t.slice(0, -1) });
    } else if (t.includes('*')) {
      const re = new RegExp('^' + t.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      rules.push({ type: 'glob', re });
    } else {
      rules.push({ type: 'path', name: t });
    }
  }
  return rules;
}

function isExcluded(rel, rules) {
  const segments = rel.split(path.sep);
  for (const rule of rules) {
    if (rule.type === 'dir' && segments.includes(rule.name)) return true;
    if (rule.type === 'path' && (rel === rule.name || rel.startsWith(rule.name + path.sep))) return true;
    if (rule.type === 'glob' && (rule.re.test(rel) || rule.re.test(segments[segments.length - 1]))) return true;
  }
  return false;
}

// 5 個公開 endpoint（底線開頭的 _registry／_super 係內部模組，唔會建成 endpoint）
const FUNCTIONS = {
  health: ['_registry', '_super'],
  troops: ['_registry'],
  portal: ['_registry'],
  proxy: ['_registry', '_super'],
  'verify-super-ticket': ['_super']
};

export function build() {
  fs.rmSync(output, { recursive: true, force: true });
  const staticDir = path.join(output, 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  const rules = loadIgnoreRules(root);

  function copyDir(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const rel = path.relative(root, srcPath).split(path.sep).join('/');
      if (entry.name === '.vercelignore') continue; // 部署 metadata，唔部署
      if (entry.isDirectory() && srcDir === root && entry.name === 'api') continue; // api/ 只以 function bundle 形式部署，唔係靜態檔
      if (isExcluded(rel, rules)) continue;
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) copyDir(srcPath, destPath);
      else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
    }
  }
  copyDir(root, staticDir);

  for (const [name, deps] of Object.entries(FUNCTIONS)) {
    const dir = path.join(output, 'functions', 'api', name + '.func');
    fs.mkdirSync(dir, { recursive: true });
    for (const module of [name, ...deps]) {
      fs.copyFileSync(path.join(root, 'api', module + '.js'), path.join(dir, module + '.js'));
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
    fs.writeFileSync(path.join(dir, '.vc-config.json'), JSON.stringify({
      runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 60
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'index.mjs'), `import handler from './${name}.js';
export default function (req, res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); return res; };
  return handler(req, res);
}
`);
  }

  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({
    version: 3,
    routes: [
      { src: '^/api/(proxy|troops|portal|health|verify-super-ticket)(?:\\.js)?/?$', dest: '/api/$1' },
      { src: '^/$', dest: '/index.html' },
      { handle: 'filesystem' }
    ]
  }, null, 2));
  return output;
}

function size(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) =>
    sum + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
}

// 直接執行（非 import）先 output
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = build();
  console.log(`Vercel output: ${size(out)} bytes (static files + ${Object.keys(FUNCTIONS).length} functions; no dependencies).`);
}
