// 產生 api/_troops_static.js —— Serverless Function 的「保底」旅團 Registry
//
// 背景（必看）：
//   Vercel 的 Node function 跑在 /var/task，只有「被 bundle 進去的檔案」才存在。
//   api/_registry.js 用 fs 讀 data/troops.json；除非 vercel.json 的 includeFiles 生效，
//   該檔案在 function 內並不存在 → registry 变空 → /api/troops 回 {}、
//   /api/proxy 對任何旅團都回 404「找不到此旅團」→ 全站無法登入。
//   本腳本把 data/troops.json 編譯成一個被 import 的 JS 模組，
//   import 一定被打包器跟隨，因此不依賴 includeFiles / fs，作為獨立可用的保底來源。
//
// 用法：
//   node scripts/sync-troops.mjs            # 重新產生（npm run build，Vercel build 時自動跑）
//   node scripts/sync-troops.mjs --check    # 只檢查是否同步（CI / npm test 用，不同步即 fail）

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'api', '_troops_static.js');
const CHECK = process.argv.includes('--check');

function readTroopFile(rel) {
  const p = path.join(ROOT, rel);
  try {
    if (!fs.existsSync(p)) return {};
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    return json && json.troops && typeof json.troops === 'object' ? json.troops : {};
  } catch (e) {
    console.error(`[sync-troops] 讀取失敗：${rel} → ${e.message}`);
    process.exit(1);
  }
}

// 與 api/_registry.js 相同的合併順序：data/troops.json 先，troops.json（根）後覆寫
const merged = { ...readTroopFile('data/troops.json'), ...readTroopFile('troops.json') };

const troops = {};
let strippedApikey = [];
for (const [id, entry] of Object.entries(merged)) {
  if (!entry || typeof entry !== 'object') continue;
  // apikey 屬機密，一律不寫進 JS bundle（正式來源是 Vercel 環境變數）
  if (entry.apikey) strippedApikey.push(id);
  const rec = {
    name: typeof entry.name === 'string' ? entry.name : `第 ${id} 旅`,
    backend: typeof entry.backend === 'string' ? entry.backend : ''
  };
  if (rec.backend) troops[id] = rec;
}
if (strippedApikey.length) {
  console.warn(`[sync-troops] ⚠️ 已忽略 troops.json 內的 apikey（旅團：${strippedApikey.join(', ')}）；apikey 請放 Vercel 環境變數`);
}

const ids = Object.keys(troops).sort();
const body =
  '// ⚠️ 自動產生，請勿手動修改：修改 data/troops.json（或 troops.json）後執行 `npm run build`\n' +
  '// 來源：scripts/sync-troops.mjs ｜ 用途：Serverless Function 內的旅團 Registry 保底來源\n' +
  `export const STATIC_TROOPS = ${JSON.stringify(troops, null, 2)};\n` +
  `export const STATIC_TROOPS_SOURCE = 'data/troops.json+troops.json';\n`;

if (CHECK) {
  let current = '';
  try { current = fs.readFileSync(OUT, 'utf8'); } catch (e) { /* 尚未產生 */ }
  if (current.replace(/^\/\/.*\n/gm, '') !== body.replace(/^\/\/.*\n/gm, '')) {
    console.error('[sync-troops] ❌ api/_troops_static.js 與 troops.json 不同步。請執行：npm run build');
    process.exit(1);
  }
  console.log(`[sync-troops] ✅ 已同步（旅團：${ids.length ? ids.join(', ') : '無'}）`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, body, 'utf8');
console.log(`[sync-troops] ✅ 已產生 api/_troops_static.js（旅團：${ids.length ? ids.join(', ') : '⚠️ 空'}）`);
if (!ids.length) console.warn('[sync-troops] ⚠️ 沒有任何有效旅團（backend 為空？），/api/proxy 將回 404');
