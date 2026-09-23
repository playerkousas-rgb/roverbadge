// 中央管理帳號 — 伺服器端專用模組（底線開頭，不會被建成 endpoint）
//
// 政策：
//   - 密碼只存在於 Vercel 環境變數 SUPER_KEY；一律當作「字串」處理：
//     不轉數字（保留開頭的 0）、不截短、不補字元。
//   - superConfigured()：未設定、空字串、或少於 4 個字元 → 拒絕（中央登入不可用）。
//     長度合格只代表「設定存在」，登入仍須完整比對密碼。
//   - 改密碼＝只改 Vercel SUPER_KEY 一個值＋Redeploy；GAS／Sheet／票據鎖匙全部唔使掂。
//
// 登入票據（superTicket，零回傳設計）：
//   Vercel 驗證密碼後簽發「短效簽名票據」，簽名鎖匙用該旅團嘅共享鎖匙 D（＝TROOP_{id}_APIKEY，
//   同 GAS Script Properties 嘅 API_KEY 同一個值，B/D 由 GS 生成後交 ADMIN 登記）。
//   GAS 用自己嘅本地 API_KEY 重新計算 HMAC 就可驗票 —— 完全唔會回打 Vercel（不做回傳）。
//   票據格式：'rbs2.' + base64url(UTF-8 JSON{id,exp,n}) + '.' + hex(HMAC-SHA256(payloadB64, D))
//   - 60 秒短效（可由 SUPER_TICKET_TTL_MS 調整，15–300 秒）
//   - 密碼錯 → 喺 proxy 第一關已被拒，根本唔會有票據；直打 GAS 冇有效票據一樣被拒
//   - 票據天然綁定旅團：簽名鎖匙係該旅團嘅 D，跨旅團驗唔過（除非兩團共用 D）
//
// 瀏覽器 session 包裝（rbs1.）：
//   中央登入成功後，GAS token 以 AES-256-GCM 包裝並綁定旅團編號才回傳瀏覽器；
//   proxy 每次請求都先解密並核對旅團，raw GAS token 不會出現在瀏覽器。
//   （包裝／解包全部只喺 proxy 兩端發生，唔涉及任何回傳。）
import crypto from 'crypto';

const APP_TAG = 'roverbadge';
export const MIN_SUPER_KEY_LEN = 4;
const TICKET_PREFIX = 'rbs2.';
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

// ---- 登入票據（HMAC-SHA256 簽名；GAS 本地驗簽，零回傳）----
const TICKET_TTL_MS = (() => {
  const v = parseInt(process.env.SUPER_TICKET_TTL_MS || '60000', 10);
  if (Number.isNaN(v)) return 60000;
  return Math.max(15000, Math.min(300000, v));
})();

function hmacHex(message, key) {
  return crypto.createHmac('sha256', String(key)).update(String(message), 'utf8').digest('hex');
}

function b64urlPad(s) {
  return s + '=='.slice(0, (4 - (s.length % 4)) % 4);
}

// 簽發登入票據：綁定 login_id + 短時效；簽名鎖匙＝該旅團共享鎖匙 D（TROOP_{id}_APIKEY）。
// 冇 D（旅團未設 APIKEY）就簽唔出票 → 中央登入不可用（一般旅團登入不受影響）。
export function issueSuperTicket({ loginId, apiKey }) {
  if (!superConfigured()) return null;
  if (typeof apiKey !== 'string' || !apiKey) return null;
  const payload = {
    id: String(loginId || ''),
    exp: Date.now() + TICKET_TTL_MS,
    n: crypto.randomBytes(8).toString('hex')
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return TICKET_PREFIX + payloadB64 + '.' + hmacHex(payloadB64, apiKey);
}

// 驗票（同 GAS 端 verifySuperLoginTicket 完全同一套數學）：HMAC 簽名 → 時效 → payload
// 供 health 自測／測試用；GAS 端用本地 API_KEY 自行驗，唔會打返嚟。
export function verifySuperTicket(ticket, apiKey) {
  if (typeof ticket !== 'string' || !ticket.startsWith(TICKET_PREFIX)) return null;
  if (typeof apiKey !== 'string' || !apiKey) return null;
  const rest = ticket.slice(TICKET_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  const payloadB64 = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/i.test(sig)) return null;
  if (!timingSafeEqualStr(sig, hmacHex(payloadB64, apiKey))) return null;
  try {
    const p = JSON.parse(Buffer.from(b64urlPad(payloadB64), 'base64url').toString('utf8'));
    if (!p || typeof p.exp !== 'number' || Date.now() > p.exp) return null;
    return { id: String(p.id || ''), exp: p.exp };
  } catch (e) {
    return null;
  }
}

// ---- 瀏覽器 session 包裝（key 由 SUPER_KEY／SUPER_SESSION_SECRET 派生，只喺 proxy 兩端用）----
function deriveSessionKey() {
  const secret = process.env.SUPER_SESSION_SECRET || process.env.SUPER_KEY || '';
  return crypto.createHash('sha256').update(`${APP_TAG}:super-session-v1:${secret}`, 'utf8').digest();
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveSessionKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptJson(payloadB64) {
  try {
    const buf = Buffer.from(String(payloadB64), 'base64url');
    if (buf.length < 29) return null; // 12 iv + 16 tag + ≥1
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveSessionKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch (e) {
    return null;
  }
}

// 瀏覽器 session 包裝：加密 + 綁定旅團編號
export function wrapSessionToken(troopId, innerToken) {
  if (!superConfigured()) return null;
  if (typeof innerToken !== 'string' || !innerToken) return null;
  return SESSION_PREFIX + encryptJson({ t: String(troopId), k: innerToken, exp: Date.now() + 30 * 24 * 3600 * 1000 });
}

// 解開 session 包裝：旅團不符 / 解密失敗 / 過期一律回 null（proxy 應回 401）
export function unwrapSessionToken(troopId, wrapped) {
  if (!superConfigured()) return null;
  if (typeof wrapped !== 'string' || !wrapped.startsWith(SESSION_PREFIX)) return null;
  const p = decryptJson(wrapped.slice(SESSION_PREFIX.length));
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
