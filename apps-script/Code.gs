// ============================================================
// 完全兼容舊版 + 新增待批申請、批量寫入優化、日誌
//   - 批量開戶／申請審批的預設密碼改為 1234（DEFAULT_PASS）
//   - 更改密碼最短長度由 6 位放寬至 4 位
//   ＋領袖免 YMIS（用電郵登入，留空自動編配內部 L 編號）＋開戶權限收緊（只可開立自己可管理的角色）
//   - 公開申請只接受 member／branch_leader（管委／團長／管理員須由現任管理層在「用戶管理」開立）
//   - Sheet 人手改寫的 GSL／admin 申請一律退回 member；領袖申請忽略 YMIS
//   - reviewApplication 開戶預設密碼 1234，首次登入強制更改；回應加 final_role + temp_password；舊有 YMIS 領袖帳號不變
//   - YMIS／Email 全表唯一（含已停用帳號）：apply／addUser／reviewApplication／addMember 劃一檢查，
//     不可重複開戶；停用帳號佔用的 YMIS／Email 須「恢復帳號」而非重新開戶
//   - 用戶管理可見全部人：getAllUsers 回傳 active＋inactive（含 status 欄）；無登入帳號的純名單成員
//     由 getMembers 差集顯示，前端可開立登入帳號／改名／刪除名單
//   - 領袖可自設成員密碼：resetPassword 接受可選 new_password（≥4位，首次登入須更改）；留空沿用隨機一次性密碼
//   - 自助找回密碼：公開 action forgotPassword（YMIS／電郵 → 臨時密碼寄到登記電郵；未登記電郵者請聯絡領袖）
//   - 新 action：reactivateUser（恢復停用）／updateUserProfile（改姓名／電郵／備註，電郵唯一）／
//     deleteMember（刪純名單成員）／deleteUser（徹底刪除已停用帳號，需團長以上，進度保留）
//   - 本檔只保留一行保留帳號識別字（SUPER_ADMIN_ID），供權限判斷與名單過濾；
//     本檔不含、不收、不比對任何登入密碼
//   - login 不接受保留帳號密碼；action=login 附帶 super_ticket 時向固定受信端點
//     （getSuperVerifyUrl()）驗票通過後才建立 session —— 票據由 Vercel 簽發（vs 同構）
//   - 新增 authorizeConnection()：升級後在編輯器執行一次，只授權 UrlFetch，不讀寫 Sheet
//   - Google Sheet 完全冇蹤跡：Users 表唔會有這列，Tokens 表以中性代號儲存
//   - 防護保留：保留帳號不能被停用／重設密碼／更改角色／自行改密碼／以此帳號開戶
//   - verifySuperTicket 加 LockService＋CacheService 票據一次性保護：同一票據只可驗票成功一次，
//     防重放／重複提交；取鎖逾時對外只回一般用語
//   - 新工作表「活動履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//   - 新 action：getLogRecords / saveLogRecord（支援批量 records[]）/ deleteLogRecord
//   - handleLoad 回應新增 logs + logsSupported
//   - 新工作表「待批履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//   - 新 action：getPendingLogRequests / submitLogRequest / reviewLogRequest
//   - 成員可申報自己的活動履歷（新申報或申請修改已批紀錄），領袖批准後寫入「活動履歷」
//   - 修改類批准後更新原有紀錄（record_id 不變）；其他（進度/其他獎章）批准後成員不能自行修改
// ============================================================

const ADMIN_YMIS = '1111111111';
const ADMIN_NAME = '管理員';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'changeme';
// 批量開戶／申請審批的預設密碼
const DEFAULT_PASS = '1234';
// 系統保留帳號識別字（唯一宣告；登入憑證不在本檔、不存於 Google Sheet）
const SUPER_ADMIN_ID = 'sheep';
// 保留帳號顯示名稱（只用於名單／審計顯示，不是登入憑證）
const SUPER_ADMIN_NAME = '系統管理員';
// 保留帳號電郵別名（登入時與識別字等值；沿用 vsbadge 同構格式）
const SUPER_ADMIN_EMAIL = SUPER_ADMIN_ID + '@roverbadge.local';
// Tokens 表內代表保留帳號的中性代號（避免帳號出現在 Sheet 任何一欄）
const SUPER_ADMIN_TOKEN_MARK = '__sys__';
// 超管 session token 前綴（proxy 版本核對＋舊版殘留 session 即時失效用）
const SUPER_TOKEN_PREFIX = 'rbs-super-v1-';
// 中央票據驗證端點（可信設定：本檔常量；vs 同構，部署網域各自寫各自）
const SUPER_VERIFY_URL = 'https://roverbadge.vercel.app/api/super';

const LOG_SHEET_NAME = '活動履歷';
const LOG_HEADERS = ['record_id','type','ymis','name','date','title','role','hours','cert_no','detail','recorder','recorded_at','updated_at'];
const LOG_TYPES = ['service','activity','training'];

//  - 新工作表「待批履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//  - 新 action：getPendingLogRequests / submitLogRequest / reviewLogRequest
//  - 成員可申報自己的活動履歷；批准後寫入「活動履歷」；批准後成員仍可申請修改（重新待批）
const LOG_PENDING_SHEET_NAME = '待批履歷';
const LOG_PENDING_HEADERS = ['request_id','record_id','type','ymis','name','date','title','role','hours','cert_no','detail','status','requested_at','submitted_by','reviewed_by','reviewed_at','review_note','submission_type'];
function safeSheetText(v,maxLen){
  let text=String(v||'').trim().substring(0,maxLen||200);
  if(/^['=+\-@\t\r]/.test(text)) text="'" +text;
  return text;
}

// ===== 旅系統：上下游接駁（進度系統節點）=====
// 同一份 Code.gs 部署在每一層節點（旅／支部系統／進度）。接入完全自願：
//   - 邊個支部系統想用本節點（Rover），就由「嗰個支部系統自己」將本節點的
//     GAS /exec URL（B）+ SHEET KEY（D）登記入佢自己 Sheet 的 Script Properties：
//     DOWNSTREAM_<id>_URL / DOWNSTREAM_<id>_KEY（有地域有鎖匙先入到）；
//     登記後上游可經 sig 讀寫下游（進了上游就等於進了下游）。掛錯（如掛去深資），
//     對方一測 sig／一睇結構就會發現，會改返。
//   - 本節點 Script Properties 的 ALLOW_LOCAL_LOGIN 係「直接入口」掣：
//     未設定＝開啟（現有旅團零影響）；任何唔係 1/true/yes/on/open 的值
//     （false/0/no/off 或串錯字）＝閂口（fail closed）；閂口後只接受有效 sig。
//     例外：中央管理帳號（super_admin）唔經旅團登記 Sheet，其 super_ticket 登入及
//     rbs-super-v1- token 操作閂口後照放行（救援鎖死旅團嘅最後通道）。
//   - 登記資料、sig、nonce 全部只存 Script Properties / CacheService，一律不寫入任何工作表。
//   - sig 係 GAS→GAS 直連（HMAC-SHA256），唔經 Vercel proxy；下游永不回打上游，不設回調。
const LINK_FLAG = 'ALLOW_LOCAL_LOGIN';
const LINK_DOWNSTREAM_PREFIX = 'DOWNSTREAM_';
const LINK_SIG_PURPOSE = 'roverbadge-troop-sig-v1';
const LINK_SIG_WINDOW_MS = 5 * 60 * 1000;
const LINK_SIG_NONCE_TTL = 600;
const LINK_MAX_SIGNED_BYTES = 900000;
const LINK_EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;
const LINK_SIG_HEX_RE = /^[0-9a-f]{64}$/i;
const LINK_NONCE_RE = /^[0-9A-Za-z_-]{8,64}$/;
const LINK_HASH_RE = /^[0-9a-f]{64}$/i;
const LINK_RESERVED_BODY_KEYS = ['sig', 'sig_ts', 'sig_nonce'];
// 上游以 sig 可以在下游執行的 action。login／apply／logout／changePassword／
// superTicketLogin／forgotPassword 等本地憑證操作永不接受（即使有 sig）。
const LINK_SIG_READ_ACTIONS = ['load', 'getLoginMode', 'getLinkState', 'getMembers', 'getConfig', 'getAllUsers', 'getOtherBadges', 'getPendingRequests', 'getApplications', 'getLogRecords', 'getPendingLogRequests'];
const LINK_SIG_WRITE_ACTIONS = ['save', 'saveOtherBadge', 'requestComplete', 'reviewRequest', 'addMember', 'addUser', 'upsertUser', 'importUsers', 'resetPassword', 'deactivateUser', 'reactivateUser', 'updateUserProfile', 'deleteMember', 'deleteUser', 'updateUserRole', 'updatePermissions', 'saveLogRecord', 'deleteLogRecord', 'reviewLogRequest', 'reviewApplication', 'setLocalLogin'];
const USER_EXPORT_FORMAT = 'roverbadge-users-export';

function linkProps() { return PropertiesService.getScriptProperties(); }
function toHex(bytes) { let out = ''; for (let i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2); return out; }
function sha256Hex(text) { return hashPassword(String(text === undefined || text === null ? '' : text)); }
function hmacSha256Hex(message, key) { return toHex(Utilities.computeHmacSha256Signature(String(message), String(key))); }
// sig 密鑰以用途字串分隔方式由「該節點的 SHEET KEY（D）」推導：
//   驗證入站 → 用本機 API_KEY（上游登記的就是這條）；簽署出站 → 用已登記的下游 SHEET KEY。
// 推導結果唔另外儲存、唔寫入工作表。
function linkSigKeyFor(key) { return hmacSha256Hex(LINK_SIG_PURPOSE, String(key || '')); }
function linkSigKey() { return linkSigKeyFor(getApiKey()); }
function linkNonce() { return Utilities.getUuid().replace(/-/g, ''); }
// 常數時間比較：兩邊先各自 SHA-256 再比對，避免逐字元短路洩漏
function safeEqualText(a, b) { return sha256Hex(String(a || '')) === sha256Hex(String(b || '')); }
function linkCanonical(action, ts, nonce, digest) { return [String(action || ''), String(ts || ''), String(nonce || ''), String(digest || '')].join('\n'); }
function maskSecret(v) { v = String(v || ''); return v.length <= 12 ? '****' : v.substring(0, 8) + '…' + v.substring(v.length - 4); }
// 上游傳來的操作者標籤：只留安全字元，避免經 auth_by／操作紀錄寫入工作表時變成算式
function linkActorLabel(v) {
  const cleaned = String(v || '').trim().replace(/[^0-9A-Za-z_.@-]/g, '').substring(0, 40);
  return cleaned || 'upstream';
}
function getLinkNodeId() { try { return safeSheetText(getSheet().getName() || 'node', 80) || 'node'; } catch (e) { return 'node'; } }

// ---- 直接入口掣（寫在本節點 Script Properties）----
// 未設定＝開啟；1/true/yes/on/open＝開啟；其餘任何值（false/0/no/off 或串錯字）＝閂口（fail closed）
function localLoginAllowed() {
  const v = String(linkProps().getProperty(LINK_FLAG) || '').trim().toLowerCase();
  if (!v) return true;
  return ['1', 'true', 'yes', 'on', 'open'].indexOf(v) >= 0;
}
// 中央管理帳號（super_admin）本地 token 識別：SUPER_TOKEN_PREFIX 前綴＋有效（validateToken 還原保留帳號）。
// 超管帳號唔係經旅團登記 Sheet（Users 表）開嘅戶：密碼喺 Vercel SUPER_KEY、票據經固定端點 /api/super 驗票，
// 唔屬「本地直接入口」管轄；閂口後照樣放行（登入後嘅 token 操作），係救援鎖死旅團（例如誤閂直接入口）嘅最後通道。
function isSuperAdminToken(token) {
  if (!token || String(token).indexOf(SUPER_TOKEN_PREFIX) !== 0) return false;
  return validateToken(token) === SUPER_ADMIN_ID;
}
function setLocalLoginAllowed(allow, actor) {
  linkProps().setProperty(LINK_FLAG, allow ? 'true' : 'false');
  writeAudit(actor || 'system', allow ? 'link_local_login_on' : 'link_local_login_off', getLinkNodeId(), allow ? '直接入口開啟' : '直接入口已閂，只收上游 sig');
  return allow ? 'true' : 'false';
}
function linkClosedResponse(action) {
  return {
    success: false, local_login: false, upstream_only: true,
    error: '此後端的直接入口已閂（' + LINK_FLAG + '=false），只接受上游簽名（sig）請求；請由上游（旅／支部系統）入口登入。' + (action ? '（已拒絕：' + action + '）' : '')
  };
}
function getLinkState() {
  return {
    success: true, node: getLinkNodeId(),
    allow_local_login: localLoginAllowed(),
    link_flag_set: String(linkProps().getProperty(LINK_FLAG) || '') === 'false' ? 'false' : (String(linkProps().getProperty(LINK_FLAG) || '') ? 'true' : '（未設定＝開啟）'),
    downstreams: listDownstreams(),
    api_key_masked: maskSecret(getApiKey()),
    export_format: USER_EXPORT_FORMAT
  };
}

// ---- sig 產生／驗證（GAS → GAS，不經 Vercel）----
//   sigKey    = hex( HMAC-SHA256( message = LINK_SIG_PURPOSE, key = D ) )
//   canonical = action + "\n" + ts(毫秒) + "\n" + nonce + "\n" + hex( SHA-256(rawBody) )
//   sig       = hex( HMAC-SHA256( canonical, sigKey ) )
function stripLinkSigFields(body) {
  const out = {};
  for (const k in (body || {})) { if (LINK_RESERVED_BODY_KEYS.indexOf(k) >= 0) continue; out[k] = (body || {})[k]; }
  return out;
}
// 兩種傳送方式共用同一套驗證：
//   query：?sig=&sts=&snonce=          digest = SHA-256(原始 body 字串)
//   body ：{...,sig,sig_ts,sig_nonce}  digest = SHA-256(JSON.stringify(去掉三個 sig 欄位後的 body))
// 上游一次送齊兩種，GAS 302 轉址即使遺失其中一種仍可驗證。
function readLinkSig(e, body, rawBody) {
  const params = (e && e.parameter) || {};
  const qSig = String(params.sig || ''), qTs = String(params.sts || ''), qNonce = String(params.snonce || '');
  if (qSig && qTs && qNonce) return { sig: qSig, ts: qTs, nonce: qNonce, digest: sha256Hex(String(rawBody || '')), transport: 'query' };
  const bSig = String((body && body.sig) || ''), bTs = String((body && body.sig_ts) || ''), bNonce = String((body && body.sig_nonce) || '');
  if (bSig && bTs && bNonce) {
    let canonicalPayload = '';
    try { canonicalPayload = JSON.stringify(stripLinkSigFields(body)); } catch (err) { return null; }
    return { sig: bSig, ts: bTs, nonce: bNonce, digest: sha256Hex(canonicalPayload), transport: 'body' };
  }
  return null;
}
function makeLinkSig(action, rawPayload, key) {
  const ts = String(Date.now()), nonce = linkNonce();
  return { sig: hmacSha256Hex(linkCanonical(action, ts, nonce, sha256Hex(String(rawPayload || ''))), linkSigKeyFor(key)), ts: ts, nonce: nonce };
}
function verifyLinkSig(e, body, rawBody) {
  try {
    const s = readLinkSig(e, body, rawBody);
    if (!s) return false;
    if (String(rawBody || '').length > LINK_MAX_SIGNED_BYTES) return false;
    if (!LINK_SIG_HEX_RE.test(String(s.sig))) return false;
    if (!LINK_NONCE_RE.test(String(s.nonce))) return false;
    const ts = parseInt(s.ts, 10);
    if (!isFinite(ts) || Math.abs(Date.now() - ts) > LINK_SIG_WINDOW_MS) return false;
    const action = String((body && body.action) || '');
    if (!safeEqualText(hmacSha256Hex(linkCanonical(action, s.ts, s.nonce, s.digest), linkSigKey()), s.sig)) return false;
    // 防重放：同一 nonce 只可用一次（CacheService 存 10 分鐘，不入工作表）。
    // 一次請求可能同時帶 query 及 body 兩組 sig；兩組 nonce 都要消耗，
    // 否則「第一次只驗到其中一組」時，重放可用另一組 nonce 再入一次。
    const cache = CacheService.getScriptCache();
    const nonces = [String(s.nonce)];
    const queryNonce = String(((e && e.parameter) || {}).snonce || '');
    const bodyNonce = String((body && body.sig_nonce) || '');
    [queryNonce, bodyNonce].forEach(function (n) {
      if (LINK_NONCE_RE.test(n) && nonces.indexOf(n) < 0) nonces.push(n);
    });
    const keys = nonces.map(function (n) { return 'link-nonce:' + sha256Hex(n).substring(0, 40); });
    for (let i = 0; i < keys.length; i++) { if (cache.get(keys[i])) return false; }
    for (let i = 0; i < keys.length; i++) { cache.put(keys[i], '1', LINK_SIG_NONCE_TTL); }
    return true;
  } catch (err) { return false; }
}

// ---- 上游：登記下游（只存 Script Properties，不寫入 SHEET）----
function normalizeLinkId(id) { return String(id || '').trim().replace(/[^0-9A-Za-z_-]/g, '').substring(0, 32); }
function isTrustedDownstreamUrl(url) { return LINK_EXEC_URL_RE.test(String(url || '').trim()); }
function registerDownstream(id, url, key, name) {
  id = normalizeLinkId(id);
  if (!id) return { success: false, error: '下游編號不可留空（只可用英文、數字、底線、連字號）' };
  if (!isTrustedDownstreamUrl(url)) return { success: false, error: '下游 URL 必須是正式 GAS /exec（https://script.google.com/macros/s/.../exec）' };
  key = String(key || '').trim();
  if (key.length < 8) return { success: false, error: '下游 SHEET KEY 太短；請抄下游 Script Properties 的 API_KEY' };
  const props = linkProps();
  props.setProperty(LINK_DOWNSTREAM_PREFIX + id + '_URL', String(url).trim().replace(/\/$/, ''));
  props.setProperty(LINK_DOWNSTREAM_PREFIX + id + '_KEY', key);
  props.setProperty(LINK_DOWNSTREAM_PREFIX + id + '_NAME', String(name || '').trim().substring(0, 80));
  props.setProperty(LINK_DOWNSTREAM_PREFIX + id + '_AT', now());
  writeAudit('system', 'link_register_downstream', id, '已登記下游 URL 及 SHEET KEY（只存 Script Properties）');
  return { success: true, id: id, message: '已登記下游 ' + id };
}
function getDownstream(id) {
  id = normalizeLinkId(id);
  if (!id) return null;
  const props = linkProps();
  const url = String(props.getProperty(LINK_DOWNSTREAM_PREFIX + id + '_URL') || '').trim();
  const key = String(props.getProperty(LINK_DOWNSTREAM_PREFIX + id + '_KEY') || '').trim();
  if (!url || !key) return null;
  return { id: id, url: url, key: key, name: String(props.getProperty(LINK_DOWNSTREAM_PREFIX + id + '_NAME') || ''), registered_at: String(props.getProperty(LINK_DOWNSTREAM_PREFIX + id + '_AT') || '') };
}
function listDownstreams() {
  const props = linkProps(), ids = {}, all = props.getProperties();
  for (const k in all) {
    const m = String(k).match(/^DOWNSTREAM_(.+)_URL$/);
    if (m) ids[m[1]] = true;
  }
  const out = [];
  for (const id in ids) {
    const d = getDownstream(id);
    if (!d) continue;
    out.push({ id: d.id, name: d.name, registered_at: d.registered_at, url_masked: maskSecret(d.url), has_key: true });
  }
  out.sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
  return out;
}
function removeDownstream(id) {
  id = normalizeLinkId(id);
  if (!id) return { success: false, error: '下游編號不正確' };
  const props = linkProps();
  ['_URL', '_KEY', '_NAME', '_AT'].forEach(function (s) { props.deleteProperty(LINK_DOWNSTREAM_PREFIX + id + s); });
  writeAudit('system', 'link_remove_downstream', id, '已移除下游登記');
  return { success: true, message: '已移除下游 ' + id };
}
// 上游打下游：body 內含 sig（digest 綁 action + 去 sig 欄位後的 body），query 再帶一組 sig（digest 綁完整原始 body）
function callDownstream(downstreamId, action, payload) {
  const d = getDownstream(downstreamId);
  if (!d) return { success: false, error: '未登記下游 ' + downstreamId + '：請先登記下游 URL 及 SHEET KEY' };
  if (String(action || '') === '') return { success: false, error: '缺少 action' };
  let rawOutgoing = '';
  try {
    const body = stripLinkSigFields(payload || {});
    body.action = action;
    const rawPayload = JSON.stringify(body);
    const inner = makeLinkSig(action, rawPayload, d.key);
    body.sig = inner.sig; body.sig_ts = inner.ts; body.sig_nonce = inner.nonce;
    rawOutgoing = JSON.stringify(body);
    const outer = makeLinkSig(action, rawOutgoing, d.key);
    const url = d.url + '?sig=' + encodeURIComponent(outer.sig) + '&sts=' + encodeURIComponent(outer.ts) + '&snonce=' + encodeURIComponent(outer.nonce);
    const response = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: rawOutgoing,
      muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true
    });
    const code = response.getResponseCode();
    const text = response.getContentText();
    let json = null; try { json = JSON.parse(text); } catch (err) { json = null; }
    if (!json) return { success: false, error: '下游回應異常（HTTP ' + code + '）：請檢查下游部署版本、存取權（任何人）及登記的 SHEET KEY' };
    return json;
  } catch (err) {
    return { success: false, error: '無法連接下游：' + (err && err.message ? err.message : String(err)) };
  }
}
function pingDownstream(downstreamId) { return callDownstream(downstreamId, 'getLinkState', {}); }
// 掣在上游：由上游閂／開下游的直接入口
function setDownstreamLocalLogin(downstreamId, allow) {
  const r = callDownstream(downstreamId, 'setLocalLogin', { allow: allow ? 'true' : 'false' });
  if (r && r.success) writeAudit('system', 'link_set_downstream_gate', normalizeLinkId(downstreamId), allow ? '下游直接入口開啟' : '下游直接入口已閂（只收 sig）');
  return r;
}

// ---- 開戶：上游揀團開戶，經 sig 落下游寫（兩邊同一 password_hash）----
function linkManager(body) {
  const onBehalf = linkActorLabel(body && body.on_behalf);
  const role = VALID_ROLES.indexOf(String((body && body.on_behalf_role) || '')) >= 0 ? String(body.on_behalf_role) : 'admin';
  return { ymis: onBehalf, name: '上游同步（' + onBehalf + '）', role: role, can_tick: true, allowed_badges: '*', status: 'active' };
}
function createAccountForDownstream(downstreamId, rawUser, manager) {
  const d = getDownstream(downstreamId);
  if (!d) return { success: false, error: '未登記下游 ' + downstreamId + '：請先登記下游 URL 及 SHEET KEY' };
  const mgr = manager && manager.role ? manager : { ymis: 'upstream', name: '上游同步', role: 'admin', can_tick: true };
  const local = addUser_(rawUser || {}, mgr);
  if (!local.success) return { success: false, error: '上游開戶失敗：' + String(local.error || '') };
  const ymis = String(local.ymis || ((rawUser || {}).ymis) || '').trim();
  const rec = upsertReadBackUser_(ymis);
  if (!rec) return { success: false, error: '上游已開戶但讀不回帳戶，未能同步下游' };
  const mirror = {
    ymis: rec.ymis, name: rec.name, email: rec.email, role: rec.role, branch: rec.branch,
    can_tick: rec.can_tick, allowed_badges: rec.allowed_badges, status: 'active', force_change_password: true,
    password_hash: String(rec.password_hash || '')
  };
  const pushed = callDownstream(downstreamId, 'upsertUser', { user: mirror, on_behalf: linkActorLabel(mgr.ymis) });
  if (!pushed || pushed.success !== true) {
    return { success: false, error: '上游已開戶，但下游寫入失敗：' + String((pushed && pushed.error) || '下游無回應'), ymis: mirror.ymis, downstream: normalizeLinkId(downstreamId) };
  }
  writeAudit(linkActorLabel(mgr.ymis), 'link_push_user', safeSheetText(mirror.ymis, 40), '帳戶已同步至下游 ' + normalizeLinkId(downstreamId));
  return { success: true, ymis: mirror.ymis, name: mirror.name, downstream: normalizeLinkId(downstreamId), message: '上游已開戶並經 sig 同步下游' };
}
// 開戶後讀回 Users 行（含 hash），用以鏡像到下游
function upsertReadBackUser_(ymis) {
  try {
    const sheet = getSheet().getSheetByName('Users');
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0] || '').trim() === ymis) {
        return {
          ymis: String(data[i][0] || '').trim(),
          name: String(data[i][1] || ''),
          email: String(data[i][2] || ''),
          role: String(data[i][3] || 'member'),
          password_hash: String(data[i][4] || ''),
          branch: String(data[i][5] || ''),
          can_tick: data[i][6] === true || String(data[i][6]).toUpperCase() === 'TRUE',
          allowed_badges: data[i].length >= 13 ? String(data[i][12] || '') : '',
          force_change_password: data[i].length >= FORCE_CHANGE_COL && isForceChangeValue(data[i][FORCE_CHANGE_COL - 1])
        };
      }
    }
  } catch (e) { }
  return null;
}

// ---- 吐 JSON（搬舊數）：匯出含 hash，只寫去 Drive，绝不寫入任何工作表 ----
function collectUsersForExport() {
  const sheet = getSheet().getSheetByName('Users');
  const out = [];
  if (!sheet) return out;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const ymis = String(data[i][0] || '').trim();
    if (!ymis) continue;
    const role = String(data[i][3] || 'member') || 'member';
    if (role === 'super_admin' || isSuperAdminId(ymis)) continue;
    out.push({
      ymis: ymis,
      name: String(data[i][1] || ''),
      email: String(data[i][2] || ''),
      role: role,
      branch: String(data[i][5] || ''),
      can_tick: data[i][6] === true || String(data[i][6]).toUpperCase() === 'TRUE',
      allowed_badges: data[i].length >= 13 ? String(data[i][12] || '') : '',
      status: String(data[i][11] || 'active') || 'active',
      force_change_password: data[i].length >= FORCE_CHANGE_COL && isForceChangeValue(data[i][FORCE_CHANGE_COL - 1]),
      password_hash: String(data[i][4] || ''),
      auth_by: String(data[i][7] || ''),
      created_at: data[i][9] ? String(data[i][9]) : '',
      last_login: data[i][10] ? String(data[i][10]) : ''
    });
  }
  return out;
}
function buildUsersExport() {
  const users = collectUsersForExport();
  return { format: USER_EXPORT_FORMAT, schema: 1, exported_at: now(), node: getLinkNodeId(), count: users.length, users: users };
}
function exportUsersJsonText() { return JSON.stringify(buildUsersExport(), null, 2); }
// Sheet 選單主通道：寫成 Drive 私人檔（Access.PRIVATE + Permission.NONE），彈窗給連結及檔案 ID；
// Drive 寫入失敗時，完整 JSON 寫入「檢視 → 執行紀錄（Logger）」作後備。「操作紀錄」只記筆數同檔案 ID。
function exportUsersJson() {
  const payload = buildUsersExport();
  const count = payload.count;
  const stamp = Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyyMMdd-HHmmss');
  let fileId = '', fileUrl = '', driveError = '';
  try {
    const ssFile = DriveApp.getFileById(getSheet().getId());
    const folder = ssFile.getParents().hasNext() ? ssFile.getParents().next() : DriveApp.getRootFolder();
    const file = folder.createFile('roverbadge-users-' + stamp + '.json', JSON.stringify(payload, null, 2), 'application/json');
    try { file.setSharingAccess(DriveApp.Access.PRIVATE); file.setSharingPermission(DriveApp.Permission.NONE); } catch (e) { }
    fileId = file.getId(); fileUrl = file.getUrl();
  } catch (e) { driveError = (e && e.message) ? e.message : String(e); }
  writeAudit('system', 'export_users_json', count + ' accounts', fileId ? ('Drive 檔 ' + fileId + '（含 hash，匯入後請刪除）') : ('Drive 寫入失敗：' + driveError + '；JSON 已輸出到執行紀錄'));
  try { Logger.log(JSON.stringify(payload, null, 2)); } catch (e) { }
  return { success: true, count: count, file_id: fileId, file_url: fileUrl, drive_error: driveError, payload: payload };
}

// ---- 匯入：逐個 upsertUser 直插 hash（保留舊密碼）----
// 新帳戶必須帶 password_hash（64 hex）；明文 password 一律拒。
// 既有帳戶（同 YMIS，或同 Email 認回同一身份）→ 更新；冇帶 hash → 保留原密碼。冪等。
function syncMemberRow_(ymis, name, branch, email, status) {
  try {
    if (String(status || '') === 'deleted') return;
    let mSheet = getSheet().getSheetByName('成員名單');
    if (!mSheet) { mSheet = getSheet().insertSheet('成員名單'); mSheet.appendRow(['YMIS', '姓名', '加入日期', '支部', '聯絡', '備註']); }
    if (mSheet.getLastColumn() < 6) mSheet.getRange(1, 6).setValue('備註');
    const mRow = memberNameRowExists_(ymis);
    if (mRow) mSheet.getRange(mRow.row, 2).setValue(name);
    else mSheet.appendRow([ymis, name, new Date(), branch || '', email || '', '']);
  } catch (e) { }
}
function upsertUser(raw, actor) {
  raw = raw || {};
  actor = linkActorLabel(actor);
  const ymis = String(raw.ymis || '').trim();
  const email = String(raw.email || '').trim().substring(0, 160);
  const hash = String(raw.password_hash || '').trim().toLowerCase();
  if (!ymis) return { success: false, ymis: '', error: '缺少 YMIS' };
  if (raw.password !== undefined && raw.password !== null && String(raw.password) !== '') return { success: false, ymis: ymis, error: '匯入不可帶明文 password；請只用 password_hash' };
  if (hash && !LINK_HASH_RE.test(hash)) return { success: false, ymis: ymis, error: 'password_hash 必須是 64 位 SHA-256 hex' };
  if (!/^\d{10}$/.test(ymis) && !/^L\d+$/i.test(ymis)) return { success: false, ymis: ymis, error: 'YMIS 須為 10 位數字或 L 編號' };
  if (email && !isValidEmail_(email)) return { success: false, ymis: ymis, error: 'Email 格式不正確' };
  const role = VALID_ROLES.indexOf(String(raw.role || '')) >= 0 ? String(raw.role) : 'member';
  if (isSuperAdminId(ymis) || isSuperAdminId(email)) return { success: false, ymis: ymis, error: '此帳號已被保留，不可操作' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, ymis: ymis, error: '系統正處理另一項寫入，請稍後重試' };
  try {
    const sheet = getSheet().getSheetByName('Users');
    if (!sheet) return { success: false, ymis: ymis, error: 'Users 工作表不存在，請先執行 initializeSheets()' };
    ensureForceChangeCol(sheet);
    const data = sheet.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < data.length; i++) { if (String(data[i][0] || '').trim() === ymis) { row = i + 1; break; } }
    if (row < 0 && email) {
      const ex = emailTakenAnyStatus_(email, '');
      if (ex) row = ex.row;
    }
    if (row < 0 && !hash) return { success: false, ymis: ymis, error: '新增帳戶必須帶 password_hash（匯入只接受 hash）' };
    if (row > 0) {
      const curRole = String(data[row - 1][3] || '').trim();
      if (curRole === 'super_admin' || isSuperAdminId(String(data[row - 1][0] || ''))) return { success: false, ymis: ymis, error: '不能操作系統管理員帳號' };
    }
    const existingName = row > 0 ? String(data[row - 1][1] || '') : '';
    const name = safeSheetText(raw.name, 100) || existingName;
    if (!name) return { success: false, ymis: ymis, error: '姓名不可留空' };
    const branch = safeSheetText(raw.branch, 100);
    const status = ['active', 'inactive', 'deleted'].indexOf(String(raw.status || '')) >= 0 ? String(raw.status) : 'active';
    const force = raw.force_change_password === undefined ? false : isForceChangeValue(raw.force_change_password);
    const allowed = raw.allowed_badges === undefined || raw.allowed_badges === null ? '' : String(raw.allowed_badges);
    if (row > 0) {
      // 1-based 欄位：2 name 3 email 4 role 5 password_hash 6 branch 7 can_tick 8 auth_by 9 auth_date 12 status 13 allowed_badges 14 force_change_password
      function setCol(col, val) { if (col) sheet.getRange(row, col).setValue(val); }
      setCol(2, name);
      if (email) setCol(3, email);
      setCol(4, role);
      if (hash) setCol(5, hash);
      if (branch) setCol(6, branch);   // 冇帶 branch 就唔洗改既有小隊
      if (raw.can_tick !== undefined) setCol(7, raw.can_tick === true || String(raw.can_tick).toUpperCase() === 'TRUE');
      setCol(8, actor);
      setCol(9, now());
      setCol(12, status);
      if (allowed !== '') setCol(13, allowed);
      else if (!String(data[row - 1][12] || '') && sheet.getLastColumn() >= 13) setCol(13, role === 'member' ? '' : (role === 'exec_committee' ? 'L1,活動段章,OTHER' : '*'));
      setCol(FORCE_CHANGE_COL, force);
      syncMemberRow_(ymis, name, branch, email, status);
      writeAudit(actor, 'link_upsert_update', ymis, '上游／匯入更新帳戶' + (hash ? '（直插 hash）' : '（保留原密碼）'));
      return { success: true, ymis: ymis, action: 'updated', password_kept: !hash };
    }
    const nowStr = now();
    const canTickNew = raw.can_tick === true || String(raw.can_tick).toUpperCase() === 'TRUE';
    const defAllowed = allowed !== '' ? allowed : (role === 'member' ? '' : (role === 'exec_committee' ? 'L1,活動段章,OTHER' : '*'));
    sheet.appendRow([ymis, name, email, role, hash, branch, canTickNew, actor, nowStr, String(raw.created_at || '') || nowStr, String(raw.last_login || ''), status, defAllowed, force]);
    syncMemberRow_(ymis, name, branch, email, status);
    writeAudit(actor, 'link_upsert_create', ymis, '上游／匯入新增帳戶（直插 hash，保留舊密碼）');
    return { success: true, ymis: ymis, action: 'created', password_kept: false };
  } finally { lock.releaseLock(); }
}
function handleUpsertUser(raw, actor) { return jsonResponse(upsertUser(raw, actor)); }
function importUsersFromText(text, actor) {
  actor = linkActorLabel(actor);
  let parsed = null;
  try { parsed = JSON.parse(String(text || '')); } catch (e) { return { success: false, error: 'JSON 格式不正確：' + ((e && e.message) || e) }; }
  const list = Array.isArray(parsed) ? parsed : ((parsed && Array.isArray(parsed.users)) ? parsed.users : null);
  if (!list) return { success: false, error: '找不到 users 陣列；請使用「匯出 JSON（含 hash）」產生的檔案' };
  if (!list.length) return { success: true, count: 0, created: 0, updated: 0, failed: 0, results: [], message: '檔案內沒有帳戶' };
  if (list.length > 2000) return { success: false, error: '一次最多匯入 2000 筆，請分批' };
  const results = [];
  let created = 0, updated = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    const r = upsertUser(list[i], actor);
    if (r && r.success) { if (r.action === 'created') created++; else updated++; } else failed++;
    results.push({ ymis: String((list[i] && list[i].ymis) || ''), success: !!(r && r.success), action: (r && r.action) || '', error: (r && r.error) || '' });
  }
  writeAudit(actor, 'link_import_users', '新增 ' + created + '／更新 ' + updated, '失敗 ' + failed + '（共 ' + list.length + ' 筆）');
  return { success: failed === 0, count: list.length, created: created, updated: updated, failed: failed, results: results, message: '匯入完成：新增 ' + created + '、更新 ' + updated + '、失敗 ' + failed };
}
function importUsersFromDrive(fileIdOrUrl, actor) {
  const input = String(fileIdOrUrl || '').trim();
  if (!input) return { success: false, error: '請貼上 Drive 檔案 ID 或連結' };
  const matched = input.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  const fileId = matched ? matched[1] : input.replace(/\?.*$/, '');
  let text = '';
  try { text = DriveApp.getFileById(fileId).getBlob().getDataAsString(); }
  catch (e) { return { success: false, error: '讀不到 Drive 檔案：' + ((e && e.message) || e) }; }
  return importUsersFromText(text, actor);
}
function handleSignedImport(body, actor) {
  if (Array.isArray(body.users)) return jsonResponse(importUsersFromText(JSON.stringify({ users: body.users }), actor));
  if (typeof body.json === 'string') return jsonResponse(importUsersFromText(body.json, actor));
  if (typeof body.drive_file_id === 'string') return jsonResponse(importUsersFromDrive(body.drive_file_id, actor));
  return jsonResponse({ success: false, error: 'importUsers 需要 users[]、json 字串或 drive_file_id' });
}

// ---- 下游：簽名請求路由（login／apply／logout／changePassword 等永不接受）----
function handleSignedRequest(action, body) {
  if (LINK_SIG_READ_ACTIONS.indexOf(action) < 0 && LINK_SIG_WRITE_ACTIONS.indexOf(action) < 0) {
    return jsonResponse({ success: false, error: '上游簽名請求不接受此操作：' + action });
  }
  const manager = linkManager(body);
  const actor = manager.ymis;
  if (LINK_SIG_WRITE_ACTIONS.indexOf(action) >= 0) {
    writeAudit('upstream', 'link_signed_' + action, actor, safeSheetText(body.on_behalf_name, 80) + '（sig 已驗證）');
  }
  if (action === 'getLinkState') return jsonResponse(getLinkState());
  if (action === 'setLocalLogin') {
    const allow = ['1', 'true', 'yes', 'on', 'open'].indexOf(String(body.allow || '').trim().toLowerCase()) >= 0;
    setLocalLoginAllowed(allow, 'upstream:' + actor);
    return jsonResponse({ success: true, allow_local_login: allow, message: allow ? '直接入口已開啟' : '直接入口已閂，只收上游 sig' });
  }
  if (action === 'load') return handleLoad();
  if (action === 'getLoginMode') return jsonResponse({ success: true, login_mode: 'standalone', local_login: localLoginAllowed(), upstream_only: !localLoginAllowed() });
  if (action === 'getMembers') return jsonResponse({ success: true, members: getMembers() });
  if (action === 'getConfig') return handleGetConfig();
  if (action === 'getAllUsers') return jsonResponse({ success: true, users: getAllUsers() });
  if (action === 'getOtherBadges') return handleGetOtherBadges(String(body.target_ymis || ''));
  if (action === 'getPendingRequests') return handleGetPendingRequests();
  if (action === 'getApplications') return handleGetApplications();
  if (action === 'getLogRecords') return handleGetLogRecords();
  if (action === 'getPendingLogRequests') return handleGetPendingLogRequests(manager);
  if (action === 'save') return handleSave(body.changes || [], String(body.confirmer || actor));
  if (action === 'saveOtherBadge') return handleSaveOtherBadge(body.records || []);
  if (action === 'requestComplete') return handleRequestComplete(body, actor);
  if (action === 'reviewRequest') return handleReviewRequest(body.request_id, body.decision, body.review_note, actor, body.confirmed_date);
  if (action === 'addMember') return handleAddMember(body.ymis, body.name, body.squad || '', body.squad_role || 'member');
  if (action === 'addUser') return handleAddUser(body, manager);
  if (action === 'upsertUser') return handleUpsertUser(body.user || body, actor);
  if (action === 'importUsers') return handleSignedImport(body, actor);
  if (action === 'resetPassword') return handleResetPassword(body.target_ymis, actor, body.new_password);
  if (action === 'deactivateUser') return handleDeactivateUser(body, manager, actor);
  if (action === 'reactivateUser') return handleReactivateUser(body, manager, actor);
  if (action === 'updateUserProfile') return handleUpdateUserProfile(body, manager, actor);
  if (action === 'deleteMember') return handleDeleteMember(body, manager, actor);
  if (action === 'deleteUser') return handleDeleteUser(body, manager, actor);
  if (action === 'updateUserRole' || action === 'updatePermissions') return handleUpdateUserRole(body.target_ymis, body.new_role, body.can_tick, actor, body.allowed_badges);
  if (action === 'saveLogRecord') return handleSaveLogRecord(body.records || (body.record ? [body.record] : []), actor, String(body.recorder_name || ''));
  if (action === 'deleteLogRecord') return handleDeleteLogRecord(body.record_id, actor);
  if (action === 'reviewLogRequest') return handleReviewLogRequest(body.request_id, body.decision, actor, body.review_note);
  if (action === 'reviewApplication') return handleReviewApplication(body.app_id, body.decision, body.review_note, manager);
  return jsonResponse({ success: false, error: '上游簽名請求不接受此操作：' + action });
}

// ===== 工具 =====
function getSheet() { return SpreadsheetApp.getActiveSpreadsheet(); }
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');
  if (!apiKey) {
    apiKey = 'rover_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', apiKey);
  }
  return apiKey;
}
function showApiKey() {
  const apiKey = getApiKey();
  const ui = SpreadsheetApp.getUi();
  if (ui) ui.alert('API Key', '你的 API Key：\n\n' + apiKey, ui.ButtonSet.OK);
  Logger.log('API Key: ' + apiKey);
  return apiKey;
}

// ===== 系統保留帳號（super_admin 角色）=====
// 識別字只在上方 SUPER_ADMIN_ID 一行宣告；本檔不含任何登入密碼。
// 權限判斷、名單過濾與各項防護（不能停用／重設密碼／更改角色／開戶）照舊。
function isSuperAdminId(id) {
  const v = String(id || '').trim().toLowerCase();
  return v === String(SUPER_ADMIN_ID).trim().toLowerCase() || v === String(SUPER_ADMIN_EMAIL).trim().toLowerCase();
}
// 升級後在編輯器執行一次，只授權 UrlFetch，不讀寫 Sheet。
function authorizeConnection(){
  const response=UrlFetchApp.fetch(SUPER_VERIFY_URL,{muteHttpExceptions:true});
  if(response.getResponseCode()!==405) throw new Error('連線服務未就緒，請檢查部署設定');
  return '連線正常，請更新 Apps Script 既有部署至新版本';
}
function verifySuperTicket(ticket){
  if(typeof ticket!=='string' || ticket.length>4096) return false;
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return false;
  try{
    const cache=CacheService.getScriptCache();
    const cacheKey='super-ticket:'+hashPassword(ticket);
    if(cache.get(cacheKey)) return false;
    const response=UrlFetchApp.fetch(SUPER_VERIFY_URL, {
      method:'post', contentType:'application/json', muteHttpExceptions:true,
      payload:JSON.stringify({ticket:ticket, apikey:getApiKey(), backend:ScriptApp.getService().getUrl()})
    });
    if(response.getResponseCode()!==200 || JSON.parse(response.getContentText()).ok!==true) return false;
    cache.put(cacheKey,'used',120);
    return true;
  }catch(e){ return false; }
  finally{ try{ lock.releaseLock(); }catch(e){} }
}
function setSuperAdminLastLogin(){
  PropertiesService.getScriptProperties().setProperty('SUPER_ADMIN_LAST_LOGIN', now());
}

function hashPassword(p) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function(b){return ('0' + (b & 0xFF).toString(16)).slice(-2);}).join('');
}
function generateToken(){ return Utilities.getUuid().replace(/-/g,'') + Date.now().toString(36); }
function now(){ return Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss'); }
function formatDate(d){ if(!d) return ''; if(d instanceof Date) return Utilities.formatDate(d,'Asia/Hong_Kong','yyyy-MM-dd'); return d.toString().split(' ')[0]; }
function jsonResponse(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

const ROLE_HIERARCHY = { 'super_admin':100,'admin':80,'group_leader':60,'branch_leader':40,'exec_committee':20,'member':0 };
const CAN_TICK_ROLES = ['admin','group_leader','branch_leader','exec_committee','super_admin'];
const CAN_MANAGE_ROLES = { 
  'super_admin': ['admin','group_leader','branch_leader','exec_committee','member'],
  'admin': ['group_leader','branch_leader','exec_committee','member'], 
  'group_leader': ['branch_leader','exec_committee','member'], 
  'branch_leader': ['exec_committee','member'] 
};
function canUserTick(r){ return CAN_TICK_ROLES.indexOf(r)>=0; }
function getRoleLevel(r){ return ROLE_HIERARCHY[r]||0; }
function canManageRole(m,t){ return (CAN_MANAGE_ROLES[m]||[]).indexOf(t)>=0; }
function canManageUser(manager,targetRole){ return manager && (manager.role==='super_admin' || canManageRole(manager.role,targetRole)); }
function generateLeaderId(){
  for(let i=0;i<20;i++){
    const id='L'+Date.now().toString().substring(7)+Math.floor(Math.random()*90+10);
    if(!getUser(id)) return id;
  }
  return 'L'+Date.now().toString()+Math.floor(Math.random()*900+100);
}
function findActiveGroupLeader(excludeYmis){
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return null;
  const data=uSheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0] && String(data[i][0])!==String(excludeYmis||'') && data[i][3] && String(data[i][3])==='group_leader' && data[i][11] && String(data[i][11])==='active'){
      return {ymis:String(data[i][0]), name:data[i][1]?String(data[i][1]):''};
    }
  }
  return null;
}
// 公開申請只接受 member／branch_leader（管委／團長／管理員須由現任管理層直接開立）
const VALID_ROLES = ['member','exec_committee','branch_leader','group_leader','admin'];
const APPLY_ROLES = ['member','branch_leader'];
const FORCE_CHANGE_COL = 14;
function ensureForceChangeCol(uSheet){
  if(!uSheet) return;
  if(uSheet.getLastColumn()<FORCE_CHANGE_COL || !String(uSheet.getRange(1,FORCE_CHANGE_COL).getValue()||'').trim()){
    uSheet.getRange(1,FORCE_CHANGE_COL).setValue('force_change_password');
  }
}
function isForceChangeValue(v){ return v===true || String(v).toUpperCase()==='TRUE'; }
// 設計：停用帳號仍佔用其 YMIS／Email（保留歷史進度與審批軌跡），不可用同一 YMIS／Email 另開新帳號；
//       如需重用，領袖應在「用戶管理」恢復該帳號（reactivateUser）而非重新開戶。
function normalizeEmail_(email){ return String(email||'').trim().toLowerCase(); }
function isValidEmail_(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||'').trim()); }
// 在 Users 表找 YMIS（不分 active／inactive；保留帳號不存表，另由 isSuperAdminId 把關）
function findUserRowAnyStatus_(ymis){
  const key=String(ymis||'').trim();
  if(!key) return null;
  const sh=getSheet().getSheetByName('Users');
  if(!sh) return null;
  const data=sh.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]||'').trim()===key){
      return {row:i+1, ymis:key, name:data[i][1]?String(data[i][1]):'', email:data[i][2]?String(data[i][2]).trim():'', role:data[i][3]?String(data[i][3]):'member', status:String(data[i][11]||'').trim()||'active'};
    }
  }
  return null;
}
function ymisTakenAnyStatus_(ymis){ return !!findUserRowAnyStatus_(ymis); }
// Email 是否已被佔用（不分 active／inactive；excludeYmis 用於「修改自己電郵」時排除自己）
function emailTakenAnyStatus_(email, excludeYmis){
  const target=normalizeEmail_(email);
  if(!target) return null;
  const sh=getSheet().getSheetByName('Users');
  if(!sh) return null;
  const data=sh.getDataRange().getValues();
  const ex=String(excludeYmis||'').trim();
  for(let i=1;i<data.length;i++){
    const rowY=String(data[i][0]||'').trim();
    if(!rowY) continue;
    if(ex && rowY===ex) continue;
    if(normalizeEmail_(data[i][2])===target){
      return {row:i+1, ymis:rowY, name:data[i][1]?String(data[i][1]):'', status:String(data[i][11]||'').trim()||'active'};
    }
  }
  return null;
}
function memberNameRowExists_(ymis){
  const key=String(ymis||'').trim();
  if(!key) return null;
  const mSheet=getSheet().getSheetByName('成員名單');
  if(!mSheet) return null;
  const data=mSheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]||'').trim()===key) return {row:i+1, name:data[i][1]?String(data[i][1]):''};
  }
  return null;
}
function maskEmail_(email){
  const e=String(email||'').trim();
  const at=e.indexOf('@');
  if(at<=0) return '***';
  const nm=e.substring(0,at), domain=e.substring(at);
  if(nm.length<=2) return nm.charAt(0)+'*'+domain;
  return nm.charAt(0)+'***'+nm.charAt(nm.length-1)+domain;
}

// ===== 初始化 =====
function initializeSheets() {
  const ss = getSheet();
  let pSheet = ss.getSheetByName('進度追蹤');
  if(!pSheet){
    pSheet = ss.insertSheet('進度追蹤');
    pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);
    pSheet.getRange(1,1,1,6).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    pSheet.setFrozenRows(1);
  } else {
    // ensure 6 columns header
    if(pSheet.getLastColumn()<6){
      pSheet.getRange(1,5).setValue('確認者'); pSheet.getRange(1,6).setValue('備註');
    }
  }
  let mSheet = ss.getSheetByName('成員名單');
  if(!mSheet){
    mSheet = ss.insertSheet('成員名單');
    mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡']);
    mSheet.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    mSheet.setFrozenRows(1);
  }
  let uSheet = ss.getSheetByName('Users');
  if(!uSheet){
    uSheet = ss.insertSheet('Users');
    uSheet.appendRow(['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','force_change_password']);
    uSheet.getRange(1,1,1,14).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    uSheet.setFrozenRows(1);
    uSheet.getRange(2,1).setValue(ADMIN_YMIS);
    uSheet.getRange(2,2).setValue(ADMIN_NAME);
    uSheet.getRange(2,3).setValue(ADMIN_EMAIL);
    uSheet.getRange(2,4).setValue('admin');
    uSheet.getRange(2,5).setValue(hashPassword(ADMIN_PASS));
    uSheet.getRange(2,6).setValue('b4');
    uSheet.getRange(2,7).setValue(true);
    uSheet.getRange(2,8).setValue('system');
    uSheet.getRange(2,9).setValue(now());
    uSheet.getRange(2,10).setValue(now());
    uSheet.getRange(2,12).setValue('active');
    uSheet.getRange(2,13).setValue('*'); // 管理員默認全部
    uSheet.getRange(2,14).setValue(true);
  } else {
    // 確保第13欄存在
    if(uSheet.getLastColumn()<13){
      uSheet.getRange(1,13).setValue('allowed_badges');
    }
    ensureForceChangeCol(uSheet);
  }
  let aSheet = ss.getSheetByName('Applications');
  if(!aSheet){
    aSheet = ss.insertSheet('Applications');
    aSheet.appendRow(['app_id','ymis','name','email','role','branch','status','applied_at','reviewed_by','reviewed_at','note']);
    aSheet.getRange(1,1,1,11).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    aSheet.setFrozenRows(1);
  }
  let tSheet = ss.getSheetByName('Tokens');
  if(!tSheet){
    tSheet = ss.insertSheet('Tokens');
    tSheet.appendRow(['token','ymis','created_at','expires_at']);
    tSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    tSheet.setFrozenRows(1);
  }
  let cSheet = ss.getSheetByName('SystemConfig');
  if(!cSheet){
    cSheet = ss.insertSheet('SystemConfig');
    cSheet.appendRow(['key','value','updated_at','updated_by']);
    cSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    cSheet.setFrozenRows(1);
    cSheet.appendRow(['login_mode','standalone',now(),'system']);
    cSheet.appendRow(['admin_email',ADMIN_EMAIL,now(),'system']);
  }
  // 新增：待批完成表
  let prSheet = ss.getSheetByName('待批完成');
  if(!prSheet){
    prSheet = ss.insertSheet('待批完成');
    prSheet.appendRow(['request_id','ymis','name','item_id','item_name','requested_date','evidence','status','created_at','reviewed_by','reviewed_at','review_note','confirmed_date']);
    prSheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    prSheet.setFrozenRows(1);
  }
  // 其他獎章紀錄表
  let oSheet = ss.getSheetByName('其他獎章');
  if(!oSheet){
    oSheet = ss.insertSheet('其他獎章');
    oSheet.appendRow(['YMIS','獎章 ID','獎章名稱','完成日期','證書編號','備註','更新時間']);
    oSheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    oSheet.setFrozenRows(1);
  }
  // 前端管理操作審計
  let auditSheet = ss.getSheetByName('操作紀錄');
  if(!auditSheet){
    auditSheet = ss.insertSheet('操作紀錄');
    auditSheet.appendRow(['時間','操作者','操作','對象','詳情']);
    auditSheet.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    auditSheet.setFrozenRows(1);
  }
  let lSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if(!lSheet){
    lSheet = ss.insertSheet(LOG_SHEET_NAME);
    lSheet.appendRow(LOG_HEADERS);
    lSheet.getRange(1,1,1,LOG_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lSheet.setFrozenRows(1);
  }
  let lpSheet = ss.getSheetByName(LOG_PENDING_SHEET_NAME);
  if(!lpSheet){
    lpSheet = ss.insertSheet(LOG_PENDING_SHEET_NAME);
    lpSheet.appendRow(LOG_PENDING_HEADERS);
    lpSheet.getRange(1,1,1,LOG_PENDING_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lpSheet.setFrozenRows(1);
  }

  // 旅系統：不預設寫入 ALLOW_LOCAL_LOGIN（未設定＝開啟，現有旅團零影響）；登記下游／sig／閂口全部經選單「🔗 旅系統」操作，資料只存 Script Properties
  // 確保系統設定有 allow_member_view_others
  let cfgSheet = ss.getSheetByName('SystemConfig');
  if(cfgSheet){
    const cfgData=cfgSheet.getDataRange().getValues();
    let hasAllow=false;
    for(let i=1;i<cfgData.length;i++){ if(cfgData[i][0]==='allow_member_view_others'){ hasAllow=true; break; } }
    if(!hasAllow){
      cfgSheet.appendRow(['allow_member_view_others','false',now(),'system']);
    }
  }

  const apiKey = getApiKey();
  let scriptUrl=''; try{ scriptUrl=ScriptApp.getService().getUrl(); }catch(e){ scriptUrl='請部署為網頁應用程式後查看';}
  // 清除 Users 表殘留的 super_admin 列（保留帳號不存於 Sheet）
  try{ removeSuperAdminRows(); }catch(e){}
  try{
    const ui=SpreadsheetApp.getUi();
    if(ui){
      // 提示只顯示本旅團自己的 API Key、URL 與旅團管理員帳號
      ui.alert('✅ 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章、活動履歷、待批履歷\n\n🔗 旅系統：選單「🔗 旅系統」→「🔑 顯示 BACKEND／APIKEY（交 ADMIN）」一次過抄 B／D；上下游接駁（登記下游／sig／閂口／搬舊數）全部經該選單操作\n\n🔑 API Key:\n'+apiKey+'\n\n👤 旅團管理員 YMIS: '+ADMIN_YMIS+' 初始密碼: '+ADMIN_PASS+'（請立即登入後更改）\n\n🌐 URL:\n'+scriptUrl);
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

// 保留帳號 (super_admin) 不存於 Users 表。
// removeSuperAdminRows()：清除 Users 表內殘留的 super_admin 列（舊版寫入的），
// - initializeSheets() 會自動執行
// - 可單獨在 Apps Script 編輯器執行，只刪 super_admin 列，不影響其他資料
function removeSuperAdminRows(){
  const ss=getSheet();
  const uSheet=ss.getSheetByName('Users');
  if(!uSheet) return {success:true,removed:0,message:'Users 工作表不存在，無需清理'};
  if(uSheet.getLastColumn()<13){
    uSheet.getRange(1,13).setValue('allowed_badges');
  }
  const data=uSheet.getDataRange().getValues();
  const su=SUPER_ADMIN_ID;
  let removed=0;
  for(let i=data.length-1;i>=1;i--){
    const y=String(data[i][0]||'').trim().toLowerCase();
    const role=String(data[i][3]||'').trim().toLowerCase();
    // 舊版殘留列：角色為 super_admin，或 YMIS 與保留帳號識別字相同
    if(role==='super_admin' || (su && y===su)){
      uSheet.deleteRow(i+1);
      removed++;
    }
  }
  return {success:true,removed:removed,message:'已從 Users 表移除 '+removed+' 列 super_admin 殘留列（保留帳號不存於 Users 表）'};
}

// ===== 用戶查詢 =====
function getUser(ymis){
  // 保留帳號 (super_admin) 免 Users 表，直接返回最高權限
  if(isSuperAdminId(ymis)){
    return {ymis:SUPER_ADMIN_ID,name:SUPER_ADMIN_NAME,email:'',role:'super_admin',can_tick:true,branch:'',squad:'',squad_role:'member',allowed_badges:'*',status:'active'};
  }
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  const hasAllowedCol = sheet.getLastColumn()>=13;
  const key=String(ymis||'').trim();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]||'').trim()===key && String(data[i][11]||'').trim()==='active'){
      return {
        ymis:data[i][0].toString(),
        name:data[i][1]?data[i][1].toString():'',
        email:data[i][2]?data[i][2].toString():'',
        role:data[i][3]?data[i][3].toString():'member',
        can_tick:data[i][6]===true||data[i][6]==='TRUE',
        branch:data[i][5]?data[i][5].toString():'',
        squad:data[i][5]?data[i][5].toString():'',
        squad_role:'member',
        allowed_badges: hasAllowedCol ? (data[i][12]?data[i][12].toString():'') : '',
        status:'active',
        force_change_password: data[i].length>=FORCE_CHANGE_COL && isForceChangeValue(data[i][FORCE_CHANGE_COL-1])
      };
    }
  }
  return null;
}
function getUserByEmail(email){
  if(!email) return null;
  // 保留帳號電郵別名（與識別字等值）
  if(String(email||'').trim().toLowerCase()===String(SUPER_ADMIN_EMAIL).trim().toLowerCase()) return getUser(SUPER_ADMIN_ID);
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues(); const target=String(email||'').trim().toLowerCase();
  if(!target) return null;
  const hasAllowed = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){
    if(String(data[i][2]||'').trim().toLowerCase()===target && String(data[i][11]||'').trim()==='active'){
      return {ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',email:data[i][2].toString(),role:data[i][3]?data[i][3].toString():'member',can_tick:data[i][6]===true||data[i][6]==='TRUE',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : '',squad:data[i][5]?data[i][5].toString():'',squad_role:'member'};
    }
  }
  return null;
}
function getAllUsers(){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return [];
  const users=[]; const data=sheet.getDataRange().getValues();
  const hasAllowed = sheet.getLastColumn()>=13;
  // 保留帳號不存於 Users 表；若 Sheet 有殘留的 super_admin 列亦一律略過
  for(let i=1;i<data.length;i++){
    const y=String(data[i][0]||'').trim();
    if(!y) continue;
    const role=data[i][3]?data[i][3].toString():'member';
    if(role==='super_admin' || isSuperAdminId(y)) continue;
    const status=String(data[i][11]||'').trim()||'active';
    users.push({ymis:y,name:data[i][1]?data[i][1].toString():'',email:data[i][2]?data[i][2].toString():'',role:role,can_tick:data[i][6]===true||data[i][6]==='TRUE',branch:data[i][5]?data[i][5].toString():'',squad:data[i][5]?data[i][5].toString():'',squad_role:'member',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : '',status:status});
  }
  return users;
}

// Token
function validateToken(token){
  if(!token) return null;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0]===token){
      if(new Date()>new Date(data[i][3])){ sheet.deleteRow(i+1); return null; }
      const y=data[i][1].toString();
      // 舊版殘留／保留帳號列：非超管標記 token 一律即時失效（唔使動 Sheet）
      if((y===SUPER_ADMIN_TOKEN_MARK || isSuperAdminId(y)) && !String(token).startsWith(SUPER_TOKEN_PREFIX)) return null;
      // 保留帳號 token 列在 Sheet 內以中性代號儲存，讀出時還原（Sheet 唔會出現帳號）
      // 向後兼容：舊版直接寫了帳號的列，經 isSuperAdminId() 一樣還原
      return (y===SUPER_ADMIN_TOKEN_MARK || isSuperAdminId(y)) ? SUPER_ADMIN_ID : y;
    }
  }
  return null;
}
function createToken(ymis){
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=(isSuperAdminId(ymis)?SUPER_TOKEN_PREFIX:'')+generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  // 保留帳號 session 喺 Tokens 表只寫中性代號，令整份 Sheet 都搵唔到帳號
  sheet.appendRow([token,isSuperAdminId(ymis)?SUPER_ADMIN_TOKEN_MARK:ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
  return token;
}
function destroyToken(token){
  if(!token) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===token){ sheet.deleteRow(i+1); return; } }
}

// ===== API =====
function doGet(e){
  const params=(e&&e.parameter)||{};
  const action=String(params.action||'');
  // 旅系統：閂口後直接入口一律拒絕（只收上游 sig；簽名請求一律走 doPost）
  // 例外：中央管理帳號 token（超管唔經旅團登記 Sheet，閂口後仍可入嚟救援）
  if(!localLoginAllowed() && !isSuperAdminToken(params.token)) return jsonResponse(linkClosedResponse(action));
  if(action==='load'){
    // 向後兼容：allow load without apikey (troops.json may not have apikey)，但帶咗 apikey 就必須驗證
    const reqKey=params.apikey;
    if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
    return handleLoad();
  }
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone',local_login:localLoginAllowed(),upstream_only:!localLoginAllowed()});
  return jsonResponse({success:false,error:'Unknown action'});
}
function doPost(e){
  try{
    const rawBody=String(((e&&e.postData)||{}).contents||'{}');
    const body=JSON.parse(rawBody||'{}');
    const action=String(body.action||'');
    // 旅系統：上游簽名（sig）請求優先路由（先驗 sig）；未簽名時先留中央登入，再檢查直接入口掣
    if(verifyLinkSig(e,body,rawBody)) return handleSignedRequest(action,body);
    // 中央管理帳號登入（Vercel 側 SUPER_KEY 驗證 → 短效票據 → 固定端點驗票）：與旅系統閘門無關，
    // 直接入口關閉後仍要可用（超管唔係經旅團登記 Sheet 開嘅戶，係救援鎖死旅團嘅最後通道）；
    // 只放行保留帳號＋super_ticket（防：一般帳號帶假票據繞過閂口）
    if(action==='login' && body.super_ticket && isSuperAdminId(body.login_id)) return handleLogin(body.login_id,body.password,body.super_ticket);
    // 旅系統：閂口後本地直接入口全拒（login/apply/GET load/apikey save/token 操作），只收 sig
    // 例外：中央管理帳號 token（rbs-super-v1-）照放行——超管登入後要救到嘢（getAllUsers／重設密碼／
    // setAllowLocalLogin 重開掣等），否則閂口鎖死連超管都救唔返
    if(!localLoginAllowed() && !isSuperAdminToken(body.token)) return jsonResponse(linkClosedResponse(action));
    if(action==='login') return handleLogin(body.login_id,body.password);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role||'member',body.branch);
    if(action==='forgotPassword') return handleForgotPassword(body.login_id);

    // save & addMember 需要 apikey (向下兼容：若無 apikey 但有有效 token 也允許)
    if(action==='save' || action==='addMember' || action==='addUser' || action==='saveOtherBadge'){
      const reqKey=body.apikey;
      if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
      // 若無 apikey，嘗試 token 驗證作為後備
      if(!reqKey && body.token){
        const tk=validateToken(body.token);
        if(!tk && action!=='addMember') return jsonResponse({success:false,error:'未授權 - 需 API Key 或有效 Token'});
      }
      if(action==='save') return handleSave(body.changes, body.confirmer||'');
      if(action==='addMember'){
        const my=body.token?validateToken(body.token):null;
        const mgr=my?getUser(my):null;
        if(!mgr && body.apikey && body.apikey===getApiKey()) mgr={role:'admin'};
        if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以新增成員'});
        return handleAddMember(body.ymis, body.name, body.squad||'', body.squad_role||'member');
      }
      if(action==='addUser'){
        const my=body.token?validateToken(body.token):null;
        const mgr=my?getUser(my):null;
        if(!mgr && body.apikey && body.apikey===getApiKey()) mgr={role:'admin'};
        if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以開新帳號'});
        return handleAddUser(body,mgr);
      }
      if(action==='saveOtherBadge') return handleSaveOtherBadge(body.records, body.apikey);
    }
    // member request - needs token but also allow apikey for member self
    if(action==='requestComplete'){
      // allow token or apikey
      let ymis=null; if(body.token){ ymis=validateToken(body.token); }
      if(!ymis && body.apikey && body.apikey===getApiKey()){ ymis=body.ymis; } // standalone mode
      if(!ymis) return jsonResponse({success:false,error:'未授權'});
      return handleRequestComplete(body, ymis);
    }

    // 以下需要 token 驗證及高權限
    const ymis=validateToken(body.token);
    if(!ymis) return jsonResponse({success:false,error:'Token 無效或過期'});
    const user=getUser(ymis);
    if(!user) return jsonResponse({success:false,error:'找不到用戶'});

    // 上下游旗標：讀取只需登入；設置需團長以上（掣同時在上游選單，可經 sig 打下游 setLocalLogin）
    if(action==='getAllowLocalLogin'){
      return handleGetAllowLocalLogin();
    }
    if(action==='setAllowLocalLogin'){
      if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'需團長以上權限'});
      return handleSetAllowLocalLogin(body.allow, ymis);
    }
    // 吐 JSON（搬舊數）：匯出含 hash（proxy 後備通道；主通道係 Sheet 選單「📤 匯出 JSON（含 hash）」→ Drive 私人檔）
    if(action==='exportUsers'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleExportUsers();
    }
    if(action==='upsertUser'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpsertUser(body.user||body, ymis);
    }
    if(action==='getAllUsers') {
      // 任何已登入用戶都可查看名單，方便領袖管理；成員僅查看自己旅團成員
      let list=getAllUsers();
      // 隱藏保留帳號：任何角色（包括 super_admin 自己）一律過濾
      list=list.filter(function(u){ return u.role!=='super_admin' && !isSuperAdminId(u.ymis); });
      return jsonResponse({success:true,users:list});
    }
    if(action==='getMembers'){ return jsonResponse({success:true,members:getMembers()}); }
    if(action==='getPendingRequests'){ if(getRoleLevel(user.role)<0) return jsonResponse({success:false,error:'權限不足'}); return handleGetPendingRequests(); }
    if(action==='reviewRequest'){ if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'}); return handleReviewRequest(body.request_id, body.decision, body.review_note, ymis, body.confirmed_date); }
    if(action==='getOtherBadges'){ return handleGetOtherBadges(body.target_ymis||ymis); }
    if(action==='getApplications'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，需團長/支部領袖'}); return handleGetApplications(); }
    if(action==='reviewApplication'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReviewApplication(body.app_id,body.decision,body.review_note,user); }
    if(action==='getConfig'){
      // 任何已登入用戶都可讀取公開設定
      return handleGetConfig();
    }
    if(action==='getLogRecords') return handleGetLogRecords();
    if(action==='saveLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleSaveLogRecord(body.records||(body.record?[body.record]:[]), ymis, body.recorder_name||'');
    }
    if(action==='deleteLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleDeleteLogRecord(body.record_id, ymis);
    }
    if(action==='getPendingLogRequests') return handleGetPendingLogRequests(user);
    if(action==='submitLogRequest') return handleSubmitLogRequest(body, ymis, user);
    if(action==='reviewLogRequest'){
      if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'});
      return handleReviewLogRequest(body.request_id, body.decision, ymis, body.review_note);
    }

    // 以下為高權限
    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password);
    if(action==='resetPassword'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleResetPassword(body.target_ymis,ymis,body.new_password); }
    if(action==='deactivateUser'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleDeactivateUser(body,user,ymis); }
    if(action==='reactivateUser'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReactivateUser(body,user,ymis); }
    if(action==='updateUserProfile'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleUpdateUserProfile(body,user,ymis); }
    if(action==='deleteMember'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleDeleteMember(body,user,ymis); }
    if(action==='deleteUser'){ if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'徹底刪除需團長以上權限，請先停用帳號再請團長處理'}); return handleDeleteUser(body,user,ymis); }
    if(action==='updateUserRole'){
      // 允許團長/支部領袖/管理員更新角色 + 細緻權限
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role,body.can_tick,ymis, body.allowed_badges);
    }
    if(action==='updatePermissions'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role||null,body.can_tick,ymis, body.allowed_badges);
    }
    if(action==='updateConfig'){
      // allow_member_view_others 可由團長以上設定，其他設定需管理員
      const key=body.key;
      if(key==='allow_member_view_others'){
        if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'需團長以上權限'});
      }else{
        if(getRoleLevel(user.role)<80) return jsonResponse({success:false,error:'需管理員權限'});
      }
      return handleUpdateConfig(body.key,body.value,ymis);
    }
    return jsonResponse({success:false,error:'Unknown action'});
  }catch(err){ return jsonResponse({success:false,error:err.toString()}); }
}

// ===== 邏輯 =====
// 中央管理帳號（vs 同構）：Vercel 驗證密碼 → 簽發短效加密票據 →
//       本函數向固定受信端點（SUPER_VERIFY_URL）驗票 → 通過後才建立 session。
// 本檔永不接收、儲存或比對任何密碼；票據一次性（LockService＋CacheService）防重放。
function handleLogin(loginId,password,superTicket){
  if(!loginId||(!password&&!superTicket)) return jsonResponse({success:false,error:'請填寫帳號和密碼'});
  if(isSuperAdminId(loginId)){
    if(!verifySuperTicket(superTicket)) return jsonResponse({success:false,error:'帳號或密碼錯誤'});
    setSuperAdminLastLogin();
    const token=createToken(SUPER_ADMIN_ID);
    return jsonResponse({success:true,token:token,user:{ymis:SUPER_ADMIN_ID,name:SUPER_ADMIN_NAME,email:SUPER_ADMIN_EMAIL,role:'super_admin',can_tick:true,branch:'',squad:'',squad_role:'member',allowed_badges:'*',status:'active'},force_change_password:false});
  }
  let user=(/^\d{10}$/.test(loginId)||/^L\d+/.test(loginId))? getUser(loginId): getUserByEmail(loginId);
  if(!user){
    // try both
    user=getUser(loginId)||getUserByEmail(loginId);
  }
  if(!user) return jsonResponse({success:false,error:'找不到此帳號'});
  const hash=hashPassword(password);
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][11].toString()==='active' && data[i][4].toString()===hash){
      const rowY=data[i][0].toString(); const rowE=data[i][2].toString().toLowerCase();
      if(rowY===user.ymis || rowE===user.email.toLowerCase() || rowY===loginId){
        const token=createToken(user.ymis);
        sheet.getRange(i+1,11).setValue(now());
        const forceChange=data[i].length>=FORCE_CHANGE_COL && isForceChangeValue(data[i][FORCE_CHANGE_COL-1]);
        return jsonResponse({success:true,token:token,user:user,force_change_password:forceChange});
      }
    }
  }
  return jsonResponse({success:false,error:'密碼錯誤'});
}
function handleChangePassword(ymis,oldP,newP){
  // 錯誤訊息刻意不含任何帳號／密碼資訊
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'系統管理員密碼不能由此更改'});
  if(!newP || newP.toString().length<4) return jsonResponse({success:false,error:'新密碼至少4位'});
  if(String(newP)===String(oldP||'')) return jsonResponse({success:false,error:'新密碼不可與原密碼相同'});
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===ymis && data[i][11].toString()==='active'){
      if(data[i][4].toString()===hashPassword(oldP)){
        sheet.getRange(i+1,5).setValue(hashPassword(newP));
        ensureForceChangeCol(sheet);
        sheet.getRange(i+1,FORCE_CHANGE_COL).setValue(false);
        return jsonResponse({success:true});
      }
    }
  }
  return jsonResponse({success:false,error:'原密碼錯誤'});
}
function handleApply(ymis,name,email,role,branch){
  // 領袖免 YMIS（用電郵登入），領袖申請一律忽略 YMIS。管委／團長／管理員不可由此申請。
  ymis=String(ymis||'').trim(); name=safeSheetText(name,100);
  email=String(email||'').trim().substring(0,160); branch=safeSheetText(branch,100);
  role=String(role||'member').trim()||'member';
  if(APPLY_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效的申請角色'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  if(role==='member'){
    if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'成員需 10位 YMIS'});
  }else{
    ymis='';
    if(!email) return jsonResponse({success:false,error:'領袖申請必須填寫聯絡電郵'});
  }
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
  if(isSuperAdminId(ymis) || isSuperAdminId(email)) return jsonResponse({success:false,error:'此帳號已被保留，請使用其他帳號'});
  if(ymis && ymisTakenAnyStatus_(ymis)){
    const ex=findUserRowAnyStatus_(ymis);
    return jsonResponse({success:false,error:(ex && ex.status!=='active')?'此 YMIS 已有帳號紀錄（已停用），請聯絡領袖恢復帳號，不需重新申請':'此 YMIS 已註冊，不可重複申請'});
  }
  if(email && emailTakenAnyStatus_(email,'')){
    const em=emailTakenAnyStatus_(email,'');
    return jsonResponse({success:false,error:(em && em.status!=='active')?'此 Email 已有帳號紀錄（已停用），請聯絡領袖恢復帳號，不需重新申請':'此 Email 已註冊，不可重複申請'});
  }
  const sheet=getSheet().getSheetByName('Applications');
  if(!sheet) return jsonResponse({success:false,error:'Applications 工作表不存在，請先執行 initializeSheets()'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][6])==='pending'){
      if(ymis && String(data[i][1])===ymis) return jsonResponse({success:false,error:'此 YMIS 已有待審批申請'});
      if(email && String(data[i][3]).toLowerCase()===email.toLowerCase()) return jsonResponse({success:false,error:'此 Email 已有待審批申請'});
    }
  }
  sheet.appendRow(['APP_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),ymis,name,email,role,branch||'','pending',now(),'','','']);
  return jsonResponse({success:true,message:'申請已提交'});
}
function handleGetApplications(){
  const sheet=getSheet().getSheetByName('Applications'); const apps=[]; const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][6].toString()==='pending'){ apps.push({app_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),email:data[i][3].toString(),requested_role:data[i][4].toString(),branch:data[i][5].toString(),applied_at:data[i][7]?formatDate(data[i][7]):''}); } }
  return jsonResponse({success:true,applications:apps});
}
function handleReviewApplication(appId,decision,note,manager,tempPassword){
  // 按申請角色開戶；審批者權限不足時退回 member。領袖免 YMIS —— 批准時一律自動編配內部 L 編號。
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決定'});
  const sheet=getSheet().getSheetByName('Applications');
  if(!sheet) return jsonResponse({success:false,error:'找不到 Applications 工作表'});
  const data=sheet.getDataRange().getValues();
  let rowIndex=-1, appData=null;
  for(let i=1;i<data.length;i++){ if(String(data[i][0])===String(appId)){ rowIndex=i+1; appData=data[i]; break; } }
  if(!appData || String(appData[6])!=='pending') return jsonResponse({success:false,error:'找不到待審批申請'});
  const reviewerYmis=(manager && manager.ymis)?String(manager.ymis):String(manager||'');
  if(decision==='rejected'){
    sheet.getRange(rowIndex,7).setValue('rejected');
    sheet.getRange(rowIndex,9).setValue(reviewerYmis);
    sheet.getRange(rowIndex,10).setValue(now());
    sheet.getRange(rowIndex,11).setValue(note||'');
    writeAudit(reviewerYmis,'reject_application',String(appData[1]),String(appId));
    return jsonResponse({success:true,message:'已拒絕申請'});
  }
  const requestedRole=String(appData[4]||'member');
  const finalRole=(APPLY_ROLES.indexOf(requestedRole)>=0 && canManageUser(manager,requestedRole))?requestedRole:'member';
  let ymis=String(appData[1]||'').trim();
  const appName=String(appData[2]||'');
  const appEmail=String(appData[3]||'').trim();
  const branchVal=safeSheetText(appData[5],100);
  // 即使因審批者權限不足而退回 member 也一樣編配 L 編號，否則該申請會永遠卡在待批無法批准；一律用 Email 登入
  if(!ymis){ ymis=generateLeaderId(); }
  if(isSuperAdminId(ymis) || isSuperAdminId(appEmail)) return jsonResponse({success:false,error:'此帳號已被保留，不能開戶'});
  if(ymisTakenAnyStatus_(ymis)) return jsonResponse({success:false,error:'此 YMIS 已有帳號紀錄（可能已開戶或已停用），請先處理現有帳號再審批'});
  if(appEmail && emailTakenAnyStatus_(appEmail,'')) return jsonResponse({success:false,error:'此 Email 已有帳號紀錄（可能已開戶或已停用），請先處理現有帳號再審批'});
  const password=DEFAULT_PASS;
  const isLeaderFinal=(finalRole!=='member');
  const allowedBadges = finalRole==='member' ? '' : (finalRole==='exec_committee' ? 'L1,活動段章,OTHER' : '*');
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success:false,error:'找不到 Users 工作表'});
  ensureForceChangeCol(uSheet);
  const nowStr=now();
  uSheet.appendRow([ymis,appName,appEmail,finalRole,hashPassword(password),branchVal,isLeaderFinal,reviewerYmis,nowStr,nowStr,'','active',allowedBadges,true]);
  const mSheet=getSheet().getSheetByName('成員名單');
  if(mSheet){
    const mRow=memberNameRowExists_(ymis);
    if(mRow) mSheet.getRange(mRow.row,2).setValue(appName);
    else mSheet.appendRow([ymis,appName,new Date(),branchVal,appEmail]);
  }
  sheet.getRange(rowIndex,7).setValue('approved');
  sheet.getRange(rowIndex,9).setValue(reviewerYmis);
  sheet.getRange(rowIndex,10).setValue(nowStr);
  sheet.getRange(rowIndex,11).setValue(note||'');
  writeAudit(reviewerYmis,'approve_application',ymis,String(appId)+' → '+finalRole);
  return jsonResponse({success:true,message:'已批准並建立帳戶，預設密碼：'+password+'（首次登入須更改）',temp_password:password,final_role:finalRole,ymis:ymis});
}
function handleUpdateUserRole(targetYmis,newRole,canTick,managerYmis, allowedBadges){
  const manager=getUser(managerYmis);
  if(!manager) return jsonResponse({success:false,error:'找不到管理員'});
  if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能更改系統管理員帳號的角色'});
  // super_admin 可以改任何人，admin 可以改團長/支部領袖/執委/成員，團長可改支部領袖/執委/成員，支部領袖可改執委/成員
  if(manager.role!=='super_admin' && !canManageRole(manager.role,newRole) && manager.role!=='admin') return jsonResponse({success:false,error:'權限不足，你的等級不可設定此角色'});
  if(newRole==='group_leader'){
    const cur=findActiveGroupLeader(targetYmis);
    if(cur) return jsonResponse({success:false,error:'團長只能有一位（現任：'+cur.name+' '+cur.ymis+'），如需更換請先將現任團長轉為其他角色'});
  }
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===targetYmis && data[i][11].toString()==='active'){
      sheet.getRange(i+1,4).setValue(newRole);
      sheet.getRange(i+1,7).setValue(canTick);
      sheet.getRange(i+1,8).setValue(managerYmis);
      sheet.getRange(i+1,9).setValue(now());
      // 處理細緻權限：若提供 allowedBadges，寫入第13欄
      if(sheet.getLastColumn()>=13){
        if(allowedBadges!==undefined && allowedBadges!==null){
          sheet.getRange(i+1,13).setValue(allowedBadges);
        } else {
          // 默認：領袖全部 (*)，成員無，執委默認 L1, L3-ACT, OTHER部分
          if(!data[i][12]){
            let def='*';
            if(newRole==='member') def='';
            else if(newRole==='exec_committee') def='L1,L3-ACT,OTHER';
            else def='*';
            sheet.getRange(i+1,13).setValue(def);
          }
        }
      }
      return jsonResponse({success:true});
    }
  }
  return jsonResponse({success:false,error:'找不到用戶'});
}
function handleUpdateConfig(key,value,ymis){
  const sheet=getSheet().getSheetByName('SystemConfig'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===key){ sheet.getRange(i+1,2).setValue(value); sheet.getRange(i+1,3).setValue(now()); sheet.getRange(i+1,4).setValue(ymis); return jsonResponse({success:true}); } }
  sheet.appendRow([key,value,now(),ymis]); return jsonResponse({success:true});
}
function handleGetConfig(){
  const sheet=getSheet().getSheetByName('SystemConfig');
  const cfg={};
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(data[i][0]) cfg[data[i][0].toString()]=data[i][1]?data[i][1].toString():'';
    }
  }
  // 默認值
  if(!cfg['allow_member_view_others']) cfg['allow_member_view_others']='false';
  return jsonResponse({success:true,config:cfg});
}
function getMembers(){
  const mSheet=getSheet().getSheetByName('成員名單'); const members=[];
  if(mSheet){ const data=mSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0]) members.push({ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',squad:data[i][5]?data[i][5].toString():''}); } }
  const uSheet=getSheet().getSheetByName('Users'); if(uSheet){ const data=uSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][11].toString()==='active' && data[i][0]){ const y=data[i][0].toString(); const role=data[i][3]?data[i][3].toString():'member'; if(role==='super_admin' || isSuperAdminId(y)) continue; if(!members.some(m=>m.ymis===y)){ members.push({ymis:y,name:data[i][1].toString(),squad:data[i][5]?data[i][5].toString():''}); } } } }
  return members;
}
function handleLoad(){
  const ss=getSheet();
  const pSheet=ss.getSheetByName('進度追蹤'); const progress={};
  if(pSheet){ const data=pSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const ymis=data[i][0].toString(); if(!ymis) continue; if(!progress[ymis]) progress[ymis]={}; progress[ymis][data[i][1].toString()]={date:data[i][2]?formatDate(data[i][2]):'',confirmer:data[i][4]?data[i][4].toString():''}; } }
  // 簡化版：同時提供 flat
  const flat={}; for(const y in progress){ flat[y]={}; for(const k in progress[y]){ flat[y][k]=progress[y][k].date; } }
  const members=getMembers();
  // pending requests
  const prSheet=ss.getSheetByName('待批完成'); const pending=[];
  if(prSheet){ const data=prSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ pending.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  // other badges
  const oSheet=ss.getSheetByName('其他獎章'); const other={};
  if(oSheet){ const data=oSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const y=data[i][0].toString(); if(!y) continue; if(!other[y]) other[y]={}; other[y][data[i][1].toString()]={name:data[i][2]?data[i][2].toString():'',date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}; } }
  const lSheet=ss.getSheetByName(LOG_SHEET_NAME);
  return jsonResponse({success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other,logs:getLogRecordsList(),logsSupported:!!lSheet});
}
function handleSave(changes, confirmer){
  const sheet=getSheet().getSheetByName('進度追蹤'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  let processed=0;
  changes.forEach(function(c){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){
      if(data[i][0].toString()===c.ymis && data[i][1].toString()===c.itemId){
        if(c.uncomplete){ sheet.deleteRow(i+1); } else { sheet.getRange(i+1,3).setValue(c.date); sheet.getRange(i+1,4).setValue(new Date()); sheet.getRange(i+1,5).setValue(confirmer||c.confirmer||''); sheet.getRange(i+1,6).setValue(c.note||''); }
        found=true; processed++; break;
      }
    }
    if(!found && !c.uncomplete){
      sheet.appendRow([c.ymis,c.itemId,c.date,new Date(),confirmer||c.confirmer||'',c.note||'']);
      processed++;
    }
  });
  return jsonResponse({success:true,processed:processed});
}
function handleAddMember(ymis,name,squad,squadRole){
  ymis=String(ymis||'').trim(); name=safeSheetText(name,100); squad=safeSheetText(squad,100);
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'不能新增系統管理員帳號'});
  if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  const uRow=findUserRowAnyStatus_(ymis);
  if(uRow) return jsonResponse({success:false,error:(uRow.status!=='active')?'此 YMIS 已有帳號紀錄（已停用），請在用戶管理恢復該帳號':'此 YMIS 已有登入帳號，請在用戶管理直接管理'});
  if(memberNameRowExists_(ymis)) return jsonResponse({success:false,error:'此 YMIS 已在成員名單，不可重複加入'});
  let sheet=getSheet().getSheetByName('成員名單');
  if(!sheet){ sheet=getSheet().insertSheet('成員名單'); sheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','備註']); }
  // 確保有 6 欄 header
  if(sheet.getLastColumn()<6){
    sheet.getRange(1,6).setValue('備註');
  }
  sheet.appendRow([ymis,name,new Date(),'','',squad||'']);
  return jsonResponse({success:true});
}
// 待批完成
function handleRequestComplete(body, requesterYmis){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const reqId='REQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  const user=getUser(requesterYmis)||{name:body.name||requesterYmis};
  sheet.appendRow([reqId,requesterYmis,user.name||body.name,body.itemId,body.itemName||body.itemId,body.requested_date||formatDate(new Date()),body.evidence||'','pending',now(),'','','', '']);
  return jsonResponse({success:true,request_id:reqId});
}
function handleGetPendingRequests(){
  const sheet=getSheet().getSheetByName('待批完成'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ list.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  return jsonResponse({success:true,requests:list});
}
function handleReviewRequest(reqId,decision,note,reviewer,confirmed_date){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const data=sheet.getDataRange().getValues(); let row=null;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===reqId){ row=data[i]; sheet.getRange(i+1,8).setValue(decision); sheet.getRange(i+1,10).setValue(reviewer); sheet.getRange(i+1,11).setValue(now()); sheet.getRange(i+1,12).setValue(note||''); sheet.getRange(i+1,13).setValue(confirmed_date||formatDate(new Date())); break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  if(decision==='approved'){
    const pSheet=getSheet().getSheetByName('進度追蹤');
    pSheet.appendRow([row[1],row[3],confirmed_date||row[5],new Date(),reviewer, '由申請轉入：'+(note||'')]);
    return jsonResponse({success:true,message:'已批准並寫入進度'});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleGetOtherBadges(ymis){
  const sheet=getSheet().getSheetByName('其他獎章'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0].toString()===ymis){ list.push({id:data[i][1].toString(),name:data[i][2].toString(),date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}); } } }
  return jsonResponse({success:true,other:list});
}
function handleSaveOtherBadge(records){
  const sheet=getSheet().getSheetByName('其他獎章'); if(!sheet) return jsonResponse({success:false,error:'Sheet missing'});
  let c=0;
  records.forEach(function(r){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){ if(data[i][0].toString()===r.ymis && data[i][1].toString()===r.badgeId){ sheet.getRange(i+1,3).setValue(r.date); sheet.getRange(i+1,4).setValue(r.cert||''); sheet.getRange(i+1,5).setValue(r.note||''); sheet.getRange(i+1,6).setValue(new Date()); found=true; c++; break; } }
    if(!found){ sheet.appendRow([r.ymis,r.badgeId,r.name||r.badgeId,r.date,r.cert||'',r.note||'',new Date()]); c++; }
  });
  return jsonResponse({success:true,processed:c});
}

// 寫入操作紀錄 (若無 audit 表則自動建)
function writeAudit(actor,action,target,detail){
  try{
    const ss=getSheet();
    let sh=ss.getSheetByName('操作紀錄');
    if(!sh){ sh=ss.insertSheet('操作紀錄'); sh.appendRow(['時間','操作者','操作','對象','詳情']); sh.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF'); sh.setFrozenRows(1); }
    // 保留帳號做嘅操作只記顯示名稱，唔記帳號
    const who=isSuperAdminId(actor)?SUPER_ADMIN_NAME:(actor||'');
    sh.appendRow([now(),who,action||'',target||'',detail||'']);
  }catch(e){ console.warn('writeAudit failed',e); }
}
function handleResetPassword(targetYmis,managerYmis,newPassword){
  try{
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    if(!targetYmis) return jsonResponse({success:false,error:'請提供目標 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能重設系統管理員密碼'});
    if(String(targetYmis)===String(managerYmis)) return jsonResponse({success:false,error:'不能重設自己的密碼，請聯絡其他管理員'});
    const custom=(newPassword!==undefined && newPassword!==null && String(newPassword).length>0) ? String(newPassword) : '';
    if(custom && custom.length<4) return jsonResponse({success:false,error:'新密碼至少4位'});
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(targetYmis)){
        if(custom){
          sh.getRange(i+1,5).setValue(hashPassword(custom));
          ensureForceChangeCol(sh);
          sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
          writeAudit(managerYmis,'set_password',targetYmis,'領袖自設密碼（首次登入須更改）');
          return jsonResponse({success:true,message:'已設定新密碼，請通知用戶首次登入後更改密碼'});
        }
        const temp='Rover'+Math.floor(100000+Math.random()*900000);
        sh.getRange(i+1,5).setValue(hashPassword(temp));
        ensureForceChangeCol(sh);
        sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
        writeAudit(managerYmis,'reset_password',targetYmis,'重設為一次性密碼: '+temp);
        return jsonResponse({success:true,temp_password:temp,message:'已重設，請通知用戶首次登入後更改密碼'});
      }
    }
    return jsonResponse({success:false,error:'找不到此 YMIS'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 有登記 Email → 產生臨時密碼並電郵寄出；冇 Email → 請聯絡領袖（領袖可在用戶管理自設密碼）
function handleForgotPassword(loginId){
  try{
    loginId=String(loginId||'').trim();
    if(!loginId) return jsonResponse({success:false,error:'請填寫 YMIS 或電郵'});
    if(isSuperAdminId(loginId)) return jsonResponse({success:false,error:'此帳號不能使用自助找回密碼'});
    let user=null;
    if(/^\d{10}$/.test(loginId) || /^L\d+/i.test(loginId)) user=getUser(loginId);
    else if(loginId.indexOf('@')>=0) user=getUserByEmail(loginId);
    else user=getUser(loginId)||getUserByEmail(loginId);
    if(!user) return jsonResponse({success:false,error:'找不到此帳號，請檢查 YMIS／電郵是否正確'});
    const email=String(user.email||'').trim();
    if(!email) return jsonResponse({success:false,error:'此帳號未登記電郵，無法自助找回密碼，請聯絡領袖重設密碼'});
    // 輕量節流：同一帳號 60 秒內只可請求一次（防濫發電郵）
    try{
      const props=PropertiesService.getScriptProperties();
      const key='FORGOT_'+user.ymis;
      const last=parseInt(props.getProperty(key)||'0',10)||0;
      if(Date.now()-last<60000) return jsonResponse({success:false,error:'請求過於頻密，請稍候一分鐘再試'});
      props.setProperty(key,String(Date.now()));
    }catch(e){}
    const temp='Rover'+Math.floor(100000+Math.random()*900000);
    const subject='【樂行童軍進度系統】臨時密碼';
    const bodyText='你好 '+user.name+'：\n\n你於樂行童軍進度追蹤系統申請了自助找回密碼。\n臨時密碼：'+temp+'\n\n請盡快登入，系統會要求你設定新密碼（至少4位）。\n如非本人操作，請聯絡你的旅團領袖。\n\n— 樂行童軍進度追蹤系統';
    // 先寄信、後改密碼：寄信失敗則密碼不變，用戶仍可用舊密碼
    try{
      MailApp.sendEmail(email,subject,bodyText);
    }catch(e){
      return jsonResponse({success:false,error:'郵件發送失敗，請聯絡領袖重設密碼'});
    }
    const sh=getSheet().getSheetByName('Users');
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(user.ymis) && String(data[i][11])==='active'){
        sh.getRange(i+1,5).setValue(hashPassword(temp));
        ensureForceChangeCol(sh);
        sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
        break;
      }
    }
    try{ writeAudit(user.ymis,'forgot_password',user.ymis,'自助找回密碼（電郵已寄出）'); }catch(e){}
    return jsonResponse({success:true,message:'臨時密碼已發送到你的登記電郵，請查收後登入並設定新密碼',email_hint:maskEmail_(email)});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 開立可登入帳號
// 上游開戶（createAccountForDownstream）直接用純函數 addUser_；前端／doPost 入口經 handleAddUser 包裝
function handleAddUser(body,mgr){ return jsonResponse(addUser_(body,mgr)); }
function addUser_(body,mgr){
  try{
    let ymis=(body.ymis||'').toString().trim();
    const name=(body.name||'').toString().trim();
    const email=(body.email||'').toString().trim();
    const role=(body.role||'member').toString().trim();
    const password=(body.password||'').toString();
    const squad=(body.squad||'').toString().trim();
    const canTick=body.can_tick===true||body.can_tick==='true'||body.can_tick==='TRUE';
    if(VALID_ROLES.indexOf(role)<0) return {success:false,error:'無效的角色: '+role}
    if(!canManageUser(mgr,role)) return {success:false,error:'權限不足，你的等級不可開立此角色'}
    // 領袖免 YMIS（用電郵登入）—— 留空且有 Email 即自動編配內部 L 編號
    if(!ymis && role!=='member'){
      if(!email) return {success:false,error:'領袖開戶必須填寫 Email（用作登入帳號）'}
      ymis=generateLeaderId();
    }
    if(!/^(\d{10}|L\d+)$/.test(ymis)) return {success:false,error:'YMIS 須為 10 位數字（領袖可留空，會自動編配）'}
    if(!name) return {success:false,error:'請填寫姓名'}
    if(email && !isValidEmail_(email)) return {success:false,error:'Email 格式不正確'}
    if(isSuperAdminId(ymis) || isSuperAdminId(email)) return {success:false,error:'不能新增系統管理員帳號'}
    if(ymisTakenAnyStatus_(ymis)){
      const ex=findUserRowAnyStatus_(ymis);
      return {success:false,error:(ex && ex.status!=='active')?'此 YMIS 已有帳號紀錄（已停用），請恢復該帳號而非重新開戶':'此 YMIS 已註冊，不可重複開戶'}
    }
    if(email){
      const em=emailTakenAnyStatus_(email,'');
      if(em) return {success:false,error:(em.status!=='active')?'此 Email 已有帳號紀錄（已停用：'+em.ymis+'），請恢復該帳號而非重新開戶':'此 Email 已被 '+em.ymis+' 使用，不可重複開戶'}
    }
    if(role==='group_leader'){
      const cur=findActiveGroupLeader('');
      if(cur) return {success:false,error:'團長只能有一位（現任：'+cur.name+' '+cur.ymis+'），如需更換請先將現任團長轉為其他角色'}
    }
    const uSheet=getSheet().getSheetByName('Users');
    if(!uSheet) return {success:false,error:'Users 工作表不存在'}
    ensureForceChangeCol(uSheet);
    const nowStr=now();
    const usedDefault=!password || password===DEFAULT_PASS;
    const pwdHash = hashPassword(password||DEFAULT_PASS);
    const allowedBadges = role==='member' ? '' : (role==='exec_committee' ? 'L1,活動段章,OTHER' : '*');
    uSheet.appendRow([
      ymis,
      name,
      email,
      role,
      pwdHash,
      squad,
      canTick,
      (mgr&&mgr.ymis)||'bulk_onboard',
      nowStr,
      nowStr,
      '',
      'active',
      allowedBadges,
      usedDefault
    ]);
    let mSheet=getSheet().getSheetByName('成員名單');
    if(!mSheet){
      mSheet=getSheet().insertSheet('成員名單');
      mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','備註']);
    }
    const mRow=memberNameRowExists_(ymis);
    if(mRow) mSheet.getRange(mRow.row,2).setValue(name);
    else mSheet.appendRow([ymis, name, new Date(), '', '', squad]);
    writeAudit((mgr&&mgr.ymis)||'','add_user',ymis,'前端開立帳號 role='+role);
    return {success:true,message:'帳號已建立'+(usedDefault?'（預設密碼：'+DEFAULT_PASS+'，首次登入須更改）':'（已設密碼）'),ymis:ymis}
  }catch(e){ return {success:false,error:e.toString()} }
}
// 停用帳號 - 設 status=inactive，清除 tokens，保留資料
function handleDeactivateUser(body,manager,managerYmis){
  try{
    const targetYmis=(body.target_ymis||'').toString().trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能停用系統管理員帳號'});
    if(targetYmis===managerYmis) return jsonResponse({success:false,error:'不能停用自己'});
    const target=getUser(targetYmis);
    if(!target) return jsonResponse({success:false,error:'找不到此用戶'});
    // 權限檢查：不能停用比自己高等級的用戶
    if(getRoleLevel(manager.role)<getRoleLevel(target.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能停用比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(targetYmis) && data[i][11]==='active'){
        sh.getRange(i+1,12).setValue('inactive');
        // 清除此用戶的 tokens
        try{
          const tSheet=getSheet().getSheetByName('Tokens');
          if(tSheet){
            const td=tSheet.getDataRange().getValues();
            for(let j=td.length-1;j>=1;j--){
              if(td[j][1] && String(td[j][1])===String(targetYmis)) tSheet.deleteRow(j+1);
            }
          }
        }catch(e){ console.warn('clear tokens failed',e); }
        // 從成員名單移除 (但保留歷史)
        try{
          const mSheet=getSheet().getSheetByName('成員名單');
          if(mSheet){
            const md=mSheet.getDataRange().getValues();
            for(let k=md.length-1;k>=1;k--){
              if(md[k][0] && String(md[k][0])===String(targetYmis)) mSheet.deleteRow(k+1);
            }
          }
        }catch(e){ console.warn('clear member list failed',e); }
        writeAudit(managerYmis,'deactivate_user',targetYmis,'停用帳號');
        return jsonResponse({success:true,message:'已停用 '+targetYmis+'，token 已清除'});
      }
    }
    return jsonResponse({success:false,error:'找不到活躍用戶'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
function handleReactivateUser(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能操作系統管理員帳號'});
    const row=findUserRowAnyStatus_(targetYmis);
    if(!row) return jsonResponse({success:false,error:'找不到此用戶'});
    if(row.role==='super_admin') return jsonResponse({success:false,error:'不能操作系統管理員帳號'});
    if(row.status==='active') return jsonResponse({success:false,error:'此帳號已是啟用狀態'});
    if(getRoleLevel(manager.role)<getRoleLevel(row.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能恢復比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    sh.getRange(row.row,12).setValue('active');
    // 恢復後同步補回成員名單（停用時曾被移除）
    try{
      if(!memberNameRowExists_(targetYmis)){
        let mSheet=getSheet().getSheetByName('成員名單');
        if(!mSheet){ mSheet=getSheet().insertSheet('成員名單'); mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','備註']); }
        mSheet.appendRow([targetYmis,row.name,new Date(),'','', '']);
      }
    }catch(e){}
    writeAudit(managerYmis,'reactivate_user',targetYmis,'恢復已停用帳號');
    return jsonResponse({success:true,message:'已恢復 '+targetYmis+'，該用戶可重新登入'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 目標無登入帳號但在成員名單 → 改名單（姓名／備註），方便管理純名單成員
function handleUpdateUserProfile(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能修改系統管理員帳號'});
    const row=findUserRowAnyStatus_(targetYmis);
    // 純名單成員（無登入帳號）：改名單
    if(!row){
      if(body.email!==undefined && body.email!==null && String(body.email).trim()!=='') return jsonResponse({success:false,error:'純名單成員沒有登入帳號，如需電郵登入請先開立登入帳號'});
      const mRow=memberNameRowExists_(targetYmis);
      if(!mRow) return jsonResponse({success:false,error:'找不到此用戶'});
      const mSheet=getSheet().getSheetByName('成員名單');
      const changed=[];
      if(body.name!==undefined && body.name!==null && String(body.name).trim()!==''){
        const nm=safeSheetText(body.name,60);
        if(!nm) return jsonResponse({success:false,error:'姓名不可為空'});
        mSheet.getRange(mRow.row,2).setValue(nm);
        changed.push('姓名');
      }
      if(body.branch!==undefined && body.branch!==null){
        if(mSheet.getLastColumn()<6) mSheet.getRange(1,6).setValue('備註');
        mSheet.getRange(mRow.row,6).setValue(safeSheetText(body.branch,100));
        changed.push('備註');
      }
      if(changed.length===0) return jsonResponse({success:false,error:'沒有變更'});
      writeAudit(managerYmis,'update_member',targetYmis,'修改純名單成員：'+changed.join('、'));
      return jsonResponse({success:true,message:'已更新 '+changed.join('、')});
    }
    if(row.role==='super_admin') return jsonResponse({success:false,error:'不能修改系統管理員帳號'});
    if(row.status!=='active') return jsonResponse({success:false,error:'此帳號已停用，請先恢復再修改'});
    if(getRoleLevel(manager.role)<getRoleLevel(row.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能修改比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    const changed=[];
    if(body.name!==undefined && body.name!==null && String(body.name).trim()!==''){
      const nm=safeSheetText(body.name,100);
      if(!nm) return jsonResponse({success:false,error:'姓名不可為空'});
      if(nm!==row.name){
        sh.getRange(row.row,2).setValue(nm);
        changed.push('姓名');
        try{
          const mRow2=memberNameRowExists_(targetYmis);
          if(mRow2) getSheet().getSheetByName('成員名單').getRange(mRow2.row,2).setValue(nm);
        }catch(e){}
      }
    }
    if(body.email!==undefined && body.email!==null){
      const em=String(body.email).trim();
      if(em && !isValidEmail_(em)) return jsonResponse({success:false,error:'Email 格式不正確'});
      if(isSuperAdminId(em)) return jsonResponse({success:false,error:'此 Email 已被保留'});
      if(em!==row.email){
        if(em){
          const taken=emailTakenAnyStatus_(em,targetYmis);
          if(taken) return jsonResponse({success:false,error:'此 Email 已被 '+taken.ymis+' 使用，不可重複'});
        }
        sh.getRange(row.row,3).setValue(em);
        changed.push('電郵');
      }
    }
    if(body.branch!==undefined && body.branch!==null){
      sh.getRange(row.row,6).setValue(safeSheetText(body.branch,100));
      changed.push('備註');
    }
    if(changed.length===0) return jsonResponse({success:false,error:'沒有變更'});
    writeAudit(managerYmis,'update_profile',targetYmis,'修改：'+changed.join('、'));
    return jsonResponse({success:true,message:'已更新 '+changed.join('、')});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
function handleDeleteMember(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能刪除系統管理員帳號'});
    const uRow=findUserRowAnyStatus_(targetYmis);
    if(uRow) return jsonResponse({success:false,error:(uRow.status==='active')?'此成員已有登入帳號，請在用戶管理停用該帳號':'此成員已有帳號紀錄（已停用），請在用戶管理恢復或徹底刪除該帳號'});
    const mRow=memberNameRowExists_(targetYmis);
    if(!mRow) return jsonResponse({success:false,error:'在成員名單找不到此 YMIS'});
    const mSheet=getSheet().getSheetByName('成員名單');
    mSheet.deleteRow(mRow.row);
    writeAudit(managerYmis,'delete_member',targetYmis,'刪除純名單成員（進度紀錄保留）');
    return jsonResponse({success:true,message:'已刪除成員 '+targetYmis+'（進度紀錄保留）'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
function handleDeleteUser(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能刪除系統管理員帳號'});
    if(String(targetYmis)===String(managerYmis)) return jsonResponse({success:false,error:'不能刪除自己'});
    const row=findUserRowAnyStatus_(targetYmis);
    if(!row) return jsonResponse({success:false,error:'找不到此用戶'});
    if(row.role==='super_admin') return jsonResponse({success:false,error:'不能刪除系統管理員帳號'});
    if(row.status==='active') return jsonResponse({success:false,error:'請先停用此帳號，再徹底刪除'});
    if(getRoleLevel(manager.role)<getRoleLevel(row.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能刪除比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    sh.deleteRow(row.row);
    try{
      const tSheet=getSheet().getSheetByName('Tokens');
      if(tSheet){
        const td=tSheet.getDataRange().getValues();
        for(let j=td.length-1;j>=1;j--){
          if(td[j][1] && String(td[j][1])===String(targetYmis)) tSheet.deleteRow(j+1);
        }
      }
    }catch(e){}
    writeAudit(managerYmis,'delete_user',targetYmis,'徹底刪除已停用帳號（進度紀錄保留）');
    return jsonResponse({success:true,message:'已徹底刪除 '+targetYmis+'（進度紀錄保留）'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}

function getLogRecordsList(){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME); const logs=[];
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0]) continue;
      logs.push({
        record_id:String(data[i][0]), type:String(data[i][1]||'activity'),
        ymis:String(data[i][2]||''), name:String(data[i][3]||''),
        date:data[i][4]?formatDate(data[i][4]):'', title:String(data[i][5]||''),
        role:String(data[i][6]||''), hours:String(data[i][7]||''),
        cert_no:String(data[i][8]||''), detail:String(data[i][9]||''),
        recorder:String(data[i][10]||''),
        recorded_at:data[i][11]?String(data[i][11]):''
      });
    }
  }
  return logs;
}
function handleGetLogRecords(){
  // 未升級/未初始化時明確報錯，讓前端顯示升級提示
  if(!getSheet().getSheetByName(LOG_SHEET_NAME)) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  return jsonResponse({success:true,logs:getLogRecordsList()});
}
function sanitizeLogRecord(r){
  r=r||{};
  let type = LOG_TYPES.indexOf(r.type)>=0 ? r.type : 'activity';
  let role = safeSheetText(r.role,60);
  if(type==='training' && !role){
    role='學員';
  }
  return {
    type: type,
    ymis: String(r.ymis||'').trim().substring(0,20),
    name: safeSheetText(r.name,60),
    date: String(r.date||'').substring(0,20),
    title: safeSheetText(r.title,120),
    role: role,
    hours: String(r.hours==null?'':r.hours).substring(0,20),
    cert_no: safeSheetText(r.cert_no,60),
    detail: safeSheetText(r.detail,500)
  };
}
function handleSaveLogRecord(records, recorderYmis, recorderName){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  if(!Array.isArray(records)||records.length===0) return jsonResponse({success:false,error:'沒有可儲存的紀錄'});
  if(records.length>200) return jsonResponse({success:false,error:'一次最多 200 筆，請分批'});
  const results=[]; let processed=0;
  records.forEach(function(r){
    const rec=sanitizeLogRecord(r);
    if(!rec.ymis||!rec.title||!rec.date){ results.push({success:false,ymis:rec.ymis,title:rec.title,error:'YMIS、名稱及日期必填'}); return; }
    const rid=String((r&&r.record_id)||'');
    if(rid){
      // 更新既有紀錄（record_id 不變）
      const data=sheet.getDataRange().getValues();
      for(let i=1;i<data.length;i++){
        if(String(data[i][0])===rid){
          sheet.getRange(i+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,sheet.getRange(i+1,11).getValue()||recorderName||recorderYmis,String(data[i][11]||''),now()]]);
          results.push({success:true,record_id:rid}); processed++;
          writeAudit(recorderYmis,'update_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
          return;
        }
      }
      results.push({success:false,record_id:rid,error:'找不到紀錄'}); return;
    }
    const newId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    sheet.appendRow([newId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorderName||recorderYmis,now(),'']);
    results.push({success:true,record_id:newId}); processed++;
    writeAudit(recorderYmis,'add_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
  });
  const failed=results.filter(function(x){return !x.success;}).length;
  return jsonResponse({success:(results.length>0&&failed===0),processed:processed,results:results,message:processed+' 筆已儲存'+(failed?'，'+failed+' 筆失敗':'')});
}
function handleDeleteLogRecord(recordId, recorderYmis){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  recordId=String(recordId||'');
  if(!recordId) return jsonResponse({success:false,error:'缺少 record_id'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0])===recordId){
      const label=String(data[i][1]||'')+': '+String(data[i][5]||'')+' '+String(data[i][4]||'');
      const target=String(data[i][2]||'');
      sheet.deleteRow(i+1);
      writeAudit(recorderYmis,'delete_log',target,label);
      return jsonResponse({success:true,message:'已刪除紀錄'});
    }
  }
  return jsonResponse({success:false,error:'找不到紀錄'});
}

// ===== 吐 JSON（搬舊數）：proxy 後備通道（主通道係 Sheet 選單 → Drive 私人檔）=====
function handleExportUsers(){
  const payload=buildUsersExport();
  return jsonResponse({success:true,count:payload.count,users:payload.users});
}

// ===== 上下游接入：ALLOW_LOCAL_LOGIN 直接入口開關（本地 token 通道）=====
// 掣值：1/true/yes/on/open＝開啟；其餘任何值（false/0/no/off 或串錯字）＝閂口（fail closed）
function handleGetAllowLocalLogin(){
  const raw=String(linkProps().getProperty(LINK_FLAG)||'');
  return jsonResponse({success:true, allow:localLoginAllowed(), allow_local_login:localLoginAllowed(), flag:raw==='false'?'false':(raw?'true':'（未設定＝開啟）')});
}
function handleSetAllowLocalLogin(allow, actorYmis){
  const v=(allow===true||['true','1','yes','on','open'].indexOf(String(allow).trim().toLowerCase())>=0);
  setLocalLoginAllowed(v,actorYmis||'local');
  return jsonResponse({success:true, allow:localLoginAllowed(), allow_local_login:localLoginAllowed(), message:v?'已開啟本地直接入口':'已關閉本地直接入口，只收 sig'});
}

function getPendingLogRequestsList(viewYmis, isLeader){
  const sheet=getSheet().getSheetByName(LOG_PENDING_SHEET_NAME); const list=[];
  if(!sheet) return list;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(!data[i][0]) continue;
    if(!isLeader && String(data[i][3])!==String(viewYmis)) continue; // 成員只看到自己的申請
    list.push({
      request_id:String(data[i][0]),
      record_id:String(data[i][1]||''),
      type:String(data[i][2]||'activity'),
      ymis:String(data[i][3]||''),
      name:String(data[i][4]||''),
      date:data[i][5]?formatDate(data[i][5]):'',
      title:String(data[i][6]||''),
      role:String(data[i][7]||''),
      hours:String(data[i][8]||''),
      cert_no:String(data[i][9]||''),
      detail:String(data[i][10]||''),
      status:String(data[i][11]||'pending'),
      requested_at:data[i][12]?String(data[i][12]):'',
      submitted_by:String(data[i][13]||''),
      reviewed_by:String(data[i][14]||''),
      reviewed_at:data[i][15]?String(data[i][15]):'',
      review_note:String(data[i][16]||''),
      submission_type:String(data[i][17]||'new')
    });
  }
  return list;
}
function handleGetPendingLogRequests(user){
  if(!getSheet().getSheetByName(LOG_PENDING_SHEET_NAME)) return jsonResponse({success:false,error:'「'+LOG_PENDING_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const isLeader=canUserTick(user.role);
  return jsonResponse({success:true,requests:getPendingLogRequestsList(user.ymis, isLeader),canApprove:isLeader});
}
function handleSubmitLogRequest(body, requesterYmis, user){
  const sheet=getSheet().getSheetByName(LOG_PENDING_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_PENDING_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  let rows=[];
  if(body.record_id){
    // 修改既有（已批）紀錄：重新待批
    const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
    if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在'});
    let found=false, origYmis='';
    const ld=lSheet.getDataRange().getValues();
    for(let i=1;i<ld.length;i++){ if(String(ld[i][0])===String(body.record_id)){ found=true; origYmis=String(ld[i][2]||''); break; } }
    if(!found) return jsonResponse({success:false,error:'找不到原有紀錄'});
    if(String(origYmis)!==String(requesterYmis)) return jsonResponse({success:false,error:'只能申請修改自己的紀錄'});
    // 防止重複待批修改
    const pd=sheet.getDataRange().getValues();
    for(let i=1;i<pd.length;i++){ if(String(pd[i][1])===String(body.record_id) && String(pd[i][11])==='pending') return jsonResponse({success:false,error:'此紀錄已有待批的修改申請'});
    }
    const d=body.data||{};
    const rec=sanitizeLogRecord({...d, ymis:origYmis});
    rows.push({record_id:String(body.record_id),type:rec.type,ymis:rec.ymis,name:user.name||'',date:rec.date,title:rec.title,role:rec.role,hours:rec.hours,cert_no:rec.cert_no,detail:rec.detail,submission_type:'edit'});
  }else{
    // 新增申報
    const records=Array.isArray(body.records)?body.records:[];
    if(records.length===0) return jsonResponse({success:false,error:'沒有可申報的紀錄'});
    if(records.length>20) return jsonResponse({success:false,error:'一次最多 20 筆，請分批'});
    records.forEach(function(r){
      const rec=sanitizeLogRecord(r);
      rows.push({record_id:'',type:rec.type,ymis:rec.ymis,name:user.name||'',date:rec.date,title:rec.title,role:rec.role,hours:rec.hours,cert_no:rec.cert_no,detail:rec.detail,submission_type:'new'});
    });
  }
  // 驗證只能申報自己的紀錄
  const selfCheck=rows.filter(function(r){ return String(r.ymis)!==String(requesterYmis); });
  if(selfCheck.length>0) return jsonResponse({success:false,error:'只能申報自己的活動履歷'});
  const validCheck=rows.filter(function(r){ return !r.ymis||!r.title||!r.date; });
  if(validCheck.length>0) return jsonResponse({success:false,error:'YMIS、名稱及日期必填'});
  const results=[]; let processed=0;
  rows.forEach(function(r){
    const rid='LOGRQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    sheet.appendRow([rid,r.record_id,r.type,r.ymis,r.name,r.date,r.title,r.role,r.hours,r.cert_no,r.detail,'pending',now(),requesterYmis,'','','',r.submission_type]);
    results.push({success:true,request_id:rid}); processed++;
    writeAudit(requesterYmis,'submit_log_request',r.ymis,(r.submission_type==='edit'?'修改':'申報')+': '+r.type+' '+r.title+' '+r.date);
  });
  return jsonResponse({success:true,processed:processed,results:results,message:processed+' 筆已送交審批'});
}
function handleReviewLogRequest(reqId, decision, reviewer, note){
  const sheet=getSheet().getSheetByName(LOG_PENDING_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_PENDING_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const data=sheet.getDataRange().getValues(); let row=null, rowIndex=null;
  for(let i=1;i<data.length;i++){ if(String(data[i][0])===String(reqId)){ row=data[i]; rowIndex=i+1; break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  if(String(row[11])!=='pending') return jsonResponse({success:false,error:'此申請已處理'});
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決策'});
  // 更新狀態
  sheet.getRange(rowIndex,12).setValue(decision);
  sheet.getRange(rowIndex,15).setValue(reviewer);
  sheet.getRange(rowIndex,16).setValue(now());
  sheet.getRange(rowIndex,17).setValue(note||'');
  if(decision==='rejected'){
    writeAudit(reviewer,'review_log_request',row[3]||'','拒絕: '+row[6]+' '+row[5]);
    return jsonResponse({success:true,message:'已拒絕申請'});
  }
  // approved：寫入 活動履歷
  const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在'});
  const rec={
    type:String(row[2]||'activity'),
    ymis:String(row[3]||''),
    name:String(row[4]||''),
    date:String(row[5]||''),
    title:String(row[6]||''),
    role:String(row[7]||''),
    hours:String(row[8]||''),
    cert_no:String(row[9]||''),
    detail:String(row[10]||'')
  };
  const submissionType=String(row[17]||'new');
  const submittedBy=String(row[13]||reviewer);
  let newRecordId='';
  if(submissionType==='edit' && String(row[1]||'')){
    // 更新原有紀錄（record_id 不變）
    const oldId=String(row[1]);
    const ld=lSheet.getDataRange().getValues();
    let updated=false;
    for(let i=1;i<ld.length;i++){
      if(String(ld[i][0])===oldId){
        lSheet.getRange(i+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,submittedBy,String(ld[i][11]||''),now()]]);
        updated=true; newRecordId=oldId; break;
      }
    }
    if(!updated) return jsonResponse({success:false,error:'原有紀錄不存在，請先聯絡領袖處理'});
  }else{
    newRecordId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    lSheet.appendRow([newRecordId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,submittedBy,now(),'']);
  }
  // 將 record_id 回填到待批表
  sheet.getRange(rowIndex,2).setValue(newRecordId);
  writeAudit(reviewer,'approve_log_request',rec.ymis,rec.type+': '+rec.title+' '+rec.date+' -> '+newRecordId);
  return jsonResponse({success:true,message:'已批准並寫入活動履歷',record_id:newRecordId});
}
// ===== 旅系統：Sheet 選單（onOpen）=====
// 全部接駁操作都經呢度做（sig 係 GAS→GAS，唔經 Vercel proxy，前端／api 唔使改）。
function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('🔗 旅系統')
      .addItem('📤 匯出 JSON（含 hash）', 'menuExportUsersJson')
      .addItem('📥 匯入 JSON（upsertUser 直插 hash）', 'menuImportUsersJson')
      .addSeparator()
      .addItem('🧭 本機接駁狀態', 'menuShowLinkState')
      .addItem('🔑 顯示 BACKEND／APIKEY（交 ADMIN）', 'menuShowLinkCredentials')
      .addSeparator()
      .addItem('➕ 登記下游（URL + SHEET KEY）', 'menuRegisterDownstream')
      .addItem('📡 測試下游連線（sig）', 'menuPingDownstream')
      .addItem('👤 為下游開戶（揀團）', 'menuCreateDownstreamUser')
      .addSubMenu(ui.createMenu('🚪 下游直接入口')
        .addItem('🔒 閂口（只收 sig）', 'menuCloseDownstreamGate')
        .addItem('🔓 開啟（容許本地登入）', 'menuOpenDownstreamGate'))
      .addItem('🗑️ 移除下游登記', 'menuRemoveDownstream')
      .addSeparator()
      .addSubMenu(ui.createMenu('🚪 本機直接入口')
        .addItem('🔒 閂口（只收 sig）', 'menuLocalLoginOff')
        .addItem('🔓 開啟（容許本地登入）', 'menuLocalLoginOn'))
      .addToUi();
  } catch (e) { }
}
function linkUi() { return SpreadsheetApp.getUi(); }
function linkAlert(title, message) {
  const text = String(message || '');
  try { const ui = linkUi(); if (ui) ui.alert(String(title || '旅系統'), text, ui.ButtonSet.OK); } catch (e) { }
  try { Logger.log(String(title || '旅系統') + ': ' + text); } catch (e) { }
  return text;
}
function linkPrompt(title, message) {
  const ui = linkUi();
  if (!ui) return null;
  const res = ui.prompt(String(title || '旅系統'), String(message || ''), ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;
  return String(res.getResponseText() || '').trim();
}
function linkConfirm(title, message) {
  const ui = linkUi();
  if (!ui) return false;
  return ui.alert(String(title || '旅系統'), String(message || ''), ui.ButtonSet.YES_NO) === ui.Button.YES;
}
function linkSummarizeResults(results, limit) {
  const bad = (results || []).filter(function (r) { return !r.success; });
  if (!bad.length) return '';
  return '\n\n首 ' + Math.min(bad.length, limit || 8) + ' 筆失敗：\n' + bad.slice(0, limit || 8).map(function (r) {
    return '・' + String(r.ymis || '?') + '：' + String(r.error || '');
  }).join('\n');
}
function menuExportUsersJson() {
  const r = exportUsersJson();
  if (!r.success) return linkAlert('匯出 JSON', '匯出失敗：' + String(r.error || ''));
  const lines = ['已匯出 ' + r.count + ' 個帳戶（含 password_hash）。'];
  if (r.file_url) lines.push('\nDrive 檔（已設為私人，匯入後請刪除）：\n' + r.file_url + '\n\n檔案 ID：' + r.file_id);
  else lines.push('\nDrive 寫入失敗（' + String(r.drive_error || '') + '）；完整 JSON 已寫入「檢視 → 執行紀錄（Logger）」，可在那裡複製。');
  lines.push('\n⚠️ 檔案含密碼 hash，只用於搬到上游／新節點，切勿公開分享或留在共用資料夾。');
  return linkAlert('匯出 JSON（含 hash）', lines.join(''));
}
function menuImportUsersJson() {
  const input = linkPrompt('匯入 JSON（upsertUser）', '貼上「匯出 JSON（含 hash）」檔案的 Drive 連結或檔案 ID：\n\n（匯入會逐個 upsertUser 直插 hash，保留舊密碼；既有帳戶只更新，不會重複開戶）');
  if (input === null) return '';
  const r = importUsersFromDrive(input, 'menu-import');
  if (!r.success) return linkAlert('匯入 JSON', '匯入失敗：' + String(r.error || ''));
  return linkAlert('匯入 JSON', '匯入完成：共 ' + r.count + ' 筆\n新增 ' + r.created + '、更新 ' + r.updated + '、失敗 ' + r.failed + linkSummarizeResults(r.results) + '\n\n確認無誤後，可閂下游直接入口（只收 sig）。');
}
function menuShowLinkState() {
  const s = getLinkState();
  const lines = [
    '節點：' + s.node,
    '本機直接入口（' + LINK_FLAG + '）：' + (s.allow_local_login ? '開啟（未閂）' : '已閂 — 只收上游 sig'),
    '設定值：' + s.link_flag_set,
    '本機 API KEY（遮罩）：' + s.api_key_masked,
    '已登記下游：' + s.downstreams.length + ' 個'
  ];
  s.downstreams.forEach(function (d) { lines.push('・' + d.id + (d.name ? '（' + d.name + '）' : '') + ' ' + d.url_masked + ' 登記於 ' + d.registered_at); });
  lines.push('\n匯出格式：' + s.export_format);
  return linkAlert('本機接駁狀態', lines.join('\n'));
}
function menuShowLinkCredentials() {
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  const lines = [
    '以下兩項由本節點 GS 產生，經收件匣交 ADMIN 登記；四項一律不寫入工作表。',
    '',
    'B　BACKEND（部署後抄此 URL）：',
    url || '（尚未部署為網頁應用程式：部署 → 新增部署 → 網頁應用程式，再按一次本選單）',
    '',
    'D　APIKEY（SHEET KEY）：',
    getApiKey(),
    '',
    'C　NAME：由你自行填寫（交 ADMIN 時一併提供）',
    'A　隱藏管理鍵：與旅系統無關，不改動、不在此顯示'
  ];
  return linkAlert('BACKEND／APIKEY（交 ADMIN）', lines.join('\n'));
}
function menuRegisterDownstream() {
  const id = linkPrompt('登記下游 1/4', '下游編號（例：團／進度節點識別，只可用英文、數字、底線、連字號）：');
  if (id === null) return '';
  const url = linkPrompt('登記下游 2/4', '下游 GAS 正式 /exec URL（B）：');
  if (url === null) return '';
  const key = linkPrompt('登記下游 3/4', '下游 SHEET KEY（下游 Script Properties 的 API_KEY，即 D）：');
  if (key === null) return '';
  const name = linkPrompt('登記下游 4/4', '下游名稱（可留空；按「取消」亦視為留空）：');
  const r = registerDownstream(id, url, key, name || '');
  return linkAlert('登記下游', r.success ? ('已登記下游 ' + r.id + '\n\n（URL 及 SHEET KEY 只存 Script Properties，不寫入工作表）\n下一步：按「📡 測試下游連線（sig）」確認可讀可寫。') : ('登記失敗：' + String(r.error || '')));
}
function menuRemoveDownstream() {
  const id = linkPrompt('移除下游登記', '要移除的下游編號：\n\n' + listDownstreams().map(function (d) { return '・' + d.id + (d.name ? '（' + d.name + '）' : ''); }).join('\n'));
  if (id === null) return '';
  const r = removeDownstream(id);
  return linkAlert('移除下游登記', r.success ? String(r.message) : ('移除失敗：' + String(r.error || '')));
}
function menuPingDownstream() {
  const id = linkPrompt('測試下游連線', '下游編號：');
  if (id === null) return '';
  const r = pingDownstream(id);
  if (!r || !r.success) return linkAlert('測試下游連線', '連線失敗：' + String((r && r.error) || '下游無回應'));
  return linkAlert('測試下游連線', '✅ sig 驗證通過，可讀可寫。\n\n下游節點：' + String(r.node || '') + '\n下游直接入口：' + (r.allow_local_login ? '開啟（未閂）' : '已閂 — 只收上游 sig') + '\n下游已登記的再下一層：' + ((r.downstreams && r.downstreams.length) || 0) + ' 個');
}
function menuCreateDownstreamUser() {
  const list = listDownstreams();
  if (!list.length) return linkAlert('為下游開戶', '尚未登記任何下游；請先按「➕ 登記下游（URL + SHEET KEY）」。');
  const id = linkPrompt('為下游開戶 1/6', '揀團（下游編號）：\n\n' + list.map(function (d) { return '・' + d.id + (d.name ? '（' + d.name + '）' : ''); }).join('\n'));
  if (id === null) return '';
  const ymis = linkPrompt('為下游開戶 2/6', 'YMIS（10 位數字；領袖可留空自動編 L 號）：');
  if (ymis === null) return '';
  const name = linkPrompt('為下游開戶 3/6', '姓名：');
  if (name === null) return '';
  const email = linkPrompt('為下游開戶 4/6', 'Email（領袖／執委必填，團員可留空）：');
  if (email === null) return '';
  const role = linkPrompt('為下游開戶 5/6', '角色：member / exec_committee / branch_leader / group_leader / admin');
  if (role === null) return '';
  const password = linkPrompt('為下游開戶 6/6', '臨時密碼（最少 4 位；預設 ' + DEFAULT_PASS + '）：');
  const finalPassword = (password === null || !password) ? DEFAULT_PASS : password;
  const r = createAccountForDownstream(id, {
    ymis: ymis, name: name, email: email, role: String(role || 'member').trim(),
    password: finalPassword, can_tick: true, branch: ''
  }, { ymis: ADMIN_YMIS, name: ADMIN_NAME, role: 'admin', can_tick: true });
  if (!r.success) return linkAlert('為下游開戶', '開戶失敗：' + String(r.error || ''));
  return linkAlert('為下游開戶', '✅ 已在上游開戶並經 sig 寫入下游 ' + r.downstream + '\n\nYMIS：' + r.ymis + '\n姓名：' + r.name + '\n臨時密碼：' + finalPassword + '\n（首次登入必須更改）');
}
function menuCloseDownstreamGate() {
  const id = linkPrompt('閂下游直接入口', '下游編號：\n\n' + listDownstreams().map(function (d) { return '・' + d.id + (d.name ? '（' + d.name + '）' : ''); }).join('\n'));
  if (id === null) return '';
  if (!linkConfirm('閂下游直接入口', '確定閂口？\n\n下游 ' + id + ' 之後只接受本上游的 sig 請求：\n・下游直接登入／申請帳戶會被拒\n・進度、帳戶、履歷一律由上游讀寫\n\n請先確認已完成匯入（upsertUser）及測試連線。')) return '';
  const r = setDownstreamLocalLogin(id, false);
  return linkAlert('閂下游直接入口', (r && r.success) ? ('✅ 下游 ' + id + ' 直接入口已閂，只收 sig。') : ('閂口失敗：' + String((r && r.error) || '下游無回應')));
}
function menuOpenDownstreamGate() {
  const id = linkPrompt('開下游直接入口', '下游編號：');
  if (id === null) return '';
  const r = setDownstreamLocalLogin(id, true);
  return linkAlert('開下游直接入口', (r && r.success) ? ('下游 ' + id + ' 直接入口已重開（本地登入恢復）。') : ('開啟失敗：' + String((r && r.error) || '下游無回應')));
}
function menuLocalLoginOff() {
  if (!linkConfirm('閂本機直接入口', '確定閂口？\n\n本節點之後只接受上游 sig 請求：\n・前端直接登入／申請帳戶會被拒\n・資料只由上游讀寫\n\n請先確認上游已登記本節點的 URL 及 SHEET KEY，並已通過「測試下游連線」。')) return '';
  setLocalLoginAllowed(false, 'menu');
  return linkAlert('閂本機直接入口', '✅ ' + LINK_FLAG + '=false：本節點只收上游 sig。如需重開，按「🔓 開啟（容許本地登入）」。');
}
function menuLocalLoginOn() {
  setLocalLoginAllowed(true, 'menu');
  return linkAlert('開本機直接入口', '✅ ' + LINK_FLAG + '=true：本節點直接入口已重開。');
}
