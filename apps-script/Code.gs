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
//   - 忘記密碼（電郵一次性重設碼）：公開 action requestPasswordReset／confirmPasswordReset
//     （YMIS／電郵 → 8 位一次性重設碼寄到登記電郵 → 即場設定新密碼；成功後舊 session 全部登出；
//       重設碼只存 SHA-256 雜湊、15 分鐘有效、最多試 5 次；回應不洩漏帳戶是否存在）
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

// ===== ROVERBOOK 對接（GS 5.4.0）=====
// 定位：ROVERBOOK 是成員自己手機上的紀錄冊（前端），ROVERBADGE 是領袖統管（後端）。
// 三條鐵律：① 成員個資只留在他自己的手機（本檔的新工作表冇任何聯絡欄位）
//          ② ROVERBADGE 只記進度，方便領袖一次過統管
//          ③ 頒發只由領袖一次過做，成員收到唯讀結果
// 介面版本見 assets/roverbook-bridge.js（前後端同一套規則；格式 'roverbadge.signoff.v2'／
// 'roverbadge.award.v1'／'roverbadge.progress.roverbook.v2'）。
const BOOK_SIGNOFF_SHEET = '紀錄冊核簽';
const BOOK_SIGNOFF_HEADERS = ['簽核編號','SCOUT ID','項目 ID','完成日期','核簽領袖','職銜','核簽日期','來源','寫入時間','備註'];
const BOOK_AWARD_SHEET = '紀錄冊頒發';
const BOOK_AWARD_HEADERS = ['SCOUT ID','獎章 ID','頒發日期','頒發人','來源','寫入時間','備註'];
// 成員手機交上嚟嘅資料**一律先入待批**，領袖逐項／一次過 CONFIRM 之後才寫入正式進度。
// 呢個係「成員自己喺 BOOK 簽了再錄入 BADGE 扮已完成」嘅唯一防線：BOOK 冇權寫正式進度。
const BOOK_PENDING_SHEET = '紀錄冊待批';
const BOOK_PENDING_HEADERS = ['待批編號','SCOUT ID','項目 ID','BOOK 日期','來源','提交時間','狀態','差異','領袖確認日期','確認人','確認時間','備註'];
const BOOK_PENDING_STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };
// 信任邊界（雙向、fail-closed）：
//   BADGE → BOOK：BOOK 無條件相信領袖核實過嘅紀錄（exported verified:true + 受信來源）；
//   BOOK → BADGE：一律唔信（成員部機可以改任何欄位）→ 只會變成「待領袖核實」。
//   差異欄位 diff 會標示來源可信度：leader-signed（BOOK 聲稱已由領袖簽）／member-claim（成員自己標記）。
const BOOK_TRUST_LEADER = 'leader-signed';
const BOOK_TRUST_CLAIM = 'member-claim';
const BOOK_PENDING_HEADERS_TRUST = '差異'; // 差異欄位同時標示 new／newer／older／same（保持表格兼容）
// 項目 ID 形狀（與 data/items.json 一致：L1-ACT-01／OT-WOSM-SW）；唔寫死清單，交由 itemCatalog 驗證
const BOOK_ITEM_RE = /^[A-Z]{1,3}[0-9]?(?:-[A-Z0-9]{1,12}){1,4}$/;
// 成員個資欄位：任何由 ROVERBOOK 傳入的欄位若命中，一律剝走並記錄（不寫入、不回傳）
const BOOK_NEVER_STORE_FIELDS = ['nameZh','nameEn','phone','email','address','dob','placeOfBirth','bloodType','emergencyName','emergencyPhone','photo','signature','signatures','holderSignature','png','group','crew','district','region','sponsoringAuthority','groupAddress','gsl','rsl','meetingPlace','dateJoined','dateScoutMovement','issueDate'];
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
//     登記後上游可經 sig 讀寫下游（進了上游就等於進了下游）。掛錯（如掛去其他支部），
//     對方一測 sig／一睇結構就會發現，會改返。
//   - 本節點 Script Properties 的 ALLOW_LOCAL_LOGIN 係「直接入口」掣：
//     未設定＝開啟（現有旅團零影響）；任何唔係 1/true/yes/on/open 的值
//     （false/0/no/off 或串錯字）＝閂口（fail closed）；閂口後只接受有效 sig。
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
const LINK_HASH_RE = /^([0-9a-f]{64}|pbkdf2\$\d+\$[0-9a-f]{16,64}\$[0-9a-f]{64})$/i;
const LINK_RESERVED_BODY_KEYS = ['sig', 'sig_ts', 'sig_nonce'];
// 上游以 sig 可以在下游執行的 action。login／apply／logout／changePassword／
// superTicketLogin／forgotPassword／requestPasswordReset／confirmPasswordReset 等本地憑證操作永不接受（即使有 sig）。
const LINK_SIG_READ_ACTIONS = ['load', 'getLoginMode', 'getLinkState', 'getMembers', 'getConfig', 'getAllUsers', 'getOtherBadges', 'getPendingRequests', 'getApplications', 'getLogRecords', 'getPendingLogRequests', 'exportUsers', 'bookRoster', 'bookPull', 'bookPending'];
const LINK_SIG_WRITE_ACTIONS = ['save', 'saveOtherBadge', 'requestComplete', 'reviewRequest', 'addMember', 'addUser', 'upsertUser', 'importUsers', 'resetPassword', 'deactivateUser', 'reactivateUser', 'updateUserProfile', 'deleteMember', 'deleteUser', 'updateUserRole', 'updatePermissions', 'updateConfig', 'saveLogRecord', 'deleteLogRecord', 'submitLogRequest', 'reviewLogRequest', 'reviewApplication', 'setLocalLogin', 'setScheme', 'bookSync', 'bookConfirm', 'bookAward'];
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
// 保留帳號 token 識別（前綴＋validateToken 還原）。保留帳號唔經旅團登記 Sheet（Users 表），
// 與旅系統直接入口閘門無關（同下方中央管理帳號登入路由一樣，唔受 ALLOW_LOCAL_LOGIN 管轄）。
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
  if (hash && !LINK_HASH_RE.test(hash)) return { success: false, ymis: ymis, error: 'password_hash 必須是 64 位 SHA-256 hex 或 pbkdf2$<iter>$<salt>$<hash> 格式' };
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
      setCol(8, sheetActor(actor));
      setCol(9, now());
      setCol(12, status);
      if (allowed !== '') setCol(13, allowed);
      else if (!String(data[row - 1][12] || '') && sheet.getLastColumn() >= 13) setCol(13, role === 'member' ? '' : (role === 'exec_committee' ? 'L1,OTHER' : '*'));
      setCol(FORCE_CHANGE_COL, force);
      syncMemberRow_(ymis, name, branch, email, status);
      writeAudit(actor, 'link_upsert_update', ymis, '上游／匯入更新帳戶' + (hash ? '（直插 hash）' : '（保留原密碼）'));
      return { success: true, ymis: ymis, action: 'updated', password_kept: !hash };
    }
    const nowStr = now();
    const canTickNew = raw.can_tick === true || String(raw.can_tick).toUpperCase() === 'TRUE';
    const defAllowed = allowed !== '' ? allowed : (role === 'member' ? '' : (role === 'exec_committee' ? 'L1,OTHER' : '*'));
    sheet.appendRow([ymis, name, email, role, hash, branch, canTickNew, sheetActor(actor), nowStr, String(raw.created_at || '') || nowStr, String(raw.last_login || ''), status, defAllowed, force]);
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
  if (action === 'exportUsers') return handleExportUsers();
  // ROVERBOOK 對接：上游簽名請求亦可（上游＝支部／進度節點一次過統管）
  if (action === 'bookRoster') return handleBookRoster(linkManager(body));
  if (action === 'bookSync') return handleBookSync(linkManager(body), body);
  if (action === 'bookConfirm') return handleBookConfirm(linkManager(body), body);
  if (action === 'bookPending') return handleBookPending(linkManager(body), body);
  if (action === 'bookAward') return handleBookAward(linkManager(body), body);
  if (action === 'bookPull') return handleBookPull(linkManager(body));
  if (action === 'save') return handleSave(body.changes || [], String(body.confirmer || actor), manager);
  if (action === 'saveOtherBadge') return handleSaveOtherBadge(body.records || [], manager);
  if (action === 'requestComplete') return handleRequestComplete(body, actor);
  if (action === 'reviewRequest') return handleReviewRequest(body.request_id, body.decision, body.review_note, manager, body.confirmed_date);
  if (action === 'setScheme') return handleSetScheme(body, manager, actor);
  if (action === 'addMember') return handleAddMember(body.ymis, body.name, body.squad || '', body.squad_role || 'member');
  if (action === 'addUser') return handleAddUser(body, manager);
  if (action === 'upsertUser') return handleUpsertUser(body.user || body, actor);
  if (action === 'importUsers') return handleSignedImport(body, actor);
  if (action === 'resetPassword') return handleResetPassword(body.target_ymis, manager, body.new_password);
  if (action === 'deactivateUser') return handleDeactivateUser(body, manager, actor);
  if (action === 'reactivateUser') return handleReactivateUser(body, manager, actor);
  if (action === 'updateUserProfile') return handleUpdateUserProfile(body, manager, actor);
  if (action === 'deleteMember') return handleDeleteMember(body, manager, actor);
  if (action === 'deleteUser') return handleDeleteUser(body, manager, actor);
  if (action === 'updateUserRole' || action === 'updatePermissions') return handleUpdateUserRole(body.target_ymis, body.new_role, body.can_tick, actor, body.allowed_badges);
  if (action === 'updateConfig') return handleUpdateConfig(body.key, body.value, actor);
  if (action === 'saveLogRecord') return handleSaveLogRecord(body.records || (body.record ? [body.record] : []), actor, String(body.recorder_name || ''));
  if (action === 'deleteLogRecord') return handleDeleteLogRecord(body.record_id, actor);
  if (action === 'submitLogRequest') return handleSubmitLogRequest(body, actor, manager);
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
  // 未初始化時唔可以扮完成：Key 照樣顯示，但先講明呢條 Key 暫時未可用＋點樣完成初始化
  const warn = initStatusWarningLines_();
  const prefix = warn.length ? warn.join('\n') + '\n' : '';
  if (ui) ui.alert('API Key', prefix + '你的 API Key：\n\n' + apiKey, ui.ButtonSet.OK);
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
// ===== /exec 網址正規化（GS 5.3.0）=====
// 同一個部署，ScriptApp.getService().getUrl() 會視乎帳戶類型回報唔同寫法：
//   標準：           https://script.google.com/macros/s/<id>/exec
//   Workspace 帳戶： https://script.google.com/a/macros/<域名>/s/<id>/exec
//   舊／手改寫法：   https://script.google.com/a/<域名>/macros/s/<id>/exec
// 登記（Vercel env TROOP_*_BACKEND）通常係「部署 → 管理部署」視窗顯示嘅標準寫法；
// 唔正規化就直接比對，Workspace 帳戶嘅旅團會永遠驗票失敗，而且完全冇訊息講得出原因。
// 呢度只改寫「形式」，唔改部署 ID；其他 host／解唔到嘅字串一律原樣回傳（比對端仍然 fail-closed）。
// 注意：getUrl() 嘅回報值唔係「部署網址」嘅權威，所以只用作正規化後比對，唔會顯示或回傳給用戶。
function canonicalServiceUrl_(u){
  return String(u||'')
    .replace(/^https:\/\/script\.google\.com\/a\/macros\/[^/]+(\/s\/)/, 'https://script.google.com/macros$1')
    .replace(/^https:\/\/script\.google\.com\/a\/[^/]+(\/macros\/)/, 'https://script.google.com$1');
}
function verifySuperTicket(ticket){
  if(typeof ticket!=='string' || ticket.length>4096) return false;
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return false;
  try{
    const cache=CacheService.getScriptCache();
    const cacheKey='super-ticket:'+hashPassword(ticket);
    if(cache.get(cacheKey)) return false;
    // backend 保留原回報字串（票據仍然綁死登記字串），另附正規化形式供比對端接受兩種寫法
    const response=UrlFetchApp.fetch(SUPER_VERIFY_URL, {
      method:'post', contentType:'application/json', muteHttpExceptions:true,
      payload:JSON.stringify({ticket:ticket, apikey:getApiKey(), backend:ScriptApp.getService().getUrl(), backendCanonical:canonicalServiceUrl_(ScriptApp.getService().getUrl())})
    });
    if(response.getResponseCode()!==200 || JSON.parse(response.getContentText()).ok!==true) return false;
    cache.put(cacheKey,'used',120);
    return true;
  }catch(e){ return false; }
  finally{ try{ lock.releaseLock(); }catch(e){} }
}

function hashPassword(p) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function(b){return ('0' + (b & 0xFF).toString(16)).slice(-2);}).join('');
}
// ===== A3 密碼雜湊：PBKDF2-HMAC-SHA256（每用戶 16-byte 隨機 salt + 時序安全比對）=====
// 新格式寫入 Users.password_hash 同一欄：pbkdf2$<iter>$<saltHex>$<dkHex>
//
// ⚠️ 迭代次數（GS 5.4.0，2026-11-04）：120,000 → 10,000。
//    Apps Script 每次 Utilities.computeHmacSha256Signature() 都要過一次 JS↔Java 邊界（約 0.1–0.3 ms），
//    所以 120,000 次＝實測 12–20 秒（唔係 Node／PHP 嗰種幾百 ms）。配合下面兩條舊 bug
//    （登入掃全表逐行驗、成功後再驗一次預設密碼），全團登入會撞爆 api/proxy.js 的上游 45 秒上限，
//    症狀就係「後端服務連線逾時」。詳見 docs/TROUBLESHOOT_LOGIN_TIMEOUT.md。
// 驗證一律讀「雜湊字串自帶嘅迭代次數」，所以舊 pbkdf2$120000$ 及更舊 64-hex 照樣登入得；
// 成功登入一次後自動改寫成本版格式（密碼本身不變）。
const PBKDF2_ITERATIONS = 10000;
// 驗證時接受嘅迭代範圍：防有人塞 pbkdf2$999999999$ 令登入變成 DoS。
// 下限 1,000（比 1,000 更低嘅雜湊視為壞資料，回「帳號或密碼錯誤」），上限 2,000,000。
const PBKDF2_MIN_ITERATIONS = 1000;
const PBKDF2_MAX_ITERATIONS = 2000000;
// 診斷用：本次執行做過幾多次 PBKDF2（回歸測試用嚟證明「一次登入只做一個 KDF」；不對外提供）
let __kdfCalls_ = 0;
let __kdfIterations_ = 0;
function hexToBytes_(hex){ const out=[]; hex=String(hex||'').replace(/[^0-9a-f]/gi,''); for(let i=0;i+1<hex.length;i+=2) out.push(parseInt(hex.substr(i,2),16)); return out; }
function xorBytes_(a,b){ const out=[]; for(let i=0;i<a.length;i++) out.push((a[i]^b[i])&0xFF); return out; }
function pbkdf2HmacSha256_(password, saltBytes, iterations){
  // dkLen=32（一個 block）：T = U1 ^ U2 ^ ... ^ Uc；U1 = PRF(P, S||INT(1))；Ui = PRF(P, U_{i-1})
  __kdfCalls_++;
  __kdfIterations_ += (iterations||0);
  let u = Utilities.computeHmacSha256Signature(saltBytes.concat([0,0,0,1]), String(password||''));
  let t = u.slice();
  for(let i=1;i<iterations;i++){
    u = Utilities.computeHmacSha256Signature(u, String(password||''));
    t = xorBytes_(t, u);
  }
  return t;
}
function hashPasswordV2(p){
  const saltHex = (Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'').slice(0,32); // 16 bytes salt
  const dk = pbkdf2HmacSha256_(String(p||''), hexToBytes_(saltHex), PBKDF2_ITERATIONS);
  return 'pbkdf2$'+PBKDF2_ITERATIONS+'$'+saltHex+'$'+toHex(dk);
}
function isLegacyPasswordHash_(h){ return /^[0-9a-f]{64}$/i.test(String(h||'')); }
// 解析 pbkdf2$<iter>$<salt>$<dk>；格式／迭代次數超出可接受範圍一律回 null（當壞資料，唔會做超長 KDF）
function parsePbkdf2Hash_(stored){
  const s=String(stored||'');
  if(s.indexOf('pbkdf2$')!==0) return null;
  const parts=s.split('$');
  if(parts.length!==4) return null;
  const iter=parseInt(parts[1],10)||0;
  if(iter<PBKDF2_MIN_ITERATIONS || iter>PBKDF2_MAX_ITERATIONS) return null;
  const saltBytes=hexToBytes_(parts[2]);
  if(!saltBytes.length) return null;
  const dkHex=String(parts[3]||'');
  if(!/^[0-9a-f]{64}$/i.test(dkHex)) return null;
  return {iterations:iter, saltBytes:saltBytes, dkHex:dkHex};
}
// 驗證密碼：自動接受舊格式（單次 SHA-256）與任何迭代次數嘅 pbkdf2$ 格式；
// 比對用 safeEqualText（雙重 SHA-256，防時序）。
function verifyPassword(p, stored){
  stored = String(stored||'');
  if(stored.indexOf('pbkdf2$')===0){
    const parsed=parsePbkdf2Hash_(stored);
    if(!parsed) return false;
    const dk = pbkdf2HmacSha256_(String(p||''), parsed.saltBytes, parsed.iterations);
    return safeEqualText(toHex(dk), parsed.dkHex);
  }
  return safeEqualText(sha256Hex(String(p||'')), stored);
}
// 呢個雜湊係唔係「本版之前」嘅格式（64-hex 或迭代次數唔同）→ 成功登入後透明改寫為本版格式
function needsPasswordRehash_(stored){
  stored=String(stored||'');
  if(!stored) return false;
  if(isLegacyPasswordHash_(stored)) return true;
  const parsed=parsePbkdf2Hash_(stored);
  if(!parsed) return false; // 壞資料／超範圍：唔主動改寫（避免把不明資料靜靜換走）
  return parsed.iterations!==PBKDF2_ITERATIONS;
}
// 反枚舉用 dummy 雜湊：改用 CacheService 跨執行重用（唔再每次「帳號不存在」都重新計一次 KDF）。
// CacheService 唔可用時退回單次執行記憶體，最後才即場計算。
const DUMMY_HASH_CACHE_KEY_ = 'pwd_dummy_hash_v1';
let __dummyPasswordHash_ = null;
function dummyPasswordHash_(){
  if(__dummyPasswordHash_) return __dummyPasswordHash_;
  try{
    const hit=CacheService.getScriptCache().get(DUMMY_HASH_CACHE_KEY_);
    if(hit){ __dummyPasswordHash_=String(hit); return __dummyPasswordHash_; }
  }catch(e){}
  const h=hashPasswordV2('timing-equalizer');
  __dummyPasswordHash_=h;
  try{ CacheService.getScriptCache().put(DUMMY_HASH_CACHE_KEY_, h, 21600); }catch(e){}
  return h;
}
// 帳號不存在／停用時燒一次 dummy KDF（令時序同「密碼錯誤」一致），並清走每次執行嘅統計
function burnDummyKdf_(password){
  const t0=Date.now();
  try{ verifyPassword(String(password||''), dummyPasswordHash_()); }catch(e){}
  return Date.now()-t0;
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
// 勾選權限 = 角色屬勾選角色 且 「可勾選」開關（users 第 7 欄 can_tick）為 true。
// 收回權限即時生效：團長收回副團長的可勾選後，即使角色是領袖也不可勾選或審批。
function canTickUser_(u){ return !!u && canUserTick(u.role) && u.can_tick===true; }

// ===== 學制（新制／舊制／舊制過渡新制）與 allowed_badges 後端強制 =====
// 項目目錄（ITEM_CATALOG_）與角色預設（DEFAULT_PERMS_）由 scripts/gen-backend-catalog.mjs 產生，勿手改。
// >>> GENERATED:ITEM_CATALOG（scripts/gen-backend-catalog.mjs 由 data/items.json 產生，勿手改）
// 學制字母：n=新制 o=舊制 t=舊制過渡新制。字母只表示「該學制可勾選」。
var ITEM_CATALOG_ = {
  "L1-ACT-01": { t: "not", s: "L1-ACT", b: "L1", o: 0 },
  "L1-UND-01": { t: "not", s: "L1-UND", b: "L1", o: 0 },
  "L1-UND-02": { t: "not", s: "L1-UND", b: "L1", o: 0 },
  "L1-UND-03": { t: "not", s: "L1-UND", b: "L1", o: 0 },
  "L1-UND-04": { t: "not", s: "L1-UND", b: "L1", o: 0 },
  "L1-ETQ-01": { t: "not", s: "L1-ETQ", b: "L1", o: 0 },
  "L1-ETQ-02": { t: "not", s: "L1-ETQ", b: "L1", o: 0 },
  "L1-ETQ-03": { t: "not", s: "L1-ETQ", b: "L1", o: 0 },
  "L1-ETQ-04": { t: "not", s: "L1-ETQ", b: "L1", o: 0 },
  "L1-ETQ-05": { t: "not", s: "L1-ETQ", b: "L1", o: 0 },
  "L1-ETQ-06": { t: "not", s: "L1-ETQ", b: "L1", o: 0 },
  "L1-PRM-01": { t: "not", s: "L1-PRM", b: "L1", o: 0 },
  "L1-CP-01": { t: "not", s: "L1-CP", b: "L1", o: 0 },
  "L2-INTRO-01": { t: "not", s: "L2-INTRO", b: "L2", o: 0 },
  "L3-LEADER-01": { t: "nt", s: "L3-LEADER", b: "L3", o: 0 },
  "L3-LEADER-02": { t: "nt", s: "L3-LEADER", b: "L3", o: 0 },
  "L3-SCOUT-01": { t: "nt", s: "L3-SCOUT", b: "L3", o: 0 },
  "L3-SCOUT-02": { t: "nt", s: "L3-SCOUT", b: "L3", o: 0 },
  "L3-SCOUT-03": { t: "nt", s: "L3-SCOUT", b: "L3", o: 0 },
  "L3-SERVICE-01": { t: "nt", s: "L3-SERVICE", b: "L3", o: 0 },
  "L3-SERVICE-02": { t: "nt", s: "L3-SERVICE", b: "L3", o: 0 },
  "L3-SERVICE-03": { t: "nt", s: "L3-SERVICE", b: "L3", o: 0 },
  "L3-INTL-01": { t: "nt", s: "L3-INTL", b: "L3", o: 0 },
  "L3-INTL-02": { t: "nt", s: "L3-INTL", b: "L3", o: 0 },
  "L3-INT-01": { t: "nt", s: "L3-INT", b: "L3", o: 0 },
  "L3-HEALTH-01": { t: "nt", s: "L3-HEALTH", b: "L3", o: 0 },
  "L3-HEALTH-02": { t: "nt", s: "L3-HEALTH", b: "L3", o: 0 },
  "L3-CHALLENGE-01": { t: "nt", s: "L3-CHALLENGE", b: "L3", o: 0 },
  "L3-CHALLENGE-02": { t: "nt", s: "L3-CHALLENGE", b: "L3", o: 0 },
  "L4-ALL-01": { t: "nt", s: "L4-ALL", b: "L4", o: 0 },
  "L4-ALL-02": { t: "nt", s: "L4-ALL", b: "L4", o: 0 },
  "L4-ALL-03": { t: "nt", s: "L4-ALL", b: "L4", o: 0 },
  "S4-AWARD-CORE-01": { t: "o", s: "S4-AWARD-CORE", b: "S4-AWARD", o: 0 },
  "S4-AWARD-CORE-02": { t: "o", s: "S4-AWARD-CORE", b: "S4-AWARD", o: 0 },
  "S4-AWARD-CORE-03": { t: "o", s: "S4-AWARD-CORE", b: "S4-AWARD", o: 0 },
  "S4-AWARD-CORE-04": { t: "o", s: "S4-AWARD-CORE", b: "S4-AWARD", o: 0 },
  "S4-AWARD-ELECT-01": { t: "o", s: "S4-AWARD-ELECT", b: "S4-AWARD", o: 0 },
  "S4-AWARD-ELECT-02": { t: "o", s: "S4-AWARD-ELECT", b: "S4-AWARD", o: 0 },
  "S4-AWARD-ELECT-03": { t: "o", s: "S4-AWARD-ELECT", b: "S4-AWARD", o: 0 },
  "S4-BP-CORE-01": { t: "o", s: "S4-BP-CORE", b: "S4-BP", o: 0 },
  "S4-BP-CORE-02": { t: "o", s: "S4-BP-CORE", b: "S4-BP", o: 0 },
  "S4-BP-CORE-03": { t: "o", s: "S4-BP-CORE", b: "S4-BP", o: 0 },
  "S4-BP-ELECT-01": { t: "o", s: "S4-BP-ELECT", b: "S4-BP", o: 0 },
  "S4-BP-ELECT-02": { t: "o", s: "S4-BP-ELECT", b: "S4-BP", o: 0 },
  "S4-BP-ELECT-03": { t: "o", s: "S4-BP-ELECT", b: "S4-BP", o: 0 },
  "OT-WOSM-SW": { t: "not", s: "", b: "", o: 1 },
  "OT-WOSM-ET": { t: "not", s: "", b: "", o: 1 },
  "OT-WOSM-WH": { t: "not", s: "", b: "", o: 1 },
  "OT-FA": { t: "not", s: "", b: "", o: 1 },
  "OT-RESCUE": { t: "not", s: "", b: "", o: 1 },
  "OT-AIR-SENIOR": { t: "not", s: "", b: "", o: 1 },
  "OT-SEA-HELM": { t: "not", s: "", b: "", o: 1 },
  "OT-FLY": { t: "not", s: "", b: "", o: 1 },
  "OT-PARA": { t: "not", s: "", b: "", o: 1 },
  "OT-ACTIVE": { t: "not", s: "", b: "", o: 1 },
  "OT-COMM": { t: "not", s: "", b: "", o: 1 },
  "OT-REL": { t: "not", s: "", b: "", o: 1 },
  "OT-CATH": { t: "not", s: "", b: "", o: 1 },
  "OT-AYP-G": { t: "not", s: "", b: "", o: 1 },
  "OT-AYP-S": { t: "not", s: "", b: "", o: 1 },
};
// 角色預設 allowed_badges（與 items.json permissionDefaults 相同；空白 allowed_badges 時使用）
var DEFAULT_PERMS_ = {
  leader: "*",
  exec_committee: "L1,OTHER",
  member: ""
};
// <<< GENERATED:ITEM_CATALOG
const SCHEME_SHEET_NAME='學制設定';
const SCHEME_KEYS_=['new','old','transition'];
const SCHEME_DEFAULT_='new';
const SCHEME_LABELS_={new:'新制（第五版）',old:'舊制（第四版）',transition:'舊制過渡新制'};
const SCHEME_LETTER_={new:'n',old:'o',transition:'t'};
function normalizeScheme_(s){ s=String(s===undefined||s===null?'':s).trim(); return SCHEME_KEYS_.indexOf(s)>=0 ? s : SCHEME_DEFAULT_; }
function schemeSheet_(create){
  const ss=getSheet(); let sh=ss.getSheetByName(SCHEME_SHEET_NAME);
  if(!sh && create){ sh=ss.insertSheet(SCHEME_SHEET_NAME); sh.appendRow(['ymis','scheme','updated_at','updated_by']); }
  return sh;
}
// 全部成員學制 {ymis: scheme}；無紀錄 = 預設新制
function schemeMap_(){
  const map={}; const sh=schemeSheet_(false); if(!sh) return map;
  const data=sh.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ const y=String(data[i][0]||'').trim(); if(y) map[y]=normalizeScheme_(data[i][1]); }
  return map;
}
function schemeOf_(ymis, map){ return (map||schemeMap_())[String(ymis||'').trim()] || SCHEME_DEFAULT_; }
function catalogEntry_(itemId){
  const k=String(itemId===undefined||itemId===null?'':itemId);
  return Object.prototype.hasOwnProperty.call(ITEM_CATALOG_, k) ? ITEM_CATALOG_[k] : null;
}
function itemInScheme_(itemId, scheme){ const c=catalogEntry_(itemId); return !!c && c.t.indexOf(SCHEME_LETTER_[scheme]||'_')>=0; }
// 權限字串：allowed_badges 空白 = 角色預設（與前端 canCurrentUserTickItem 相同）
function permissionStringOf_(user){
  const stored=String((user&&user.allowed_badges)||'').trim();
  if(stored!=='') return stored;
  const key=user.role==='exec_committee'?'exec_committee':(user.role==='member'?'member':'leader');
  return String(DEFAULT_PERMS_[key]||'');
}
// 與 assets/rover-scope.js canTickItem 相同規則：* ／ 項目 ID ／ 段章 ／ 獎章 ／ OTHER
function tokenAllowsItem_(allowed, itemId){
  const tokens=String(allowed||'').split(/[,，]/).map(function(s){ return s.trim(); }).filter(Boolean);
  if(tokens.indexOf('*')>=0) return true;
  if(tokens.indexOf(itemId)>=0) return true;
  const c=catalogEntry_(itemId); if(!c) return false;
  if(c.s && tokens.indexOf(c.s)>=0) return true;
  if(c.b && tokens.indexOf(c.b)>=0) return true;
  if(c.o && tokens.indexOf('OTHER')>=0) return true;
  return false;
}
// 操作者能否勾選此項（不含學制）。actor 為 null ＝ 有效 API Key（系統）全權
function actorCanTickItem_(actor, itemId){
  if(!actor) return true;
  if(!canTickUser_(actor)) return false;
  if(actor.role==='super_admin') return true;
  return tokenAllowsItem_(permissionStringOf_(actor), itemId);
}
// 整批檢查：任一筆違反即整批拒絕（呼叫端不得寫入）。pairs: [{ymis,itemId}]。回傳 null＝通過，字串＝錯誤
function checkTickBatch_(pairs, actor){
  const map=schemeMap_();
  for(let i=0;i<pairs.length;i++){
    const p=pairs[i]||{};
    const id=String(p.itemId===undefined||p.itemId===null?'':p.itemId);
    if(!catalogEntry_(id)) return '未知或已停用的項目 ID：'+id+'（舊版紀錄不可再勾選或申請）';
    const ym=String(p.ymis||'').trim();
    const sch=schemeOf_(ym, map);
    if(!itemInScheme_(id, sch)) return '項目 '+id+' 不屬於 '+(ym||'（未指定成員）')+' 所選學制（'+SCHEME_LABELS_[sch]+'）';
    if(actor && !actorCanTickItem_(actor, id)) return '權限不足：無權勾選 '+id+'（請管理員調整 allowed_badges）';
  }
  return null;
}
// 設定學制：本人可改自己；他人需為可勾選的領袖（或超管）。整列 upsert，寫入審計
function handleSetScheme(body, actor, actorYmis){
  const me=String(actorYmis||'').trim();
  const target=String((body&&body.target_ymis)||me).trim();
  const scheme=String((body&&body.scheme)||'').trim();
  if(!target) return jsonResponse({success:false,error:'缺少成員 YMIS'});
  if(SCHEME_KEYS_.indexOf(scheme)<0) return jsonResponse({success:false,error:'學制須為 new（新制）／old（舊制）／transition（舊制過渡新制）'});
  if(target!==me && !(actor && canTickUser_(actor)))
    return jsonResponse({success:false,error:'只可由可勾選的領袖為他人設定學制'});
  const sh=schemeSheet_(true);
  const data=sh.getDataRange().getValues(); let row=-1;
  for(let i=1;i<data.length;i++){ if(String(data[i][0]||'').trim()===target){ row=i+1; break; } }
  const ts=now(); const by=sheetActor(me);
  if(row>0){ sh.getRange(row,2).setValue(scheme); sh.getRange(row,3).setValue(ts); sh.getRange(row,4).setValue(by); }
  else sh.appendRow([target,scheme,ts,by]);
  writeAudit(me,'set_scheme',target,scheme);
  return jsonResponse({success:true,ymis:target,scheme:scheme,schemes:schemeMap_()});
}
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
// ===== GS 版本與初始化核對（最新版本公告用；index.html 的 GS_LATEST 須同步改）=====
// 發佈新版 Code.gs 時更新 GS_VERSION／GS_RELEASE_DATE；本版若要求執行一次 initializeSheets()，GS_INIT_REQUIRED=true。
// INITIALIZED_GS_VERSION（Script Property）只在 initializeSheets() 成功走完最後一步才寫入，
// 表示「此 GS 版本的初始化已完成」。initializeSheets() 只做增補（缺表／缺欄位標題／缺預設管理員），
// 不刪除、不改寫任何既有用戶、進度、紀錄或金鑰資料（見 docs/LEADER_GUIDE.md「資料保全規則」）。
const GS_VERSION = '5.4.0';
const GS_RELEASE_DATE = '2026-11-04';
const GS_INIT_REQUIRED = true;
const GS_INIT_PROP = 'INITIALIZED_GS_VERSION';
function gsVersionInfo_(){
  let initialized='';
  try{ initialized=String(PropertiesService.getScriptProperties().getProperty(GS_INIT_PROP)||''); }catch(e){}
  return {gsVersion:GS_VERSION, gsReleaseDate:GS_RELEASE_DATE, initRequired:GS_INIT_REQUIRED, initializedGsVersion:initialized};
}
// 未初始化時唔可以扮完成（GS 5.3.0）：
// 選單「🔑 顯示 API KEY（交 ADMIN）」只讀 Script Properties，getApiKey() 會即時生成並持久化 API_KEY，
// 所以用戶可以在 initializeSheets() 之前攞到一條「睇落正常」嘅 Key，以為接入完成（實際一張表都未建）。
// 呢個 helper 只產生警告文字：Key 照樣顯示，但會講明暫時未可用＋唯一嘅完成步驟（選單「🔧 初始化／更新」）。
function initStatusWarningLines_(){
  const info = gsVersionInfo_();
  if (info.initRequired && info.initializedGsVersion !== info.gsVersion) {
    return ['⚠️ 尚未完成初始化／更新（此 API Key 暫時未可用）',
            '請先執行選單「🔧 初始化／更新」一次（等同 initializeSheets()）；',
            '只會補建缺少的工作表及預設管理員，不會刪改任何既有資料。', ''];
  }
  return [];
}
// 表頭只在「該格完全空白」時才寫入，絕不覆蓋既有欄名
function setHeaderIfEmpty_(sheet, col, label){
  if(!sheet) return;
  if(!String(sheet.getRange(1,col).getValue()||'').trim()) sheet.getRange(1,col).setValue(label);
}
const FORCE_CHANGE_COL = 14;
// A5 登入閘：同一帳號連續失敗上限次數、鎖定時長（毫秒）
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15*60*1000;
function ensureForceChangeCol(uSheet){
  if(!uSheet) return;
  if(uSheet.getLastColumn()<FORCE_CHANGE_COL || !String(uSheet.getRange(1,FORCE_CHANGE_COL).getValue()||'').trim()){
    uSheet.getRange(1,FORCE_CHANGE_COL).setValue('force_change_password');
  }
}
// 預設管理員 seed（2026-10 對齊 vsbadge ensureSeedAccount）：
// 每次 initializeSheets 都檢查；只有完全搵唔到（同 YMIS 或同 Email）先補回（新增列，不覆蓋既有帳號）。
// 注意：本函式不再逐列改寫既有帳號的 force_change_password。「密碼仍為預設值就強制改密」改在
// handleLogin() 讀取時判斷（見 isDefaultPasswordHash_），既不改寫用戶資料，也保留強制改密效果。
function ensureAdminSeed(uSheet){
  if(!uSheet) return;
  ensureForceChangeCol(uSheet);
  const data = uSheet.getDataRange().getValues();
  const id = String(ADMIN_YMIS).toLowerCase();
  const email = String(ADMIN_EMAIL).toLowerCase();
  let exists = false;
  for(let i=1;i<data.length;i++){
    const rid = String(data[i][0]||'').toLowerCase();
    const rem = String(data[i][2]||'').toLowerCase();
    if(rid===id || (email && rem===email)){ exists=true; break; }
  }
  if(!exists){
    const row = ['','','','','','','','','','','','','',''];
    row[0]=ADMIN_YMIS;                 // ymis
    row[1]=ADMIN_NAME;                 // name
    row[2]=ADMIN_EMAIL;                // email
    row[3]='admin';                    // role
    row[4]=hashPasswordV2(ADMIN_PASS);   // password_hash
    row[5]='b4';                       // branch
    row[6]=true;                       // can_tick
    row[7]='system';                   // auth_by
    row[8]=now();                      // auth_date
    row[9]=now();                      // created_at
    row[11]='active';                  // status
    row[12]='*';                       // allowed_badges（管理員默認全部）
    row[13]=true;                      // force_change_password
    uSheet.appendRow(row);
  }
}
function isForceChangeValue(v){ return v===true || String(v).toUpperCase()==='TRUE'; }
// 密碼雜湊仍等於預設密碼（changeme）＝ 必須首次登入強制改密（讀取時判斷，不寫入資料）
// 舊版殘留保留帳號列（角色 super_admin 或 YMIS 等於保留識別字）：只用於讀取時略過，不刪除
function isLegacySuperRow_(row){
  const y=String((row&&row[0])||'').trim().toLowerCase();
  const role=String((row&&row[3])||'').trim().toLowerCase();
  return role==='super_admin' || (!!SUPER_ADMIN_ID && y===String(SUPER_ADMIN_ID).toLowerCase());
}
// 「呢個明文密碼係唔係預設密碼」＝ 必須首次登入強制改密。
// GS 5.4.0：舊版 isDefaultPasswordHash_() 會為咗判斷而再跑一次 PBKDF2（成功登入＝2× KDF，
// 直接撞爆 proxy 上游上限）。登入流程已經驗證過同一個明文密碼，所以直接字串比對就係同等資訊，
// 唔需要、亦唔應該再做任何雜湊。本函式保留名稱供舊呼叫點使用，只做字串比對（零 KDF）。
function isDefaultPasswordHash_(){ return false; } // 已停用：雜湊 → 預設密碼嘅推斷唔再需要（見 isDefaultPassword_）
function isDefaultPassword_(plain){ const p=String(plain===undefined||plain===null?'':plain); return p!=='' && (p===ADMIN_PASS || p===DEFAULT_PASS); }
// 診斷用：某個雜湊係唔係預設密碼（只在選單「⏱️ 密碼雜湊效能測試」／維運用；登入流程永不呼叫）
function hashMatchesDefaultPassword_(hash){
  const h=String(hash||'').trim();
  if(!h) return false;
  try{
    if(isLegacyPasswordHash_(h)) return safeEqualText(sha256Hex(ADMIN_PASS), h) || safeEqualText(sha256Hex(DEFAULT_PASS), h);
    if(parsePbkdf2Hash_(h)) return verifyPassword(ADMIN_PASS,h) || verifyPassword(DEFAULT_PASS,h);
  }catch(e){}
  return false;
}
// 旅系統 GS 版本核對（前端「最新版本公告」用；唯讀，不含任何用戶資料）
function ecStatusResponse_(){ return jsonResponse(Object.assign({success:true}, gsVersionInfo_())); }
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
  schemeSheet_(true); // 學制設定（ymis／scheme／updated_at／updated_by）；無紀錄 = 預設新制
  let pSheet = ss.getSheetByName('進度追蹤');
  if(!pSheet){
    pSheet = ss.insertSheet('進度追蹤');
    pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);
    pSheet.getRange(1,1,1,6).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    pSheet.setFrozenRows(1);
  } else {
    // 補缺欄表頭（只寫空白格，不覆蓋既有欄名）
    setHeaderIfEmpty_(pSheet,5,'確認者'); setHeaderIfEmpty_(pSheet,6,'備註');
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
  } else {
    // 確保第13欄表頭存在（只寫空白格）
    setHeaderIfEmpty_(uSheet,13,'allowed_badges');
  }
  // 2026-10 對齊 vsbadge：每次初始化都確保預設管理員存在（被刪會補回，新增列）；
  // 不再改寫既有帳號的 force_change_password（預設密碼強制改密改在 handleLogin 判斷）
  ensureAdminSeed(uSheet);
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
  // 忘記密碼（電郵重設碼）：新建 Sheet 一併建立「密碼重設」表；舊 Sheet 由 getPasswordResetSheet() 即用即補，
  // 所以本次更新毋須重跑 initializeSheets()。
  let pwSheet = ss.getSheetByName(PWD_RESET_SHEET);
  if(!pwSheet){
    pwSheet = ss.insertSheet(PWD_RESET_SHEET);
    pwSheet.appendRow(PWD_RESET_HEADERS);
    pwSheet.getRange(1,1,1,PWD_RESET_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    pwSheet.setFrozenRows(1);
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

  // ROVERBOOK 對接（GS 5.4.0）：新工作表「紀錄冊核簽」＋「紀錄冊頒發」
  // 只存「SCOUT ID → 項目／日期／核簽人」與「SCOUT ID → 獎章／頒發日期」。
  // 成員個人資料（姓名以外嘅聯絡方法、相片、簽名墨跡）永遠唔會寫入本試算表。
  [BOOK_SIGNOFF_SHEET, BOOK_AWARD_SHEET, BOOK_PENDING_SHEET].forEach(function(name){
    const sh = ss.getSheetByName(name);
    if(sh) return;
    const headers = name===BOOK_SIGNOFF_SHEET ? BOOK_SIGNOFF_HEADERS
      : (name===BOOK_AWARD_SHEET ? BOOK_AWARD_HEADERS : BOOK_PENDING_HEADERS);
    const created = ss.insertSheet(name);
    created.appendRow(headers);
    created.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    created.setFrozenRows(1);
  });

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
  // 資料保全：初始化不再自動刪除任何列（舊版殘留 super_admin 列、Tokens 殘留 session 皆保留；
  // 這些列已由 isLegacySuperRow_() 在登入時略過，不能作為身分）。如需清理，須由管理員手動執行
  // removeSuperAdminRows()／removeSuperAdminTokenRows()，並先備份試算表。
  try{
    const ui=SpreadsheetApp.getUi();
    if(ui){
      // 只顯示 API Key；正式部署 URL 以 Google 部署視窗為準，不自動推算或回傳。
      ui.alert('✅ 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章、活動履歷、待批履歷\n\n🔑 API Key = '+apiKey+'\n\n正式部署 URL 請從 Google「部署」視窗取得；請自行在原有 ADMIN FORM 填寫旅團編號、名稱、URL 和 API Key。\n\n👤 旅團管理員 YMIS: '+ADMIN_YMIS+' 初始密碼: '+ADMIN_PASS+'（請立即登入後更改）');
    }
  }catch(e){}
  // 最後一步：只有以上全部成功，才記下「此 GS 版本的初始化已完成」（前端據此顯示「全部完成」）
  PropertiesService.getScriptProperties().setProperty(GS_INIT_PROP, GS_VERSION);
  return {success:true,apiKey:apiKey,gsVersion:GS_VERSION,initializedGsVersion:GS_VERSION};
}

// removeSuperAdminTokenRows()：清除 Tokens 表內舊版以 __sys__／帳號／rbs-super-v1- 寫入嘅
// 保留帳號 session 行（舊版登入紀錄）；initializeSheets() 會自動執行，可單獨重跑。
function removeSuperAdminTokenRows(){
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return {success:true,removed:0,message:'Tokens 工作表不存在'};
  const data=sheet.getDataRange().getValues();
  let removed=0;
  for(let i=data.length-1;i>=1;i--){
    const y=String(data[i][1]||'').trim();
    if(y===SUPER_ADMIN_TOKEN_MARK || isSuperAdminId(y) || String(data[i][0]||'').indexOf(SUPER_TOKEN_PREFIX)===0){ sheet.deleteRow(i+1); removed++; }
  }
  return {success:true,removed:removed};
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
  const keyNorm=scoutNorm_(key);
  for(let i=1;i<data.length;i++){
    // 舊版殘留 super_admin 列：保留不刪（資料保全），但不可作為登入身分
    if(isLegacySuperRow_(data[i])) continue;
    const rowKey=String(data[i][0]||'').trim();
    const sameId = rowKey===key || (keyNorm && scoutNorm_(rowKey)===keyNorm);
    if(sameId && String(data[i][11]||'').trim()==='active'){
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
    if(isLegacySuperRow_(data[i])) continue; // 舊版殘留 super_admin 列不可作為登入身分（保留不刪）
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
// 保留帳號 session（無狀態）：SUPER_TOKEN_PREFIX + HMAC(用途字串, 本節點 API_KEY)。
// 唔寫 Tokens 表——旅團 Sheet 完全冇中央帳號嘅登入紀錄；呢條 token 只等同本節點本地
// 最高權限（Sheet 主人本身就有同等權限），跨旅團仍然要 Vercel SUPER_KEY 驗票先登入到。
function superAdminSessionToken(){
  return SUPER_TOKEN_PREFIX + hmacSha256Hex('roverbadge-super-session-v1', getApiKey());
}
function validateToken(token){
  if(!token) return null;
  // 保留帳號：無狀態驗證（常數時間比較；錯值／偽造一律 null，唔會讀寫 Tokens 表）
  if(String(token).indexOf(SUPER_TOKEN_PREFIX)===0)
    return safeEqualText(String(token), superAdminSessionToken()) ? SUPER_ADMIN_ID : null;
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
  // 保留帳號：無狀態 token，唔寫 Tokens 表（Sheet 零登入紀錄）
  if(isSuperAdminId(ymis)) return superAdminSessionToken();
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  sheet.appendRow([token,ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
  return token;
}
function destroyToken(token){
  if(!token) return;
  if(String(token).indexOf(SUPER_TOKEN_PREFIX)===0) return; // 保留帳號：無狀態 token，冇行可刪
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===token){ sheet.deleteRow(i+1); return; } }
}

// ===== API =====
function doGet(e){
  const params=(e&&e.parameter)||{};
  const action=String(params.action||'');
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone',local_login:localLoginAllowed(),upstream_only:!localLoginAllowed()});
  // GS 版本核對：唯讀、只回版本與初始化標記，不含用戶資料；放在閂口之前，旅系統關閉時仍可核對
  if(action==='ecStatus') return ecStatusResponse_();
  // 旅系統：閂口後直接入口一律拒絕（只收上游 sig；簽名請求一律走 doPost）
  // 保留帳號 token 與旅系統閘門無關（同 doPost 中央管理帳號登入路由）
  if(!localLoginAllowed() && !isSuperAdminToken(params.token)) return jsonResponse(linkClosedResponse(action));
  if(action==='load'){
    // 向後兼容：allow load without apikey (troops.json may not have apikey)，但帶咗 apikey 就必須驗證
    const reqKey=params.apikey;
    if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
    return handleLoad();
  }
  return jsonResponse({success:false,error:'Unknown action'});
}
function doPost(e){
  try{
    const rawBody=String(((e&&e.postData)||{}).contents||'{}');
    const body=JSON.parse(rawBody||'{}');
    const action=String(body.action||'');
    // 旅系統：上游簽名（sig）請求優先路由（先驗 sig）；未簽名時先留中央登入，再檢查直接入口掣
    if(verifyLinkSig(e,body,rawBody)) return handleSignedRequest(action,body);
    if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone',local_login:localLoginAllowed(),upstream_only:!localLoginAllowed()});
    // 中央管理帳號登入（Vercel 側 SUPER_KEY 驗證 → 短效票據 → 固定端點驗票）：與旅系統閘門無關，
    // 直接入口關閉後仍要可用（SUPER_KEY 與旅系統脫鉤）；
    // 只放行保留帳號＋super_ticket（防：一般帳號帶假票據繞過閂口）
    if(action==='login' && body.super_ticket && isSuperAdminId(body.login_id)) return handleLogin(body.login_id,body.password,body.super_ticket);
    // 旅系統：閂口後本地直接入口全拒（login/apply/GET load/apikey save/token 操作），只收 sig
    // 保留帳號 token 與旅系統閘門無關（同上，唔經旅團登記 Sheet）；一般 token 先受閂口管制
    if(!localLoginAllowed() && !isSuperAdminToken(body.token)) return jsonResponse(linkClosedResponse(action));
    if(action==='login') return handleLogin(body.login_id,body.password);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role||'member',body.branch);
    if(action==='forgotPassword') return handleForgotPassword(body.login_id);
    // 忘記密碼（電郵一次性重設碼）：同 forgotPassword 一樣係登入前公開入口（閘門之後、token 驗證之前）；
    // 授權完全靠寄到登記電郵嘅一次性重設碼；handler 完全唔讀 token／apikey／自稱身份欄位。
    if(action==='requestPasswordReset') return handleRequestPasswordReset(body);
    if(action==='confirmPasswordReset') return handleConfirmPasswordReset(body);

    // save & addMember 需要 apikey (向下兼容：若無 apikey 但有有效 token 也允許)
    if(action==='save' || action==='addMember' || action==='addUser' || action==='saveOtherBadge'){
      const reqKey=body.apikey;
      if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
      // 操作者身分以 token 為準（api/proxy.js 會替每個請求附上旅團 APIKEY，所以 APIKEY 本身唔可以代表使用者）：
      //   · 帶 token：必須有效，操作者＝該使用者（檢查角色＋allowed_badges），即使同時帶 APIKEY
      //   · 帶無效 token：一律拒絕
      //   · 只有有效 APIKEY、冇 token：系統操作（actor=null，只檢查學制）
      //   · 冇 token 冇 APIKEY：拒絕（舊版會照樣寫入，已修正）
      const keyOk=!!reqKey;
      let tokenUser=null;
      if(body.token){
        const tk=validateToken(body.token);
        if(!tk) return jsonResponse({success:false,error:'Token 無效或過期'});
        if(tk) tokenUser=getUser(tk);
        if(tk && !tokenUser) return jsonResponse({success:false,error:'找不到用戶'});
      }
      if(!keyOk && !tokenUser) return jsonResponse({success:false,error:'未授權 - 需 API Key 或有效 Token'});
      const actor=tokenUser||null;
      if(action==='save') return handleSave(body.changes||[], body.confirmer||'', actor);
      if(action==='addMember'){
        const my=body.token?validateToken(body.token):null;
        let mgr=my?getUser(my):null;
        // 系統路徑：無 token ＋ 有效 APIKEY（批量開戶工具）。帶任何 token 則只以 token 判斷
        if(!mgr && !body.token && body.apikey && body.apikey===getApiKey()) mgr={role:'admin',ymis:'system'};
        if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以新增成員'});
        return handleAddMember(body.ymis, body.name, body.squad||'', body.squad_role||'member');
      }
      if(action==='addUser'){
        const my=body.token?validateToken(body.token):null;
        let mgr=my?getUser(my):null;
        // 系統路徑：無 token ＋ 有效 APIKEY（批量開戶工具）。帶任何 token 則只以 token 判斷
        if(!mgr && !body.token && body.apikey && body.apikey===getApiKey()) mgr={role:'admin',ymis:'system'};
        if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以開新帳號'});
        return handleAddUser(body,mgr);
      }
      if(action==='saveOtherBadge') return handleSaveOtherBadge(body.records||[], actor);
    }
    // member request - needs token but also allow apikey for member self
    if(action==='requestComplete'){
      // allow token or apikey
      let ymis=null; if(body.token){ ymis=validateToken(body.token); if(!ymis) return jsonResponse({success:false,error:'Token 無效或過期'}); }
      if(!ymis && body.apikey && body.apikey===getApiKey()){ ymis=body.ymis; } // 無 token 時才以 APIKEY 代表 body.ymis（standalone）
      if(!ymis) return jsonResponse({success:false,error:'未授權'});
      return handleRequestComplete(body, ymis);
    }

    // 以下需要 token 驗證及高權限
    const ymis=validateToken(body.token);
    if(!ymis) return jsonResponse({success:false,error:'Token 無效或過期'});
    const user=getUser(ymis);
    if(!user) return jsonResponse({success:false,error:'找不到用戶'});

    // ROVERBOOK 對接（GS 5.4.0）：成員手機 ↔ 領袖統管
    //   bookRoster：領袖讀全團進度一覽（零個資）
    //   bookSync  ：上載成員紀錄冊的進度／核簽（個資一律剝走，只寫 SCOUT ID＋項目＋日期）
    //   bookAward ：領袖一次過頒發（可一次多成員多獎章）
    //   bookPull  ：成員只下載「自己」的進度＋頒發＋核簽（身分由 token 決定，唔接受任意 SCOUT ID）
    if(action==='bookRoster') return handleBookRoster(user);
    if(action==='bookSync') return handleBookSync(user, body);
    if(action==='bookConfirm') return handleBookConfirm(user, body);
    if(action==='bookPending') return handleBookPending(user, body);
    if(action==='bookAward') return handleBookAward(user, body);
    if(action==='bookPull') return handleBookPull(user);

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
    if(action==='reviewRequest'){ if(!canTickUser_(user)) return jsonResponse({success:false,error:'權限不足，需領袖權限'}); return handleReviewRequest(body.request_id, body.decision, body.review_note, user, body.confirmed_date); }
    if(action==='setScheme') return handleSetScheme(body, user, ymis);
    if(action==='getOtherBadges'){ return handleGetOtherBadges(body.target_ymis||ymis); }
    if(action==='getApplications'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，需團長/支部領袖'}); return handleGetApplications(); }
    if(action==='reviewApplication'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReviewApplication(body.app_id,body.decision,body.review_note,user); }
    if(action==='getConfig'){
      // 任何已登入用戶都可讀取公開設定
      return handleGetConfig();
    }
    if(action==='getLogRecords') return handleGetLogRecords();
    if(action==='saveLogRecord'){
      if(!canTickUser_(user)) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleSaveLogRecord(body.records||(body.record?[body.record]:[]), ymis, body.recorder_name||'');
    }
    if(action==='deleteLogRecord'){
      if(!canTickUser_(user)) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleDeleteLogRecord(body.record_id, ymis);
    }
    if(action==='getPendingLogRequests') return handleGetPendingLogRequests(user);
    if(action==='submitLogRequest') return handleSubmitLogRequest(body, ymis, user);
    if(action==='reviewLogRequest'){
      if(!canTickUser_(user)) return jsonResponse({success:false,error:'權限不足，需領袖權限'});
      return handleReviewLogRequest(body.request_id, body.decision, ymis, body.review_note);
    }

    // 以下為高權限
    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password,body.token);
    if(action==='resetPassword'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleResetPassword(body.target_ymis,user,body.new_password); }
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
// ===== 登入：單行定位（GS 5.4.0）=====
// 舊版 handleLogin() 係「掃全表逐行驗」，每個 active 帳號都跑一次完整 KDF：
//   錯密碼＝全表 N 次；正確密碼亦要跑到你嗰行先停。排第 3 行之後嘅帳號就爆 proxy 上游 45 秒上限，
//   典型症狀係「管理員／頭幾個帳號入得，其他人全部逾時」。
// 現在改為：先「純文字掃描」（零 KDF）定位到唯一一行，再對該行做「一次」KDF 驗證。
// 掃描成本仍然 O(N)，但只係讀儲存格，唔係 O(N × 10,000 次 HMAC)。
function isActiveStatus_(v){ return String(v===undefined||v===null?'':v).trim()==='active'; }
// 用登入識別字（YMIS／L 編號／電郵）定位 Users 表唯一一行；唔做任何 KDF。
// 回傳 { rowIndex, ymis, email, hash, user } 或 null。
function locateLoginRow_(loginId){
  const key=String(loginId||'').trim();
  if(!key) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  if(data.length<2) return null;
  const hasAllowedCol=sheet.getLastColumn()>=13;
  const lower=key.toLowerCase();
  const build=function(i){
    const row=data[i];
    const rEmail=String(row[2]||'').trim();
    return {
      rowIndex:i+1,
      ymis:String(row[0]===undefined||row[0]===null?'':row[0]).trim(),
      email:rEmail,
      role:String(row[3]||'member'),
      hash:String(row[4]===undefined||row[4]===null?'':row[4]),
      active:isActiveStatus_(row[11]),
      forceChange:(row.length>=FORCE_CHANGE_COL && isForceChangeValue(row[FORCE_CHANGE_COL-1])),
      user:{
        ymis:String(row[0]===undefined||row[0]===null?'':row[0]).trim(),
        name:row[1]?String(row[1]):'',
        email:rEmail,
        role:String(row[3]||'member'),
        can_tick:row[6]===true||row[6]==='TRUE',
        branch:row[5]?String(row[5]):'',
        squad:row[5]?String(row[5]):'',
        squad_role:'member',
        allowed_badges:hasAllowedCol?(row[12]?String(row[12]):''):'',
        status:'active',
        force_change_password:(row.length>=FORCE_CHANGE_COL && isForceChangeValue(row[FORCE_CHANGE_COL-1]))
      }
    };
  };
  // 一次掃描，同時記住「YMIS 命中」與「電郵命中」；YMIS 優先（同 getUser/getUserByEmail 的既有次序一致）
  // SCOUT ID 正規化（2026-11-05）：`81420` ⇄ `0000081420` 要當同一個人。
  // 只影響「比對」，Sheet 內原有寫法同資料一律不變。
  const keyNorm=scoutNorm_(key);
  const keyAliases=scoutAliases_(key);
  let byId=-1, byEmail=-1;
  for(let i=1;i<data.length;i++){
    if(isLegacySuperRow_(data[i])) continue; // 舊版殘留 super_admin 列不可作為登入身分（保留不刪）
    const rowY=String(data[i][0]===undefined||data[i][0]===null?'':data[i][0]).trim();
    const rowE=String(data[i][2]||'').trim().toLowerCase();
    if(byId<0 && rowY && (rowY===key || (keyNorm && scoutNorm_(rowY)===keyNorm))) byId=i;
    if(byEmail<0 && rowE && rowE===lower) byEmail=i;
    if(byId>=0 && byEmail>=0) break;
  }
  void keyAliases;
  const idx=byId>=0?byId:byEmail;
  if(idx<0) return null;
  return build(idx);
}
function handleLogin(loginId,password,superTicket){
  if(!loginId||(!password&&!superTicket)) return jsonResponse({success:false,error:'請填寫帳號和密碼'});
  if(isSuperAdminId(loginId)){
    if(!verifySuperTicket(superTicket)) return jsonResponse({success:false,error:'帳號或密碼錯誤'});
    const token=createToken(SUPER_ADMIN_ID);
    return jsonResponse({success:true,token:token,user:{ymis:SUPER_ADMIN_ID,name:SUPER_ADMIN_NAME,email:SUPER_ADMIN_EMAIL,role:'super_admin',can_tick:true,branch:'',squad:'',squad_role:'member',allowed_badges:'*',status:'active'},force_change_password:false});
  }
  const loginT0=Date.now();
  const found=locateLoginRow_(loginId);
  // A17 防枚舉：找不到帳號（或帳號已停用）與密碼錯誤回同一訊息；另燒一次 dummy KDF 令時序一致
  if(!found || !found.active){
    const ms=burnDummyKdf_(password);
    logSlowLogin_('login', ms, found && found.ymis);
    return jsonResponse({success:false,error:'帳號或密碼錯誤'});
  }
  // A5 失敗鎖定：同一帳號 5 次失敗鎖 15 分鐘（ScriptProperties 記錄；鎖定中回同一訊息，唔洩漏帳號存在）
  const loginProps=PropertiesService.getScriptProperties();
  const failKey='LOGIN_FAIL:'+found.ymis;
  let failRec=null; try{ failRec=JSON.parse(loginProps.getProperty(failKey)||'null'); }catch(e){}
  if(failRec && Number(failRec.until||0)>Date.now()){
    const ms=burnDummyKdf_(password); // 鎖定中亦要保持同一時序，唔可以「快回」洩漏帳號存在
    logSlowLogin_('login', ms, found.ymis);
    return jsonResponse({success:false,error:'帳號或密碼錯誤'});
  }
  // 只對「已定位嘅呢一行」做一次 KDF（本版最重要嘅修正）
  const kdfStart=Date.now();
  const ok=verifyPassword(password, found.hash);
  const kdfMs=Date.now()-kdfStart;
  logSlowLogin_('login', Date.now()-loginT0, found.ymis, kdfMs);
  const sheet=getSheet().getSheetByName('Users');
  if(ok){
    try{ loginProps.deleteProperty(failKey); }catch(e){}
    const token=createToken(found.ymis);
    try{ sheet.getRange(found.rowIndex,11).setValue(now()); }catch(e){}
    // 強制改密：旗標為 TRUE，或「已驗證成功嘅明文密碼」本身就係預設密碼。
    // GS 5.4.0：唔再為咗判斷預設密碼而額外跑一次 KDF —— 呢個密碼剛剛已經驗證過，
    //           字串比對就係同等資訊（舊版會令成功登入變成 2× KDF，直接撞爆上游上限）。
    const forceChange=found.forceChange || isDefaultPassword_(password);
    // 透明升級：舊 64-hex 或舊迭代次數（例如 pbkdf2$120000$）→ 成功登入後改寫為本版格式（密碼不變）。
    // 只會喺登入成功後做，且升級後同一密碼照樣可登入；失敗時靜靜保留原雜湊（下次登入再試）。
    if(needsPasswordRehash_(found.hash)){
      try{ sheet.getRange(found.rowIndex,5).setValue(hashPasswordV2(password)); }catch(e){}
    }
    return jsonResponse({success:true,token:token,user:found.user,force_change_password:forceChange});
  }
  // 密碼錯誤：計次，達上限即鎖定並寫審計（對外統一回「帳號或密碼錯誤」）
  const f=((failRec&&Number(failRec.f))||0)+1;
  try{
    loginProps.setProperty(failKey, JSON.stringify({f:f, until: f>=LOGIN_MAX_FAILS ? Date.now()+LOGIN_LOCK_MS : 0}));
    if(f>=LOGIN_MAX_FAILS) writeAudit('system','login_locked', found.ymis, '連續 '+LOGIN_MAX_FAILS+' 次登入失敗，鎖定 15 分鐘');
  }catch(e){}
  return jsonResponse({success:false,error:'帳號或密碼錯誤'});
}
// 慢登入觀測：只在超過 8 秒時寫一行執行紀錄（唔含密碼、唔寫入任何工作表）。
// Vercel 端（api/proxy.js）另有 slow_password_kdf log；兩邊對照即可分辨「邊個旅團 / 邊條路徑慢」。
const SLOW_LOGIN_MS = 8000;
function logSlowLogin_(action, ms, who, kdfMs){
  if(!(ms>=SLOW_LOGIN_MS)) return;
  try{
    Logger.log('slow_password_kdf action='+String(action||'')+' duration='+ms+'ms'+
      (typeof kdfMs==='number'?(' kdf='+kdfMs+'ms'):'')+
      ' iterations='+PBKDF2_ITERATIONS+(who?(' user='+String(who).slice(0,20)):''));
    console.warn('慢登入／慢密碼操作：action='+String(action||'')+' duration='+ms+'ms；請確認本旅團 GS 已更新至 5.4.0（PBKDF2 '+PBKDF2_ITERATIONS+' 次）');
  }catch(e){}
}
function handleChangePassword(ymis,oldP,newP,keepToken){
  // 錯誤訊息刻意不含任何帳號／密碼資訊
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'系統管理員密碼不能由此更改'});
  if(!newP || newP.toString().length<4) return jsonResponse({success:false,error:'新密碼至少4位'});
  if(String(newP)===String(oldP||'')) return jsonResponse({success:false,error:'新密碼不可與原密碼相同'});
  // GS 5.4.0：先用純文字掃描定位（零 KDF），只對該行驗一次舊密碼，唔好逐行跑 KDF
  const target=locateLoginRow_(ymis);
  if(!target || !target.active) return jsonResponse({success:false,error:'原密碼錯誤'});
  const chgT0=Date.now();
  if(verifyPassword(oldP, target.hash)){
    logSlowLogin_('changePassword', Date.now()-chgT0, target.ymis);
    const sheet=getSheet().getSheetByName('Users');
    sheet.getRange(target.rowIndex,5).setValue(hashPasswordV2(newP));
    ensureForceChangeCol(sheet);
    sheet.getRange(target.rowIndex,FORCE_CHANGE_COL).setValue(false);
    // A5：改密碼後踢走該用戶其他所有 session（保留當前 token）
    try{ destroyUserTokensExcept(ymis, keepToken); }catch(e){}
    return jsonResponse({success:true});
  }
  logSlowLogin_('changePassword', Date.now()-chgT0, target.ymis);
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
    sheet.getRange(rowIndex,9).setValue(sheetActor(reviewerYmis));
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
  const allowedBadges = finalRole==='member' ? '' : (finalRole==='exec_committee' ? 'L1,OTHER' : '*');
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success:false,error:'找不到 Users 工作表'});
  ensureForceChangeCol(uSheet);
  const nowStr=now();
  uSheet.appendRow([ymis,appName,appEmail,finalRole,hashPasswordV2(password),branchVal,isLeaderFinal,sheetActor(reviewerYmis),nowStr,nowStr,'','active',allowedBadges,true]);
  const mSheet=getSheet().getSheetByName('成員名單');
  if(mSheet){
    const mRow=memberNameRowExists_(ymis);
    if(mRow) mSheet.getRange(mRow.row,2).setValue(appName);
    else mSheet.appendRow([ymis,appName,new Date(),branchVal,appEmail]);
  }
  sheet.getRange(rowIndex,7).setValue('approved');
  sheet.getRange(rowIndex,9).setValue(sheetActor(reviewerYmis));
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
      sheet.getRange(i+1,8).setValue(sheetActor(managerYmis));
      sheet.getRange(i+1,9).setValue(now());
      // 處理細緻權限：若提供 allowedBadges，寫入第13欄
      if(sheet.getLastColumn()>=13){
        if(allowedBadges!==undefined && allowedBadges!==null){
          sheet.getRange(i+1,13).setValue(allowedBadges);
        } else {
          // 默認：領袖全部 (*)，成員無，執委默認 L1,OTHER（與 data/items.json permissionDefaults 一致）
          if(!data[i][12]){
            let def='*';
            if(newRole==='member') def='';
            else if(newRole==='exec_committee') def='L1,OTHER';
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
  // ---- 進度：key 一律用正規化 SCOUT ID（81420 ⇄ 0000081420），避免同一人兩份 ----
  const pSheet=ss.getSheetByName('進度追蹤'); const progress={};
  if(pSheet){
    const data=pSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const sid=scoutNorm_(data[i][0]); if(!sid) continue;
      const itemId=String(data[i][1]||'').trim(); if(!itemId) continue;
      if(!progress[sid]) progress[sid]={};
      progress[sid][itemId]={date:data[i][2]?formatDate(data[i][2]):'',confirmer:data[i][4]?data[i][4].toString():''};
    }
  }
  // 簡化版：同時提供 flat
  const flat={}; for(const y in progress){ flat[y]={}; for(const k in progress[y]){ flat[y][k]=progress[y][k].date; } }
  // ---- 其他獎章 ----
  const oSheet=ss.getSheetByName('其他獎章'); const other={};
  if(oSheet){
    const data=oSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const y=scoutNorm_(data[i][0]); if(!y) continue;
      if(!other[y]) other[y]={};
      other[y][data[i][1].toString()]={date:data[i][3]?formatDate(data[i][3]):''};
    }
  }
  // ---- 待批申請（待批完成＋紀錄冊待批）----
  const prSheet=ss.getSheetByName('待批完成'); const pending=[];
  if(prSheet){ const data=prSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(String(data[i][7]||'').trim()==='pending'){ pending.push({request_id:data[i][0].toString(),ymis:scoutNorm_(data[i][1]),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  if(typeof bookPendingRows_==='function'){
    bookPendingRows_().forEach(function(r){
      if(r.status!==BOOK_PENDING_STATUS.PENDING) return;
      pending.push({request_id:r.pendingId,ymis:scoutNorm_(r.scoutId),item_id:r.itemId,item_name:r.itemId,requested_date:r.date,evidence:'',status:'pending',created_at:r.submittedAt,source:'ROVERBOOK'});
    });
  }
  // ---- 成員名單 ----
  // ★ ROVERBOOK 兼容（2026-11-05）：BOOK 的伺服器端係「先喺 members 搵到本人，再讀 me.progress／
  //   me.flatProgress／me.otherBadges／me.pendingRequests」。所以每個成員都要帶埋自己嗰份進度，
  //   否則 BOOK 端會攞到空白進度（明明有紀錄都顯示冇）。
  //   同時保留 name 供本系統前端使用；ROVERBOOK 端自己會剝（零個資由佢負責）。
  //   如果 BOOK 之後改為讀頂層 progress，呢個結構一樣通（兩邊都通）。
  // 頒發（只認 L1–L6 獎章）先一次過讀，避免每人掃一次 Sheet
  const awardByScout={};
  (function(){ const aSheet=ss.getSheetByName(BOOK_AWARD_SHEET); if(!aSheet) return;
    const d=aSheet.getDataRange().getValues();
    for(let i=1;i<d.length;i++){
      const sid=scoutNorm_(d[i][0]); const bid=String(d[i][1]||'');
      if(!sid || !/^L\d$/.test(bid)) continue;
      if(!awardByScout[sid]) awardByScout[sid]={};
      awardByScout[sid][bid]=formatDate(d[i][2]);
    }
  })();
  const members=(typeof getMembers==='function'?getMembers():[]).map(function(m){
    const sid=scoutNorm_(m.ymis);
    const mine=Object.assign({}, progress[sid]||{});
    const flatMine={}; Object.keys(mine).forEach(function(k){ flatMine[k]=mine[k].date; });
    return {
      ymis: sid, scoutId: sid, memberNo: sid,
      name: m.name||'', squad: m.squad||'',
      progress: mine, flatProgress: flatMine,
      badges: awardByScout[sid]||{},
      otherBadges: other[sid]||{},
      pendingRequests: pending.filter(function(p){ return scoutNorm_(p.ymis)===sid; })
        .map(function(p){ return {itemId:p.item_id, date:p.requested_date, status:'pending'}; })
    };
  });
  const lSheet=ss.getSheetByName(LOG_SHEET_NAME);
  const gsInfo=gsVersionInfo_();
  return jsonResponse({success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other,logs:getLogRecordsList(),logsSupported:!!lSheet,schemes:schemeMap_(),schemeDefault:SCHEME_DEFAULT_,gsVersion:gsInfo.gsVersion,gsReleaseDate:gsInfo.gsReleaseDate,initRequired:gsInfo.initRequired,initializedGsVersion:gsInfo.initializedGsVersion});
}
// 進度寫入（整批檢查後才寫）。actor：token 使用者（檢查角色＋allowed_badges）；null ＝ API Key 系統
function handleSave(changes, confirmer, actor){
  confirmer=sheetActor(confirmer);
  const list=Array.isArray(changes)?changes:[];
  const err=checkTickBatch_(list.map(function(c){ return {ymis:c&&c.ymis, itemId:c&&c.itemId}; }), actor||null);
  if(err) return jsonResponse({success:false,error:err,processed:0});
  const sheet=getSheet().getSheetByName('進度追蹤'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  let processed=0;
  list.forEach(function(c){
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
  ymis=scoutNorm_(ymis); name=safeSheetText(name,100); squad=safeSheetText(squad,100);
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'不能新增系統管理員帳號'});
  // SCOUT ID：接受 1–10 位數字（81420 → 0000081420），一律以 10 位正規化值儲存
  if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'SCOUT ID（YMIS）須為 10 位數字'});
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
  const b=body||{};
  // 項目代號：接受 item_id（BOOK 契約）或 itemId（本系統前端）；兩者都必須通過同一套目錄／學制檢查
  const itemId=String(b.item_id||b.itemId||'').trim();
  const err=checkTickBatch_([{ymis:requesterYmis, itemId:itemId}], null);
  if(err) return jsonResponse({success:false,error:err});
  const reqId='REQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  const user=getUser(requesterYmis)||{name:b.name||requesterYmis};
  // 證據欄位：BOOK 唔應該上傳個資（相片／簽名），只留短文字；長度上限 200，非字串一律空白
  const evidence=typeof b.evidence==='string'?b.evidence.trim().slice(0,200):'';
  sheet.appendRow([reqId,requesterYmis,user.name||b.name||requesterYmis,itemId,String(b.item_name||b.itemName||itemId).slice(0,80),String(b.requested_date||b.date||'').slice(0,20)||formatDate(new Date()),evidence,'pending',now(),'','','', '']);
  // 回傳同時帶 `id`／`date`：ROVERBOOK 的 submitPending 會逐項記錄結果（itemId／date／ok／status）
  return jsonResponse({
    success:true, request_id:reqId, status:'pending',
    scoutId:scoutNorm_(requesterYmis),
    item_id:itemId, id:itemId,
    date:String(b.requested_date||b.date||'').slice(0,20)
  });
}
function handleGetPendingRequests(){
  const sheet=getSheet().getSheetByName('待批完成'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ list.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  return jsonResponse({success:true,requests:list});
}
// reviewer 必須是操作者物件（role／allowed_badges）；審批等同勾選，須通過同一套範圍檢查
function handleReviewRequest(reqId,decision,note,reviewer,confirmed_date){
  if(!reviewer || typeof reviewer!=='object') return jsonResponse({success:false,error:'審批需領袖身分'});
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const data=sheet.getDataRange().getValues(); let row=null, rowIdx=-1;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===reqId){ row=data[i]; rowIdx=i; break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  const err=checkTickBatch_([{ymis:row[1].toString(), itemId:row[3].toString()}], reviewer);
  if(err) return jsonResponse({success:false,error:err});
  sheet.getRange(rowIdx+1,8).setValue(decision); sheet.getRange(rowIdx+1,10).setValue(sheetActor(reviewer.ymis)); sheet.getRange(rowIdx+1,11).setValue(now()); sheet.getRange(rowIdx+1,12).setValue(note||''); sheet.getRange(rowIdx+1,13).setValue(confirmed_date||formatDate(new Date()));
  if(decision==='approved'){
    const pSheet=getSheet().getSheetByName('進度追蹤');
    pSheet.appendRow([row[1],row[3],confirmed_date||row[5],new Date(),sheetActor(reviewer.ymis), '由申請轉入：'+(note||'')]);
    return jsonResponse({success:true,message:'已批准並寫入進度'});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleGetOtherBadges(ymis){
  const sheet=getSheet().getSheetByName('其他獎章'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0].toString()===ymis){ list.push({id:data[i][1].toString(),name:data[i][2].toString(),date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}); } } }
  return jsonResponse({success:true,other:list});
}
function handleSaveOtherBadge(records, actor){
  const list=Array.isArray(records)?records:[];
  for(let i=0;i<list.length;i++){
    const cat=catalogEntry_(list[i]&&list[i].badgeId);
    if(!cat || !cat.o) return jsonResponse({success:false,error:'不是其他獎章（OT-*）ID：'+((list[i]&&list[i].badgeId)||'')});
  }
  const err=checkTickBatch_(list.map(function(r){ return {ymis:r&&r.ymis, itemId:r&&r.badgeId}; }), actor||null);
  if(err) return jsonResponse({success:false,error:err,processed:0});
  const sheet=getSheet().getSheetByName('其他獎章'); if(!sheet) return jsonResponse({success:false,error:'Sheet missing'});
  let c=0;
  list.forEach(function(r){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){ if(data[i][0].toString()===r.ymis && data[i][1].toString()===r.badgeId){ sheet.getRange(i+1,3).setValue(r.date); sheet.getRange(i+1,4).setValue(r.cert||''); sheet.getRange(i+1,5).setValue(r.note||''); sheet.getRange(i+1,6).setValue(new Date()); found=true; c++; break; } }
    if(!found){ sheet.appendRow([r.ymis,r.badgeId,r.name||r.badgeId,r.date,r.cert||'',r.note||'',new Date()]); c++; }
  });
  return jsonResponse({success:true,processed:c});
}

// 寫入操作紀錄 (若無 audit 表則自動建)
// 保留帳號做嘅任何工作表／紀錄寫入一律以中性「system」現身：
// 唔落帳號識別字、唔落電郵、唔落顯示名稱（工作表層面完全睇唔到中央帳號存在過）
function sheetActor(ymis){
  const v=String(ymis||'').trim();
  if(!v) return '';
  return (isSuperAdminId(v)||v===String(SUPER_ADMIN_NAME).trim())?'system':v;
}
function writeAudit(actor,action,target,detail){
  try{
    const ss=getSheet();
    let sh=ss.getSheetByName('操作紀錄');
    if(!sh){ sh=ss.insertSheet('操作紀錄'); sh.appendRow(['時間','操作者','操作','對象','詳情']); sh.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF'); sh.setFrozenRows(1); }
    const who=sheetActor(actor);
    sh.appendRow([now(),who,action||'',target||'',detail||'']);
  }catch(e){ console.warn('writeAudit failed',e); }
}
function handleResetPassword(targetYmis,managerRef,newPassword){
  try{
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    if(!targetYmis) return jsonResponse({success:false,error:'請提供目標 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能重設系統管理員密碼'});
    // 權限主體：接受已驗證的管理員物件（token 入口／上游簽章入口），或 YMIS 字串（舊呼叫方式）
    const mgr=(managerRef && typeof managerRef==='object') ? managerRef : getUser(String(managerRef||''));
    if(!mgr || !mgr.ymis) return jsonResponse({success:false,error:'未授權'});
    if(getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'權限不足'});
    const managerYmis=String(mgr.ymis);
    if(String(targetYmis)===managerYmis) return jsonResponse({success:false,error:'不能重設自己的密碼，請聯絡其他管理員'});
    const custom=(newPassword!==undefined && newPassword!==null && String(newPassword).length>0) ? String(newPassword) : '';
    if(custom && custom.length<4) return jsonResponse({success:false,error:'新密碼至少4位'});
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(targetYmis)){
        // 授權（前後端一致）：只可重設自己管得到的角色。
        // admin 不可重設 admin（只有 super_admin 可以）；高權限可重設低權限（低權限帳號本就由其上級批核／可停用）。
        const targetRole=String(data[i][3]||'member');
        if(targetRole==='super_admin' || isSuperAdminId(String(data[i][0]))) return jsonResponse({success:false,error:'不能重設系統管理員密碼'});
        if(!canManageUser(mgr,targetRole)) return jsonResponse({success:false,error:'權限不足，不能重設該角色密碼'});
        if(custom){
          sh.getRange(i+1,5).setValue(hashPasswordV2(custom));
          ensureForceChangeCol(sh);
          sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
          writeAudit(managerYmis,'set_password',targetYmis,'領袖自設密碼（首次登入須更改）');
          afterPasswordReset_(targetYmis);
          return jsonResponse({success:true,message:'已設定新密碼，請通知用戶首次登入後更改密碼'});
        }
        const temp='Rover'+Math.floor(100000+Math.random()*900000);
        sh.getRange(i+1,5).setValue(hashPasswordV2(temp));
        ensureForceChangeCol(sh);
        sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
        writeAudit(managerYmis,'reset_password',targetYmis,'重設為一次性密碼（已寄出，不留底）');
        afterPasswordReset_(targetYmis);
        return jsonResponse({success:true,temp_password:temp,message:'已重設，請通知用戶首次登入後更改密碼'});
      }
    }
    return jsonResponse({success:false,error:'找不到此 YMIS'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 密碼重設成功後：清走該帳號的登入失敗計數（否則鎖定 15 分鐘內改完密碼仍然登入不到），
// 並踢走該帳號所有舊 session（與電郵自助重設一致；舊裝置即刻失效）。不動管理員自己的 session。
function afterPasswordReset_(targetYmis){
  try{ PropertiesService.getScriptProperties().deleteProperty('LOGIN_FAIL:'+String(targetYmis||'')); }catch(e){}
  try{ destroyUserTokens(targetYmis); }catch(e){}
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
    // A17 防枚舉（舊版 action 保留向後兼容，但回應與新流程一樣中性）：
    // 找不到帳號／未登記電郵／被停用，全部回同一個「成功」訊息，實際只在找到帳號時寄信
    const genericFp='如該帳號已登記電郵，臨時密碼已寄出；如未收到，請聯絡旅團領袖重設密碼';
    if(!user || String(user.status||'active')!=='active') return jsonResponse({success:true,message:genericFp});
    const email=String(user.email||'').trim();
    if(!email) return jsonResponse({success:true,message:genericFp});
    // 輕量節流：同一帳號 60 秒內只可請求一次（防濫發電郵）
    try{
      const props=PropertiesService.getScriptProperties();
      const key='FORGOT_'+user.ymis;
      const last=parseInt(props.getProperty(key)||'0',10)||0;
      if(Date.now()-last<60000) return jsonResponse({success:true,message:genericFp}); // 節流亦回中性訊息（唔洩漏帳戶存在）
      props.setProperty(key,String(Date.now()));
    }catch(e){}
    const temp='Rover'+Math.floor(100000+Math.random()*900000);
    const subject='【樂行童軍進度系統】臨時密碼';
    const bodyText='你好 '+user.name+'：\n\n你於樂行童軍進度追蹤系統申請了自助找回密碼。\n臨時密碼：'+temp+'\n\n請盡快登入，系統會要求你設定新密碼（至少4位）。\n如非本人操作，請聯絡你的旅團領袖。\n\n— 樂行童軍進度追蹤系統';
    // 先寄信、後改密碼：寄信失敗則密碼不變，用戶仍可用舊密碼
    try{
      MailApp.sendEmail(email,subject,bodyText);
    }catch(e){
      // 寄信失敗都回中性訊息（唔洩漏帳戶存在）；失敗只記審計，領袖可由選單旗標排查
      try{ writeAudit(user.ymis,'forgot_password_mail_failed',user.ymis,'自助找回密碼郵件發送失敗'); }catch(e2){}
      return jsonResponse({success:true,message:genericFp});
    }
    const sh=getSheet().getSheetByName('Users');
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(user.ymis) && String(data[i][11])==='active'){
        sh.getRange(i+1,5).setValue(hashPasswordV2(temp));
        ensureForceChangeCol(sh);
        sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
        break;
      }
    }
    try{ writeAudit(user.ymis,'forgot_password',user.ymis,'自助找回密碼（電郵已寄出）'); }catch(e){}
    // 唔回 email_hint：連遮罩電郵都會向請求人確認「帳戶存在」，一律中性
    return jsonResponse({success:true,message:genericFp});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// ===== 登入前「忘記密碼」：電郵一次性重設碼（自助，唔經管理員）=====
// 安全合約：
//   ① 公開入口唔等於無授權 —— 授權 = 寄到 Users 表登記電郵嘅一次性重設碼。
//   ② 重設碼只存 SHA-256 雜湊；15 分鐘到期；最多 5 次嘗試；一次性；新申請即刻作廢舊碼。
//   ③ 無論帳戶存唔存在，回應一律一致（唔俾人用呢個入口探測邊個 YMIS／電郵有帳號）；
//      電郵發送失敗亦只記全團旗標 + log，唔改回應。
//   ④ 只受理「啟用中＋已登記電郵＋已設密碼」嘅普通帳戶；保留帳號、舊版殘留 super_admin 列、
//      停用帳號一律唔受理。
//   ⑤ 成功後該用戶所有舊 session token 即刻失效，並寫一條唔含密碼／重設碼嘅操作紀錄。
//   ⑥ 兩個 action 完全唔讀 request 自帶嘅 token／apikey／角色等欄位（api/proxy.js 亦會主動剷走）。
const PWD_RESET_SHEET = '密碼重設';
const PWD_RESET_HEADERS = ['reset_id','ymis','email','code_hash','created_ms','expires_ms','attempts','status','used_at'];
const PWD_RESET_COLS = {reset_id:0,ymis:1,email:2,code_hash:3,created_ms:4,expires_ms:5,attempts:6,status:7,used_at:8};
const PWD_RESET_TTL_MS = 15*60*1000;
const PWD_RESET_MAX_ATTEMPTS = 5;
const PWD_RESET_EMAIL_WINDOW_MS = 30*60*1000;
const PWD_RESET_MAX_PER_EMAIL = 3;
const PWD_RESET_GLOBAL_WINDOW_MS = 60*60*1000;
const PWD_RESET_MAX_GLOBAL = 30;
const PWD_RESET_KEEP_MS = 24*60*60*1000;
// 發信失敗（例如換 Code.gs 後未重新授權 MailApp「傳送電郵」範圍）記一個全團旗標：
// 所有請求一律回同一個 delivery 狀態，前端可以老實提示「請聯絡領袖」，同時唔會洩漏邊個電郵係有效帳戶。
const PWD_RESET_MAIL_FLAG = 'PWD_RESET_MAIL_ERROR';

function normalizeResetEmail(v){ return String(v===undefined||v===null?'':v).trim().toLowerCase().substring(0,120); }
function normalizeResetCode(v){ return String(v===undefined||v===null?'':v).toUpperCase().replace(/[^0-9A-Z]/g,'').substring(0,16); }
// 電郵會寫入工作表：同 safeSheetText 一樣，唔接受以 = + - @ 開頭，避免儲存格變成算式。
function validResetEmail(email){
  return !!email && email.length<=120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^[=+\-@]/.test(email);
}
// 以 YMIS 或電郵搵帳戶（跳過舊版殘留 super_admin 列；只回啟用中帳戶）
function findResetUser_(loginId){
  const v=String(loginId||'').trim();
  if(!v || isSuperAdminId(v)) return null;
  const sh=getSheet().getSheetByName('Users'); if(!sh) return null;
  const data=sh.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(isLegacySuperRow_(data[i])) continue;
    const y=String(data[i][0]||'').trim(), em=String(data[i][2]||'').trim();
    const isEmailInput=v.indexOf('@')>=0;
    const match=isEmailInput ? em.toLowerCase()===v.toLowerCase() : (y===v || em.toLowerCase()===v.toLowerCase());
    if(match && String(data[i][11]||'').trim()==='active'){
      return {rowIndex:i+1, ymis:y, email:em, role:String(data[i][3]||''), status:String(data[i][11]||''), hasPassword:!!String(data[i][4]||'').trim()};
    }
  }
  return null;
}
function findResetUserByYmis_(ymis){
  return findResetUser_(String(ymis||''));
}
// 限速／查表一律用呢個 key：有帳戶就用登記電郵，冇帳戶就用輸入本身（加前綴避免撞到電郵格式）
function resolveResetKey_(loginId){
  const u=findResetUser_(loginId);
  if(u && u.email) return normalizeResetEmail(u.email);
  const v=normalizeResetEmail(loginId);
  return v.indexOf('@')>=0 ? v : ('ymis:'+v);
}
function getPasswordResetSheet(){
  const ss=getSheet(); if(!ss) return null;
  let sh=ss.getSheetByName(PWD_RESET_SHEET);
  if(!sh){
    // 舊 Sheet 冇呢張表都唔使重跑 initializeSheets()：第一次用「忘記密碼」就自動補建
    // （只加空白表，唔郁任何現有資料、帳號或 API Key）。
    sh=ss.insertSheet(PWD_RESET_SHEET);
    sh.appendRow(PWD_RESET_HEADERS);
    sh.getRange(1,1,1,PWD_RESET_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}
function passwordResetTable(){
  const sheet=getPasswordResetSheet(); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  const headers=(data[0]||[]).map(function(h){ return String(h===undefined||h===null?'':h).trim().toLowerCase(); });
  const col={};
  Object.keys(PWD_RESET_COLS).forEach(function(k){ const i=headers.indexOf(k); col[k]=i>=0?i:PWD_RESET_COLS[k]; });
  const rows=[];
  for(let r=1;r<data.length;r++){
    const d=data[r];
    rows.push({rowIndex:r+1,
      reset_id:String(d[col.reset_id]||''), ymis:String(d[col.ymis]||''),
      email:String(d[col.email]||'').toLowerCase(), code_hash:String(d[col.code_hash]||''),
      created_ms:Number(d[col.created_ms]||0), expires_ms:Number(d[col.expires_ms]||0),
      attempts:Number(d[col.attempts]||0), status:String(d[col.status]||''),
      used_at:String(d[col.used_at]||'')});
  }
  return {sheet:sheet,col:col,data:data,rows:rows};
}
function passwordResetSetCell(t,row,name,value){
  t.sheet.getRange(row.rowIndex,t.col[name]+1).setValue(value);
  row[name]=value;
}
function passwordResetRateLimit(t,key,nowMs){
  let perKey=0, globalCount=0;
  for(let i=0;i<t.rows.length;i++){
    const r=t.rows[i];
    if(r.created_ms>nowMs-PWD_RESET_GLOBAL_WINDOW_MS) globalCount++;
    if(r.email===key && r.created_ms>nowMs-PWD_RESET_EMAIL_WINDOW_MS) perKey++;
  }
  if(perKey>=PWD_RESET_MAX_PER_EMAIL || globalCount>=PWD_RESET_MAX_GLOBAL)
    return '請求過於頻密，請稍後再試（約 30 分鐘後）';
  return '';
}
function prunePasswordResets(t,nowMs){
  // 公開入口唔可以俾人無限填表：清走 24 小時前嘅列（由底向上刪，索引唔會錯）。
  for(let i=t.data.length-1;i>=1;i--){
    const r=t.rows[i-1]; if(!r) continue;
    if(r.created_ms && r.created_ms<nowMs-PWD_RESET_KEEP_MS) t.sheet.deleteRow(i+1);
  }
}
function generateResetCode(){
  return (Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'').toUpperCase().substring(0,8);
}
function sendPasswordResetEmail(email,code){
  const display=code.substring(0,4)+'-'+code.substring(4);
  const subject='【樂行童軍進度追蹤】忘記密碼重設碼 / Password reset code';
  const bodyText=[
    '樂行童軍進度追蹤系統',
    '',
    '我哋收到「忘記密碼」申請。請返到登入頁撳「🔑 忘記密碼」，輸入以下重設碼並設定新密碼（至少 4 位）。',
    'We received a "forgot password" request. On the sign-in page choose "🔑 Forgot password", enter the code below and set a new password (at least 4 characters).',
    '',
    '重設碼 / Reset code：'+display,
    '有效時間 / Valid for：15 分鐘 / 15 minutes',
    '',
    '如非你本人申請，請忽略呢封電郵，密碼唔會改變；請勿將重設碼轉發畀任何人。',
    'If you did not request this, ignore this email and never share the code.',
    '',
    '收唔到或已過期？可重新申請（新碼會作廢舊碼），或聯絡旅團領袖喺「用戶管理」重設密碼。',
    'No email or expired? Request a new code, or ask your troop leader to reset it in User Management.',
    '',
    '（此電郵由旅團 Google Apps Script 自動發出，請勿回覆 / Do not reply）'
  ].join('\n');
  MailApp.sendEmail(email,subject,bodyText);
}
function handleRequestPasswordReset(body){
  body=body||{};
  const loginId=String(body.login_id||body.email||'').trim().substring(0,120);
  if(!loginId) return jsonResponse({success:false,error:'請填寫 YMIS 或登記電郵'});
  const key=resolveResetKey_(loginId);
  if(key.indexOf('@')>=0 && !validResetEmail(key))
    return jsonResponse({success:false,error:'請輸入有效的登記電郵 / Please enter a valid email'});
  const nowMs=Date.now();
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(8000)) return jsonResponse({success:false,error:'系統繁忙，請稍後再試'});
  try{
    const t=passwordResetTable();
    if(!t) return jsonResponse({success:false,error:'系統尚未初始化'});
    const rate=passwordResetRateLimit(t,key,nowMs);
    if(rate) return jsonResponse({success:false,error:rate});
    prunePasswordResets(t,nowMs);
    // 新申請一律取代同一 key 先前未用嘅碼：任何時間一個帳戶只得一組有效碼。
    for(let i=0;i<t.rows.length;i++){
      const r=t.rows[i];
      if(r.email===key && r.status==='pending') passwordResetSetCell(t,r,'status','superseded');
    }
    const user=findResetUser_(loginId);
    const email=user ? normalizeResetEmail(user.email) : '';
    const eligible=!!user && !!email && user.hasPassword && user.role!=='super_admin' && !isSuperAdminId(user.ymis);
    const code=eligible?generateResetCode():'';
    const resetId='PWR_'+nowMs+'_'+Utilities.getUuid().replace(/-/g,'').substring(0,8);
    // 無合資格帳戶照記一列（唔寄信、唔存碼），令限速對所有輸入一致，亦唔透露帳戶是否存在。
    t.sheet.appendRow([resetId,eligible?String(user.ymis):'',key,code?hashPassword(code):'',
      nowMs,nowMs+PWD_RESET_TTL_MS,0,eligible?'pending':'no_account','']);
    if(eligible){
      try{
        sendPasswordResetEmail(email,code);
        try{ linkProps().deleteProperty(PWD_RESET_MAIL_FLAG); }catch(e2){}
      }catch(e){
        Logger.log('password reset email failed: '+e);
        try{ linkProps().setProperty(PWD_RESET_MAIL_FLAG,String(nowMs)); }catch(e2){}
      }
    }
    // 所有情況回同一句：唔俾人用回應探測帳戶是否存在。
    let mailError='';
    try{ mailError=String(linkProps().getProperty(PWD_RESET_MAIL_FLAG)||''); }catch(e){}
    return jsonResponse({success:true,delivery:mailError?'unavailable':'ok',
      message:'若此帳號已登記電郵，重設碼已發送到登記電郵（15 分鐘內有效）'});
  }finally{ try{ lock.releaseLock(); }catch(e){} }
}
// 管理員換 Code.gs 後喺 Apps Script 編輯器執行一次：Google 會要求授權「傳送電郵」範圍，
// 並寄一封測試信俾執行者自己，確認日後重設碼寄得出去。
// 唔寫任何工作表、唔改任何帳號資料、唔係 initializeSheets()。
function testPasswordResetMail(){
  const me=String(Session.getActiveUser().getEmail()||'').trim();
  if(!me) throw new Error('搵唔到執行者電郵，請喺試算表嘅 Apps Script 編輯器執行');
  MailApp.sendEmail(me,'【樂行童軍進度追蹤】忘記密碼發信測試',
    '呢封測試電郵確認本旅團 Apps Script 已取得「傳送電郵」授權，「忘記密碼」重設碼可以正常寄出。\n請勿回覆。');
  try{ linkProps().deleteProperty(PWD_RESET_MAIL_FLAG); }catch(e){}
  return '測試電郵已寄出至 '+me;
}
function handleConfirmPasswordReset(body){
  body=body||{};
  const loginId=String(body.login_id||body.email||'').trim().substring(0,120);
  const code=normalizeResetCode(body.code);
  const newPw=String(body.new_password===undefined||body.new_password===null?'':body.new_password);
  const generic='重設碼不正確或已過期，請重新申請 / Invalid or expired reset code';
  if(!loginId || code.length!==8) return jsonResponse({success:false,error:generic});
  if(!newPw || newPw.length<4) return jsonResponse({success:false,error:'新密碼至少4位'});
  const key=resolveResetKey_(loginId);
  const nowMs=Date.now();
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(8000)) return jsonResponse({success:false,error:'系統繁忙，請稍後再試'});
  try{
    const t=passwordResetTable();
    if(!t) return jsonResponse({success:false,error:'系統尚未初始化'});
    let target=null;
    for(let i=0;i<t.rows.length;i++){
      const r=t.rows[i];
      if(r.email!==key || r.status!=='pending' || !r.code_hash) continue;
      if(r.expires_ms<=nowMs){ passwordResetSetCell(t,r,'status','expired'); continue; }
      if(!target || r.created_ms>target.created_ms) target=r;
    }
    if(!target) return jsonResponse({success:false,error:generic});
    if(target.attempts>=PWD_RESET_MAX_ATTEMPTS){
      passwordResetSetCell(t,target,'status','locked');
      return jsonResponse({success:false,error:generic});
    }
    if(!safeEqualText(sha256Hex(code),target.code_hash)){
      passwordResetSetCell(t,target,'attempts',target.attempts+1);
      if(target.attempts>=PWD_RESET_MAX_ATTEMPTS) passwordResetSetCell(t,target,'status','locked');
      return jsonResponse({success:false,error:generic});
    }
    // 重設碼啱都要再驗一次帳戶狀態：期間被停用／改電郵／變成保留帳號就唔可以改密碼。
    const u=findResetUserByYmis_(target.ymis);
    if(!u || !u.hasPassword || u.role==='super_admin' || isSuperAdminId(u.ymis) || normalizeResetEmail(u.email)!==key){
      passwordResetSetCell(t,target,'status','void');
      return jsonResponse({success:false,error:generic});
    }
    const uSheet=getSheet().getSheetByName('Users');
    uSheet.getRange(u.rowIndex,5).setValue(hashPasswordV2(newPw));
    ensureForceChangeCol(uSheet);
    uSheet.getRange(u.rowIndex,FORCE_CHANGE_COL).setValue(false);
    passwordResetSetCell(t,target,'status','used');
    passwordResetSetCell(t,target,'used_at',now());
    for(let i=0;i<t.rows.length;i++){
      const r=t.rows[i];
      if(r!==target && (r.email===key||r.ymis===target.ymis) && r.status==='pending')
        passwordResetSetCell(t,r,'status','superseded');
    }
    destroyUserTokens(target.ymis);
    writeAudit('system','password_reset_by_email',target.ymis,'以登記電郵重設碼自助重設密碼（不記錄重設碼／密碼）');
    return jsonResponse({success:true,message:'密碼已重設，請用新密碼登入'});
  }finally{ try{ lock.releaseLock(); }catch(e){} }
}
// 密碼重設成功後，該用戶所有舊 session 即刻失效（懷疑密碼外洩時尤其重要）。
function destroyUserTokens(ymis){
  if(!ymis) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--){ if(String(data[i][1]||'')===String(ymis)) sheet.deleteRow(i+1); }
}
// 踢走某用戶全部 session 但保留指定 token（改密碼時保留當前 session；A5：改密碼後其他舊 session 全部失效）
function destroyUserTokensExcept(ymis, keepToken){
  if(!ymis) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--){
    if(String(data[i][1]||'')===String(ymis) && String(data[i][0]||'')!==String(keepToken||'')) sheet.deleteRow(i+1);
  }
}
// 踢走某用戶全部 session，但保留指定 token（改密碼時保留當前 session；A5：改密碼後舊 session 全部失效）
function destroyUserTokensExcept(ymis, keepToken){
  if(!ymis) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--){
    if(String(data[i][1]||'')===String(ymis) && String(data[i][0]||'')!==String(keepToken||'')) sheet.deleteRow(i+1);
  }
}

// 開立可登入帳號
// 上游開戶（createAccountForDownstream）直接用純函數 addUser_；前端／doPost 入口經 handleAddUser 包裝
function handleAddUser(body,mgr){ return jsonResponse(addUser_(body,mgr)); }
function addUser_(body,mgr){
  try{
    // SCOUT ID 正規化：81420 → 0000081420（十位數左補零）。只補零，不會改寫既有紀錄。
    let ymis=scoutNorm_((body.ymis||'').toString().trim());
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
    const pwdHash = hashPasswordV2(password||DEFAULT_PASS);
    const allowedBadges = role==='member' ? '' : (role==='exec_committee' ? 'L1,OTHER' : '*');
    uSheet.appendRow([
      ymis,
      name,
      email,
      role,
      pwdHash,
      squad,
      canTick,
      sheetActor((mgr&&mgr.ymis)||'bulk_onboard'),
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
  const isLeader=canTickUser_(user);
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
  sheet.getRange(rowIndex,15).setValue(sheetActor(reviewer));
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
// ===== ROVERBOOK 對接（GS 5.4.0）=====
// 定位不變：ROVERBADGE 仍然係領袖的統管後端；ROVERBOOK 只係**成員自己擁有**、出外可讀的紀錄冊前端。
// 頒發仍然只由領袖做（bookAward），團集會「有參加就一次過簽」照舊用「全團總覽 → 批量剔」（唔經 BOOK）。
//
// 三條鐵律：
//   ① 成員個人資料只留在成員自己的手機：本節任何函數都唔會接收／回傳／寫入姓名以外嘅個資，
//      即使請求夾帶（phone／email／address／photo／signature…）亦會剝走，只回一張「剝走了甚麼」清單。
//   ② ROVERBADGE 只記進度（SCOUT ID + 項目 ID + 完成日期 + 核簽領袖），方便領袖一次過統管。
//   ③ 頒發（badge award）只由領袖一次過做；成員只收到唯讀結果。
//
// ★ 安全閘（2026-11-05 修正）：成員喺 BOOK 自己簽嘅紀錄**唔可以直接變成 BADGE 的完成進度**。
//   bookSync 只會寫入「紀錄冊待批」（pending），一律唔會寫「進度追蹤」、亦唔會寫「紀錄冊核簽」。
//   領袖要經 bookConfirm 逐項／一次過 CONFIRM，才會寫入正式進度 —— 杜絕「成員自己簽完錄入就扮完成」。
//
// ★ 只加不減（防舊資料回寫）：同一個 (SCOUT ID, 項目) 已經有紀錄時，
//   較早日期只會標為 diff='older'（領袖可以選擇覆寫，因為「可以改」），
//   同一日或較後日期標為 diff='same'／'newer'；重覆提交同一個日期唔會產生第二行。

function bookStripPersonal_(obj, sink) {
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).forEach(function (k) {
    if (BOOK_NEVER_STORE_FIELDS.indexOf(k) >= 0) { if (sink) sink[k] = true; return; }
    const v = obj[k];
    if (v && typeof v === 'object') bookStripPersonal_(v, sink);
  });
}
function bookPrivacyReport_(obj) { const sink = {}; bookStripPersonal_(obj, sink); return { removedFields: Object.keys(sink), removedCount: Object.keys(sink).length }; }
function bookNormDate_(v) {
  const m = String(v === undefined || v === null ? '' : v).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return '';
  const out = m[1] + '-' + ('0' + parseInt(m[2], 10)).slice(-2) + '-' + ('0' + parseInt(m[3], 10)).slice(-2);
  const t = new Date(out + 'T00:00:00Z');
  return (!isNaN(t.getTime()) && t.toISOString().slice(0, 10) === out) ? out : '';
}
function bookScoutId_(v) { return String(v === undefined || v === null ? '' : v).trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32); }
// SCOUT ID 正規化（與 api/roverbook.js scoutNorm() 同一套；2026-11-05 對接規格）：
//   純數字 1–10 位 → 左補 0 到 10 位（81420 ⇄ 0000081420 視為同一人）；其餘（L 開頭內部編號）原樣。
// 只影響「比對」，唔會改寫任何既有 Sheet 資料；不過寫入新紀錄時會存正規化值，避免一人兩份。
function scoutNorm_(v) {
  const raw = bookScoutId_(v);
  if (!raw) return '';
  if (/^\d{1,10}$/.test(raw)) return ('0000000000' + raw).slice(-10);
  return raw;
}
// 回傳「同一個人」在 Sheet 內可能出現的所有寫法（讓舊未補零紀錄都對得上）
function scoutAliases_(v) {
  const norm = scoutNorm_(v);
  const raw = bookScoutId_(v);
  const out = [];
  [norm, raw].forEach(function (x) { if (x && out.indexOf(x) < 0) out.push(x); });
  // 如果 Sheet 上存的是「未補零」的原始數字，亦要對得上
  if (/^\d+$/.test(norm)) {
    const trimmed = norm.replace(/^0+/, '');
    if (trimmed && out.indexOf(trimmed) < 0) out.push(trimmed);
  }
  return out;
}
function scoutMatches_(rowValue, wanted) {
  const v = bookScoutId_(rowValue);
  if (!v) return false;
  const aliases = Array.isArray(wanted) ? wanted : scoutAliases_(wanted);
  return aliases.indexOf(v) >= 0;
}
function bookSheet_(name, headers) {
  const ss = getSheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ---- 正式進度（進度追蹤）：同 (SCOUT ID, 項目) 只保留較後日期 ----
// 回傳 { existing: 'YYYY-MM-DD' | '' }，讓呼叫端知道「本來有冇、係邊日」
function bookProgressDateOf_(sid, itemId) {
  const aliases = scoutAliases_(sid);
  const sh = getSheet().getSheetByName('進度追蹤');
  if (!sh) return '';
  const data = sh.getDataRange().getValues();
  let best = '';
  for (let i = 1; i < data.length; i++) {
    if (!scoutMatches_(data[i][0], aliases)) continue;
    if (String(data[i][1] || '').trim() !== itemId) continue;
    const d = bookNormDate_(data[i][2]);
    if (d && d > best) best = d;
  }
  return best;
}
// 寫入正式進度：只加不減（只可以改日期，唔會移除已完成紀錄）
function bookWriteProgress_(sid, itemId, date, confirmer, note) {
  const aliases = scoutAliases_(sid);
  const sh = getSheet().getSheetByName('進度追蹤');
  if (!sh) return { ok: false, reason: '找不到「進度追蹤」工作表' };
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (!scoutMatches_(data[i][0], aliases)) continue;
    if (String(data[i][1] || '').trim() !== itemId) continue;
    sh.getRange(i + 1, 3).setValue(date);
    sh.getRange(i + 1, 4).setValue(new Date());
    sh.getRange(i + 1, 5).setValue(confirmer || '');
    sh.getRange(i + 1, 6).setValue(note || '');
    return { ok: true, updated: true };
  }
  sh.appendRow([sid, itemId, date, new Date(), confirmer || '', note || '']);
  return { ok: true, updated: false };
}

// ---- 核簽紀錄（由領袖 CONFIRM 之後才寫；成員自己交嘅唔會直接入呢張表）----
function writeBookSignoffs_(items, meta) {
  const sh = bookSheet_(BOOK_SIGNOFF_SHEET, BOOK_SIGNOFF_HEADERS);
  const data = sh.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < data.length; i++) {
    if (!data[i][1] || !data[i][2]) continue;
    index[String(data[i][1]) + '|' + String(data[i][2])] = i + 1;
  }
  const ts = now();
  let written = 0, skipped = 0;
  (items || []).forEach(function (it) {
    const sid = scoutNorm_(it && it.scoutId);
    const itemId = String((it && it.itemId) || '').trim();
    const date = bookNormDate_(it && (it.date || it.verifiedDate));
    if (!sid || !BOOK_ITEM_RE.test(itemId) || !date) { skipped++; return; }
    const leader = safeSheetText((it && (it.leader || it.assessor)) || (meta && meta.leader) || '', 60);
    const title = safeSheetText((it && it.leaderTitle) || (meta && meta.leaderTitle) || '', 40);
    const source = safeSheetText((it && it.source) || (meta && meta.source) || 'ROVERBOOK', 24);
    const note = safeSheetText((it && it.note) || '', 160);
    const key = sid + '|' + itemId;
    if (index[key]) {
      const row = index[key];
      const prevDate = bookNormDate_(data[row - 1][3] || '');
      // 日期只可以向前：舊核簽唔會被較早的日期蓋走
      if (!prevDate || date >= prevDate) sh.getRange(row, 4).setValue(date);
      if (leader) sh.getRange(row, 5).setValue(leader);
      if (title) sh.getRange(row, 6).setValue(title);
      sh.getRange(row, 7).setValue((meta && meta.date) || date);
      sh.getRange(row, 9).setValue(ts);
      if (note) sh.getRange(row, 10).setValue(note);
    } else {
      const signId = 'BS_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      sh.appendRow([signId, sid, itemId, date, leader, title, (meta && meta.date) || date, source, ts, note]);
      index[key] = sh.getLastRow();
    }
    written++;
  });
  return { written: written, skipped: skipped };
}
function writeBookAwards_(awards, actorYmis, confirmRemove) {
  const sh = bookSheet_(BOOK_AWARD_SHEET, BOOK_AWARD_HEADERS);
  const data = sh.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0] || !data[i][1]) continue;
    index[String(data[i][0]) + '|' + String(data[i][1])] = i + 1;
  }
  const ts = now();
  const writer = sheetActor(actorYmis);
  let written = 0, skipped = 0, corrected = 0, removed = 0;
  (awards || []).forEach(function (a) {
    const sid = scoutNorm_(a && (a.scoutId || a.ymis));
    const badge = String((a && (a.badgeId || a.badge)) || '').trim().toUpperCase();
    const date = bookNormDate_(a && (a.date || a.awardDate));
    if (!sid || !/^L\d$/.test(badge) || !date) { skipped++; return; }
    const key = sid + '|' + badge;
    // 撤回（只限領袖、需要 confirm:true；預設唔會誤刪）
    if (a && a.remove === true) {
      if (!confirmRemove) { skipped++; return; }
      if (index[key]) { sh.deleteRow(index[key]); delete index[key]; removed++; } else { skipped++; }
      return;
    }
    if (index[key]) {
      // 已頒發過：預設唔會重複寫、亦唔會改日期；要改日期必須明確 correct:true（領袖更正錯日期）
      const row = index[key];
      const prev = bookNormDate_(data[row - 1][2] || '');
      if (a && a.correct === true && confirmRemove && date !== prev) {
        sh.getRange(row, 3).setValue(date);
        sh.getRange(row, 6).setValue(ts);
        sh.getRange(row, 7).setValue(safeSheetText('更正頒發日期（原 ' + (prev || '空白') + '）' + ((a && a.note) ? '：' + a.note : ''), 160));
        corrected++;
      } else { skipped++; }
      return;
    }
    sh.appendRow([sid, badge, date, writer, safeSheetText((a && a.source) || 'ROVERBADGE', 24), ts, safeSheetText((a && a.note) || '', 160)]);
    index[key] = sh.getLastRow();
    written++;
  });
  return { written: written, skipped: skipped, corrected: corrected, removed: removed };
}

// ---- 待批（成員交上嚟、等領袖 CONFIRM）----
function bookPendingRows_() {
  const sh = getSheet().getSheetByName(BOOK_PENDING_SHEET);
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    out.push({
      row: i + 1,
      pendingId: String(data[i][0] || ''), scoutId: String(data[i][1] || ''), itemId: String(data[i][2] || ''),
      date: bookNormDate_(data[i][3]), source: String(data[i][4] || ''), submittedAt: String(data[i][5] || ''),
      status: String(data[i][6] || ''), diff: String(data[i][7] || ''),
      confirmedDate: bookNormDate_(data[i][8]), confirmer: String(data[i][9] || ''), confirmedAt: String(data[i][10] || ''), note: String(data[i][11] || '')
    });
  }
  return out;
}
// 由 BOOK 傳入嘅每一項判斷「可信度」：只有 verified===true 且來源屬受信清單才算 leader-signed。
// 但仍然只係「BOOK 聲稱」，一樣要入待批（成員部機可以改 JSON）。
const BOOK_TRUSTED_SOURCES_ = ['roverbadge', 'roverbadge/signoff', 'roverbadge.signoff.v2', 'leader'];
function bookTrustOf_(entry) {
  if (!entry || typeof entry !== 'object') return BOOK_TRUST_CLAIM;
  if (entry.verified !== true) return BOOK_TRUST_CLAIM;
  const src = String(entry.source || (entry.verification && entry.verification.source) || '').toLowerCase();
  if (!src) return BOOK_TRUST_CLAIM;
  for (let i = 0; i < BOOK_TRUSTED_SOURCES_.length; i++) {
    if (src.indexOf(BOOK_TRUSTED_SOURCES_[i]) >= 0) return BOOK_TRUST_LEADER;
  }
  return BOOK_TRUST_CLAIM;
}
// 把一份 BOOK 進度寫入「待批」：已存在（pending）或已批准（同日）就唔會再加一行
function stageBookPending_(sid, progress, opts) {
  // opts.verifiedClaims = { itemId: 'leader-signed' | 'member-claim' }（由 trustOf 判斷，缺省 member-claim）
  // 注意：**兩種都一樣入待批**。BOOK 聲稱「領袖已核實」只係方便領袖快速全部確認，
  // 絕對唔會令紀錄自動變成完成（成員部機改一個 JSON 就可以自稱 verified）。

  const o = opts || {};
  const sh = bookSheet_(BOOK_PENDING_SHEET, BOOK_PENDING_HEADERS);
  const existing = {};
  bookPendingRows_().forEach(function (r) {
    existing[r.scoutId + '|' + r.itemId + '|' + r.date + '|' + r.status] = true;
  });
  const ts = now();
  const staged = [], older = [], duplicates = [], skipped = [];
  let stagedCount = 0;
  Object.keys(progress || {}).forEach(function (itemId) {
    const date = bookNormDate_(progress[itemId]);
    const id = String(itemId || '').trim();
    if (!BOOK_ITEM_RE.test(id) || !date) { skipped.push({ itemId: id, reason: '項目 ID 或日期格式不正確' }); return; }
    const have = bookProgressDateOf_(sid, id);
    if (have && date < have) {
      // 舊資料：只記錄，不會自動回寫（防止「舊同步去新」）
      older.push({ itemId: id, date: date, existing: have });
      return;
    }
    if (existing[sid + '|' + id + '|' + date + '|' + BOOK_PENDING_STATUS.PENDING] ||
        (have && date === have)) {
      duplicates.push({ itemId: id, date: date });
      return;
    }
    const diff = have ? 'newer' : 'new';
    const trust = (o.verifiedClaims && o.verifiedClaims[id]) === BOOK_TRUST_LEADER ? BOOK_TRUST_LEADER : BOOK_TRUST_CLAIM;
    const pendingId = 'BP_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    sh.appendRow([pendingId, sid, id, date, safeSheetText(o.source || 'ROVERBOOK', 24), ts,
      BOOK_PENDING_STATUS.PENDING, diff, '', '', '',
      safeSheetText('來源信任：' + (trust === BOOK_TRUST_LEADER ? 'BOOK 顯示領袖已簽（仍待你確認）' : '成員自己標記（未經任何領袖）'), 160)]);
    staged.push({ pendingId: pendingId, itemId: id, date: date, diff: diff, trust: trust, existing: have || '' });
    stagedCount++;
  });
  return {
    staged: stagedCount, items: staged, older: older, duplicates: duplicates,
    skipped: skipped, at: ts
  };
}

// 撤回（withdraw）偵測：核簽表有紀錄、但正式「進度追蹤」已經冇該項目 → 領袖已撤回。
// 呢個情況唔可以再由核簽補回（舊版 bug：撤回後 bookPull 仍然回「已核實」，BOOK 會重新採用）。
function bookWithdrawnOf_(sid) {
  const signed = {}, done = {};
  const aliases = scoutAliases_(sid);
  const sSheet = getSheet().getSheetByName(BOOK_SIGNOFF_SHEET);
  if (sSheet) {
    const data = sSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!scoutMatches_(data[i][1], aliases)) continue;
      const id = String(data[i][2] || '').trim();
      if (BOOK_ITEM_RE.test(id)) signed[id] = bookNormDate_(data[i][3]);
    }
  }
  const pSheet = getSheet().getSheetByName('進度追蹤');
  if (pSheet) {
    const data = pSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!scoutMatches_(data[i][0], aliases)) continue;
      const id = String(data[i][1] || '').trim();
      if (BOOK_ITEM_RE.test(id)) done[id] = true;
    }
  }
  const out = {};
  Object.keys(signed).forEach(function (id) { if (!done[id]) out[id] = signed[id]; });
  return out;
}
// 成員是否存在（可寫入的目標）：Users（active）或 成員名單。防止打錯 YMIS 寫入幽靈紀錄。
function bookScoutExists_(sid) {
  const key = String(sid || '').trim();
  if (!key) return false;
  if (isSuperAdminId(key)) return true;
  const aliases = scoutAliases_(key);
  // SCOUT ID 可能係「未補零」的 YMIS（81420 vs 0000081420）→ 逐個寫法都試
  for (let i = 0; i < aliases.length; i++) {
    const a = aliases[i];
    try { if (getUser(a)) return true; } catch (e) { }
    try { if (memberNameRowExists_(a)) return true; } catch (e) { }
  }
  // Users／成員名單可能存原始未補零值 → 直接掃比對（資料量細）
  try {
    const u = getSheet().getSheetByName('Users');
    if (u) {
      const d = u.getDataRange().getValues();
      for (let i = 1; i < d.length; i++) { if (isLegacySuperRow_(d[i])) continue; if (scoutMatches_(d[i][0], aliases)) return true; }
    }
    const m = getSheet().getSheetByName('成員名單');
    if (m) {
      const d2 = m.getDataRange().getValues();
      for (let i = 1; i < d2.length; i++) { if (scoutMatches_(d2[i][0], aliases)) return true; }
    }
  } catch (e) { }
  return false;
}

function bookProgressOf_(sid) {
  const out = {};
  const withdrawn = bookWithdrawnOf_(sid);
  const aliases = scoutAliases_(sid);
  const pSheet = getSheet().getSheetByName('進度追蹤');
  if (pSheet) {
    const data = pSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!scoutMatches_(data[i][0], aliases)) continue;
      const itemId = String(data[i][1] || '').trim();
      if (!BOOK_ITEM_RE.test(itemId)) continue;
      const date = bookNormDate_(data[i][2]);
      if (date && (!out[itemId] || date > out[itemId])) out[itemId] = date;
    }
  }
  const sSheet = getSheet().getSheetByName(BOOK_SIGNOFF_SHEET);
  if (sSheet) {
    const data = sSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!scoutMatches_(data[i][1], aliases)) continue;
      const itemId = String(data[i][2] || '').trim();
      if (!BOOK_ITEM_RE.test(itemId)) continue;
      if (withdrawn[itemId]) continue; // 領袖已撤回：唔可以由核簽補回
      const date = bookNormDate_(data[i][3]);
      if (date && (!out[itemId] || date > out[itemId])) out[itemId] = date;
    }
  }
  return out;
}
function bookAwardsOf_(sid) {
  const out = {};
  const aliases = scoutAliases_(sid);
  const sh = getSheet().getSheetByName(BOOK_AWARD_SHEET);
  if (!sh) return out;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (!scoutMatches_(data[i][0], aliases)) continue;
    const badge = String(data[i][1] || '').trim().toUpperCase();
    const date = bookNormDate_(data[i][2]);
    if (/^L\d$/.test(badge) && date) out[badge] = date;
  }
  return out;
}
// 成員自己手機上已有、但 BADGE 未入帳嘅項目（只計 pending，唔會當成完成）
function bookPendingOf_(sid) {
  const out = {};
  const aliases = scoutAliases_(sid);
  bookPendingRows_().forEach(function (r) {
    if (aliases.indexOf(bookScoutId_(r.scoutId)) < 0 || r.status !== BOOK_PENDING_STATUS.PENDING || !r.date) return;
    if (!out[r.itemId] || r.date > out[r.itemId]) out[r.itemId] = r.date;
  });
  return out;
}

// 領袖讀：全團「已完成」一覽（零個資；只有 SCOUT ID 與項目／日期）＋ 待批清單
function handleBookRoster(actor) {
  if (!canTickUser_(actor)) return jsonResponse({ success: false, error: '權限不足，需已獲勾選權限的領袖' });
  const sheet = getSheet().getSheetByName('進度追蹤');
  const members = {};
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const sid = scoutNorm_(data[i][0]);
      const itemId = String(data[i][1] || '').trim();
      if (!sid || !BOOK_ITEM_RE.test(itemId)) continue;
      const date = bookNormDate_(data[i][2]);
      if (!date) continue;
      if (!members[sid]) members[sid] = {};
      if (!members[sid][itemId] || date > members[sid][itemId]) members[sid][itemId] = date;
    }
  }
  // 待批（成員交上嚟、等領袖 CONFIRM）
  const pending = bookPendingRows_()
    .filter(function (r) { return r.status === BOOK_PENDING_STATUS.PENDING; })
    .map(function (r) { return { pendingId: r.pendingId, scoutId: r.scoutId, itemId: r.itemId, date: r.date, diff: r.diff, trust: /BOOK 顯示領袖已簽/.test(r.note || '') ? BOOK_TRUST_LEADER : BOOK_TRUST_CLAIM }; });
  const pendingByScout = {};
  pending.forEach(function (r) {
    if (!pendingByScout[r.scoutId]) pendingByScout[r.scoutId] = {};
    if (!pendingByScout[r.scoutId][r.itemId] || r.date > pendingByScout[r.scoutId][r.itemId]) pendingByScout[r.scoutId][r.itemId] = r.date;
  });
  return jsonResponse({
    success: true, members: members, count: Object.keys(members).length,
    pending: pending, pendingByScout: pendingByScout, pendingCount: pending.length,
    // 兼容舊前端：以前叫 unsignedFromBook
    unsignedFromBook: pending.map(function (r) { return { scoutId: r.scoutId, itemId: r.itemId, date: r.date }; }),
    privacy: { personalData: 'none' }
  });
}

// 讀待批清單：領袖看全部（可指定 scoutId），成員只看自己（只讀，零個資）
function handleBookPending(actor, body) {
  const b = body || {};
  const isLeader = canTickUser_(actor);
  const want = scoutNorm_(b.scoutId);
  const me = scoutNorm_(actor && (actor.scoutId || actor.ymis));
  if (!isLeader && want && want !== me) return jsonResponse({ success: false, error: '權限不足：只可以查看自己的待批紀錄' });
  const sid = isLeader ? want : me;
  const status = String(b.status || BOOK_PENDING_STATUS.PENDING);
  const aliases = sid ? scoutAliases_(sid) : null;
  const list = bookPendingRows_().filter(function (r) {
    if (aliases && aliases.indexOf(bookScoutId_(r.scoutId)) < 0) return false;
    if (status !== 'all' && r.status !== status) return false;
    return true;
  }).map(function (r) {
    const trust = /BOOK 顯示領袖已簽/.test(r.note || '') ? BOOK_TRUST_LEADER : BOOK_TRUST_CLAIM;
    return { pendingId: r.pendingId, scoutId: r.scoutId, itemId: r.itemId, date: r.date, diff: r.diff, trust: trust, source: r.source, submittedAt: r.submittedAt };
  });
  return jsonResponse({ success: true, pending: list, count: list.length, scope: sid || 'all', privacy: { personalData: 'none' } });
}

// 領袖（或成員自己）上載：只會寫入「紀錄冊待批」，**唔會**寫入 進度追蹤／紀錄冊核簽
function handleBookSync(actor, body) {
  if (!canTickUser_(actor)) return jsonResponse({ success: false, error: '權限不足，需已獲勾選權限的領袖' });
  const b = body || {};
  const sid = scoutNorm_(b.scoutId || b.ymis || (b.member && b.member.scoutId));
  if (!sid) return jsonResponse({ success: false, error: '缺少 SCOUT ID：請成員在紀錄冊填一次成員編號' });
  // 防幽靈紀錄：SCOUT ID 必須對應本旅團現有成員（打錯一個數字就會變成冇人跟進的待批）
  if (!bookScoutExists_(sid)) {
    return jsonResponse({ success: false, error: '找不到成員 ' + sid + '：請先在「用戶管理」或「成員名單」建立該成員，或核對紀錄冊上的成員編號', unknownScoutId: sid });
  }
  const privacy = bookPrivacyReport_(b);
  const rawProgress = (b.progress && typeof b.progress === 'object') ? b.progress : {};
  const clean = {}, rejected = [], verifiedClaims = {};
  Object.keys(rawProgress).forEach(function (itemId) {
    const id = String(itemId || '').trim();
    const entry = rawProgress[itemId];
    const date = bookNormDate_(typeof entry === 'string' ? entry : (entry && entry.date));
    if (!BOOK_ITEM_RE.test(id) || !date) { rejected.push({ itemId: id, reason: '項目 ID 或日期格式不正確' }); return; }
    const err = checkTickBatch_([{ ymis: sid, itemId: id }], null);
    if (err) { rejected.push({ itemId: id, reason: err }); return; }
    clean[id] = date;
    // 信任標記來源：① 前端送來的 trusts[id]（bridge 已判斷，因為 progress 只有日期字串）
    //               ② 否則自行檢查原始 entry；兩者都只影響「顯示方便」，一樣要入待批。
    const declared = b.trusts && typeof b.trusts === 'object' ? String(b.trusts[id] || '') : '';
    verifiedClaims[id] = (declared === BOOK_TRUST_LEADER) ? BOOK_TRUST_LEADER : bookTrustOf_(entry);
  });
  const stage = stageBookPending_(sid, clean, { source: 'ROVERBOOK', verifiedClaims: verifiedClaims });
  writeAudit(actor.ymis, 'book_sync', sid,
    'ROVERBOOK 上載：待批 ' + stage.staged + ' 項、較舊未回寫 ' + stage.older.length + ' 項、重覆 ' + stage.duplicates.length + ' 項（已剝走個資欄位 ' + privacy.removedCount + ' 個）');
  return jsonResponse({
    success: true, scoutId: sid,
    staged: stage.staged, items: stage.items,
    older: stage.older, duplicates: stage.duplicates,
    rejected: rejected, privacy: privacy,
    progress: bookProgressOf_(sid), pending: bookPendingOf_(sid), awards: bookAwardsOf_(sid),
    needsConfirm: stage.staged > 0,
    leaderSignedCount: stage.items.filter(function (x) { return x.trust === BOOK_TRUST_LEADER; }).length,
    memberClaimCount: stage.items.filter(function (x) { return x.trust === BOOK_TRUST_CLAIM; }).length,
    trustNote: 'BOOK 交上嚟嘅每一項都只會入「待批」：即使 BOOK 顯示已由領袖簽核，都要你在這裡再確認一次（成員部機可以改任何欄位，所以一律唔信）。',
    message: stage.staged > 0
      ? ('已放入「紀錄冊待批」' + stage.staged + ' 項，等領袖確認後才會計入進度（BOOK 交上嚟嘅資料唔會自動變成已完成）')
      : '沒有新的項目需要確認（已存在、較舊或格式不正確）'
  });
}

// 領袖 CONFIRM：把待批項目寫入正式進度（逐項揀，或一次過全部批准）
function handleBookConfirm(actor, body) {
  if (!canTickUser_(actor)) return jsonResponse({ success: false, error: '權限不足，需已獲勾選權限的領袖' });
  const b = body || {};
  const all = bookPendingRows_().filter(function (r) { return r.status === BOOK_PENDING_STATUS.PENDING; });
  const wantIds = Array.isArray(b.pendingIds) ? b.pendingIds.map(String) : null;
  const wantScout = scoutNorm_(b.scoutId);
  // 一定要指明範圍（逐項 pendingIds 或一位 scoutId，或明確 all:true）。
  // 舊版「冇帶 id 就等於全團」太容易誤按，會一次過確認全團所有待批。
  if (!wantIds && !wantScout && b.all !== true) {
    return jsonResponse({ success: false, error: '請指明要確認哪些項目（pendingIds）、哪一位成員（scoutId），或明確 all:true 一次過確認全部' });
  }
  let targets = all;
  if (wantIds) targets = all.filter(function (r) { return wantIds.indexOf(r.pendingId) >= 0; });
  else if (wantScout) {
    const aliases = scoutAliases_(wantScout);
    targets = all.filter(function (r) { return aliases.indexOf(bookScoutId_(r.scoutId)) >= 0; });
  }
  // 可以只批准某幾項：b.items=[{pendingId,date}] 覆寫日期（「只加不減，但可以改」）
  const dateOverride = {};
  (Array.isArray(b.items) ? b.items : []).forEach(function (it) {
    const pid = String((it && it.pendingId) || '');
    const d = bookNormDate_(it && it.date);
    if (pid && d) dateOverride[pid] = d;
  });
  const decision = String(b.decision || 'approve').toLowerCase();
  if (decision === 'reject') {
    const sh = bookSheet_(BOOK_PENDING_SHEET, BOOK_PENDING_HEADERS);
    let n = 0;
    targets.forEach(function (r) {
      sh.getRange(r.row, 7).setValue(BOOK_PENDING_STATUS.REJECTED);
      sh.getRange(r.row, 9).setValue('');
      sh.getRange(r.row, 10).setValue(sheetActor(actor.ymis));
      sh.getRange(r.row, 11).setValue(now());
      n++;
    });
    if (n) writeAudit(actor.ymis, 'book_confirm_reject', String(n) + ' 項', '領袖拒絕 ROVERBOOK 待批紀錄');
    return jsonResponse({ success: true, approved: 0, rejected: n, message: '已拒絕 ' + n + ' 項（不會計入進度）' });
  }
  if (!targets.length) return jsonResponse({ success: true, approved: 0, rejected: 0, message: '沒有待批項目' });
  // 授權檢查：領袖必須有權勾選該項目（同一套 allowed_badges 規則）
  const bad = [];
  targets.forEach(function (r) {
    const err = checkTickBatch_([{ ymis: r.scoutId, itemId: r.itemId }], actor);
    if (err) bad.push({ pendingId: r.pendingId, itemId: r.itemId, reason: err });
  });
  if (bad.length) return jsonResponse({ success: false, error: bad[0].reason, rejected: bad });
  const confirmDate = bookNormDate_(b.date) || formatDate(new Date());
  const confirmer = sheetActor(actor.ymis);
  const sh = bookSheet_(BOOK_PENDING_SHEET, BOOK_PENDING_HEADERS);
  let approved = 0;
  const signItems = [];
  targets.forEach(function (r) {
    if (!r.date) return;
    const date = dateOverride[r.pendingId] || r.date;
    const have = bookProgressDateOf_(r.scoutId, r.itemId);
    // 只加不減：除非領袖明確表示要改（b.overwrite=true），否則較早日期唔會蓋走既有紀錄
    if (have && date < have && !b.overwrite) {
      sh.getRange(r.row, 7).setValue(BOOK_PENDING_STATUS.REJECTED);
      sh.getRange(r.row, 12).setValue('較舊日期（既有 ' + have + '），已保留原紀錄');
      sh.getRange(r.row, 10).setValue(confirmer);
      sh.getRange(r.row, 11).setValue(now());
      return;
    }
    const res = bookWriteProgress_(r.scoutId, r.itemId, date, confirmer, '由 ROVERBOOK 待批確認（' + r.pendingId + '）');
    if (!res.ok) return;
    signItems.push({ scoutId: r.scoutId, itemId: r.itemId, date: date, leader: actor.name || '', note: 'CONFIRM ' + r.pendingId });
    sh.getRange(r.row, 7).setValue(BOOK_PENDING_STATUS.APPROVED);
    sh.getRange(r.row, 8).setValue(have ? (date > have ? 'newer' : 'same') : 'new');
    sh.getRange(r.row, 9).setValue(date);
    sh.getRange(r.row, 10).setValue(confirmer);
    sh.getRange(r.row, 11).setValue(now());
    approved++;
  });
  if (signItems.length) writeBookSignoffs_(signItems, { leader: actor.name || '', leaderTitle: '', source: 'ROVERBADGE' });
  writeAudit(actor.ymis, 'book_confirm', String(approved) + ' 項', '領袖確認 ROVERBOOK 待批紀錄並寫入進度');
  return jsonResponse({ success: true, approved: approved, rejected: targets.length - approved, signoffs: signItems.length, message: '已確認 ' + approved + ' 項並寫入進度' });
}

// 領袖一次過頒發：可指定多個成員／多個獎章，一 call 完成
function handleBookAward(actor, body) {
  if (!canTickUser_(actor)) return jsonResponse({ success: false, error: '權限不足，需已獲勾選權限的領袖' });
  const b = body || {};
  const list = Array.isArray(b.awards) ? b.awards : (b.scoutId ? [b] : []);
  if (!list.length) return jsonResponse({ success: false, error: '請提供 awards[]（scoutId／badgeId／date）' });
  // 防幽靈頒發：任何一個 SCOUT ID 唔存在就整批拒絕（唔會半寫入）
  const unknown = [];
  list.forEach(function (a) {
    const sid2 = scoutNorm_(a && (a.scoutId || a.ymis));
    if (sid2 && !bookScoutExists_(sid2) && unknown.indexOf(sid2) < 0) unknown.push(sid2);
  });
  if (unknown.length) {
    return jsonResponse({ success: false, error: '找不到成員：' + unknown.join('、') + '（請先在用戶管理／成員名單建立，或核對編號）', unknownScoutId: unknown, written: 0 });
  }
  const res = writeBookAwards_(list, actor.ymis, b.confirm === true);
  writeAudit(actor.ymis, 'book_award', String(list.length) + ' 人／章',
    '一次過頒發：' + res.written + ' 筆、更正日期 ' + (res.corrected || 0) + ' 筆、撤回 ' + (res.removed || 0) + ' 筆（略過 ' + res.skipped + ' 筆）');
  return jsonResponse({
    success: true, written: res.written, skipped: res.skipped,
    corrected: res.corrected || 0, removed: res.removed || 0,
    message: '已頒發 ' + res.written + ' 筆' +
      (res.corrected ? '、更正 ' + res.corrected + ' 筆' : '') +
      (res.removed ? '、撤回 ' + res.removed + ' 筆' : '') +
      '（略過 ' + res.skipped + ' 筆：已存在、需 confirm、或格式不正確）'
  });
}

// 成員自己下載「唯讀」進度（只回自己那行；用 token 身分，不接受任意 SCOUT ID）
function handleBookPull(actor) {
  const sid = scoutNorm_(actor && (actor.scoutId || actor.ymis));
  if (!sid) return jsonResponse({ success: false, error: '找不到 SCOUT ID' });
  const progress = bookProgressOf_(sid);
  const awards = bookAwardsOf_(sid);
  const pending = bookPendingOf_(sid);
  // 核簽清單（成員可貼回 ROVERBOOK；不含任何人名以外的個資）
  const signoffs = [];
  const withdrawn = bookWithdrawnOf_(sid);
  const pullAliases = scoutAliases_(sid);
  const sh = getSheet().getSheetByName(BOOK_SIGNOFF_SHEET);
  if (sh) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!scoutMatches_(data[i][1], pullAliases)) continue;
      const itemId = String(data[i][2] || '').trim();
      const date = bookNormDate_(data[i][3]);
      if (!BOOK_ITEM_RE.test(itemId) || !date) continue;
      if (withdrawn[itemId]) continue; // 已撤回 → 唔可以再宣稱「已核實」
      signoffs.push({ id: itemId, date: date, leader: String(data[i][4] || ''), title: String(data[i][5] || ''), verified: true });
    }
  }
  const withdrawnIds = Object.keys(withdrawn);
  // BOOK 側只可以「無條件相信」呢啲（全部係 BADGE 領袖核實過 / 由領袖行為產生）
  const verifiedInBadge = {};
  Object.keys(progress).forEach(function (k) { verifiedInBadge[k] = progress[k]; });
  // ---- 給 ROVERBOOK 的「個人純進度」視圖（endpoint-compatible）----
  // ROVERBOOK 的伺服器端會用 { ymis, progress{itemId:date}, otherBadges, pendingRequests[{itemId,date,status}] }
  // 呢個包裝令佢可以直接消費；姓名／電郵／電話等一律唔會出現（本身已剝清）。
  const flatProgress = {};
  Object.keys(progress).forEach(function (k) { flatProgress[k] = progress[k]; });
  const bookAwardsCompat = {};
  Object.keys(awards).forEach(function (k) { bookAwardsCompat[k] = awards[k]; });
  const pendingList = Object.keys(pending).sort().map(function (k) {
    return { itemId: k, date: pending[k], status: 'pending' };
  });
  const pendingIds = Object.keys(pending).sort();
  // 其他獎章（OT-*）：只回 id → 日期（零個資）；ROVERBOOK 只會用日期
  const otherBadges = {};
  const oSheet = getSheet().getSheetByName('其他獎章');
  if (oSheet) {
    const aliases = scoutAliases_(sid);
    const data = oSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (!scoutMatches_(data[i][0], aliases)) continue;
      const id = String(data[i][1] || '').trim();
      const date = bookNormDate_(data[i][3]);
      if (!id || !date) continue;
      otherBadges[id] = { date: date };
    }
  }
  return jsonResponse({
    success: true, schema: 'roverbadge.progress.roverbook.v2', scoutId: sid,
    verified: true, verifiedBy: 'ROVERBADGE',
    // ---- ROVERBOOK 直接消費的形狀（同 ROVERBOOK api/roverbadge.js 期望一致）----
    ymis: sid,                        // BOOK 會 normalizeScoutId(ymis) 後當作本人編號
    flatProgress: flatProgress,       // { itemId: 'YYYY-MM-DD' }
    otherBadges: otherBadges,         // { 'OT-…': { date } }
    pendingRequests: pendingList,     // [{ itemId, date, status:'pending' }]
    pendingItemIds: pendingIds,       // BOOK 前端用嚟避免重複送交
    badgeDates: bookAwardsCompat,     // { L1: 'YYYY-MM-DD' }（獎章頒發日期）
    withdrawnItemIds: withdrawnIds,   // BOOK 要由本機移除嘅項目
    // ---- 本系統前端用的完整形狀（不變）----
    progress: progress, awards: awards, signoffs: signoffs,
    verifiedInBadge: verifiedInBadge,
    pending: pending, unverified: pending,
    // 領袖撤回清單：BOOK 必須把呢啲項目由「已完成」移除（BOOK 側 applySignoff 會處理）
    withdrawn: withdrawnIds,
    privacy: { personalData: 'none', note: '只回進度與頒發；姓名、聯絡、相片、簽名墨跡不出本檔' }
  });
}

function menuBookStatus() {
  const stats = bookStats_();
  const lines = [
    'ROVERBOOK 對接狀態（GS v' + GS_VERSION + '）',
    '',
    '・「' + BOOK_PENDING_SHEET + '」：待領袖確認 ' + stats.pending + ' 項（成員交上嚟，未計入進度）',
    '・「' + BOOK_SIGNOFF_SHEET + '」：' + stats.signoffs + ' 筆核簽（' + stats.signedMembers + ' 位成員，全部由領袖確認產生）',
    '・「' + BOOK_AWARD_SHEET + '」：' + stats.awards + ' 筆頒發（' + stats.awardedMembers + ' 位成員）',
    '・待批較舊而未有回寫：' + stats.olderBlocked + ' 項',
    '',
    '重要：成員喺 ROVERBOOK 自己簽嘅紀錄，只會進入「' + BOOK_PENDING_SHEET + '」，',
    '要領袖逐項／一次過確認（CONFIRM）之後才會寫入正式「進度追蹤」。',
    '',
    '私隱：本試算表只存 SCOUT ID、項目、日期、核簽領袖姓名；',
    '成員的電話／電郵／地址／相片／簽名墨跡永遠留在佢自己部手機。',
    '三張表都在「🔧 初始化／更新」時自動補建，唔會改動任何既有資料。'
  ];
  return linkAlert('📖 ROVERBOOK 對接', lines.join('\n'));
}
function bookStats_() {
  const out = { signoffs: 0, awards: 0, signedMembers: {}, awardedMembers: {}, pending: 0, olderBlocked: 0 };
  const sh = getSheet().getSheetByName(BOOK_SIGNOFF_SHEET);
  if (sh) {
    const d = sh.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (!d[i][1]) continue;
      out.signoffs++; out.signedMembers[String(d[i][1])] = true;
    }
  }
  bookPendingRows_().forEach(function (r) {
    if (r.status === BOOK_PENDING_STATUS.PENDING) out.pending++;
    if (r.status === BOOK_PENDING_STATUS.REJECTED && r.diff === 'older') out.olderBlocked++;
  });
  const a = getSheet().getSheetByName(BOOK_AWARD_SHEET);
  if (a) {
    const d = a.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) { if (!d[i][0]) continue; out.awards++; out.awardedMembers[String(d[i][0])] = true; }
  }
  out.signedMembers = Object.keys(out.signedMembers).length;
  out.awardedMembers = Object.keys(out.awardedMembers).length;
  return out;
}


// ===== 旅系統：Sheet 選單（onOpen）=====
// 全部接駁操作都經呢度做（sig 係 GAS→GAS，唔經 Vercel proxy，前端／api 唔使改）。
function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('🔗 旅系統')
      .addItem('🔧 初始化／更新（執行 initializeSheets）', 'menuInitializeSheets')
      .addSeparator()
      .addItem('📤 匯出 JSON（含 hash）', 'menuExportUsersJson')
      .addItem('📥 匯入 JSON（upsertUser 直插 hash）', 'menuImportUsersJson')
      .addSeparator()
      .addItem('🧭 本機接駁狀態', 'menuShowLinkState')
      .addItem('🔑 顯示 API KEY（交 ADMIN）', 'menuShowLinkCredentials')
      .addItem('⏱️ 密碼雜湊效能測試', 'menuBenchmarkPasswordKdf')
      .addItem('📖 ROVERBOOK 對接狀態', 'menuBookStatus')
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
// ===== 唯一嘅更新入口（GS 5.3.0）=====
// 首次建表、以及每次貼上新 Code.gs 之後，用戶只需要按呢一個掣一次。
// 佢只呼叫 initializeSheets()：只補建缺少嘅工作表／表頭欄／預設管理員，並喺全部成功後
// 最後一步寫入初始化標記（INITIALIZED_GS_VERSION）。絕不刪除、覆寫、重置任何既有帳號、
// 進度、徽章、履歷、設定，亦絕不更換既有 API_KEY —— 所以可以安心重跑。
// 普通用戶唔需要（亦唔應該被要求去）搵任何其他維護函式。
function menuInitializeSheets() {
  let failure = '';
  try { initializeSheets(); } catch (e) { failure = String((e && e.message) || e); }
  if (failure) {
    return linkAlert('🔧 初始化／更新', '❌ 未完成：' + failure + '\n\n未完成時不會寫入初始化標記；既有資料不受影響。請稍後再按一次本掣。');
  }
  const info = gsVersionInfo_();
  const lines = [
    '✅ 已完成初始化／更新（GS v' + info.gsVersion + '，初始化標記 ' + (info.initializedGsVersion || '—') + '）',
    '',
    '呢個掣就係唯一嘅更新步驟：',
    '・首次建表、以及每次貼上新 Code.gs 並部署「新版本」後，按一次即可',
    '・重跑只會補建缺少的工作表、表頭欄與預設管理員',
    '・不會刪除或改寫任何既有帳號、進度、徽章、活動履歷、系統設定',
    '・不會更換 API Key（沿用原有嗰條，已登記嘅接入不受影響）',
    '',
    '如需把 API Key 交 ADMIN，請按「🔑 顯示 API KEY（交 ADMIN）」。'
  ];
  return linkAlert('🔧 初始化／更新', lines.join('\n'));
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
  const key = getApiKey();
  // 未初始化時先講明「呢條 Key 暫時未可用」＋唯一嘅完成步驟；Key 照樣顯示（不影響既有流程）
  const message = initStatusWarningLines_().join('\n') +
    'API Key = ' + key +
    '\n\n正式部署 URL 請從 Google「部署」視窗取得；請自行在原有 ADMIN FORM 填寫旅團編號、名稱、URL 和 API Key。';
  return linkAlert('API KEY（交 ADMIN）', message);
}
// ===== ⏱️ 密碼雜湊效能測試（GS 5.4.0）=====
// 只讀：即場用 Utilities.computeHmacSha256Signature 原路徑量真實毫秒數（唔係喺 Node 估），
// 再用本旅團真實（假資料）Users 表計四條登入路徑各自要幾秒。完全唔改任何儲存格。
const KDF_BENCH_LIMIT_MS = 30000; // 任何一條路徑超過 30 秒 = fail（proxy 上游上限 45 秒，要留緩衝）
function benchmarkPasswordKdf(){
  const runs = [1000, 10000, 120000];
  const salt = hexToBytes_((Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32));
  const sample = 'benchmark-passphrase';
  const rows = [];
  const perIter = {};
  runs.forEach(function (iter) {
    const t0 = Date.now();
    pbkdf2HmacSha256_(sample, salt, iter);
    const ms = Date.now() - t0;
    perIter[iter] = ms;
    rows.push({ path: '純 PBKDF2 ' + iter + ' 次', ms: ms, note: iter === PBKDF2_ITERATIONS ? '本版寫入格式' : (iter === 120000 ? '舊版格式（GS 5.2.x–5.3.0）' : '下限參考') });
  });
  // 用真實 Users 表計四條路徑（只讀；每個路徑最多驗一次，完全唔會逐行掃）
  const sheet = getSheet().getSheetByName('Users');
  const paths = [];
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    const actives = [];
    for (let i = 1; i < data.length; i++) {
      if (isLegacySuperRow_(data[i])) continue;
      if (String(data[i][11] || '').trim() === 'active') actives.push({ row: i + 1, ymis: String(data[i][0] || ''), hash: String(data[i][4] || '') });
    }
    const probe = function (label, hash, password) {
      if (!hash) return paths.push({ label: label, ms: 0, note: '冇此類帳號' });
      const t = Date.now();
      let ok = false;
      try { ok = verifyPassword(password, hash); } catch (e) { }
      paths.push({ label: label, ms: Date.now() - t, note: ok ? '驗證成功（1× KDF）' : '驗證失敗（1× KDF）' });
    };
    const wrongPw = '\u0000benchmark-wrong-' + Date.now();
    const first = actives[0];
    probe('① 本版 pbkdf2$' + PBKDF2_ITERATIONS + '$ 帳號（第 ' + (first ? first.row : '-') + ' 行）', first ? first.hash : '', wrongPw);
    const legacy = actives.filter(function (a) { return isLegacyPasswordHash_(a.hash); })[0];
    probe('② 舊 64-hex 帳號（第 ' + (legacy ? legacy.row : '-') + ' 行）', legacy ? legacy.hash : '', wrongPw);
    const row10 = actives.filter(function (a) { return a.row === 10; })[0] || actives[9];
    const row30 = actives.filter(function (a) { return a.row === 30; })[0] || actives[29];
    probe('③ 排第 10 行嘅帳號', row10 ? row10.hash : '', wrongPw);
    probe('③ 排第 30 行嘅帳號', row30 ? row30.hash : '', wrongPw);
    paths.push({ label: '④ 錯密碼（已定位單行）', ms: paths[0] ? paths[0].ms : 0, note: '單行驗證 1× KDF，與 ① 同成本；唔會再掃全表' });
    paths.push({ label: '④ 帳號不存在（dummy 雜湊）', ms: burnDummyKdf_(wrongPw), note: 'CacheService 重用 dummy 雜湊，每個執行最多計一次' });
  }
  const lines = [];
  lines.push('GS v' + GS_VERSION + '（PBKDF2 迭代 ' + PBKDF2_ITERATIONS + ' 次，proxy 上游上限 45 秒）');
  lines.push('');
  lines.push('【單次 KDF 實測毫秒】');
  rows.forEach(function (r) { lines.push('・' + r.path + '：' + r.ms + ' ms　' + r.note); });
  lines.push('');
  lines.push('【本旅團 Users 表四條登入路徑】');
  paths.forEach(function (p) { lines.push('・' + p.label + '：' + p.ms + ' ms　' + p.note); });
  const worst = paths.reduce(function (m, p) { return Math.max(m, p.ms); }, 0);
  const verdict = worst > KDF_BENCH_LIMIT_MS ? '❌ FAIL（最慢一條 ' + worst + ' ms > ' + KDF_BENCH_LIMIT_MS + ' ms）' : '✅ PASS（最慢一條 ' + worst + ' ms，安全邊界 ' + KDF_BENCH_LIMIT_MS + ' ms）';
  lines.push('');
  lines.push('結果：' + verdict);
  const msg = lines.join('\n');
  try { linkAlert('⏱️ 密碼雜湊效能測試', msg); } catch (e) { }
  try { Logger.log(msg); } catch (e) { }
  return { success: true, gsVersion: GS_VERSION, iterations: PBKDF2_ITERATIONS, bench: rows, paths: paths, worstMs: worst, pass: worst <= KDF_BENCH_LIMIT_MS, text: msg };
}
function menuBenchmarkPasswordKdf() { const r = benchmarkPasswordKdf(); return r.text; }
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
