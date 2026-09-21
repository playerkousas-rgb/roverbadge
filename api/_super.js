// 中央管理帳號 — 伺服器端專用模組（底線開頭，不會被建成 endpoint）
//
// 政策（與同系 APP 一致）：
//   - 密碼只存在於 Vercel 環境變數 SUPER_KEY；一律當作「字串」處理：
//     不轉數字（保留開頭的 0）、不截短、不補字元。
//   - superConfigured()：未設定、空字串、或少於 4 個字元 → 拒絕（中央登入不可用）。
//     長度合格只代表「設定存在」，登入仍須完整比對密碼。
//   - 密碼永不傳給旅團 GAS、不寫入任何 log；GAS 只收到短效加密登入票據。
//
// 登入票據（superTicket）：
//   Vercel 驗證密碼後簽發 AES-256-GCM 加密票據，綁定旅團編號 + 旅團後端設定 + 短時效；
//   GAS 向本 APP 固定的中央驗證端點（/api/verify-super-ticket）驗票，通過才建立 session。
//   票據不能跨旅團使用：backend 綁定不符即驗票失敗。
//
// 瀏覽器 session 包裝（rbs1.）：
//   中央登入成功後，GAS token 以 AES-256-GCM 包裝並綁定旅團編號才回傳瀏覽器；
//   proxy 每次請求都先解密並核對旅團，raw GAS token 不會出現在瀏覽器。
import crypto from 'crypto';

const APP_TAG = 'roverbadge';
export const MIN_SUPER_KEY_LEN = 4;
const TICKET_PREFIX = 'rbt1.';
export const SESSION_PREFIX = 'rbs1.';

// SUPER_KEY 必須當作字串：未設定 / 空字串 / 少於 4 字元都視為未設定完成
export function superConfigured() {
  const k = process.env.SUPER_KEY;
  return typeof k === 'string' && k.length >= MIN_SUPER_KEY_LEN;
}

function timingSafeEqualStr(a, b) {
  // 先 hash 再比對：避免長度不同時 timingSafeEqual 拋錯，同時保持常數時間比較
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 完整比對密碼（長度合格 ≠ 登入成功；這裡才是實際驗證）
export function verifySuperPassword(password) {
  if (!superConfigured()) return false;
  if (typeof password !== 'string' || password.length === 0 || password.length > 200) return false;
  return timingSafeEqualStr(password, process.env.SUPER_KEY);
}

// 加密 key 由 SUPER_KEY（或選用 SUPER_SESSION_SECRET）派生；不同用途用不同 salt，
// 票據與 session 包裝的 key 不能互用。SUPER_KEY 輪換後舊票據／舊包裝自動失效。
function deriveKey(purpose) {
  const secret = process.env.SUPER_SESSION_SECRET || process.env.SUPER_KEY || '';
  return crypto.createHash('sha256').update(`${APP_TAG}:${purpose}:${secret}`, 'utf8').digest();
}

function encryptJson(purpose, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(purpose), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptJson(purpose, payloadB64) {
  try {
    const buf = Buffer.from(String(payloadB64), 'base64url');
    if (buf.length < 29) return null; // 12 iv + 16 tag + ≥1
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(purpose), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch (e) {
    return null;
  }
}

const TICKET_TTL_MS = (() => {
  const v = parseInt(process.env.SUPER_TICKET_TTL_MS || '60000', 10);
  if (Number.isNaN(v)) return 60000;
  return Math.max(15000, Math.min(300000, v));
})();

function normalizeBackend(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

// 簽發登入票據：綁定 login_id + 旅團 + 後端設定 + 短時效
export function issueSuperTicket({ loginId, troopId, backend }) {
  if (!superConfigured()) return null;
  const payload = {
    a: APP_TAG,
    id: String(loginId || ''),
    t: String(troopId || ''),
    b: normalizeBackend(backend),
    exp: Date.now() + TICKET_TTL_MS,
    n: crypto.randomBytes(8).toString('hex')
  };
  return TICKET_PREFIX + encryptJson('super-ticket-v1', payload);
}

// 驗票（中央驗證服務用）：解密 → 檢查時效 / 應用標籤 / 後端綁定
// claimedBackend 由 GAS 自報（ScriptApp.getService().getUrl()），必須與票據綁定的 backend 一致
export function verifySuperTicket(ticket, claimedBackend) {
  if (!superConfigured()) return null;
  if (typeof ticket !== 'string' || !ticket.startsWith(TICKET_PREFIX)) return null;
  const p = decryptJson('super-ticket-v1', ticket.slice(TICKET_PREFIX.length));
  if (!p || p.a !== APP_TAG) return null;
  if (typeof p.exp !== 'number' || Date.now() > p.exp + 10000) return null; // 容許 10s 時鐘偏差
  if (!p.b || normalizeBackend(claimedBackend) !== p.b) return null;        // 票據綁定後端，不能跨旅團
  return p;
}

// 瀏覽器 session 包裝：加密 + 綁定旅團編號
export function wrapSessionToken(troopId, innerToken) {
  if (!superConfigured()) return null;
  if (typeof innerToken !== 'string' || !innerToken) return null;
  return SESSION_PREFIX + encryptJson('super-session-v1', { t: String(troopId), k: innerToken, exp: Date.now() + 30 * 24 * 3600 * 1000 });
}

// 解開 session 包裝：旅團不符 / 解密失敗 / 過期一律回 null（proxy 應回 401）
export function unwrapSessionToken(troopId, wrapped) {
  if (!superConfigured()) return null;
  if (typeof wrapped !== 'string' || !wrapped.startsWith(SESSION_PREFIX)) return null;
  const p = decryptJson('super-session-v1', wrapped.slice(SESSION_PREFIX.length));
  if (!p || String(p.t) !== String(troopId)) return null;
  if (typeof p.exp !== 'number' || Date.now() > p.exp) return null;
  return typeof p.k === 'string' && p.k ? p.k : null;
}

// ---- 中央登入速率限制（best-effort，per function instance 記憶體）----
// 注意：這只能減慢線上猜測；對「離線破解 SUPER_KEY」完全無效 —— 密碼強度才是根本。
const LIMIT_WINDOW_MS = 60000;
const LIMIT_MAX = 10;
const attempts = new Map(); // key -> [timestamps]

export function superLoginRateLimited(key) {
  const now = Date.now();
  const k = String(key || 'anon').slice(0, 120);
  const list = (attempts.get(k) || []).filter(t => now - t < LIMIT_WINDOW_MS);
  if (list.length >= LIMIT_MAX) {
    attempts.set(k, list);
    return true;
  }
  list.push(now);
  attempts.set(k, list);
  // 防止 Map 無限成長
  if (attempts.size > 5000) {
    for (const [kk, vv] of attempts) if (!vv.length) attempts.delete(kk);
  }
  return false;
}
