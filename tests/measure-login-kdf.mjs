// ============================================================
// 實測腳本：登入 KDF 成本「修前 / 修後」對照（GS 5.3.0 → 5.4.0）
//
// 為什麼要有呢個腳本（唔可以靠推論）：
//   「登入要幾多秒」＝ KDF 次數 × 每次迭代的 hmac 呼叫數 × GAS 的 JS↔Java 邊界成本。
//   前兩項係「程式碼的屬性」，可以 100% 精確量（本腳本用 gas-harness 真實跑 Code.gs，
//   數到每一條登入路徑實際做咗幾多次 Utilities.computeHmacSha256Signature()）。
//   第三項係「Apps Script 執行環境的屬性」，Node 度唔到 —— 呢度用兩個來源約束佢：
//     ① scoutbadge 2026-11-04 事故實測：120,000 次 ≈ 12–20 秒 → 每次呼叫 0.1–0.17 ms
//     ② 官方文件／社群一致說法：每次 native 呼叫 0.1–0.3 ms
//   所以本腳本輸出「hmac 呼叫次數」＋「0.10／0.15／0.30 ms 三個估值下的秒數」，
//   唔會假裝自己量到真 GAS 的毫秒（真數字請喺 Apps Script 跑 benchmarkPasswordKdf()）。
//
// 用法：
//   node tests/measure-login-kdf.mjs            # 對照 HEAD（修前）與工作區（修後）
//   node tests/measure-login-kdf.mjs --base=<sha>   # 指定「修前」版本
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { loadCodeGs, CODE_GS_PATH } from './gas-harness.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const argBase = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1] || 'HEAD';

// 邊界成本估值（ms / 次 native 呼叫）
const LATENCIES = [
  { label: '0.10 ms', ms: 0.10 },
  { label: '0.15 ms', ms: 0.15 },
  { label: '0.30 ms', ms: 0.30 }
];
const PROXY_LIMIT_MS = 45000; // api/proxy.js ROVERBADGE_PROXY_TIMEOUT_MS 預設值

function oldSourcePath() {
  try {
    const src = execFileSync('git', ['show', `${argBase}:apps-script/Code.gs`], { cwd: repoRoot, encoding: 'utf8' });
    const p = path.join(os.tmpdir(), `roverbadge-codegs-${argBase.replace(/[^A-Za-z0-9]/g, '_')}.gs`);
    fs.writeFileSync(p, src);
    return p;
  } catch (e) {
    return null;
  }
}

// 建立一個「真實旅團」形狀的 Users 表：預設管理員（pbkdf2）＋ 11 個已重設密碼的帳號（pbkdf2 迭代由該版本決定）
function buildTroop(env, version) {
  env.api.initializeSheets();
  const users = env.ss.sheets.get('Users');
  const newHash = (pw) => {
    const h = env.api.hashPasswordV2(pw);
    return h;
  };
  for (let i = 1; i <= 11; i++) {
    const row = new Array(14).fill('');
    row[0] = '30000000' + String(i).padStart(2, '0');
    row[1] = '成員' + i;
    row[2] = `m${i}@example.org`;
    row[3] = 'member';
    row[4] = newHash('Pw!' + i + 'Abcd');
    row[6] = false;
    row[11] = 'active';
    row[12] = '';
    row[13] = false;
    users.appendRow(row);
  }
  return {
    users,
    iterOf: (ymis) => {
      const r = users.rows.find(x => String(x[0]) === String(ymis));
      return r ? parseInt(String(r[4]).split('$')[1] || '0', 10) || 0 : 0;
    }
  };
}

function measure(label, sourcePath) {
  const env = loadCodeGs(sourcePath ? { sourcePath } : {});
  const T = buildTroop(env, label);
  const rows = [];
  const kdfIter = env.api.PBKDF2_ITERATIONS || (parseInt(String(env.ss.sheets.get('Users').rows[1][4]).split('$')[1], 10) || 0);

  const run = (name, fn, expectOk = true) => {
    env.resetHmacCalls();
    const t0 = Date.now();
    const out = fn();
    const ms = Date.now() - t0;
    rows.push({ name, hmacCalls: env.hmacCalls(), nodeMs: ms, ok: !!(out && out.success), expectOk, error: (out && out.error) || '' });
  };

  // ① 新種（本版/該版本）pbkdf2 帳號，正確密碼
  run('① 新種 pbkdf2 帳號（第 2 行，密碼正確）', () => env.call({ action: 'login', login_id: '1111111111', password: 'changeme' }));
  // ② 舊 64-hex 帳號，正確密碼（會觸發透明升級）
  const legacyRow = new Array(14).fill('');
  legacyRow[0] = '3999999999'; legacyRow[1] = '舊帳號'; legacyRow[2] = 'legacy@example.org';
  legacyRow[3] = 'member'; legacyRow[4] = sha256('LegacyPw!1'); legacyRow[6] = false;
  legacyRow[11] = 'active'; legacyRow[12] = ''; legacyRow[13] = false;
  env.ss.sheets.get('Users').appendRow(legacyRow);
  run('② 舊 64-hex 帳號（密碼正確，含透明升級）', () => env.call({ action: 'login', login_id: '3999999999', password: 'LegacyPw!1' }));
  // ③ 排第 10 行 / 第 30 行之後的帳號
  const rowIdx = (ymis) => env.ss.sheets.get('Users').rows.findIndex(r => String(r[0]) === String(ymis)) + 1;
  run(`③ 排第 ${rowIdx('3000000008')} 行的帳號（密碼正確）`, () => env.call({ action: 'login', login_id: '3000000008', password: 'Pw!8Abcd' }));
  // 補到 30 個帳號之後再登入最後一個
  for (let i = 12; i <= 30; i++) {
    const r = new Array(14).fill('');
    r[0] = '30000000' + String(i).padStart(2, '0'); r[1] = '成員' + i; r[2] = `m${i}@example.org`;
    r[3] = 'member'; r[4] = env.api.hashPasswordV2('Pw!' + i + 'Abcd'); r[6] = false; r[11] = 'active'; r[12] = ''; r[13] = false;
    env.ss.sheets.get('Users').appendRow(r);
  }
  run(`③ 排第 ${rowIdx('3000000030')} 行的帳號（密碼正確）`, () => env.call({ action: 'login', login_id: '3000000030', password: 'Pw!30Abcd' }));
  // ④ 錯密碼 / 帳號不存在
  run('④ 錯密碼（帳號排第 ' + rowIdx('3000000030') + ' 行）', () => env.call({ action: 'login', login_id: '3000000030', password: 'wrong-password' }), false);
  run('④ 帳號不存在（dummy KDF）', () => env.call({ action: 'login', login_id: '8888888888', password: 'whatever' }), false);

  return { label, sourcePath: sourcePath || CODE_GS_PATH, iterations: kdfIter, rows };
}

function fmtTable(res) {
  const lines = [];
  lines.push(`\n===== ${res.label} =====`);
  lines.push(`PBKDF2 迭代（該版本寫入格式）：${res.iterations}`);
  lines.push('路徑'.padEnd(42) + 'hmac 呼叫'.padStart(12) + 'Node 實測'.padStart(12) + LATENCIES.map(l => (`@${l.label}`).padStart(11)).join(''));
  for (const r of res.rows) {
    const cells = LATENCIES.map(l => ((r.hmacCalls * l.ms) / 1000).toFixed(1) + 's').map(s => s.padStart(11)).join('');
    lines.push(String(r.name).padEnd(42) + String(r.hmacCalls).padStart(12) + (r.nodeMs + 'ms').padStart(12) + cells + ((r.ok === r.expectOk) ? '' : '   ⚠️ 結果不符預期：' + (r.error || 'success')));
  }
  lines.push('（@0.15 ms 為 scoutbadge 事故回推值；任何一條 > ' + (PROXY_LIMIT_MS / 1000) + ' 秒即等於用戶見到「連線逾時」）');
  return lines.join('\n');
}

const before = oldSourcePath();
const results = [];
if (before) results.push(measure(`修前（${argBase} = 上一個已提交版本）`, before));
else console.log('⚠️  取不到舊版 Code.gs（非 git 環境），只量修後數字');
results.push(measure('修後（工作區，本版）', null));

results.forEach(r => console.log(fmtTable(r)));

// 摘要表
console.log('\n===== 摘要（@0.15 ms／次）=====');
const pick = (res, needle) => res.rows.find(r => r.name.indexOf(needle) >= 0) || { hmacCalls: 0 };
const secs = (calls) => ((calls * 0.15) / 1000).toFixed(1) + 's';
const verdict = (calls) => ((calls * 0.15) > PROXY_LIMIT_MS ? '❌ 逾時' : '✅ 正常');
if (before) {
  for (const p of ['①', '②', '排第 10 行', '排第 33 行', '④ 錯密碼', '④ 帳號不存在']) {
    const b = pick(results[0], p); const a = pick(results[1], p);
    console.log(`${p.padEnd(10)} 修前 ${secs(b.hmacCalls).padStart(6)} ${verdict(b.hmacCalls).padEnd(8)} → 修後 ${secs(a.hmacCalls).padStart(6)} ${verdict(a.hmacCalls)}`);
  }
} else {
  for (const r of results[0].rows) console.log(`${r.name.padEnd(42)} ${secs(r.hmacCalls)} ${verdict(r.hmacCalls)}`);
}
console.log('\n真數字請喺 Apps Script 執行 benchmarkPasswordKdf()（選單「🔗 旅系統 → ⏱️ 密碼雜湊效能測試」）。');
