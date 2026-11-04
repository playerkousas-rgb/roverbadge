// Vercel 同源 Proxy — 多旅團 GAS 安全轉發層
//
// 架構：
//   瀏覽器 ──同源 POST──▶ /api/proxy ──伺服器端──▶ 已登記旅團的 GAS /exec ──▶ Google Sheet
//
// 安全原則：
//   1. 前端只提交 troopId，永不提交後端 URL（杜絕 SSRF / Open Proxy）
//   2. GAS URL 全部由伺服器端可信 Registry（TROOP_* env）解析
//   3. 只接受白名單 HTTPS GAS /exec URL（見 api/_registry.js isTrustedExecUrl）
//   4. 只接受 action 白名單；寫入／讀取類 action 必須附帶 token 字串（真偽由 GAS 驗證）
//   5. 永不在 log 記錄 token／密碼／apikey／payload 內容
//
// 中央管理帳號登入（見 api/_super.js／api/super.js）：
//   - 密碼只在 Vercel 驗證（SUPER_KEY）；通過先簽發 60 秒加密票據（vs 同構 rbs1.，綁定旅團＋backend＋apikey）
//   - GAS 向固定受信端點 /api/super 驗票通過後先發 token；密碼永不出現在 GAS／Sheet／URL／log
//   - 回傳瀏覽器的 session 有加密包裝並綁定旅團（rbs1.），跨旅團用唔到
//
// GAS request schema 完全保留（action + 原欄位），一般旅團帳號流程不需修改任何 Code.gs。

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { getTrustedTroop, isTrustedExecUrl } from './_registry.js';
import { accountId, isSuperId, checkSuperPassword, superConfigured, sealSuper, openSuper } from './_super.js';
import { APP_TYPE, buildRegistrationPayload, getAdminApiUrl, isAdminSuccess } from './_admin.js';

export const config = { maxDuration: 60 };

const SUPER_SESSION_PURPOSE = 'roverbadge-super-session-v1';
const LINK_SIG_PURPOSE = 'roverbadge-troop-sig-v1';
const SIGNED_ACTION_MAP = {
  getAllowLocalLogin: 'getLinkState',
  setAllowLocalLogin: 'setLocalLogin'
};
const LINK_SIG_SUPPORTED = new Set([
  'load', 'getLoginMode', 'getLinkState', 'getMembers', 'getConfig', 'getAllUsers',
  'getOtherBadges', 'getPendingRequests', 'getApplications', 'getLogRecords', 'getPendingLogRequests',
  'exportUsers', 'save', 'saveOtherBadge', 'requestComplete', 'reviewRequest', 'addMember', 'addUser',
  'upsertUser', 'importUsers', 'resetPassword', 'deactivateUser', 'reactivateUser',
  'updateUserProfile', 'deleteMember', 'deleteUser', 'updateUserRole', 'updatePermissions',
  'updateConfig', 'saveLogRecord', 'deleteLogRecord', 'submitLogRequest', 'reviewLogRequest',
  'reviewApplication', 'setLocalLogin', 'setScheme', 'bookRoster', 'bookSync', 'bookAward', 'bookPull'
]);

function buildSuperInnerToken(apikey) {
  return 'rbs-super-v1-' + createHmac('sha256', String(apikey || '')).update(SUPER_SESSION_PURPOSE, 'utf8').digest('hex');
}

function buildSuperUser() {
  return {
    ymis: accountId,
    name: '系統管理員',
    email: `${accountId}@roverbadge.local`,
    role: 'super_admin',
    can_tick: true,
    branch: '',
    squad: '',
    squad_role: 'member',
    allowed_badges: '*',
    status: 'active'
  };
}

function makeLinkSig(action, rawPayload, apikey) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const digest = createHash('sha256').update(String(rawPayload || ''), 'utf8').digest('hex');
  const canonical = [String(action || ''), ts, nonce, digest].join('\n');
  const sigKey = createHmac('sha256', String(apikey || '')).update(LINK_SIG_PURPOSE, 'utf8').digest('hex');
  const sig = createHmac('sha256', sigKey).update(canonical, 'utf8').digest('hex');
  return { sig, ts, nonce };
}

// ---- 可調參數（皆可由 Vercel env 覆寫）----
const UPSTREAM_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.ROVERBADGE_PROXY_TIMEOUT_MS || '45000', 10);
  if (Number.isNaN(v)) return 45000;
  return Math.max(1000, Math.min(55000, v));
})();
const MAX_DATA_BYTES = 2 * 1024 * 1024; // 單次請求 data 上限 (2MB)

// 中央管理員收件匣（新旅團接入申請／回報）。URL 由 api/_admin.js 動態解析
// （SCOUT_ADMIN_API → ROVERBADGE_ADMIN_API → CUBSBADGE_ADMIN_API → SCOUTBADGE_ADMIN_API → 內建預設），
// 目的地永遠是伺服器端常數，不由用戶輸入決定。

// ---- action 白名單（對照 Code.gs doGet/doPost）----
// 公開（無需 token）
// ecStatus：只回 GS 版本與初始化標記（不含用戶資料），供「最新版本公告」核對
// 公開（無需 token）。requestPasswordReset／confirmPasswordReset 係「忘記密碼」登入前入口：
// 授權完全靠寄到登記電郵嘅一次性重設碼，唔靠 session token，所以列為公開（同 login／apply 一樣）。
const PUBLIC_ACTIONS = new Set(['login', 'apply', 'forgotPassword', 'requestPasswordReset', 'confirmPasswordReset', 'getLoginMode', 'ecStatus']);
// 需要登入 token 的旅團內操作
const TOKEN_ACTIONS = new Set([
  'logout', 'load', 'getConfig', 'getMembers', 'getOtherBadges',
  'save', 'saveOtherBadge', 'requestComplete', 'setScheme',
  'getPendingRequests', 'reviewRequest',
  'getLogRecords', 'saveLogRecord', 'deleteLogRecord',
  'getPendingLogRequests', 'submitLogRequest', 'reviewLogRequest',
  'getAllUsers', 'addMember', 'addUser',
  'resetPassword', 'changePassword', 'deactivateUser',
  'reactivateUser', 'updateUserProfile', 'deleteMember', 'deleteUser',
  'getApplications', 'reviewApplication',
  'updateUserRole', 'updatePermissions', 'updateConfig',
  // 旅系統升級：支部與上下游接入（與進度追蹤成對；上游控下游寫）
  'getBranches', 'saveBranch', 'deleteBranch',
  'getAllowLocalLogin', 'setAllowLocalLogin',
  // 吐 JSON（搬舊數）：含 hash 直插
  'exportUsers', 'upsertUser',
  // ROVERBOOK 對接（GS 5.4.0）：成員手機 ↔ 領袖統管（只交換進度，零個資）
  //   bookRoster／bookAward／bookSync 需領袖；bookPull 只回 token 本人的進度
  'bookRoster', 'bookSync', 'bookAward', 'bookPull'
]);
// 上游 sig 直通可替代 token 的操作（閂口後經 sig 落下游寫）
const SIG_ACTIONS = new Set(['addUser','upsertUser','addMember','exportUsers','getBranches','saveBranch','deleteBranch','getAllowLocalLogin','setAllowLocalLogin']);
// Proxy 內部特殊 action（不轉發去旅團 GAS）
const LOCAL_ACTIONS = new Set(['submitRegistration', 'submitFeedback']);
// GAS 端以 doGet 處理的 action（其餘一律 POST 去 doPost）
const GET_ACTIONS = new Set(['load', 'getLoginMode', 'ecStatus']);

function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

function safeLog(fields) {
  // 只記錄 metadata，絕不記錄 token／密碼／apikey／payload
  try { console.log(JSON.stringify({ svc: 'roverbadge-proxy', ...fields })); } catch (e) { /* ignore */ }
}

// ---- 慢密碼操作觀測（GS 5.4.0，對齊 scoutbadge 6.4.0）----
// 背景：GS 5.2.x–5.3.0 每次登入做 120,000 次 PBKDF2（Apps Script 每次 HMAC 都要過 JS↔Java 邊界），
// 成功登入更做 2×、密碼錯就掃全表 → 撞爆上游 45 秒上限，用戶只見到「後端服務連線逾時」。
// GS 5.4.0 起改為 10,000 次 + 單行定位，正常 1–3 秒。呢度對慢過 8 秒嘅密碼類 action 額外寫一行：
//   [proxy] slow_password_kdf troop=<id> action=login duration=<ms>
// 一行就認得出「邊個旅團仲未更新」，唔需要逐個問。只記 metadata，永不記帳號或密碼。
const PASSWORD_ACTIONS = new Set(['login', 'changePassword', 'resetPassword', 'forgotPassword', 'requestPasswordReset', 'confirmPasswordReset', 'addUser', 'upsertUser']);
const SLOW_PASSWORD_LOG_MS = 8000;
function logSlowPassword(action, troopId, ms) {
  if (!PASSWORD_ACTIONS.has(action)) return;
  if (!(ms >= SLOW_PASSWORD_LOG_MS)) return;
  safeLog({ result: 'slow_password_kdf', troop: troopId, action, duration: Math.round(ms) });
}

async function readRawBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel 已解析 JSON
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DATA_BYTES + 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

// 轉發到指定 GAS URL；redirect: 'follow' 讓 Node fetch 在伺服器端跟隨 GAS 的 302
async function callUpstream(url, { method, params, payload }) {
  const init = { method, redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
  let target = url;
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') continue; // query 只放簡單值
      qs.set(k, String(v));
    }
    target = url + (url.includes('?') ? '&' : '?') + qs.toString();
  } else {
    init.headers = { 'Content-Type': 'text/plain;charset=utf-8' }; // 與前端舊寫法一致，GAS postData.contents 原樣收到
    init.body = JSON.stringify(payload || {});
  }
  const up = await fetch(target, init);
  const text = await up.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: up.status, json, raw: text };
}

// ---- 新旅團接入申請：匿名探測後端初始化狀態（GS 5.3.0）----
// 未初始化嘅後端（一張工作表都未建）就算管理員批准接入，前端都唔會有任何帳號可用——
// 用戶喺 initializeSheets() 之前已經攞到一條「睇落正常」嘅 API Key，容易以為接入完成。
// 所以申請送去管理員收件匣之前，先匿名讀一次 ecStatus（唯讀，只回版本＋初始化標記）：
//   ・initRequired===true 且 initializedGsVersion 為空 → 判定未完成初始化 → 422，且唔送管理員
//   ・舊版後端冇呢兩個欄位／冇 ecStatus action ＝「未知」→ 照樣轉交（唔可以誤殺合法申請）
//   ・探測失敗／逾時／非 JSON／URL 唔喺白名單 → 一律當「未知」→ 照樣轉交
// 只探測通過 isTrustedExecUrl() 嘅正式 script.google.com /exec URL（防 SSRF）；探測唔帶任何密鑰，
// 回應只當版本字串／boolean 用；任何錯誤訊息一律唔回顯後端網址或 API Key。
const PROBE_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.ROVERBADGE_PROBE_TIMEOUT_MS || '12000', 10);
  if (Number.isNaN(v)) return 12000;
  return Math.max(2000, Math.min(30000, v));
})();

async function probeAnonymousBackend(backendUrl) {
  const url = String(backendUrl || '').trim();
  if (!isTrustedExecUrl(url)) return null;
  try {
    const target = url + (url.includes('?') ? '&' : '?') + 'action=ecStatus';
    const up = await fetch(target, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const text = await up.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (up.status !== 200 || !json || json.success !== true) return null;
    const short = (v) => (typeof v === 'string' ? v.slice(0, 32) : '');
    return {
      initRequired: json.initRequired === true,
      initializedGsVersion: short(json.initializedGsVersion),
      gsVersion: short(json.gsVersion)
    };
  } catch (e) {
    return null; // 探測唔到 ＝ 未知，照樣轉交（唔可以因為探測失敗而誤殺合法申請）
  }
}

// 初始化閘攔住時嘅訊息：可行動（講明按哪個選單掣、只會補建、不會刪改、之後用同一條網址重新提交），
// 而且唔回顯後端網址／API Key。
const INIT_GATE_ERROR = '後端尚未完成初始化／更新，申請暫時未送出：請先喺該旅團嘅 Google 試算表選單「🔗 旅系統 → 🔧 初始化／更新（執行 initializeSheets）」按一次——只會補建缺少的工作表及預設管理員，不會刪改任何既有資料、不會更換 API Key。完成後用同一條網址重新提交申請。';

// 當保留帳號（已於 Vercel 通過 SUPER_KEY 及 rbs1. session 驗證）存取已閂口（ALLOW_LOCAL_LOGIN=false）
// 或未升級之 GAS 時，自動以該旅團已登記的 APIKEY 簽署 sig 請求轉發，確保保留帳號在任何閂口狀態下都能進入及操作。
async function callUpstreamSigned(troop, action, data) {
  if (!troop || !troop.apikey) return null;
  const signedAction = SIGNED_ACTION_MAP[action] || action;
  if (!LINK_SIG_SUPPORTED.has(signedAction)) return null;
  const clean = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k === 'sig' || k === 'sig_ts' || k === 'sig_nonce' || k === 'token' || k === 'apikey') continue;
    clean[k] = v;
  }
  clean.action = signedAction;
  clean.on_behalf = 'system';
  clean.on_behalf_name = 'system';
  clean.on_behalf_role = 'admin';
  if ('confirmer' in clean) clean.confirmer = 'system';
  if ('recorder_name' in clean) clean.recorder_name = 'system';
  const rawPayload = JSON.stringify(clean);
  const inner = makeLinkSig(signedAction, rawPayload, troop.apikey);
  const bodyWithSig = { ...clean, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
  const rawOutgoing = JSON.stringify(bodyWithSig);
  const outer = makeLinkSig(signedAction, rawOutgoing, troop.apikey);
  const target = troop.backend + (troop.backend.includes('?') ? '&' : '?') +
    `sig=${encodeURIComponent(outer.sig)}&sts=${encodeURIComponent(outer.ts)}&snonce=${encodeURIComponent(outer.nonce)}`;
  const up = await fetch(target, {
    method: 'POST',
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: rawOutgoing
  });
  const text = await up.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: up.status, json, raw: text };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  // 只接受所需 HTTP method
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    safeLog({ result: 'method_not_allowed', method: req.method, ms: Date.now() - t0 });
    return sendJson(res, 405, { success: false, error: '此 API 只接受 POST 請求' });
  }

  const body = await readRawBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { success: false, error: '請求格式錯誤' });
  }

  const action = String(body.action || '');
  const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? { ...body.data } : {};
  const troopId = String(body.troopId || '').trim();

  // 輸入驗證：action 白名單
  if (!PUBLIC_ACTIONS.has(action) && !TOKEN_ACTIONS.has(action) && !LOCAL_ACTIONS.has(action)) {
    safeLog({ result: 'bad_action', action: action.slice(0, 40), ms: Date.now() - t0 });
    return sendJson(res, 400, { success: false, error: '不支援的操作' });
  }
  // 輸入驗證：payload 大小
  let dataBytes = 0;
  try { dataBytes = Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch (e) { dataBytes = MAX_DATA_BYTES + 1; }
  if (dataBytes > MAX_DATA_BYTES) {
    return sendJson(res, 413, { success: false, error: '提交內容過大，請分批處理' });
  }

  // ===== 統一回報：只經伺服器端固定收件匣轉送；回應明確標示送達狀態 =====
  if (action === 'submitFeedback') {
    const adminApi = getAdminApiUrl();
    if (!isTrustedExecUrl(adminApi)) {
      safeLog({ result: 'feedback_inbox_misconfig', ms: Date.now() - t0 });
      return sendJson(res, 500, { success: false, deliveryStatus: 'not_sent', error: '回報服務暫時無法使用，請稍後重試' });
    }
    const type = String(data.type || '').trim().toLowerCase();
    const contact = String(data.contact || '').trim().substring(0, 120);
    if (!['issue', 'feedback'].includes(type)) return sendJson(res, 400, { success: false, deliveryStatus: 'not_sent', error: '回報類型不正確' });
    if (contact && contact.length < 3) return sendJson(res, 400, { success: false, deliveryStatus: 'not_sent', error: '聯絡方式最少需要3個字元' });
    const safeText = (value, limit) => {
      const text = String(value || '').trim().substring(0, limit);
      return /^[=+\-@]/.test(text) ? "'" + text : text;
    };
    const troopIdRaw = String(data.troopId || '').trim();
    const troopId = /^[0-9A-Za-z_-]{1,32}$/.test(troopIdRaw) ? troopIdRaw : '';
    const name = safeText(data.name, 80);
    const common = { type, sourceApp: 'roverbadge', troopId, name, contact: safeText(contact, 120) };
    let payload;
    if (type === 'issue') {
      const title = String(data.title || '').trim().substring(0, 120);
      const desc = String(data.desc || '').trim().substring(0, 2000);
      if (!title || !desc) return sendJson(res, 400, { success: false, deliveryStatus: 'not_sent', error: '請簡單寫下問題及需要的協助' });
      const severity = ['低', '中', '高', '緊急'].includes(String(data.severity || '')) ? String(data.severity) : '中';
      payload = { ...common, title: safeText(title, 120), desc: safeText(desc, 2000), severity };
    } else {
      const content = String(data.content || '').trim().substring(0, 2000);
      if (content.length < 5) return sendJson(res, 400, { success: false, deliveryStatus: 'not_sent', error: '請簡單描述你的意見' });
      const fbType = ['建議', '讚', '批評', '其他'].includes(String(data.fbType || '')) ? String(data.fbType) : '建議';
      payload = { ...common, fbType, content: safeText(content, 2000) };
    }
    try {
      const up = await callUpstream(adminApi, { method: 'POST', payload });
      if (!up.json) {
        safeLog({ result: 'feedback_inbox_bad_response', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { success: false, deliveryStatus: 'unknown', error: '暫時未能確認回報是否送達' });
      }
      if (!isAdminSuccess(up.status, up.json)) {
        safeLog({ result: 'feedback_inbox_rejected', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { success: false, deliveryStatus: 'rejected', error: '回報未能送出，請稍後重試' });
      }
      safeLog({ result: 'feedback_received', status: up.status, ms: Date.now() - t0 });
      return sendJson(res, 200, { success: true, deliveryStatus: 'confirmed', message: '已傳送給開發者，請等待通知。' });
    } catch (e) {
      const timeout = e && e.name === 'TimeoutError';
      safeLog({ result: timeout ? 'feedback_timeout' : 'feedback_send_error', ms: Date.now() - t0 });
      return sendJson(res, timeout ? 504 : 502, { success: false, deliveryStatus: 'unknown', error: '暫時未能確認回報是否送達' });
    }
  }

  // ===== 特殊：新旅團接入申請（轉發去中央管理員收件匣，目的地固定於伺服器端）=====
  // 公開路徑：唔需要 SUPER_KEY，亦保證唔會將伺服器端任何密鑰放入送往上游的 JSON。
  if (action === 'submitRegistration') {
    const adminApi = getAdminApiUrl();
    if (!isTrustedExecUrl(adminApi)) {
      safeLog({ result: 'admin_api_misconfig', ms: Date.now() - t0 });
      return sendJson(res, 500, { success: false, error: '伺服器設定錯誤，請聯絡管理員' });
    }
    // Scout Admin GS 只認 backendUrl（不認 scriptUrl）；前端格式照舊，由呢層映射。
    const registration = buildRegistrationPayload(data, { appType: APP_TYPE });
    if (!registration.ok) {
      safeLog({ result: 'admin_registration_invalid', missing: registration.missing.join(','), ms: Date.now() - t0 });
      return sendJson(res, 400, {
        success: false,
        error: '請填寫旅團編號、Apps Script URL 及 API Key',
        missing: registration.missing
      });
    }
    const regPayload = registration.payload;
    // 送上游前再明確清走任何密鑰欄位（payload 由白名單欄位重建，呢步係額外保險）。
    delete regPayload.superKey;
    delete regPayload.super_key;
    delete regPayload.SUPER_KEY;
    // ===== 初始化閘（GS 5.3.0）：後端未完成初始化就唔好佔用管理員審批 =====
    // 判定為「未完成初始化」時直接 422：呢次申請唔會送到管理員收件匣，用戶按指引跑一次
    // 「🔧 初始化／更新」後用同一條網址重新提交即可。探測唔到（舊版後端／逾時／非白名單 URL）
    // 一律當「未知」照樣轉交，唔會誤殺合法申請。
    const probe = await probeAnonymousBackend(regPayload.backendUrl);
    if (probe && probe.initRequired && !probe.initializedGsVersion) {
      safeLog({ result: 'registration_backend_uninitialized', initGate: 'blocked', ms: Date.now() - t0 });
      return sendJson(res, 422, { success: false, deliveryStatus: 'not_sent', error: INIT_GATE_ERROR });
    }
    try {
      const up = await callUpstream(adminApi, { method: 'POST', payload: regPayload });
      // Scout Admin GS 以 { status: 'success' } 表示成功；亦兼容 { success: true }。
      // HTTP 非 2xx、非 JSON、status 唔啱，一律當未送達，唔可以回前端成功。
      if (!isAdminSuccess(up.status, up.json)) {
        safeLog({ result: 'admin_upstream_bad', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { success: false, error: '申請未能送達管理員，請稍後重試' });
      }
      safeLog({
        result: 'registration_ok', status: up.status,
        initGate: !probe ? 'unknown' : (probe.initRequired ? (probe.initializedGsVersion ? 'initialized' : 'blocked') : 'not_required'),
        ms: Date.now() - t0
      });
      return sendJson(res, 200, { success: true, message: '申請已提交' });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      safeLog({ result: timeout ? 'admin_timeout' : 'admin_fetch_error', ms: Date.now() - t0 });
      // 契約：未能確認送達一律 502 success:false（前端只會顯示失敗，不會假成功）
      return sendJson(res, 502, { success: false, error: timeout ? '提交逾時，請稍後重試' : '申請未能送達管理員，請稍後重試' });
    }
  }

  // ===== 一般旅團 action：必須給 troopId，由伺服器端 Registry 解析 GAS URL =====
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(troopId)) {
    return sendJson(res, 400, { success: false, error: '旅團編號格式不正確' });
  }
  const troop = getTrustedTroop(troopId);
  if (!troop) {
    safeLog({ result: 'unknown_troop', troopId, ms: Date.now() - t0 });
    return sendJson(res, 404, { success: false, error: '找不到此旅團，或旅團後端設定無效，請聯絡管理員' });
  }

  // 不接受用戶自行夾帶驗證票據或覆寫頂層 action。
  delete data.super_ticket;
  delete data.action;
  // 「忘記密碼」兩個 action 係登入前公開入口，授權完全靠寄到登記電郵嘅一次性重設碼：
  // 唔可以畀請求自帶有效管理員 token／指定 YMIS／角色去影響流程，後端亦完全唔讀呢啲欄位。
  // 呢度主動剷走身份欄位（defense in depth），只保留 login_id／email／code／new_password。
  if (action === 'requestPasswordReset' || action === 'confirmPasswordReset') {
    ['token', 'ymis', 'target_ymis', 'role', 'password_hash', 'code_hash', 'user', 'apikey', 'sig', 'sig_ts', 'sig_nonce']
      .forEach(k => delete data[k]);
  }
  const superLogin = action === 'login' && isSuperId(data.login_id);
  if (superLogin) {
    if (!superConfigured()) {
      safeLog({ result: 'super_auth_misconfig', troopId, ms: Date.now() - t0 });
      return sendJson(res, 503, { success: false, error: '登入服務暫時無法使用，請聯絡管理員' });
    }
    if (!checkSuperPassword(data.password)) return sendJson(res, 401, { success: false, error: '帳號或密碼錯誤' });
    data.login_id = accountId;
    delete data.password;
    data.super_ticket = sealSuper('login', { troopId, backend: troop.backend, apikey: troop.apikey }, 60);
  }
  let isSuperSession = false;
  if (typeof data.token === 'string' && data.token.startsWith('rbs1.')) {
    const session = openSuper('session', data.token);
    if (!session || session.troopId !== troopId || typeof session.token !== 'string') {
      return sendJson(res, 401, { success: false, error: '登入已過期，請重新登入' });
    }
    if (action === 'changePassword') return sendJson(res, 403, { success: false, error: '此帳號不支援在此更改密碼，請聯絡管理員' });
    data.token = session.token;
    isSuperSession = true;
    if ('confirmer' in data) data.confirmer = 'system';
    if ('recorder_name' in data) data.recorder_name = 'system';
  }
  if (TOKEN_ACTIONS.has(action)) {
    // 若帶有 sig 且屬於 SIG_ACTIONS 則可經上游 sig 直通（真偽由 GAS 驗證）
    const hasSig = typeof data.sig === 'string' && data.sig.length >= 8;
    const canUseSig = hasSig && SIG_ACTIONS.has(action);
    if (!canUseSig) {
      if (typeof data.token !== 'string' || data.token.length < 4 || data.token.length > 4096) {
        return sendJson(res, 401, { success: false, error: '未登入或登入已過期，請重新登入' });
      }
    }
  }
  const effectiveApikey = troop.apikey;

  try {
    let up = null;
    try {
      if (GET_ACTIONS.has(action)) {
        up = await callUpstream(troop.backend, {
          method: 'GET',
          params: { action, apikey: effectiveApikey || undefined, token: data.token }
        });
      } else {
        const payload = { ...data, action };
        if (effectiveApikey) payload.apikey = effectiveApikey;
        up = await callUpstream(troop.backend, { method: 'POST', payload });
      }
    } catch (innerErr) {
      if (!superLogin) throw innerErr;
    }

    // 保留帳號已於 Vercel 通過 SUPER_KEY 驗證（不經 Sheet Users 表）；
    // 即使旅團 GAS 直接入口已閂（ALLOW_LOCAL_LOGIN=false）或後端未升級／未跑 authorizeConnection，
    // 仍以本旅團 APIKEY 簽發無狀態 session，確保保留帳號任何情況下都能進入。
    if (superLogin) {
      const validUpstreamSuper = up && up.json && up.json.success &&
        typeof up.json.token === 'string' && up.json.token.startsWith('rbs-super-v1-') &&
        up.json.user && up.json.user.role === 'super_admin';
      const rawSuperToken = validUpstreamSuper ? up.json.token : buildSuperInnerToken(effectiveApikey);
      const superUser = validUpstreamSuper ? up.json.user : buildSuperUser();
      const sealed = sealSuper('session', { troopId, token: rawSuperToken }, 30 * 24 * 60 * 60);
      safeLog({ result: 'ok', troopId, action, status: (up && up.status) || 200, ms: Date.now() - t0 });
      return sendJson(res, 200, {
        success: true,
        token: sealed,
        user: superUser,
        force_change_password: false
      });
    }

    // 保留帳號後續操作：若旅團 GAS 因 ALLOW_LOCAL_LOGIN=false（只收上游 sig）或未升級而拒絕直接請求，
    // 自動改以本旅團 APIKEY 簽署 sig 請求重試，無痕繞過閂口限制。
    if (isSuperSession) {
      if (action === 'logout' && (!up || !up.json || !up.json.success)) {
        safeLog({ result: 'ok', troopId, action, status: 200, ms: Date.now() - t0 });
        return sendJson(res, 200, { success: true });
      }
      const gateOrTokenBlocked = !up || !up.json || (!up.json.success && (
        up.json.upstream_only === true ||
        up.json.local_login === false ||
        /直接入口已閂|ALLOW_LOCAL_LOGIN|Token 無效或過期|無效或已過期的登入令牌|未授權|未登入|找不到用戶/.test(String(up.json.error || ''))
      ));
      if (gateOrTokenBlocked) {
        const signedUp = await callUpstreamSigned(troop, action, data);
        if (signedUp && signedUp.json) up = signedUp;
      }
    }

    if (!up || !up.json) {
      // 上游 HTTP 失敗或回應非 JSON（GAS HTML error page）
      const st = (up && up.status) || 502;
      safeLog({ result: 'upstream_bad_response', troopId, action, status: st, ms: Date.now() - t0 });
      const msg = st >= 400
        ? `旅團後端暫時無法使用（HTTP ${st}），請稍後重試`
        : '旅團後端回應格式異常，請稍後重試或通知管理員檢查 Apps Script 部署';
      return sendJson(res, 502, { success: false, error: msg });
    }

    logSlowPassword(action, troopId, Date.now() - t0);
    safeLog({ result: 'ok', troopId, action, status: up.status, ms: Date.now() - t0 });
    // GAS 業務錯誤（success:false）照原樣回傳，前端按語意顯示
    return sendJson(res, 200, up.json);
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    logSlowPassword(action, troopId, Date.now() - t0);
    safeLog({ result: timeout ? 'upstream_timeout' : 'upstream_fetch_error', troopId, action, ms: Date.now() - t0 });
    return sendJson(res, timeout ? 504 : 502, {
      success: false,
      error: timeout ? '旅團後端回應逾時，操作可能未完成，請先重新載入確認狀態才重試' : '無法連接旅團後端，請稍後重試'
    });
  }
}
