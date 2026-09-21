// 伺服器端可信旅團 Registry（只供 /api 內部使用，不會作為 endpoint 公開）
//
// v4.0：旅團登記唯一來源是 Vercel 環境變數，不再讀任何 JSON 檔案：
//   TROOP_{ID}_NAME       旅團顯示名稱（可留空，預設「第 {ID} 旅」）
//   TROOP_{ID}_BACKEND    旅團 GAS /exec URL（必須通過 isTrustedExecUrl 白名單）
//   TROOP_{ID}_APIKEY     旅團 API Key（只留在伺服器端，永不下發前端）
//   TROOP_{ID}_PORTALORIGIN / TROOP_{ID}_PORTALROLES / TROOP_{ID}_PORTALDISABLED
//                         Portal 接入設定（可選，見下）；另有全域 PORTAL_DEFAULT_ORIGIN / PORTAL_DEFAULT_ROLES
//
// 旅團編號 = 變數名稱中 TROOP_ 與 _BACKEND 之間的原文，前導零原樣保留：
//   TROOP_0082_* → 旅團「0082」；TROOP_82_* 是另一個旅團「82」，兩者不會混淆。
//
// safety: backend 必須通過 isTrustedExecUrl() 驗證，否則視為未登記。
// 前端只經 /api/troops 拿到 {id: {name}}，backend / apikey 任何情況都不出伺服器。

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

// ---- 環境變數解析 ----
// 旅團編號字元集與 /api/proxy 的 troopId 驗證一致：[0-9A-Za-z]{1,32}
const TROOP_ENV_RE = /^TROOP_([0-9A-Za-z]{1,32})_(NAME|BACKEND|APIKEY|PORTALORIGIN|PORTALROLES|PORTALDISABLED)$/;

function truthy(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

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
    envBackendTroops: Object.keys(process.env).filter(k => /^TROOP_[0-9A-Za-z]{1,32}_BACKEND$/.test(k)).sort(),
    portalDefaultOriginSet: !!process.env.PORTAL_DEFAULT_ORIGIN,
    portalDefaultRolesSet: !!process.env.PORTAL_DEFAULT_ROLES
  };
}

// 全域 Portal 預設值（主系統來源網址／允許角色；不是密碼、不是 GAS URL）
export function getPortalDefaults() {
  const out = {};
  const origin = String(process.env.PORTAL_DEFAULT_ORIGIN || '').trim().replace(/\/+$/, '');
  const roles = String(process.env.PORTAL_DEFAULT_ROLES || '').trim();
  if (origin) out.origin = origin;
  if (roles) out.roles = roles;
  return out;
}

// 合併環境變數，回傳 { [id]: {name, backend, apikey, backendTrusted, portal} }
export function getRegistry() {
  const raw = collectEnvTroops();
  const out = {};
  for (const [id, e] of Object.entries(raw)) {
    const backend = String(e.BACKEND || '').trim();
    const portal = {};
    const pOrigin = String(e.PORTALORIGIN || '').trim().replace(/\/+$/, '');
    const pRoles = String(e.PORTALROLES || '').trim();
    if (pOrigin) portal.origin = pOrigin;
    if (pRoles) portal.roles = pRoles;
    if (e.PORTALDISABLED !== undefined && truthy(e.PORTALDISABLED)) portal.disabled = true;
    out[id] = {
      name: String(e.NAME || '').trim() || `第 ${id} 旅`,
      backend,
      apikey: String(e.APIKEY || '').trim(),
      backendTrusted: isTrustedExecUrl(backend),
      portal
    };
  }
  return out;
}

// Proxy 專用：只回傳通過 URL 白名單驗證的旅團
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
  return { id, name: t.name, backend: t.backend.trim(), apikey: (t.apikey || '').trim(), portal: t.portal || {} };
}

// 前端旅團選擇器專用：只暴露 id + name（＋非機密的 Portal 接入設定），
// 任何情況都不回傳 backend / apikey
export function listPublicTroops() {
  const reg = getRegistry();
  const out = {};
  for (const [id, t] of Object.entries(reg)) {
    // 只有後端設定有效才列出
    if (t.backend && t.backendTrusted) {
      out[id] = { name: t.name };
      if (t.portal && Object.keys(t.portal).length) out[id].portal = t.portal;
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
