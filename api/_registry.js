// 伺服器端可信旅團 Registry（只供 /api 內部使用，不會作為 endpoint 公開）
// 資料來源（全部在伺服器端解析，前端永遠看不到 GAS URL）：
//   1. Vercel 環境變數 TROOP_{ID}_BACKEND / TROOP_{ID}_APIKEY（最高優先）
//   2. data/troops.json ／ troops.json（Git 內的公開 Registry；於 function 內需 vercel.json includeFiles 才讀到）
//   3. api/_troops_static.js（由 scripts/sync-troops.mjs 產生的保底來源，一定在 bundle 內）
// safety: backend 必須通過 isTrustedExecUrl() 驗證，否則視為未登記。
//
// ⚠️ 為何要有 2、3 兩條路徑（2026-08 全站登入失效的根因之一）：
//   Vercel Node function 的執行目錄是 /var/task，只有被 bundle 的檔案才存在。
//   從前只靠 fs 讀 data/troops.json，該檔在 function 內並不存在 → registry 空
//   → /api/troops 回 {}、/api/proxy 對所有旅團回 404，前端只看到「格式異常 (404)」。
//   現在：fs 讀不到時自動退回 bundle 內的靜態來源，兩者皆空才會 404。

import fs from 'fs';
import path from 'path';
import { STATIC_TROOPS, STATIC_TROOPS_SOURCE } from './_troops_static.js';

// 刻意唔使用 import.meta.url / __dirname：Vercel 嘅 Node builder 將 ESM 編譯成 lambda 時，
// import.meta 有機會爆「Cannot use 'import.meta' outside a module」而整次 build 失敗。
// lambda 內 process.cwd() 就係 /var/task（includeFiles 嘅檔案亦落喺度），所以 cwd 已經夠用；
// 需要指定別的位置時用 ROVERBADGE_PROJECT_ROOT（只供本機／測試）。

// 已登記的 GAS /exec URL 白名單格式（只接受 HTTPS 正式部署 URL，不接受 /dev）
const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

// 本機測試專用：設 ROVERBADGE_PROXY_TEST=1 時允許 http://127.0.0.1|localhost 的 mock GAS。
// 絕對不會影響 Vercel 正式環境（正式環境不會設定此變數）。
const TEST_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\-/?=&%]*)?$/;

export function isTrustedExecUrl(url) {
  if (typeof url !== 'string' || url.length > 300) return false;
  if (EXEC_URL_RE.test(url.trim())) return true;
  if (process.env.ROVERBADGE_PROXY_TEST === '1' && TEST_LOCAL_RE.test(url.trim())) return true;
  return false;
}

// function 內 process.cwd() === /var/task；本機 dev 時 === repo root。
// 兩者之外再試 __dirname 的相對位置，涵蓋 includeFiles 放進 lambda 後的各種落地路徑。
function candidateRoots() {
  const roots = [];
  const push = (r) => { if (r && !roots.includes(r)) roots.push(r); };
  const envRoot = process.env.ROVERBADGE_PROJECT_ROOT;
  push(envRoot ? path.resolve(envRoot) : null);
  push(process.cwd());                       // Vercel: /var/task（includeFiles 嘅 data/ 就喺呢度）
  push(path.resolve(process.cwd(), '..'));    // 万一 lambda cwd 落咗喺子目錄
  return roots;
}

function collectFileTroops() {
  const roots = candidateRoots();
  const merged = {};
  const hits = [];
  for (const root of roots) {
    // 每個 root 都依同樣順序：data/troops.json → troops.json（後者覆寫）
    for (const rel of [path.join('data', 'troops.json'), 'troops.json']) {
      const p = path.join(root, rel);
      try {
        if (!fs.existsSync(p)) continue;
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (json && json.troops && typeof json.troops === 'object') {
          Object.assign(merged, json.troops);
          if (!hits.includes(rel)) hits.push(rel);
        }
      } catch (e) {
        // 單一檔案損毀不影響其他來源；只在伺服器 log 提示
        console.warn('[registry] read troops file failed:', p);
      }
    }
    if (Object.keys(merged).length) break; // 已在某 root 找到，不再試其他 root
  }
  return { troops: merged, hits };
}

function envVar(...names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

// ---- 檔案讀取結果做短 TTL 快取（避免每個 request 都讀磁碟；env 每次照樣覆寫）----
let cache = null; // { at, fileTroops, source }
const CACHE_TTL_MS = (() => {
  const v = parseInt(process.env.ROVERBADGE_REGISTRY_TTL_MS || '30000', 10);
  return Number.isNaN(v) ? 30000 : Math.max(0, v);
})();

function fileTroopsWithSource() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  const { troops, hits } = collectFileTroops();
  const usedFile = Object.keys(troops).length > 0;
  const out = usedFile
    ? { at: Date.now(), fileTroops: troops, source: `file:${hits.join(',')}` }
    : {
        at: Date.now(),
        fileTroops: (STATIC_TROOPS && typeof STATIC_TROOPS === 'object') ? STATIC_TROOPS : {},
        source: (STATIC_TROOPS && Object.keys(STATIC_TROOPS).length) ? `static:${STATIC_TROOPS_SOURCE}` : 'none'
      };
  cache = out;
  return out;
}

// 供 /api/health 與測試使用：回傳解析來源等除錯資訊（不含任何機密）
export function getRegistryDiagnostics() {
  const { at, fileTroops, source } = fileTroopsWithSource();
  return {
    cwd: process.cwd(),
    rootsTried: candidateRoots(),
    fileTroopsFound: Object.keys(fileTroops).length,
    staticTroopsFound: Object.keys((STATIC_TROOPS && typeof STATIC_TROOPS === 'object') ? STATIC_TROOPS : {}).length,
    source,
    cachedMs: Math.max(0, CACHE_TTL_MS - (Date.now() - at)),
    envBackendTroops: Object.keys(process.env).filter(k => /^TROOP_[0-9A-Za-z]+_BACKEND$/i.test(k)).sort()
  };
}

// 合併檔案/靜態保底 + 環境變數，回傳 { [id]: {name, backend, apikey, backendTrusted} }
export function getRegistry() {
  const { fileTroops } = fileTroopsWithSource();
  const idsFromEnv = new Set();
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^TROOP_([0-9A-Za-z]+)_(BACKEND|APIKEY)$/i);
    if (m) idsFromEnv.add(m[1]);
  }

  const allIds = new Set([...Object.keys(fileTroops), ...idsFromEnv]);
  const out = {};
  for (const id of allIds) {
    const fileEntry = fileTroops[id] || {};
    const idUpper = String(id).toUpperCase();
    const idNoZero = String(id).replace(/^0+/, '') || String(id);
    const backend =
      envVar(`TROOP_${id}_BACKEND`, `TROOP_${idUpper}_BACKEND`, `TROOP_${idNoZero}_BACKEND`) ||
      fileEntry.backend || '';
    const apikey =
      envVar(`TROOP_${id}_APIKEY`, `TROOP_${idUpper}_APIKEY`, `TROOP_${idNoZero}_APIKEY`) ||
      fileEntry.apikey || '';
    const name = fileEntry.name || `第 ${id} 旅`;
    out[id] = {
      name,
      backend,
      apikey,
      backendTrusted: isTrustedExecUrl(backend)
    };
  }
  return out;
}

// Proxy 專用：只回傳通過 URL 白名單驗證的旅團
export function getTrustedTroop(id) {
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return null;
  const reg = getRegistry();
  const t = reg[id];
  if (!t || !t.backend || !t.backendTrusted) return null;
  return { id, name: t.name, backend: t.backend.trim(), apikey: (t.apikey || '').trim() };
}

// 前端旅團選擇器專用：只暴露 id + name，任何情況都不回傳 backend / apikey
export function listPublicTroops() {
  const reg = getRegistry();
  const out = {};
  for (const [id, t] of Object.entries(reg)) {
    // 只有後端設定有效才列出
    if (t.backend && t.backendTrusted) {
      out[id] = { name: t.name };
    }
  }
  return out;
}

// 僅供 /api/health 除錯用：回傳旅團 + 上游 host，絕不含 apikey / 完整 URL
export function listTroopHealth() {
  const reg = getRegistry();
  return Object.entries(reg).map(([id, t]) => {
    let host = '';
    try { host = t.backend ? new URL(t.backend).host : ''; } catch (e) { host = 'invalid'; }
    return { id, name: t.name, backendHost: host, backendTrusted: !!t.backendTrusted, apikeyConfigured: !!t.apikey };
  });
}
