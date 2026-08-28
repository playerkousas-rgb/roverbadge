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

export function loadCodeGs({ promptAnswers = [] } = {}) {
  const code = fs.readFileSync(CODE_GS_PATH, 'utf8');

  const ss = {
    sheets: new Map(),
    getSheetByName(name) { return ss.sheets.get(name) || null; },
    insertSheet(name) { const s = makeSheet(name); ss.sheets.set(name, s); return s; },
    getActiveSheet() { return ss.sheets.values().next().value || null; }
  };

  const scriptProps = new Map();
  const ui = makeUi(promptAnswers);

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
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/HARNESS/exec' }) }
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const exported = `
;globalThis.__api = {
  initializeSheets, checkSuperAdmin, removeSuperAdminRows, handleLogin, getUser, getAllUsers,
  getMembers, getApiKey, doPost, doGet,
  // 測試內省用：直接讀 Code.gs 內的超管憑證，以便驗證「超管確實存在且可用」，
  // 同時驗證這份憑證不會經任何 alert / API 回應 / 名單流出
  getSuperAdminUser, getSuperAdminPass
};`;
  vm.runInContext(code + exported, ctx, { filename: 'Code.gs' });

  const api = sandbox.__api;
  const jsonOf = (resp) => JSON.parse(resp.getContent());

  return {
    api,
    ss,
    ui,
    scriptProps,
    // 走真實 doPost() 路由（與部署後的 /exec 相同路徑）
    call: (body) => jsonOf(api.doPost({ postData: { contents: JSON.stringify(body) } })),
    get: (parameter) => jsonOf(api.doGet({ parameter }))
  };
}
