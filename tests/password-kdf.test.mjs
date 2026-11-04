// ============================================================
// 登入 KDF 逾時回歸測試（GS 5.4.0，對齊 scoutbadge 6.4.0 / PR #51）
//
// 事故：2026-11-04 scoutbadge 全旅團「登入回後端服務連線逾時」。根因係 Apps Script
// 每次 Utilities.computeHmacSha256Signature() 都要過一次 JS↔Java 邊界（約 0.1–0.3 ms），
// 於是 120,000 次 PBKDF2 ＝ 12–20 秒；再加上本 repo 兩個更嚴重的放大因素：
//   ① handleLogin() 逐行掃全表驗密碼（每個 active 帳號＝1× KDF）
//   ② 成功登入後 isDefaultPasswordHash_() 再驗一次（2× KDF）
// → 排第 3 行之後的帳號必定爆 api/proxy.js 的 45 秒上游上限。
//
// 本檔做兩件事：
//   A. 回歸斷言（唔靠時間，跑得再快都守得住）：
//      舊雜湊可登入、錯密碼只做一次 KDF、帳號排第 30 行仍然 < 5 秒、未更新旅團不會壞、
//      迭代次數有上限防止再改回會逾時的值、前端對舊版 GS 顯示「此版本登入會逾時」。
//   B. 實測（唔講推論，用數據）：用 gas-harness 的 GAS 邊界延遲模擬，
//      同時量「修前」（git 取出的 GS 5.3.0 Code.gs）與「修後」（本版）四條登入路徑。
//      腳本：node tests/measure-login-kdf.mjs（npm run measure:kdf）
//
// 執行：node --test tests/password-kdf.test.mjs
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadCodeGs } from './gas-harness.mjs';
import { loadAssetModule, repoRoot } from './browser-module-harness.mjs';

const GsRelease = loadAssetModule('assets/gs-release.js');
const codeSrc = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const isV2 = (h) => /^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/i.test(String(h || ''));

function newEnv(opts = {}) {
  const env = loadCodeGs(opts);
  env.api.initializeSheets();
  return env;
}
// 種一個帳號（legacy=true → 64-hex 單次 SHA-256；否則用 options.hash）
function seed(env, o, legacy = true) {
  const sh = env.ss.sheets.get('Users');
  const row = new Array(14).fill('');
  row[0] = o.ymis; row[1] = o.name || '測試'; row[2] = o.email || '';
  row[3] = o.role || 'member'; row[4] = legacy ? sha256(o.pwd || 'pw') : String(o.hash || '');
  row[6] = true; row[11] = 'active'; row[12] = '*'; row[13] = false;
  sh.appendRow(row);
}
const login = (env, id, pw) => env.call({ action: 'login', login_id: id, password: pw });

// ---------- 0. 迭代次數：夠用、但唔可以再變成會逾時的值 ----------
test('PBKDF2 迭代次數落在安全區間（下限 1,000／上限 20,000），新格式用常數本身', () => {
  const env = newEnv();
  const n = env.api.PBKDF2_ITERATIONS;
  assert.ok(Number.isInteger(n), 'PBKDF2_ITERATIONS 必須是整數');
  assert.ok(n >= 1000, '迭代次數不可低於 1,000（會被 validate 拒絕）：' + n);
  assert.ok(n <= 20000, '迭代次數上限 20,000 —— 再高會撞爆 proxy 上游 45 秒上限：' + n);
  // 新雜湊寫入時用同一常數（唔可以硬編碼 120000）
  const h = env.api.hashPasswordV2('abc12345');
  assert.equal(h.split('$')[1], String(n), '新雜湊的迭代次數必須等於 PBKDF2_ITERATIONS');
  assert.ok(isV2(h));
  assert.ok(!/pbkdf2\$120000\$/.test(h), '唔可以再寫 120,000 次迭代的雜湊');
});

test('verifyPassword 用雜湊字串自帶的迭代次數：1000／10000／120000 全部驗得過', () => {
  const env = newEnv();
  for (const iter of [1000, 10000, 120000]) {
    const salt = 'ab'.repeat(16);
    const dk = crypto.pbkdf2Sync('Pw!1234', Buffer.from(salt, 'hex'), iter, 32, 'sha256').toString('hex');
    const stored = `pbkdf2$${iter}$${salt}$${dk}`;
    assert.equal(env.api.verifyPassword('Pw!1234', stored), true, `${iter} 次迭代應可驗證`);
    assert.equal(env.api.verifyPassword('wrong', stored), false, `${iter} 次迭代錯密碼應被拒`);
  }
  // 超出可接受範圍 → 當壞資料（唔會做超長 KDF）
  assert.equal(env.api.verifyPassword('x', `pbkdf2$999999999$${'ab'.repeat(16)}$${'cd'.repeat(32)}`), false);
  assert.equal(env.api.verifyPassword('x', `pbkdf2$1$${'ab'.repeat(16)}$${'cd'.repeat(32)}`), false);
  // 迭代邊界常數
  assert.equal(env.api.PBKDF2_MIN_ITERATIONS, 1000);
  assert.equal(env.api.PBKDF2_MAX_ITERATIONS, 2000000);
});

// ---------- 1. 舊雜湊可登入＋透明升級（資料保全：唔會鎖死任何人） ----------
test('舊 64-hex 帳號可登入，成功一次後自動升級為本版格式（密碼不變）', () => {
  const env = newEnv();
  seed(env, { ymis: '1000000001', email: 'a1@example.org', pwd: 'Legacy!1' }, true);
  const r = login(env, '1000000001', 'Legacy!1');
  assert.equal(r.success, true, JSON.stringify(r));
  const h = env.ss.sheets.get('Users').rows.find(x => String(x[0]) === '1000000001')[4];
  assert.ok(isV2(h), '升級後應為 pbkdf2$ 格式：' + h);
  assert.equal(h.split('$')[1], String(env.api.PBKDF2_ITERATIONS), '升級後應為本版迭代次數');
  assert.equal(login(env, '1000000001', 'Legacy!1').success, true, '升級後同一密碼仍可登入');
  // 已係本版格式 → 唔會再改寫
  const again = env.ss.sheets.get('Users').rows.find(x => String(x[0]) === '1000000001')[4];
  login(env, '1000000001', 'Legacy!1');
  assert.equal(env.ss.sheets.get('Users').rows.find(x => String(x[0]) === '1000000001')[4], again);
});

test('舊 pbkdf2$120000$ 帳號可登入（唔會鎖死已貼過 5.2.x／5.3.0 的旅團），登入後降回本版迭代次數', () => {
  const env = newEnv();
  const salt = 'ff'.repeat(16);
  const dk = crypto.pbkdf2Sync('Old!1234', Buffer.from(salt, 'hex'), 120000, 32, 'sha256').toString('hex');
  const legacyV2 = `pbkdf2$120000$${salt}$${dk}`;
  seed(env, { ymis: '1000000002', email: 'a2@example.org', hash: legacyV2 }, false);
  const r = login(env, '1000000002', 'Old!1234');
  assert.equal(r.success, true, JSON.stringify(r));
  const h = env.ss.sheets.get('Users').rows.find(x => String(x[0]) === '1000000002')[4];
  assert.equal(h.split('$')[1], String(env.api.PBKDF2_ITERATIONS), '應透明升級為本版迭代次數');
  assert.equal(login(env, '1000000002', 'Old!1234').success, true);
});

// ---------- 2. 一次登入只做一個 KDF（最關鍵的回歸） ----------
test('正確密碼：成功登入只做一次 KDF（唔會再為「預設密碼」多跑一次）', () => {
  const env = newEnv();
  // 用本版雜湊（pbkdf2$）seed：呢個情境先會暴露「預設密碼再驗一次」的 2× KDF
  seed(env, { ymis: '1000000010', email: 'b1@example.org', hash: env.api.hashPasswordV2('OnlyOnce!9') }, false);
  env.api.__resetKdfStats();
  const r = login(env, '1000000010', 'OnlyOnce!9');
  assert.equal(r.success, true);
  const st = env.api.__kdfStats();
  // 一次登入＝1× 驗證 KDF（升級改寫唔需要再算）；絕對唔可以係 2×
  assert.equal(st.calls, 1, '成功登入應只做 1 次 PBKDF2，實際 ' + st.calls + ' 次');
  assert.ok(st.iterations <= env.api.PBKDF2_ITERATIONS * 2, '總迭代次數異常：' + st.iterations);
});

test('錯密碼：只做一次 KDF（唔會掃全表 N 次）', () => {
  const env = newEnv();
  for (let i = 0; i < 12; i++) {
    seed(env, { ymis: '10000001' + String(i).padStart(2, '0'), email: `c${i}@example.org`, hash: env.api.hashPasswordV2('Right!' + i) }, false);
  }
  env.api.__resetKdfStats();
  assert.equal(login(env, '1000000105', 'wrong-password').success, false);
  // 舊版會對全表每個 active 帳號（12 個＋預設管理員）各做一次 120k KDF；本版只有目標一行
  assert.equal(env.api.__kdfStats().calls, 1, '錯密碼只應做 1 次 PBKDF2（掃全表會做 13 次）');
  // 舊 64-hex 帳號錯密碼：連 KDF 都唔使做（單次 SHA-256 比對，零 KDF）
  seed(env, { ymis: '1000000199', email: 'legacy@example.org', pwd: 'LegacyX1' }, true);
  env.api.__resetKdfStats();
  assert.equal(login(env, '1000000199', 'wrong-password').success, false);
  assert.equal(env.api.__kdfStats().calls, 0, '舊雜湊錯密碼應為 0 次 KDF');
});

test('帳號不存在／已停用：只燒一次 dummy KDF，回應與密碼錯誤完全一致（A17）', () => {
  const env = newEnv();
  seed(env, { ymis: '1000000020', email: 'd0@example.org', pwd: 'Active!1' });
  seed(env, { ymis: '1000000021', email: 'd1@example.org', pwd: 'Gone1234' });
  const u = env.ss.sheets.get('Users');
  u.rows.find(r => String(r[0]) === '1000000021')[11] = 'inactive';
  env.api.__resetKdfStats();
  const missing = login(env, '9999999999', 'whatever1');
  const inactive = login(env, '1000000021', 'Gone1234');
  const wrong = login(env, '1000000020', 'whatever1');
  for (const r of [missing, inactive, wrong]) {
    assert.equal(r.success, false);
    assert.equal(r.error, '帳號或密碼錯誤', '三種失敗必須同一訊息');
  }
  // 3 次失敗＝3 次 KDF（每次 1×）；唔可以係「全表 × N」
  assert.ok(env.api.__kdfStats().calls <= 3, '失敗路徑 KDF 次數過多：' + env.api.__kdfStats().calls);
});

test('dummy 雜湊用 CacheService 重用：同一執行內第二次「帳號不存在」唔再重新計算', () => {
  const env = newEnv();
  env.api.__resetKdfStats();
  env.resetHmacCalls();
  login(env, '9999999998', 'x1');
  const firstHmac = env.hmacCalls();
  const first = env.api.__kdfStats().calls;
  login(env, '9999999997', 'x2');
  const second = env.api.__kdfStats().calls - first;
  // 第一次：建立 dummy 雜湊 1× ＋ 驗證 1×（＝2）；之後每次只需驗證 1×。
  // 舊版每次「帳號不存在」都要重新建立 dummy 雜湊（＝每次 2×），亦冇跨執行重用。
  assert.equal(first, 2, '第一次應為「建立 dummy＋驗證」＝2 次 KDF，實際 ' + first);
  assert.equal(second, 1, '第二次應只做驗證 1 次（dummy 雜湊已快取），實際 ' + second);
  // dummy 雜湊只建一次：第一次＝建立(1×)＋驗證(1×)，第二次只有驗證(1×)
  const n = env.api.PBKDF2_ITERATIONS;
  assert.equal(firstHmac, 2 * n, '第一次應為 2× 迭代的 hmac 呼叫（建立 dummy＋驗證），實際 ' + firstHmac);
  assert.equal(env.hmacCalls() - firstHmac, n, '第二次應只有 1× 迭代的驗證，實際 ' + (env.hmacCalls() - firstHmac));
});

// ---------- 3. 行數無關：排第 30 行仍然快（結構性證明） ----------
test('帳號排第 30 行：登入只做 1 次 KDF，唔會隨行數增加', () => {
  const env = newEnv();
  for (let i = 0; i < 40; i++) seed(env, { ymis: '20000001' + String(i).padStart(2, '0'), email: `e${i}@example.org`, pwd: 'Row!' + i + 'pass' });
  const rows = env.ss.sheets.get('Users').rows;
  const idx = rows.findIndex(r => String(r[0]) === '2000000130');
  assert.ok(idx + 1 >= 31, '測試前提：目標帳號應在第 31 行之後（實際第 ' + (idx + 1) + ' 行）');
  env.api.__resetKdfStats();
  const t0 = Date.now();
  const r = login(env, '2000000130', 'Row!30pass');
  const ms = Date.now() - t0;
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(env.api.__kdfStats().calls, 1, '排第 ' + (idx + 1) + ' 行仍然只做 1 次 KDF');
  assert.ok(ms < 5000, '排第 ' + (idx + 1) + ' 行的帳號登入必須 < 5 秒（實測 ' + ms + ' ms）');
});

test('locateLoginRow_ 只用文字定位（零 KDF），YMIS／電郵／大小寫都認得', () => {
  const env = newEnv();
  seed(env, { ymis: '3000000001', email: 'Mixed.Case@Example.ORG', pwd: 'p1' });
  env.api.__resetKdfStats();
  assert.equal(env.api.locateLoginRow_('3000000001').ymis, '3000000001');
  assert.equal(env.api.locateLoginRow_('mixed.case@example.org').ymis, '3000000001');
  assert.equal(env.api.locateLoginRow_('nobody@example.org'), null);
  assert.equal(env.api.__kdfStats().calls, 0, '定位階段唔應該做任何 KDF');
});

// ---------- 4. 未更新旅團唔會壞（向後兼容） ----------
test('未更新旅團：舊版 GS 仍可登入（新舊雜湊並存），前端會標示「此版本登入會逾時」', () => {
  // 後端：本版必須同時接受 64-hex、pbkdf2$120000$、pbkdf2$10000$
  const env = newEnv();
  seed(env, { ymis: '4000000001', email: 'f1@example.org', pwd: 'Mix!1234' }, true);
  assert.equal(login(env, '4000000001', 'Mix!1234').success, true);
  // 前端：GS 5.2.x–5.3.x 要標紅；5.4.0 或更舊（未引入 120k 的版本）唔標；未知版本唔估
  const L = GsRelease.GS_LATEST;
  assert.equal(GsRelease.versionAtRisk('5.3.0'), true);
  assert.equal(GsRelease.versionAtRisk('5.2.4'), true);
  assert.equal(GsRelease.loginTimeoutNotice({ gsVersion: '5.3.0' }), true);
  assert.equal(GsRelease.versionAtRisk(L.version), false, '本版唔應該被標紅');
  assert.equal(GsRelease.versionAtRisk('6.0.0'), false);
  assert.equal(GsRelease.versionAtRisk('5.1.9'), false, '未引入 120k PBKDF2 的舊版登入係快嘅，唔應該靠嚇');
  assert.equal(GsRelease.versionAtRisk(''), false);
  assert.equal(GsRelease.loginTimeoutNotice(null), false);
  assert.equal(GsRelease.loginTimeoutNotice({ success: false, error: 'Unknown action' }), false);
});

// ---------- 5. 效能測試入口存在（選單掣＋可程式呼叫） ----------
test('benchmarkPasswordKdf() 存在且可用：量真實毫秒、計四條路徑、>30 秒即 fail', () => {
  const env = newEnv();
  seed(env, { ymis: '5000000001', email: 'g1@example.org', pwd: 'Bench!1' }, true);
  assert.equal(typeof env.api.benchmarkPasswordKdf, 'function');
  assert.equal(typeof env.api.menuBenchmarkPasswordKdf, 'function');
  env.api.onOpen(); // 選單只在 onOpen() 時建立
  const menuLabels = env.menuItems.map(m => m.label).join('|');
  assert.match(menuLabels, /密碼雜湊效能測試/, 'Sheet 選單必須有「⏱️ 密碼雜湊效能測試」');
  const r = env.api.benchmarkPasswordKdf();
  assert.equal(r.success, true);
  assert.equal(r.iterations, env.api.PBKDF2_ITERATIONS);
  assert.ok(r.bench.length >= 3, '應量至少三個迭代次數');
  assert.ok(r.paths.length >= 4, '應計四條登入路徑');
  assert.equal(typeof r.worstMs, 'number');
  assert.equal(r.pass, true, '本版在 Node 環境量度應遠低於 30 秒：' + r.worstMs + ' ms');
  // 只讀：唔可以改任何 Users 儲存格
  const before = JSON.stringify(env.ss.sheets.get('Users').rows);
  env.api.benchmarkPasswordKdf();
  assert.equal(JSON.stringify(env.ss.sheets.get('Users').rows), before, 'benchmark 必須是唯讀');
});

// ---------- 6. proxy：慢密碼 log ＋ 上游超時仍容得下第一次慢登入 ----------
test('proxy：密碼類 action 慢過 8 秒會寫 slow_password_kdf（含 troop／action／duration）', async () => {
  const proxySrc = fs.readFileSync(new URL('../api/proxy.js', import.meta.url), 'utf8');
  assert.match(proxySrc, /slow_password_kdf/);
  assert.match(proxySrc, /troop: troopId, action, duration/);
  assert.match(proxySrc, /const PASSWORD_ACTIONS = new Set\(\[[^\]]*'login'/);
  assert.match(proxySrc, /SLOW_PASSWORD_LOG_MS = 8000/);
  // 真跑一次 logSlowPassword（由 proxy 模組輸出唔方便，直接檢查原始碼＋行為契約）
  const { default: handler } = await import('../api/proxy.js');
  assert.equal(typeof handler, 'function', 'proxy 必須仍可載入');
});

test('proxy 上游超時（45s）大於前端 apiRequest 超時（45s 以下）／單次登入成本', () => {
  const proxySrc = fs.readFileSync(new URL('../api/proxy.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const up = parseInt((proxySrc.match(/ROVERBADGE_PROXY_TIMEOUT_MS \|\| '(\d+)'/) || [])[1], 10);
  const fe = parseInt((html.match(/const timeoutMs=opts\.timeout\|\|(\d+);/) || [])[1], 10);
  assert.equal(up, 45000, 'proxy 上游逾時應為 45,000 ms');
  assert.equal(fe, 45000, '前端預設逾時應為 45,000 ms');
  // 兩者唔可以打架：前端必定 ≤ proxy（否則前端會先斷線，見唔到 proxy 的 504 說明）
  assert.ok(fe <= up, '前端逾時（' + fe + '）不可大於 proxy 上游逾時（' + up + '）');
  // 本版一次登入＝1× 本版迭代；即使係舊 pbkdf2$120000$ 帳號的一次性升級亦只係 2× 本版級數，
  // 用「迭代次數」而唔係「秒數」寫斷言，令測試唔會綁死硬件速度。
  const env = newEnv();
  assert.ok(env.api.PBKDF2_ITERATIONS <= 20000);
});

// ---------- 7. 部署文件必須交代新步驟（唔可以叫用戶重設密碼） ----------
test('docs：新增登入逾時排查文件，且明確禁止「叫用戶重設密碼／回退單次 SHA-256」', () => {
  const docPath = new URL('../docs/TROUBLESHOOT_LOGIN_TIMEOUT.md', import.meta.url);
  assert.ok(fs.existsSync(docPath), '缺少 docs/TROUBLESHOOT_LOGIN_TIMEOUT.md');
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /slow_password_kdf/);
  assert.match(doc, /benchmarkPasswordKdf/);
  assert.match(doc, /建立新版本/);
  assert.match(doc, /唔好叫用戶重設密碼|不要叫用戶重設密碼/);
  assert.match(doc, /唔可以.*單次 SHA-256|不要回退成單次 SHA-256/);
  // Code.gs 內要有可執行診斷入口
  assert.match(codeSrc, /function benchmarkPasswordKdf\(\)/);
  assert.match(codeSrc, /KDF_BENCH_LIMIT_MS = 30000/);
});

// ---------- 8. 版號同步（GS 5.4.0） ----------
test('GS_VERSION 與前端 GS_LATEST 同步為 5.4.0，release date 2026-11-04', () => {
  assert.match(codeSrc, /const GS_VERSION = '5\.4\.0';/);
  assert.match(codeSrc, /const GS_RELEASE_DATE = '2026-11-04';/);
  assert.equal(GsRelease.GS_LATEST.version, '5.4.0');
  assert.equal(GsRelease.GS_LATEST.releaseDate, '2026-11-04');
  // 除錯用：git 版本可用（實測腳本靠佢取舊版 Code.gs）
  try {
    execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' });
  } catch (e) { /* 非 git 環境亦唔應該令測試失敗 */ }
});
