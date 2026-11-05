// ROVERBOOK 用戶端 API — 成員手機紀錄冊（BOOK）專用的「唯讀＋申請」閘道
//
// 定位（ROVERBOOK 已合併到 main 的對接規格）：
//   ROVERBOOK 係成員自己擁有嘅紀錄冊前端；ROVERBADGE 係領袖統管後端。
//   BOOK 只可以「讀自己」＋「申請完成」，**永遠唔可以**寫入進度／批核自己。
//
// 對外契約（給 ROVERBOOK 伺服器端呼叫）：
//   GET  /api/roverbook?action=troops               → { troops: { id: { name, en } } }（只 id＋名稱）
//   POST /api/roverbook  { action, troopId, data }   action 只准：
//     · login            → { success, token, scoutId, ymis }（**剝除姓名／電郵**）
//     · logout           → { success }
//     · load             → 所有成員的進度／其他獎章／待批申請（**零個資**，由 BOOK 端自行過濾自己）
//     · requestComplete  → 建立 status:'pending'，由領袖在 ROVERBADGE 內 CONFIRM
//   其餘（save／saveOtherBadge／reviewRequest／addUser／exportUsers…）一律 **403 Forbidden**。
//
// 三條硬規則：
//   ① 零個人資料：回應經 sanitize 白名單，姓名／電郵／電話／地址／相片／簽名墨跡永不外流。
//      login 連姓名都剝走（BOOK 唔需要），只留 scoutId。
//   ② SCOUT ID 十位數前導零正規化：`81420` ⇄ `0000081420` 視為同一個人（比對一律用正規化值）；
//      GAS 端亦有同一套 `scoutNorm_()`，兩邊一致。
//   ③ 寫入只有一條路：requestComplete（status:'pending'）→ 領袖 CONFIRM。
//      BOOK 永遠改唔到「已完成」。
//
// 為何另外開 endpoint 而唔係喺 /api/proxy 加分支：
//   /api/proxy 係本系統前端的完整權限面（領袖可以 save／reviewRequest／管理帳戶）。
//   ROVERBOOK 只需要 4 個 action，用一個「只懂 4 件事」的細 endpoint 做介面，
//   比喺 proxy 加 client 判斷更難出錯（少了任何一條漏寫 403 的路徑）。

import { getTrustedTroop, listPublicTroops } from './_registry.js';

export const config = { maxDuration: 60 };

const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_DATA_BYTES = 200 * 1024;

// BOOK 只准呢四個 action（其餘一律 403，包括本系統前端的所有寫入動作）
const BOOK_ACTIONS = new Set(['login', 'logout', 'load', 'requestComplete']);
// 明確列出「已知但拒絕」的寫入動作，方便除錯同寫測試（403 而非 400）
const FORBIDDEN_ACTIONS = new Set([
  'save', 'saveOtherBadge', 'reviewRequest', 'reviewApplication', 'reviewLogRequest',
  'addUser', 'addMember', 'upsertUser', 'importUsers', 'exportUsers', 'resetPassword',
  'changePassword', 'deactivateUser', 'reactivateUser', 'updateUserProfile', 'deleteMember',
  'deleteUser', 'updateUserRole', 'updatePermissions', 'updateConfig', 'setScheme',
  'setLocalLogin', 'setAllowLocalLogin', 'saveLogRecord', 'deleteLogRecord', 'submitLogRequest',
  'apply', 'forgotPassword', 'requestPasswordReset', 'confirmPasswordReset',
  'bookSync', 'bookConfirm', 'bookAward', 'bookRoster', 'bookPending', 'bookPull',
  'getAllUsers', 'getApplications', 'getLogRecords', 'getPendingLogRequests',
  'submitRegistration', 'submitFeedback', 'getBranches', 'saveBranch', 'deleteBranch'
]);

// ---- SCOUT ID 正規化（與 Code.gs scoutNorm_ 同一套）----
// 10 位純數字 → 原樣；少於 10 位純數字 → 左補 0 到 10 位（81420 ⇄ 0000081420）；
// 其餘（領袖內部編號 L… 等）→ 去除不安全字元後回傳，最多 32 字。
function scoutNorm(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32);
  if (!raw) return '';
  if (/^\d{1,10}$/.test(raw)) return raw.padStart(10, '0');
  return raw;
}

// ---- 零個資 sanitizer ----
// 只留白名單欄位；任何未列出的欄位一律丟棄（fail-closed，唔係「剝走黑名單」）。
const NEVER_FIELDS = [
  'name', 'nameZh', 'nameEn', 'email', 'phone', 'address', 'dob', 'placeOfBirth',
  'bloodType', 'photo', 'signature', 'signatures', 'holderSignature', 'png', 'ink',
  'emergencyName', 'emergencyPhone', 'emergencyRelation', 'group', 'crew', 'district',
  'region', 'sponsoringAuthority', 'groupAddress', 'gsl', 'rsl', 'meetingPlace',
  'dateJoined', 'dateScoutMovement', 'issueDate', 'contact', 'remarks', 'remark',
  'password', 'password_hash', 'apikey', 'token', 'squad', 'branch', 'role'
];
function hasNeverField(obj, depth) {
  if (!obj || typeof obj !== 'object' || (depth || 0) > 6) return false;
  return Object.keys(obj).some((k) => {
    if (NEVER_FIELDS.indexOf(k) >= 0) return true;
    const v = obj[k];
    return v && typeof v === 'object' ? hasNeverField(v, (depth || 0) + 1) : false;
  });
}
// 遞迴剝走黑名單欄位（即使上游多回欄位，都唔會漏出去）
function stripNever(value, depth) {
  if ((depth || 0) > 8) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripNever(v, (depth || 0) + 1)).filter((v) => v !== undefined);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).forEach((k) => {
    if (NEVER_FIELDS.indexOf(k) >= 0) return;
    const v = stripNever(value[k], (depth || 0) + 1);
    if (v !== undefined) out[k] = v;
  });
  return out;
}
const ITEM_ID_RE = /^[A-Z]{1,3}[0-9]?(?:-[A-Z0-9]{1,12}){1,4}$/;

// login：只回 { success, token, scoutId, ymis }，姓名／電郵一律唔回
function sanitizeLogin(json) {
  if (!json || typeof json !== 'object') return json;
  const user = (json.user && typeof json.user === 'object') ? json.user : {};
  const scoutId = scoutNorm(user.ymis || json.ymis || '');
  const out = {
    success: json.success === true,
    token: typeof json.token === 'string' ? json.token : '',
    scoutId: scoutId,
    ymis: scoutId,            // 兼容舊名（同一個值，唔含任何個人資料）
    force_change_password: json.force_change_password === true,
    privacy: { personalData: 'none' }
  };
  if (json.success !== true) out.error = String(json.error || '登入失敗');
  return out;
}

// load：保留進度結構，但每個成員只留 itemId → { date, confirmer? }；姓名／電郵等一律唔回
function sanitizeLoad(json) {
  if (!json || typeof json !== 'object') return json;
  const progress = {};
  const srcProgress = (json.progress && typeof json.progress === 'object') ? json.progress : {};
  Object.keys(srcProgress).forEach((ymis) => {
    const sid = scoutNorm(ymis);
    if (!sid || !srcProgress[ymis] || typeof srcProgress[ymis] !== 'object') return;
    const items = {};
    Object.keys(srcProgress[ymis]).forEach((itemId) => {
      if (!ITEM_ID_RE.test(itemId)) return;
      const v = srcProgress[ymis][itemId];
      const date = String((v && typeof v === 'object' ? v.date : v) || '').slice(0, 20);
      if (!date) return;
      items[itemId] = { date: date };
      const confirmer = v && typeof v === 'object' ? String(v.confirmer || '').slice(0, 60) : '';
      if (confirmer) items[itemId].confirmer = confirmer; // 領袖姓名（唔係成員個資）
    });
    if (Object.keys(items).length) progress[sid] = items;
  });
  const other = {};
  const srcOther = (json.otherBadges && typeof json.otherBadges === 'object') ? json.otherBadges : {};
  Object.keys(srcOther).forEach((ymis) => {
    const sid = scoutNorm(ymis);
    if (!sid || !srcOther[ymis] || typeof srcOther[ymis] !== 'object') return;
    const items = {};
    Object.keys(srcOther[ymis]).forEach((id) => {
      const v = srcOther[ymis][id] || {};
      // 其他獎章只留 id / 日期 / 證書編號（cert 可能含個人資料 → 唔回）
      const date = String(v.date || '').slice(0, 20);
      if (!date) return;
      items[id] = { date: date };
    });
    if (Object.keys(items).length) other[sid] = items;
  });
  // 待批申請：只留 request_id / 項目 / 日期 / 狀態；姓名、證據、YMIS 以外一律唔回
  const pending = (Array.isArray(json.pendingRequests) ? json.pendingRequests : []).map((r) => ({
    request_id: String((r && r.request_id) || '').slice(0, 60),
    scoutId: scoutNorm(r && (r.ymis || r.scoutId)),
    item_id: String((r && r.item_id) || '').slice(0, 32),
    requested_date: String((r && r.requested_date) || '').slice(0, 20),
    status: String((r && r.status) || 'pending').slice(0, 16)
  })).filter((r) => r.scoutId && ITEM_ID_RE.test(r.item_id));
  return {
    success: json.success === true,
    scoutIdMode: 'roverbook',
    members: Object.keys(progress),          // 只有 SCOUT ID（BOOK 端自行過濾自己嗰個）
    progress: progress,
    otherBadges: other,
    pendingRequests: pending,
    schemes: (json.schemes && typeof json.schemes === 'object') ? json.schemes : {},
    schemeDefault: json.schemeDefault || 'new',
    gsVersion: String(json.gsVersion || '').slice(0, 20),
    privacy: { personalData: 'none', note: '姓名／電郵／電話／地址／相片／簽名墨跡永不出現在本回應' }
  };
}

// requestComplete：只確認「已建立 pending」，回最少資訊
function sanitizeRequestComplete(json) {
  if (!json || typeof json !== 'object') return json;
  const out = {
    success: json.success === true,
    status: json.success === true ? 'pending' : 'rejected',
    request_id: String(json.request_id || '').slice(0, 60),
    note: json.success === true ? '已交給領袖，需領袖在 ROVERBADGE 確認後才計入進度' : '',
    privacy: { personalData: 'none' }
  };
  if (json.success !== true) out.error = String(json.error || '申請未能建立');
  return out;
}

// 唔依賴 launcher 的 res.status()/res.json() shim：直接用 Node 原生 API，
// 令同一個 handler 喺 Vercel、本地 dev server、測試都可以原樣跑。
function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
  return res;
}
function safeLog(fields) {
  try { console.log(JSON.stringify({ svc: 'roverbadge-roverbook-api', ...fields })); } catch (e) { /* ignore */ }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  let parsed = null;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
  return parsed;
}

async function callUpstream(troop, { method, params, payload }) {
  const url = method === 'GET'
    ? troop.backend + (troop.backend.includes('?') ? '&' : '?') + new URLSearchParams(params).toString()
    : troop.backend;
  const response = await fetch(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: method === 'POST' ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
    body: method === 'POST' ? JSON.stringify(payload) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON（例如 GAS HTML 錯誤頁）*/ }
  return { status: response.status, json, raw: text };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  // ---- GET：旅團清單（只 id＋名稱，永不回 backend／apikey）----
  if (req.method === 'GET') {
    // Vercel 會提供 req.query，但原生 Node（本地 dev／測試）只有 req.url → 兩邊都要支援
    let query = req.query;
    if (!query) {
      try { query = Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams.entries()); }
      catch (e) { query = {}; }
    }
    const action = String(query.action || 'troops');
    if (action !== 'troops') {
      return sendJson(res, 400, { success: false, error: 'GET 只支援 action=troops' });
    }
    const troops = listPublicTroops();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify({
      success: true,
      troops: troops,
      privacy: { personalData: 'none', note: '只 id＋名稱；backend URL／API Key 永不公開' }
    }));
    return res;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { success: false, error: '此 API 只接受 GET（旅團清單）或 POST（指定 action）' });
  }

  const body = await readRawBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { success: false, error: '請求格式錯誤' });
  }
  const action = String(body.action || '');
  const troopId = String(body.troopId || '').trim();
  const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? { ...body.data } : {};

  // ① 白名單閘：已知寫入動作 → 403；未知動作 → 400
  if (!BOOK_ACTIONS.has(action)) {
    if (FORBIDDEN_ACTIONS.has(action)) {
      safeLog({ result: 'forbidden_action', action: action.slice(0, 40), troopId, ms: Date.now() - t0 });
      return sendJson(res, 403, {
        success: false,
        error: 'ROVERBOOK 只可以讀取及申請完成（login／logout／load／requestComplete）；直接寫入進度或批核一律禁止，請由領袖在 ROVERBADGE 確認。',
        action: action.slice(0, 40)
      });
    }
    return sendJson(res, 400, { success: false, error: '不支援的操作（ROVERBOOK 只准 login／logout／load／requestComplete）' });
  }

  // ③ payload 大小
  let dataBytes = 0;
  try { dataBytes = Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch (e) { dataBytes = MAX_DATA_BYTES + 1; }
  if (dataBytes > MAX_DATA_BYTES) return sendJson(res, 413, { success: false, error: '提交內容過大' });

  // ④ 逐 action 前處理
  if (action === 'login') {
    // 只准 YMIS／SCOUT ID＋密碼；任何其他欄位一律丟棄
    const loginId = scoutNorm(data.login_id || data.ymis || data.scoutId);
    if (!loginId) return sendJson(res, 400, { success: false, error: '請輸入 SCOUT ID（或 YMIS）' });
    if (typeof data.password !== 'string' || !data.password) return sendJson(res, 400, { success: false, error: '請輸入密碼' });
    data.login_id = loginId;
    ['ymis', 'scoutId', 'token', 'apikey', 'name', 'email', 'role'].forEach((k) => delete data[k]);
  } else if (action === 'logout') {
    if (typeof data.token !== 'string' || !data.token) return sendJson(res, 401, { success: false, error: '缺少登入憑證' });
  } else if (action === 'load') {
    if (typeof data.token !== 'string' || !data.token) return sendJson(res, 401, { success: false, error: '未登入或登入已過期' });
  } else if (action === 'requestComplete') {
    if (typeof data.token !== 'string' || !data.token) return sendJson(res, 401, { success: false, error: '未登入或登入已過期' });
    const itemId = String(data.item_id || data.itemId || '').trim();
    if (!ITEM_ID_RE.test(itemId)) return sendJson(res, 400, { success: false, error: '項目代號格式不正確' });
    // BOOK 唔可以自稱已完成、唔可以指定狀態：只保留最小欄位
    const clean = {
      action: 'requestComplete',
      token: data.token,
      item_id: itemId,
      item_name: String(data.item_name || data.itemName || itemId).slice(0, 80),
      requested_date: String(data.requested_date || data.date || '').slice(0, 20),
      evidence: String(data.evidence || '').slice(0, 200)
    };
    Object.keys(data).forEach((k) => delete data[k]);
    Object.assign(data, clean);
  }

  // ② 旅團解析（只由伺服器端 Registry，永不接受客戶端提供的 backend URL）
  // 放在輸入驗證之後：格式錯就 400（唔會因為旅團 id 打錯而被誤導成 404）
  const troop = getTrustedTroop(troopId);
  if (!troop) return sendJson(res, 404, { success: false, error: '找不到此旅團，或旅團後端設定無效' });

  // ⑤ 轉發（apikey 只由伺服器端加入）
  try {
    let up;
    const payload = { ...data, action };
    if (troop.apikey) payload.apikey = troop.apikey;
    up = await callUpstream(troop, { method: 'POST', payload });
    if (!up || !up.json) {
      safeLog({ result: 'upstream_bad_response', action, troopId, status: (up && up.status) || 0, ms: Date.now() - t0 });
      return sendJson(res, 502, { success: false, error: '旅團後端暫時無法使用，請稍後重試' });
    }
    let out;
    if (action === 'login') out = sanitizeLogin(up.json);
    else if (action === 'load') out = sanitizeLoad(up.json);
    else if (action === 'requestComplete') out = sanitizeRequestComplete(up.json);
    else out = { success: up.json.success === true };
    // 最後一道：任何個資欄位（就算上游多回）都唔會漏出去
    out = stripNever(out) || out;
    safeLog({ result: 'ok', action, troopId, status: up.status, ms: Date.now() - t0 });
    return sendJson(res, 200, out);
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    safeLog({ result: timeout ? 'upstream_timeout' : 'upstream_fetch_error', action, troopId, ms: Date.now() - t0 });
    return sendJson(res, timeout ? 504 : 502, { success: false, error: '旅團後端連線逾時，請稍後重試' });
  }
}

// 測試用：唔會對外 export 到 API，但 jest/node:test 可以直接讀
export const __internal = { scoutNorm, stripNever, hasNeverField, sanitizeLogin, sanitizeLoad, sanitizeRequestComplete, BOOK_ACTIONS, FORBIDDEN_ACTIONS, NEVER_FIELDS };
