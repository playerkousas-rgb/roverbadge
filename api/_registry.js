// 伺服器端環境變數 Registry；不讀取或公開旅團 JSON。
// 刻意零內部依賴（唔 import 其他 api 模組）：本檔被 troops／portal／proxy／super 四個 function 共用，
// 亦被 tests/serverless-registry.test.mjs 複製到「只有 env、冇 scripts/」嘅模擬 lambda 單獨執行。
import { createHash, timingSafeEqual } from 'node:crypto';

// 已登記的 GAS /exec URL 白名單格式（只接受 HTTPS 正式部署 URL，不接受 /dev）
const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

// ===== /exec 網址正規化（GS 5.3.0）=====
// 同一個部署有幾種等價寫法，視乎帳戶類型由 ScriptApp.getService().getUrl() 回報：
//   標準（登記用）：  https://script.google.com/macros/s/<id>/exec
//   Workspace 帳戶：  https://script.google.com/a/macros/<域名>/s/<id>/exec
//   舊／手改寫法：    https://script.google.com/a/<域名>/macros/s/<id>/exec
// 登記字串（TROOP_{ID}_BACKEND）同 GAS 回報字串形式唔同時，直接字串比對會永遠失敗，
// 而且完全冇錯誤訊息講得出原因（用戶只見到「登入失敗」）。所以一律「正規化後再比較」。
// 注意：getUrl() 嘅回報值唔係「部署網址」嘅權威，正規化只用於比對，唔會用作顯示或回傳。
// 其他 host／解唔到嘅字串一律原樣回傳（fail-closed 由比對端把關，唔會放寬）。
export function canonicalBackendUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch (e) { return raw; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'script.google.com') return raw;
  let pathname = u.pathname;
  let m = pathname.match(/^\/a\/macros\/[^/]+(\/s\/.+)$/);
  if (m) pathname = '/macros' + m[1];
  else {
    m = pathname.match(/^\/a\/[^/]+(\/macros\/s\/.+)$/);
    if (m) pathname = m[1];
  }
  return u.protocol + '//' + u.hostname + pathname;
}

// 時序安全字串比對（與 api/_super.js 嘅密鑰比對同語義；本地實作以保持本檔零內部依賴）
const sha256Digest = (text) => createHash('sha256').update(String(text), 'utf8').digest();
function sameUrlText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = sha256Digest(a);
  const db = sha256Digest(b);
  return da.length === db.length && timingSafeEqual(da, db);
}

// 比對用嘅形式（尾斜線視同同一形式；只影響比對，不改寫任何已登記設定）
function compareForm(value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/\/+$/, '');
}

// 登記字串嘅等價形式集合（登記字串＋正規化字串）
export function backendForms(backend) {
  const forms = new Set();
  for (const v of [compareForm(backend), compareForm(canonicalBackendUrl(backend))]) {
    if (v) forms.add(v);
  }
  return [...forms];
}

// 驗票端比對：「登記字串」原樣接受，或者**兩邊正規化後相等**即接受
//（登記用標準寫法、GAS 回報 /a/macros/<域名>/s/<id>/exec，或者反過來，都算同一個部署）。
// 其餘一律拒絕：換部署 ID、改一個 byte、空字串、非 script.google.com 全部 fail-closed。
export function backendMatches(backend, supplied) {
  const p = compareForm(supplied);
  if (!p) return false;
  for (const form of backendForms(backend)) {
    if (sameUrlText(form, p)) return true;
  }
  const registeredCanonical = compareForm(canonicalBackendUrl(backend));
  const suppliedCanonical = compareForm(canonicalBackendUrl(p));
  if (!registeredCanonical || !suppliedCanonical) return false;
  return sameUrlText(registeredCanonical, suppliedCanonical);
}

// 正規化 origin：只接受 http/https，並用 URL.origin 統一（小寫 host、去掉 path / query / hash）
// 用於 portalOrigin（主系統網址）比對，容許管理員填 "https://hub.example/app/" 這類寫法。
export function normalizeOrigin(v){
  if(typeof v!=='string') return '';
  const s=v.trim();
  if(!s) return '';
  try{
    const u=new URL(s);
    if(u.protocol!=='http:' && u.protocol!=='https:') return '';
    return u.origin;
  }catch(e){ return ''; }
}

// TROOP_{ID}_PORTALDISABLED 開關判定：設咗呢個變數就當「停用」，
// 除非明確寫 0 / false / no / off（方便管理員臨時開返）。
function isDisabledFlag(v){
  if(v===true) return true;
  if(typeof v!=='string') return false;
  const s=v.trim().toLowerCase();
  if(!s) return false;
  return !['0','false','no','off'].includes(s);
}

// 把 "a, b ,c" / ["a","b"] 轉成乾淨的字串陣列
function parseRoleList(v){
  if(Array.isArray(v)) return v.map(x=>String(x||'').trim()).filter(Boolean);
  if(typeof v!=='string') return [];
  return v.split(',').map(x=>x.trim()).filter(Boolean);
}

// 本機測試專用：設 ROVERBADGE_PROXY_TEST=1 時允許 http://127.0.0.1|localhost 的 mock GAS。
// 絕對不會影響 Vercel 正式環境（正式環境不會設定此變數）。
const TEST_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\-/?=&%]*)?$/;

export function isTrustedExecUrl(url) {
  if (typeof url !== 'string' || url.length > 300) return false;
  if (EXEC_URL_RE.test(url.trim())) return true;
  if (process.env.ROVERBADGE_PROXY_TEST === '1' && process.env.VERCEL !== '1' && TEST_LOCAL_RE.test(url.trim())) return true;
  return false;
}

function envVar(...names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

// 每旅團三個必填變數：NAME / BACKEND / APIKEY；ID 保留前導零。
export function getRegistry() {
  const ids = new Set();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^TROOP_([0-9A-Za-z_-]{1,32})_(NAME|EN|BACKEND|APIKEY|PORTALORIGIN|PORTALROLES|PORTALDISABLED)$/);
    if (m) ids.add(m[1]);
  }
  const defaultOrigin = normalizeOrigin(envVar('PORTAL_DEFAULT_ORIGIN', 'ROVERBADGE_PORTAL_ORIGIN'));
  const defaultRoles = parseRoleList(envVar('PORTAL_DEFAULT_ROLES', 'ROVERBADGE_PORTAL_ROLES'));
  const out = Object.create(null);
  for (const id of ids) {
    const get = suffix => envVar(`TROOP_${id}_${suffix}`).trim();
    const backend = get('BACKEND');
    const roles = parseRoleList(get('PORTALROLES'));
    out[id] = {
      id, name: get('NAME'), en: get('EN'), backend, apikey: get('APIKEY'),
      backendTrusted: isTrustedExecUrl(backend),
      portalOrigin: normalizeOrigin(get('PORTALORIGIN')) || defaultOrigin,
      portalRoles: roles.length ? roles : defaultRoles,
      portalEnabled: !isDisabledFlag(get('PORTALDISABLED'))
    };
  }
  return out;
}

// Proxy 專用：只回傳通過 URL 白名單驗證的旅團
export function getTrustedTroop(id) {
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return null;
  const reg = getRegistry();
  const t = reg[id];
  if (!t || !t.name || !t.apikey || !t.backend || !t.backendTrusted) return null;
  return {
    id,
    name: t.name,
    en: t.en || '',
    backend: t.backend.trim().replace(/\/$/, ''),
    apikey: (t.apikey || '').trim(),
    portalOrigin: t.portalOrigin || '',
    portalRoles: t.portalRoles || [],
    portalEnabled: t.portalEnabled !== false
  };
}

// 前端旅團選擇器專用：只暴露 id + name，任何情況都不回傳 backend / apikey
export function listPublicTroops() {
  const reg = getRegistry();
  const out = Object.create(null);
  for (const [id, t] of Object.entries(reg)) {
    // 三項必填設定齊備，並通過後端 URL 白名單才列出
    // 白名單輸出：只給 id + 顯示名稱。backend / apikey / portalOrigin / portalRoles 一律不外洩。
    if (t.name && t.apikey && t.backendTrusted) out[id] = { name: t.name, en: t.en || '' };
  }
  return out;
}
