// GAS 執行環境模擬器（測試專用）
// 目的：在 Node 內「真的執行」apps-script/Code.gs 這份要部署上去的程式碼，
// 而不是執行一份重寫的 mock。這樣 Code.gs 的改動（例如 initializeSheets() 彈框內容、
// handleLogin() 的系統管理帳號邏輯）才會被測試實際跑到。
//
// 模擬的 GAS API：SpreadsheetApp / PropertiesService / Utilities / ContentService /
// ScriptApp / Logger / SpreadsheetApp.getUi()（可程式化的 alert / prompt）
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CODE_GS_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');

function makeRange(sheet, row, col, numRows, numCols) {
  const pad = (r, c) => {
    while (sheet.rows.length < r) sheet.rows.push([]);
    for (let i = 0; i < r; i++) while (sheet.rows[i].length < c) sheet.rows[i].push('');
  };
  const range = {
    getValue() { return sheet.rows[row - 1] && sheet.rows[row - 1][col - 1] !== undefined ? sheet.rows[row - 1][col - 1] : ''; },
    getValues() {
      const out = [];
      for (let i = 0; i < numRows; i++) {
        const line = [];
        for (let j = 0; j < numCols; j++) {
          const v = sheet.rows[row - 1 + i] ? sheet.rows[row - 1 + i][col - 1 + j] : undefined;
          line.push(v === undefined ? '' : v);
        }
        out.push(line);
      }
      return out;
    },
    setValue(v) { pad(row, col); sheet.rows[row - 1][col - 1] = v; return range; },
    setValues(arr) {
      arr.forEach((line, i) => line.forEach((v, j) => { pad(row + i, col + j); sheet.rows[row - 1 + i][col - 1 + j] = v; }));
      return range;
    },
    setFontWeight() { return range; },
    setBackground() { return range; },
    setFontColor() { return range; }
  };
  return range;
}

function makeSheet(name) {
  const sheet = {
    name,
    rows: [],
    getName() { return sheet.name; },
    appendRow(arr) { sheet.rows.push(arr.map(v => (v === undefined ? '' : v))); },
    getRange(a, b, c, d) {
      const numRows = c === undefined ? 1 : c;
      const numCols = d === undefined ? 1 : d;
      return makeRange(sheet, a, b, numRows, numCols);
    },
    getLastColumn() { return sheet.rows.reduce((m, r) => Math.max(m, r.length), 0); },
    getLastRow() { return sheet.rows.length; },
    getDataRange() {
      const cols = Math.max(1, sheet.getLastColumn());
      return makeRange(sheet, 1, 1, Math.max(1, sheet.rows.length), cols);
    },
    deleteRow(idx) { sheet.rows.splice(idx - 1, 1); },
    setFrozenRows() { return sheet; }
  };
  return sheet;
}

function makeMenu(title, allItems) {
  const menu = {
    title,
    addItem(label, handler) { allItems.push({ title, label, handler }); return menu; },
    addSeparator() { return menu; },
    addSubMenu() { return menu; },
    addToUi() { return menu; }
  };
  return menu;
}

function makeUi(promptAnswers) {
  const ui = {
    Button: { OK: 'ok', CANCEL: 'cancel', CLOSE: 'close' },
    ButtonSet: { OK: 'ok', OK_CANCEL: 'ok_cancel', YES_NO: 'yes_no' },
    alerts: [],
    prompts: [],
    alert(title, msg) { ui.alerts.push({ title: String(title || ''), msg: String(msg || '') }); },
    prompt(title, msg) {
      ui.prompts.push({ title: String(title || ''), msg: String(msg || '') });
      const answer = promptAnswers.length ? promptAnswers.shift() : null;
      return {
        getSelectedButton() { return answer === null ? ui.Button.CANCEL : ui.Button.OK; },
        getResponseText() { return answer === null ? '' : String(answer); }
      };
    }
  };
  return ui;
}

// Utilities.formatDate：支援 Code.gs 用到的 yyyy / MM / dd / HH / mm / ss
function formatDate(d, tz, fmt) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return String(fmt)
    .replace('yyyy', dt.getUTCFullYear())
    .replace('MM', p(dt.getUTCMonth() + 1))
    .replace('dd', p(dt.getUTCDate()))
    .replace('HH', p(dt.getUTCHours()))
    .replace('mm', p(dt.getUTCMinutes()))
    .replace('ss', p(dt.getUTCSeconds()));
}

// 忙等：模擬 GAS 每次執行原生呼叫的固定成本（唔用 setTimeout，保持同步語意）
function busyWait(ms) {
  const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  while (process.hrtime.bigint() < end) { /* spin */ }
}

// options:
//   promptAnswers／urlFetchHandler／serviceUrls：見上方說明
//   sourcePath：改為載入另一份 Code.gs（例如 git 取出的舊版，用嚟量「修前」成本）
//   hmacLatencyMs：每次 Utilities.computeHmacSha256Signature() 額外燒幾多毫秒（模擬 GAS 邊界；預設 0）
export function loadCodeGs({ promptAnswers = [], urlFetchHandler = null, serviceUrls = ['https://script.google.com/macros/s/HARNESS/exec'], sourcePath = null, hmacLatencyMs = 0 } = {}) {
  const code = fs.readFileSync(sourcePath || CODE_GS_PATH, 'utf8');

  const ss = {
    sheets: new Map(),
    getSheetByName(name) { return ss.sheets.get(name) || null; },
    insertSheet(name) { const s = makeSheet(name); ss.sheets.set(name, s); return s; },
    getActiveSheet() { return ss.sheets.values().next().value || null; }
  };

  const scriptProps = new Map();
  const ui = makeUi(promptAnswers);
  const scriptServiceCalls = { getUrl: 0 };
  let serviceUrlIndex = 0;
  const menuItems = [];
  ui.createMenu = (title) => makeMenu(title, menuItems);
  const mailOutbox = []; // v8.8：MailApp.sendEmail 寄出的郵件（測試觀測用）
  const scriptCache = new Map(); // v8.9.2：CacheService（票據一次性防重放）
  let scriptLockHeld = false; // v8.9.2：LockService（單執行緒測試環境簡化版）

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, String, Number, Array, Object, Boolean, RegExp, Error, parseInt, parseFloat, isNaN,
    Logger: { log() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ui
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (scriptProps.has(k) ? scriptProps.get(k) : null),
        setProperty: (k, v) => { scriptProps.set(k, String(v)); },
        deleteProperty: (k) => { scriptProps.delete(k); },
        getKeys: () => Array.from(scriptProps.keys())
      })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(algo, str) {
        return Array.from(crypto.createHash('sha256').update(String(str), 'utf8').digest());
      },
      // v8.9.3：登入票據 HMAC 簽／驗 + base64url + newBlob（零回傳本地驗簽用）
      computeHmacSha256Signature(value, key) {
        // 真 GAS 接受 String 或 Byte[] 作 data；PBKDF2 會傳 byte[]，呢度要同 semantics
        // GAS_HMAC_LATENCY_MS：可選的「JS↔Java 邊界」延遲模擬（預設 0＝唔加延遲，行為完全不變）。
        //   真 Apps Script 每次呼叫要過邊界，實測約 0.1–0.3 ms；Node 只需幾微秒。
        //   設了呢個值之後，PBKDF2 的「KDF 次數 × 延遲」就等於真 GAS 的秒數，
        //   所以測試可以用同一個延遲同時量「修前」與「修後」兩份 Code.gs（見 tests/password-kdf.test.mjs）。
        if (sandbox.__hmacCalls !== undefined) sandbox.__hmacCalls++;
        if (sandbox.__hmacLatencyMs > 0) busyWait(sandbox.__hmacLatencyMs);
        const v = Array.isArray(value) ? Buffer.from(value.map(b => b & 0xFF)) : Buffer.from(String(value), 'utf8');
        return Array.from(crypto.createHmac('sha256', String(key)).update(v).digest());
      },
      base64EncodeWebSafe(str) {
        return Buffer.from(String(str), 'utf8').toString('base64url');
      },
      base64DecodeWebSafe(str) {
        return Array.from(Buffer.from(String(str).replace(/=+$/, ''), 'base64url'));
      },
      newBlob(bytes) {
        const arr = Array.isArray(bytes) ? Uint8Array.from(bytes.map(b => b & 0xFF)) : bytes;
        return { getDataAsString: () => Buffer.from(arr).toString('utf8') };
      },
      getUuid: () => crypto.randomUUID(),
      formatDate
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({
        setMimeType() { return this; },
        getContent: () => s
      })
    },
    MailApp: {
      sendEmail(to, subject, body) {
        mailOutbox.push({ to: String(to), subject: String(subject), body: String(body) });
      },
      getRemainingDailyQuota() { return 100; }
    },
    // 忘記密碼發信測試（testPasswordResetMail）用：預設冇執行者電郵，測試可用 setSessionEmail 注入
    Session: {
      getActiveUser: () => ({ getEmail: () => String(sandbox.__sessionEmail || '') })
    },
    ScriptApp: { getService: () => ({ getUrl: () => { scriptServiceCalls.getUrl++; const values = serviceUrls.length ? serviceUrls : ['']; return values[serviceUrlIndex++ % values.length]; } }) },
    // v8.9.2：LockService + CacheService（handleSuperTicketLogin 票據一次性保護）
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (scriptLockHeld) return false; scriptLockHeld = true; return true; },
        releaseLock: () => { scriptLockHeld = false; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (scriptCache.has(String(k)) ? scriptCache.get(String(k)) : null),
        put: (k, v) => { scriptCache.set(String(k), String(v)); },
        remove: (k) => { scriptCache.delete(String(k)); }
      })
    },
    // v8.9：UrlFetchApp（中央驗票連線）。測試可注入 urlFetchHandler(url, opts) →
    // { code, content }；未注入時預設連線失敗（等同沙箱無外網）。
    UrlFetchApp: {
      fetch(url, opts) {
        const o = opts || {};
        sandbox.__urlFetchLog.push({ url: String(url), method: o.method || 'get', payload: o.payload || null });
        if (!urlFetchHandler) throw new Error('Exception: 模擬環境未設定外部連線（DNS error）');
        const r = urlFetchHandler(String(url), o);
        const code = (r && r.code) || 200;
        const content = String((r && r.content) || '');
        return { getResponseCode: () => code, getContentText: () => content };
      }
    }
  };
  sandbox.__urlFetchLog = [];
  // GAS 邊界延遲模擬（預設 0：唔影響任何既有測試的語意或時間）
  sandbox.__hmacLatencyMs = Math.max(0, Number(hmacLatencyMs) || 0);
  sandbox.__hmacCalls = 0;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const exported = `
;globalThis.__api = {
  initializeSheets, showApiKey, menuShowLinkCredentials, onOpen, removeSuperAdminRows, handleLogin, getUser, getAllUsers,
  getMembers, getApiKey, doPost, doGet, isSuperAdminId, verifySuperTicket, authorizeConnection, testPasswordResetMail,
  // GS 5.3.0 測試內省用：唯一更新入口（選單掣）、初始化狀態警告、/exec 正規化
  menuInitializeSheets, initStatusWarningLines_, canonicalServiceUrl_, gsVersionInfo_,
  // 測試內省用：保留帳號識別字（唯一宣告在 Code.gs），用以驗證名單過濾與防護邏輯
  SUPER_ADMIN_ID,
  // 學制／allowed_badges 測試用：發 token、讀取生成的項目目錄與角色預設
  createToken, ITEM_CATALOG_, DEFAULT_PERMS_,
  // A3/A5 測試內省用：密碼雜湊／驗證與匯入
  hashPassword, hashPasswordV2, verifyPassword, isLegacyPasswordHash_, upsertUser,
  // GS 5.4.0 測試內省用：PBKDF2 迭代常數／解析／升級判斷／單行定位／效能測試／慢登入 log。
  // 用 typeof 守衛：同一個 harness 亦要載入「修前」的舊版 Code.gs（例如 tests/measure-login-kdf.mjs），
  // 嗰啲版本冇呢啲符號，唔可以因此拋 ReferenceError。
  PBKDF2_ITERATIONS: (typeof PBKDF2_ITERATIONS !== 'undefined' ? PBKDF2_ITERATIONS : undefined),
  PBKDF2_MIN_ITERATIONS: (typeof PBKDF2_MIN_ITERATIONS !== 'undefined' ? PBKDF2_MIN_ITERATIONS : undefined),
  PBKDF2_MAX_ITERATIONS: (typeof PBKDF2_MAX_ITERATIONS !== 'undefined' ? PBKDF2_MAX_ITERATIONS : undefined),
  parsePbkdf2Hash_: (typeof parsePbkdf2Hash_ !== 'undefined' ? parsePbkdf2Hash_ : undefined),
  needsPasswordRehash_: (typeof needsPasswordRehash_ !== 'undefined' ? needsPasswordRehash_ : undefined),
  locateLoginRow_: (typeof locateLoginRow_ !== 'undefined' ? locateLoginRow_ : undefined),
  isDefaultPassword_: (typeof isDefaultPassword_ !== 'undefined' ? isDefaultPassword_ : undefined),
  benchmarkPasswordKdf: (typeof benchmarkPasswordKdf !== 'undefined' ? benchmarkPasswordKdf : undefined),
  menuBenchmarkPasswordKdf: (typeof menuBenchmarkPasswordKdf !== 'undefined' ? menuBenchmarkPasswordKdf : undefined),
  logSlowLogin_: (typeof logSlowLogin_ !== 'undefined' ? logSlowLogin_ : undefined),
  // GS 5.4.0 ROVERBOOK 對接：手動測試用
  handleBookSync: (typeof handleBookSync !== 'undefined' ? handleBookSync : undefined),
  handleBookAward: (typeof handleBookAward !== 'undefined' ? handleBookAward : undefined),
  handleBookPull: (typeof handleBookPull !== 'undefined' ? handleBookPull : undefined),
  handleBookRoster: (typeof handleBookRoster !== 'undefined' ? handleBookRoster : undefined),
  menuBookStatus: (typeof menuBookStatus !== 'undefined' ? menuBookStatus : undefined),
  bookStats_: (typeof bookStats_ !== 'undefined' ? bookStats_ : undefined),
  __kdfStats: () => ({ calls: (typeof __kdfCalls_ !== 'undefined' ? __kdfCalls_ : 0), iterations: (typeof __kdfIterations_ !== 'undefined' ? __kdfIterations_ : 0) }),
  __resetKdfStats: () => { if (typeof __kdfCalls_ !== 'undefined') { __kdfCalls_ = 0; __kdfIterations_ = 0; } },
  // 重設密碼授權測試用：直接以已驗證管理員物件呼叫（等同 token／上游簽章兩條入口的授權檢查）
  handleResetPassword
};`;
  vm.runInContext(code + exported, ctx, { filename: 'Code.gs' });

  const api = sandbox.__api;
  const jsonOf = (resp) => JSON.parse(resp.getContent());

  return {
    api,
    ss,
    ui,
    scriptProps,
    scriptServiceCalls,
    menuItems,
    mailOutbox,
    mailApp: sandbox.MailApp,               // 測試可替換 sendEmail 模擬發信失敗
    setSessionEmail: (e) => { sandbox.__sessionEmail = String(e || ''); }, // testPasswordResetMail 用
    urlFetchLog: sandbox.__urlFetchLog,
    hmacCalls: () => sandbox.__hmacCalls,
    resetHmacCalls: () => { sandbox.__hmacCalls = 0; },
    setHmacLatency: (ms) => { sandbox.__hmacLatencyMs = Math.max(0, Number(ms) || 0); },
    // 走真實 doPost() 路由（與部署後的 /exec 相同路徑）
    call: (body) => jsonOf(api.doPost({ postData: { contents: JSON.stringify(body) } })),
    get: (parameter) => jsonOf(api.doGet({ parameter }))
  };
}
