// Scout Admin GS 中央收件匣契約（與 ScoutBadge / vsbadge / cubsbadge 對齊）
//
// 所有 APP 嘅「新旅團接入申請」同「回報／意見」都送往同一個中央 Google Apps Script
// 收件匣。為方便各 APP 共用同一套 Vercel 環境變數命名，收件匣 URL 只要設定以下任何
// 一個（優先次序如下）即可；全部未設／空白才用內建預設 /exec：
//
//   SCOUT_ADMIN_API → ROVERBADGE_ADMIN_API → CUBSBADGE_ADMIN_API → SCOUTBADGE_ADMIN_API → DEFAULT
//
// 契約重點（同 Scout Admin GS 對接）：
//   - 申請 payload 固定 type: "apply"、appType: "roverbadge"（或 "cubsbadge"）
//   - URL 欄位只認 backendUrl（前端仍可送 scriptUrl，伺服器端映射，永不轉發 scriptUrl）
//   - troopId / backendUrl / apiKey 必填，缺漏即 400，唔會呼叫上游
//   - troopName 空白時補「第 {troopId} 旅」，令 Scout Admin 看板必定顯示卡片
//   - note 自動加 `[appType]` 標記（已加過唔會重複），令管理員一眼睇出邊個 APP 寄出
//   - 上游成功判斷：HTTP 2xx 且 status === 'success' 或 success === true
//   - 呢條公開路徑永遠唔需要、亦永遠唔會轉發 SUPER_KEY／superKey

// 內建預設收件匣（伺服器端常數，不由用戶輸入決定）
export const DEFAULT_ADMIN_API =
  'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';

// 與 ScoutBadge / vsbadge / cubsbadge 共用的環境變數名稱（依優先次序）
export const ADMIN_API_ENV_NAMES = [
  'SCOUT_ADMIN_API',
  'ROVERBADGE_ADMIN_API',
  'CUBSBADGE_ADMIN_API',
  'SCOUTBADGE_ADMIN_API'
];

// 本 APP 預設標記
export const APP_TYPE = 'roverbadge';

// 動態讀取（每次呼叫都重新讀 env，方便測試及 Redeploy 後即時生效）；一律 trim。
// 空白字串／只有空格視同未設定，會繼續試下一個名稱。
export function getAdminApiUrl() {
  for (const name of ADMIN_API_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return DEFAULT_ADMIN_API;
}

export function normalizeAppType(value, fallback = APP_TYPE) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'cubsbadge' || text === 'roverbadge' ? text : fallback;
}

// `[roverbadge] 原備註`／`[roverbadge]`；已經有同一標記就唔會重複加。
export function taggedNote(note, appType = APP_TYPE) {
  const tag = `[${normalizeAppType(appType)}]`;
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) return tag;
  if (text.toLowerCase().startsWith(tag.toLowerCase())) return text;
  return `${tag} ${text}`;
}

export function defaultTroopName(troopId) {
  return `第 ${troopId} 旅`;
}

function text(value, limit) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, limit);
}

// 建立送往 Scout Admin GS 的申請 payload。
// 前端格式完全不變（仍然送 scriptUrl），由呢層映射為 backendUrl 並丟棄 scriptUrl。
export function buildRegistrationPayload(data = {}, options = {}) {
  const appType = normalizeAppType(options.appType || data.appType);
  const troopId = text(data.troopId, 32);
  const backendUrl = text(data.backendUrl || data.scriptUrl, 300);
  const apiKey = text(data.apiKey, 120);
  const rawName = text(data.troopName, 100);
  const missing = [];
  if (!troopId) missing.push('troopId');
  if (!backendUrl) missing.push('backendUrl');
  if (!apiKey) missing.push('apiKey');
  return {
    ok: missing.length === 0,
    missing,
    payload: {
      type: 'apply',
      appType,
      troopId,
      // 空白旅團名會令 Scout Admin 看板略過唔顯示；統一補預設值保住卡片。
      troopName: rawName || defaultTroopName(troopId || '?'),
      backendUrl,
      apiKey,
      note: taggedNote(text(data.note, 500), appType)
    }
  };
}

// Scout Admin GS：成功回 { status: 'success', message }, 失敗回 { status: 'error' }。
// 亦兼容較舊／姊妹版本回 { success: true }。必須 HTTP 2xx 先算成功。
export function isAdminSuccess(httpStatus, result) {
  const code = Number(httpStatus);
  if (!Number.isFinite(code) || code < 200 || code > 299) return false;
  if (!result || typeof result !== 'object') return false;
  if (result.success === true) return true;
  return typeof result.status === 'string' && result.status.trim().toLowerCase() === 'success';
}
