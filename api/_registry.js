// 伺服器端可信旅團 Registry（只供 /api 內部使用，不會作為 endpoint 公開）
//
// v4.0：旅團登記唯一來源是 Vercel 環境變數，不再讀任何 JSON 檔案：
//   TROOP_{ID}_NAME       旅團顯示名稱（可留空，預設「第 {ID} 旅」）
//   TROOP_{ID}_EN         旅團英文名稱（可選；英文介面顯示，例：82nd Group）
//   TROOP_{ID}_BACKEND    旅團 GAS /exec URL（必須通過 isTrustedExecUrl 白名單）
//   TROOP_{ID}_APIKEY     旅團 API Key（只留在伺服器端，永不下發前端）
//   TROOP_{ID}_PORTALORIGIN / TROOP_{ID}_PORTALROLES / TROOP_{ID}_PORTALDISABLED
//                         Portal 接入例外設定（可選；見 docs/PORTAL_INTEGRATION.md）
// 全域 Portal 預設（所有旅團共用同一個主系統前端時只設呢兩條）：
//   PORTAL_DEFAULT_ORIGIN / PORTAL_DEFAULT_ROLES
//
// 旅團編號 = 變數名稱中 TROOP_ 與後綴之間的原文，前導零原樣保留：
//   TROOP_0082_* → 旅團「0082」；TROOP_82_* 是另一個旅團「82」，兩者不會混淆。
//
// safety: backend 必須通過 isTrustedExecUrl() 驗證，否則視為未登記。
// 前端只經 /api/troops 拿到 {id: {name, en}}，backend / apikey / Portal 設定
// 任何情況都不出伺服器（Portal 免登入改由 /api/portal 在伺服器端驗證）。

// 已登記的 GAS /exec URL 白名單格式（只接受 HTTPS 正式部署 URL，不接受 /dev）
const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

// 本機測試專用：設 ROVERBADGE_PROXY_TEST=1 時允許 http://127.0.0.1|localhost 的 mock GAS。
// 雙重保護：只要跑在 Vercel（VERCEL=1，正式與 Preview 部署皆然）就必定失效，
// 因此即使誤把這個 env 加到 Vercel 專案，也不會在生產環境開洞。
const TEST_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\-/?=&%]*)?$/;

export function isTrustedExecUrl(url) {
  if (typeof url !== 'string' || url.length > 300) return false;
  if (EXEC_URL_RE.test(url.trim())) return true;
  if (process.env.ROVERBADGE_PROXY_TEST === '1' && process.env.VERCEL !== '1' && TEST_LOCAL_RE.test(url.trim())) return true;
  return false;
}

// 正規化 origin：只接受 http/https，並用 URL.origin 統一（小寫 host、去掉 path / query / hash）
// 用於 portalOrigin（主系統網址）比對，容許管理員填 "https://hub.example/app/" 這類寫法。
export function normalizeOrigin(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch (e) { return ''; }
}

// TROOP_{ID}_PORTALDISABLED 開關判定：設咗呢個變數就當「停用」，
// 除非明確寫 0 / false / no / off（方便管理員臨時開返）。
function isDisabledFlag(v) {
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  if (!s) return false;
  return !['0', 'false', 'no', 'off'].includes(s);
}

// 把 "a, b ,c" / ["a","b"] 轉成乾淨的字串陣列
function parseRoleList(v) {
  if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean);
  if (typeof v !== 'string') return [];
  return v.split(',').map(x => x.trim()).filter(Boolean);
}

// ---- 環境變數解析 ----
// 旅團編號字元集與 /api/proxy 的 troopId 驗證一致：[0-9A-Za-z_-]{1,32}
//（後綴錨定在結尾，貪婪匹配不會誤食 _PORTAL* 等後綴）
const TROOP_ENV_RE = /^TROOP_([0-9A-Za-z_-]{1,32})_(NAME|EN|BACKEND|APIKEY|PORTALORIGIN|PORTALROLES|PORTALDISABLED)$/;

// 每次呼叫都重新掃描 process.env（Vercel env 在 function 生命週期內固定，掃描成本可忽略；
// 本機測試可以在 import 後再注入 env，行為與正式環境一致）。
function collectEnvTroops() {
  const raw = {};
  for (const k of Object.keys(process.env)) {
    const m = k.match(TROOP_ENV_RE);
    if (!m) continue;
    const id = m[1];
    if (!raw[id]) raw[id] = {};
    raw[id][m[2]] = process.env[k];
  }
  return raw;
}

// 供 /api/health 與測試使用：回傳解析來源等除錯資訊（不含任何機密）
export function getRegistryDiagnostics() {
  const raw = collectEnvTroops();
  return {
    source: Object.keys(raw).length ? 'env' : 'none',
    troopsFound: Object.keys(raw).length,
    envBackendTroops: Object.keys(process.env).filter(k => /^TROOP_[0-9A-Za-z_-]{1,32}_BACKEND$/.test(k)).sort(),
    portalDefaultOriginSet: !!process.env.PORTAL_DEFAULT_ORIGIN,
    portalDefaultRolesSet: !!process.env.PORTAL_DEFAULT_ROLES
  };
}

// 合併環境變數，回傳 { [id]: {name, en, backend, apikey, backendTrusted,
//                             portalOrigin, portalRoles, portalEnabled} }
// Portal 優先次序：個別旅團 env → 全域 PORTAL_DEFAULT_* env（不再讀取 JSON）
export function getRegistry() {
  const raw = collectEnvTroops();
  const defaultOrigin = normalizeOrigin(process.env.PORTAL_DEFAULT_ORIGIN || '');
  const defaultRoles = parseRoleList(process.env.PORTAL_DEFAULT_ROLES || '');
  const out = {};
  for (const [id, e] of Object.entries(raw)) {
    const backend = String(e.BACKEND || '').trim();
    const roles = parseRoleList(e.PORTALROLES || '');
    out[id] = {
      name: String(e.NAME || '').trim() || `第 ${id} 旅`,
      en: String(e.EN || '').trim(),
      backend,
      apikey: String(e.APIKEY || '').trim(),
      backendTrusted: isTrustedExecUrl(backend),
      portalOrigin: normalizeOrigin(e.PORTALORIGIN || '') || defaultOrigin,
      portalRoles: roles.length ? roles : defaultRoles,
      portalEnabled: !isDisabledFlag(e.PORTALDISABLED || '')
    };
  }
  return out;
}

// Proxy／Portal 專用：只回傳通過 URL 白名單驗證的旅團
//（與姊妹系統 vsbadge 的刻意差異：roverbadge 容許旅團未設 NAME／APIKEY——
// NAME 缺省用「第 {ID} 旅」；APIKEY 缺省時 proxy 沿用前端舊值，人類仍靠登入 token 防護。
// 詳見 VERCEL_ENV_SETUP.md 常見問答。）
export function getTrustedTroop(id) {
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return null;
  const reg = getRegistry();
  // 精確匹配優先（前導零／大小寫原樣保留）；找不到才做大小寫不敏感後備
  let t = reg[id];
  if (!t) {
    const lower = id.toLowerCase();
    const hit = Object.keys(reg).find(k => k.toLowerCase() === lower);
    if (hit) t = reg[hit];
  }
  if (!t || !t.backend || !t.backendTrusted) return null;
  return {
    id,
    name: t.name,
    en: t.en || '',
    backend: t.backend.trim(),
    apikey: (t.apikey || '').trim(),
    portalOrigin: t.portalOrigin || '',
    portalRoles: t.portalRoles || [],
    portalEnabled: t.portalEnabled !== false
  };
}

// 前端旅團選擇器專用：只暴露 id + 顯示名稱（＋英文名稱），
// 任何情況都不回傳 backend / apikey / Portal 設定
export function listPublicTroops() {
  const reg = getRegistry();
  const out = {};
  for (const [id, t] of Object.entries(reg)) {
    // 只有後端設定有效才列出
    if (t.backend && t.backendTrusted) {
      out[id] = { name: t.name, en: t.en || '' };
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
