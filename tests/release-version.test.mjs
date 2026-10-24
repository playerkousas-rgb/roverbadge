// 最新版本公告／GS 版本核對／資料保全規則（before/after 快照）測試
// 直接執行 apps-script/Code.gs（gas-harness），並讀取 assets/gs-release.js 與 index.html。
// 執行：node --test tests/release-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCodeGs } from './gas-harness.mjs';
import { loadAssetModule, repoRoot } from './browser-module-harness.mjs';

const GsRelease = loadAssetModule('assets/gs-release.js');
const codeSrc = fs.readFileSync(path.join(repoRoot, 'apps-script', 'Code.gs'), 'utf8');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const proxySrc = fs.readFileSync(path.join(repoRoot, 'api', 'proxy.js'), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// 讀取 Code.gs 頂層常數（字串或 true／false）
function gsConst(name) {
  const m = codeSrc.match(new RegExp('const ' + name + " = ('([^']*)'|true|false);"));
  assert.ok(m, 'Code.gs 缺少常數 ' + name);
  return m[2] !== undefined ? m[2] : m[1] === 'true';
}

// ---------- 1. 版本常數：Code.gs 與前端 GS_LATEST 必須一致 ----------
test('Code.gs GS_VERSION／GS_RELEASE_DATE／GS_INIT_REQUIRED 與前端 GS_LATEST 一致', () => {
  assert.equal(gsConst('GS_VERSION'), GsRelease.GS_LATEST.version);
  assert.equal(gsConst('GS_RELEASE_DATE'), GsRelease.GS_LATEST.releaseDate);
  assert.equal(gsConst('GS_INIT_REQUIRED'), GsRelease.GS_LATEST.initRequired);
  assert.equal(gsConst('GS_INIT_PROP'), 'INITIALIZED_GS_VERSION');
});

// ---------- 2. 版本比較與三種狀態 ----------
test('compareVersions 以數字比較（5.10.0 > 5.2.1）', () => {
  assert.equal(GsRelease.compareVersions('5.2.1', '5.2.0'), 1);
  assert.equal(GsRelease.compareVersions('5.2.0', '5.2.1'), -1);
  assert.equal(GsRelease.compareVersions('5.10.0', '5.2.1'), 1);
  assert.equal(GsRelease.compareVersions('5.2.1', '5.2.1'), 0);
  assert.equal(GsRelease.compareVersions('5.2', '5.2.0'), 0);
});

test('statusOf：未核對／GS 未更新／GS 已更新但未初始化／全部完成', () => {
  const L = { version: '5.2.1', releaseDate: '2026-10-23', initRequired: true };
  assert.equal(GsRelease.statusOf(null, L).code, 'unchecked');
  // 舊版 GS：無 gsVersion 欄位（ecStatus 未知 action／load 無版本）
  assert.equal(GsRelease.statusOf({ success: false, error: 'Unknown action' }, L).code, 'outdated');
  assert.equal(GsRelease.statusOf({ gsVersion: '5.2.0', initRequired: true, initializedGsVersion: '5.2.0' }, L).code, 'outdated');
  // GS 已更新，但初始化標記仍為空／舊版本
  assert.equal(GsRelease.statusOf({ gsVersion: '5.2.1', initRequired: true, initializedGsVersion: '' }, L).code, 'needs_init');
  assert.equal(GsRelease.statusOf({ gsVersion: '5.2.1', initRequired: true, initializedGsVersion: '5.2.0' }, L).code, 'needs_init');
  // 全部完成
  assert.equal(GsRelease.statusOf({ gsVersion: '5.2.1', initRequired: true, initializedGsVersion: '5.2.1' }, L).code, 'ok');
  // 本版不要求初始化：無標記也算完成
  assert.equal(GsRelease.statusOf({ gsVersion: '5.2.1', initRequired: false, initializedGsVersion: '' }, L).code, 'ok');
  // GS 比前端公告版本更新：視為已更新
  assert.equal(GsRelease.statusOf({ gsVersion: '5.3.0', initRequired: true, initializedGsVersion: '5.3.0' }, L).code, 'ok');
});

test('initNotice respects the current optional-init release while retaining required-init semantics', () => {
  const L = GsRelease.GS_LATEST;
  assert.equal(L.initRequired, false);
  assert.equal(GsRelease.initNotice({ gsVersion: L.version, initRequired: false, initializedGsVersion: '' }, L), false);
  assert.equal(GsRelease.statusOf({ gsVersion: L.version, initRequired: false, initializedGsVersion: '' }, L).code, 'ok');
  const olderInitRelease = { version: '5.2.3', releaseDate: '2026-10-25', initRequired: true };
  assert.equal(GsRelease.initNotice({ gsVersion: '5.2.3', initRequired: true, initializedGsVersion: '' }, olderInitRelease), true);
  assert.equal(GsRelease.initNotice({ gsVersion: '5.2.3', initRequired: true, initializedGsVersion: '5.2.3' }, olderInitRelease), false);
});

// ---------- 3. Code.gs：ecStatus／load 回報版本，標記只在初始化成功後寫入 ----------
test('ecStatus 回報版本與標記，且不含任何用戶資料；旅系統閂口後仍可核對', () => {
  const env = loadCodeGs();
  const r = env.get({ action: 'ecStatus' });
  assert.equal(r.success, true);
  assert.equal(r.gsVersion, GsRelease.GS_LATEST.version);
  assert.equal(r.initializedGsVersion, '', '未初始化前標記應為空');
  assert.equal(GsRelease.statusOf(r).code, 'ok', 'this release does not require initialization even before any initialization marker exists');
  const text = JSON.stringify(r);
  assert.ok(!/ymis|password|apikey|token|members|users/i.test(text), '回應不應含用戶或金鑰資料：' + text);
  // 關閉直接入口（閂口）：load 會被擋，但 ecStatus 仍可核對版本
  env.scriptProps.set('ALLOW_LOCAL_LOGIN', 'false');
  assert.equal(env.get({ action: 'load' }).success, false, '對照組：閂口後 load 應被擋');
  const closed = env.get({ action: 'ecStatus' });
  assert.equal(closed.success, true, '閂口後 ecStatus 仍應可用');
  assert.equal(closed.gsVersion, GsRelease.GS_LATEST.version);
});

test('initializeSheets() 成功完成後才寫入 INITIALIZED_GS_VERSION；load 同時回報版本', () => {
  const env = loadCodeGs();
  assert.equal(env.scriptProps.get('INITIALIZED_GS_VERSION'), undefined);
  const res = env.api.initializeSheets();
  assert.equal(res.success, true);
  assert.equal(env.scriptProps.get('INITIALIZED_GS_VERSION'), GsRelease.GS_LATEST.version);
  const st = GsRelease.statusOf(env.get({ action: 'ecStatus' }));
  assert.equal(st.code, 'ok');
  const load = env.get({ action: 'load' });
  assert.equal(load.success, true);
  assert.equal(load.gsVersion, GsRelease.GS_LATEST.version);
  assert.equal(load.initializedGsVersion, GsRelease.GS_LATEST.version);
  assert.equal(load.initRequired, false);
  assert.equal(GsRelease.statusOf(load).code, 'ok');
});

test('initializeSheets() 中途失敗：標記不寫入，狀態仍為「未初始化」', () => {
  const env = loadCodeGs();
  const origInsert = env.ss.insertSheet;
  env.ss.insertSheet = (name) => {
    if (name === '活動履歷') throw new Error('模擬失敗：無法建立活動履歷');
    return origInsert(name);
  };
  assert.throws(() => env.api.initializeSheets(), /模擬失敗/);
  assert.equal(env.scriptProps.get('INITIALIZED_GS_VERSION'), undefined, '失敗時不可寫入標記');
  assert.equal(GsRelease.statusOf(env.get({ action: 'ecStatus' })).code, 'ok', 'failed optional initialization does not create a false mandatory-init state');
});

// ---------- 4. 資料保全：舊結構升級只補表頭，不改寫既有資料 ----------
test('舊版 Sheet 結構升級：只補缺失表頭，既有儲存格與列原封不動', () => {
  const env = loadCodeGs();
  const users = env.ss.insertSheet('Users');
  users.appendRow(['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status']);
  const legacyUser = ['1234567890', '張小明', 'a@x.hk', 'member', sha256('mypass'), 'b4', false, 'admin', '2026-01-01', '2026-01-01', '', 'active'];
  users.appendRow(legacyUser);
  const prog = env.ss.insertSheet('進度追蹤');
  prog.appendRow(['YMIS', '項目 ID', '完成日期', '更新時間']);
  const legacyProg = ['1234567890', 'L1-ACT-01', '2026-01-05', '2026-01-05'];
  prog.appendRow(legacyProg);

  env.api.initializeSheets();

  assert.equal(users.rows[0][12], 'allowed_badges', '補上第 13 欄表頭');
  assert.equal(users.rows[0][13], 'force_change_password', '補上第 14 欄表頭');
  assert.deepEqual(users.rows[0].slice(0, 12), ['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status'], '既有表頭不變');
  assert.deepEqual(users.rows[1], legacyUser, '既有用戶列不變');
  assert.deepEqual(prog.rows[0].slice(0, 4), ['YMIS', '項目 ID', '完成日期', '更新時間'], '進度表既有表頭不變');
  assert.equal(prog.rows[0][4], '確認者');
  assert.equal(prog.rows[0][5], '備註');
  assert.deepEqual(prog.rows[1], legacyProg, '既有進度列不變');
  // 舊用戶仍可用原密碼登入（登入不因升級而失效）
  const login = env.call({ action: 'login', login_id: '1234567890', password: 'mypass' });
  assert.equal(login.success, true, JSON.stringify(login));
});

// ---------- 5. 資料保全：完整 before/after 快照 ----------
function snapshotOf(env) {
  const sheets = {};
  for (const [name, sh] of env.ss.sheets.entries()) sheets[name] = JSON.parse(JSON.stringify(sh.rows));
  const props = {};
  for (const [k, v] of env.scriptProps.entries()) props[k] = v;
  return { sheets, props };
}

test('before/after：重跑 initializeSheets() 不改寫、不刪除任何既有資料', () => {
  const env = loadCodeGs();
  env.api.initializeSheets(); // 建立完整表結構（之後為「既有旅團」狀態）
  const users = env.ss.getSheetByName('Users');
  const cfg = env.ss.getSheetByName('SystemConfig');
  const progress = env.ss.getSheetByName('進度追蹤');
  const members = env.ss.getSheetByName('成員名單');
  const tokens = env.ss.getSheetByName('Tokens');
  const logs = env.ss.getSheetByName('活動履歷');

  // 模擬一個已運作一段時間的旅團
  users.appendRow(['1234567890', '張小明', 'a@x.hk', 'member', sha256('changeme'), 'b4', false, 'admin', '2026-01-01', '2026-01-01', '', 'active', '', false]);
  users.appendRow(['2345678901', '李大文', 'b@x.hk', 'branch_leader', sha256('mypass'), 'b4', true, 'admin', '2026-01-01', '2026-01-01', '', 'active', 'PT21,PT22', true]);
  users.appendRow(['3456789012', '陳小美', '', 'member', sha256('x'), 'b4', false, 'admin', '', '', '', 'inactive', '', false]);
  users.appendRow(['legacy_sysop', '舊版殘留', '', 'super_admin', sha256('zz'), 'b4', true, 'system', '', '', '', 'active', '*', true]);
  progress.appendRow(['1234567890', 'L1-ACT-01', '2026-02-01', '2026-02-01', '李大文', '']);
  progress.appendRow(['1234567890', 'OLD-ID-99', '2025-01-01', '2025-01-01', '李大文', '舊版紀錄']);
  members.appendRow(['1234567890', '張小明', '2026-01-01', 'b4', '']);
  addOtRow(env);
  logs.appendRow(['2026-03-01 10:00', '李大文', 'approve', '1234567890', 'detail']);
  tokens.appendRow(['tok-abc', '1234567890', '2026-03-01', '2026-03-02']);
  const allowRow = cfg.rows.findIndex((r) => r[0] === 'allow_member_view_others');
  cfg.getRange(allowRow + 1, 2).setValue('true');

  const before = snapshotOf(env);
  env.api.initializeSheets();
  env.api.initializeSheets();
  const after = snapshotOf(env);

  // (a) 既有非空儲存格一律不變；既有列不減少；資料列完全相同（允許尾部新增）
  for (const name of Object.keys(before.sheets)) {
    const b = before.sheets[name];
    const a = after.sheets[name];
    assert.ok(a, `工作表 ${name} 不可消失`);
    assert.ok(a.length >= b.length, `${name} 列數不可減少：${b.length} → ${a.length}`);
    b.forEach((row, i) => {
      row.forEach((cell, j) => {
        if (i === 0 && cell === '') return; // 表頭空格允許補上
        assert.equal(a[i][j], cell, `${name} 第 ${i + 1} 列第 ${j + 1} 欄被改寫`);
      });
      if (i > 0) assert.equal(a[i].length, row.length, `${name} 第 ${i + 1} 列欄數被改動`);
    });
  }
  // (b) 特定資料保全斷言
  const usersAfter = after.sheets['Users'];
  assert.equal(usersAfter.filter((r) => r[0] === '1234567890').length, 1, '用戶不可重複');
  const defaultPwRow = usersAfter.find((r) => r[0] === '1234567890');
  assert.equal(defaultPwRow[13], false, '密碼仍為預設值的用戶：初始化不改寫 force_change_password');
  assert.ok(usersAfter.some((r) => r[0] === 'legacy_sysop'), '殘留 super_admin 列保留（不自動刪除）');
  assert.ok(after.sheets['Tokens'].some((r) => r[0] === 'tok-abc'), 'Tokens 既有 session 保留');
  assert.ok(after.sheets['進度追蹤'].some((r) => r[1] === 'OLD-ID-99'), '舊版項目 ID 紀錄保留');
  assert.ok(after.sheets['其他獎章'], '其他獎章工作表保留');
  assert.equal(after.sheets['SystemConfig'].find((r) => r[0] === 'allow_member_view_others')[1], 'true', '系統設定值保留');
  // (c) API Key 與所有 Script Properties 不變
  assert.deepEqual(after.props, before.props, 'Script Properties（含 API_KEY）不可改變');
  assert.ok(after.props.API_KEY, 'API_KEY 應已存在');
  // (d) 強制改密改在登入時判斷：旗標未寫入，但預設密碼仍要求改密
  const login = env.call({ action: 'login', login_id: '1234567890', password: 'changeme' });
  assert.equal(login.success, true, JSON.stringify(login));
  assert.equal(login.force_change_password, true, '預設密碼登入時必須強制改密');
  const login2 = env.call({ action: 'login', login_id: '2345678901', password: 'mypass' });
  assert.equal(login2.force_change_password, true, '旗標為 TRUE 的用戶仍須改密');
});

function addOtRow(env) {
  const ot = env.ss.getSheetByName('其他獎章');
  ot.appendRow(['1234567890', 'OT-01', '示範獎章', '2026-03-01', 'CERT-9', 'note', '2026-03-01']);
}

// ---------- 6. 前端接線（靜態檢查，不需瀏覽器） ----------
test('index.html：載入 gs-release.js，三個頁面都有公告容器，並以 ecStatus 重新檢查', () => {
  assert.match(indexHtml, /<script src="assets\/gs-release\.js"><\/script>/);
  for (const id of ['gsNoticeHome', 'gsNoticeLogin', 'gsNoticeMain']) {
    assert.match(indexHtml, new RegExp('id="' + id + '"'), '缺少容器 ' + id);
  }
  assert.match(indexHtml, /apiRequest\('ecStatus'/);
  assert.match(indexHtml, /onclick="gsRecheck\(\)"/);
  assert.match(indexHtml, /本次更新毋須重跑初始化/);
  assert.ok(fs.existsSync(path.join(repoRoot, GsRelease.GS_LATEST.codeUrl)), 'Code.gs 下載路徑必須存在');
  assert.equal(GsRelease.GS_LATEST.initRequired, false, 'display-only release must not require initializeSheets');
  // 公告區不得寫入任何資料：不呼叫 save／save* 等寫入 action
  const seg = indexHtml.slice(indexHtml.indexOf('function gsNoticeHtml'), indexHtml.indexOf('document.addEventListener(\'DOMContentLoaded\', renderGsNotices)'));
  assert.doesNotMatch(seg, /apiRequest\('(save|add|update|delete|reset|submit|review)/);
});

test('index.html：公告用到的每個 tr() 字串都在 i18n_dict.tsv（英文介面不會漏翻）', () => {
  const seg = indexHtml.slice(indexHtml.indexOf('function gsNoticeHtml'), indexHtml.indexOf('async function loadTroops'));
  const keys = new Set(fs.readFileSync(path.join(repoRoot, 'i18n_dict.tsv'), 'utf8')
    .split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')[0]));
  const literals = [...seg.matchAll(/tr\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]);
  assert.ok(literals.length >= 15, '應抓到公告字串：' + literals.length);
  const missing = literals.filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], '缺少翻譯的 tr() 字串');
});

test('proxy：ecStatus 同時在公開與 GET 白名單（閂口後仍可核對）', () => {
  const pub = proxySrc.match(/const PUBLIC_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  const get = proxySrc.match(/const GET_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(pub && /'ecStatus'/.test(pub[1]), 'PUBLIC_ACTIONS 需含 ecStatus');
  assert.ok(get && /'ecStatus'/.test(get[1]), 'GET_ACTIONS 需含 ecStatus');
});
