// ============================================================
// 「忘記密碼」（電郵一次性重設碼）回歸測試 — GS 5.2.3（2026-11-02）
//
// 三層驗證：
//   A. 以 gas-harness 真實執行 apps-script/Code.gs（經 doPost 路由）：
//      完整重設流程、不洩漏帳戶、重設碼只存雜湊、錯碼計次／鎖定、過期、限速、
//      舊碼作廢、身份欄位注入無效、中途停用拒絕、舊 Sheet 自動補表、發信故障旗標、
//      成功後舊 session 失效＋中性操作紀錄、testPasswordResetMail()
//   B. api/proxy.js：兩個 action 列為公開、主動剷走客戶端身份欄位（token／YMIS／角色…）
//   C. 端到端：真 /api/proxy（handler）→ 真 HTTP → mock GAS：寄碼 → 錯碼拒絕 → 改密 →
//      舊密碼失效、新密碼可登入
//
// 執行：node --test tests/password-reset.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCodeGs } from './gas-harness.mjs';
import { startMockGas, SUPER_ADMIN_ID_FOR_TESTS } from './mock-gas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

const LEADER = { ymis: '1234560101', name: '領袖甲', email: 'leader@example.org', role: 'group_leader', pwd: 'OldPass!123' };
const MEMBER = { ymis: '1234560102', name: '成員乙', email: 'member@example.org', role: 'member', pwd: 'Member!234' };
const NO_MAIL = { ymis: '1234560103', name: '無郵丙', email: '', role: 'member', pwd: 'NoMail!234' };

// ---------- A. 真實 Code.gs ----------
function newEnv() {
  const env = loadCodeGs();
  env.api.initializeSheets();
  return env;
}
function seedUser(env, o) {
  const sh = env.ss.sheets.get('Users');
  const row = new Array(14).fill('');
  row[0] = o.ymis; row[1] = o.name || ''; row[2] = o.email || ''; row[3] = o.role || 'member';
  row[4] = sha256(o.pwd || 'oldpw'); row[6] = o.can_tick === undefined ? true : o.can_tick;
  row[11] = o.status || 'active'; row[12] = o.allowed || '*'; row[13] = o.force === undefined ? false : o.force;
  sh.appendRow(row);
}
function resetRows(env) {
  const sh = env.ss.sheets.get('密碼重設');
  if (!sh) return [];
  return sh.rows.slice(1);
}
function lastMail(env) { return env.mailOutbox[env.mailOutbox.length - 1]; }
function codeFromMail(mail) {
  const m = String(mail.body).match(/([0-9A-Z]{4})-([0-9A-Z]{4})/);
  return m ? (m[1] + m[2]) : '';
}
function issueCode(env, loginId) {
  const r = env.call({ action: 'requestPasswordReset', login_id: loginId });
  assert.equal(r.success, true, JSON.stringify(r));
  const mail = lastMail(env);
  return { res: r, code: codeFromMail(mail), mail };
}
function confirm(env, loginId, code, newPw, extra = {}) {
  return env.call({ action: 'confirmPasswordReset', login_id: loginId, code, new_password: newPw, ...extra });
}

test('A1 initializeSheets 一併建立「密碼重設」表（表頭正確）', () => {
  const env = newEnv();
  const sh = env.ss.sheets.get('密碼重設');
  assert.ok(sh, '要有密碼重設 sheet');
  assert.equal(JSON.stringify(sh.rows[0]), JSON.stringify(['reset_id', 'ymis', 'email', 'code_hash', 'created_ms', 'expires_ms', 'attempts', 'status', 'used_at']));
});

test('A2 完整流程：電郵發碼 → 確認重設 → 新密碼可登入、舊密碼失效、不強制改密', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  const { res, code, mail } = issueCode(env, LEADER.email);
  assert.equal(res.delivery, 'ok');
  assert.equal(mail.to, LEADER.email);
  assert.match(mail.subject, /重設碼/);
  assert.ok(code.length === 8, '重設碼 8 位');
  // 回應唔含重設碼；表內只存雜湊
  assert.ok(!JSON.stringify(res).includes(code));
  const row = resetRows(env)[0];
  assert.equal(row[7], 'pending');
  assert.match(row[3], /^[0-9a-f]{64}$/);
  assert.ok(row[3] !== code && row[3] === sha256(code));
  assert.equal(row[1], LEADER.ymis);

  const ok = confirm(env, LEADER.email, code, 'NewPass!456');
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.ok(!JSON.stringify(ok).includes(code));
  assert.equal(resetRows(env)[0][7], 'used');

  const oldLogin = env.call({ action: 'login', login_id: LEADER.ymis, password: LEADER.pwd });
  assert.equal(oldLogin.success, false, '舊密碼應失效');
  const newLogin = env.call({ action: 'login', login_id: LEADER.ymis, password: 'NewPass!456' });
  assert.equal(newLogin.success, true, JSON.stringify(newLogin));
  assert.equal(newLogin.force_change_password, false, '自選新密碼毋須再強制改密');
  // 也可用電郵登入
  const emLogin = env.call({ action: 'login', login_id: LEADER.email.toUpperCase(), password: 'NewPass!456' });
  assert.equal(emLogin.success, true, '電郵登入（大小寫不敏感）');
});

test('A3 可用 YMIS 申請重設碼（解析到登記電郵）', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  const { code, mail } = issueCode(env, LEADER.ymis);
  assert.equal(mail.to, LEADER.email, '重設碼寄去登記電郵');
  assert.equal(confirm(env, LEADER.ymis, code, 'NewPass!789').success, true);
  assert.equal(env.call({ action: 'login', login_id: LEADER.ymis, password: 'NewPass!789' }).success, true);
});

test('A4 不洩漏帳戶：未知電郵／無電郵帳戶／保留帳號回應一致、唔寄信', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  seedUser(env, NO_MAIL);
  const known = env.call({ action: 'requestPasswordReset', login_id: LEADER.email });
  const mailsAfterKnown = env.mailOutbox.length;
  const ghost = env.call({ action: 'requestPasswordReset', login_id: 'nobody@example.org' });
  assert.equal(ghost.success, true);
  assert.equal(ghost.message, known.message, '回應文案一致');
  assert.equal(ghost.delivery, known.delivery);
  assert.equal(env.mailOutbox.length, mailsAfterKnown, '未知電郵唔寄信');
  assert.equal(resetRows(env).filter(r => r[7] === 'no_account').length, 1);
  assert.equal(resetRows(env).find(r => r[7] === 'no_account')[3], '', 'no_account 列唔存 code_hash');

  const noMail = env.call({ action: 'requestPasswordReset', login_id: NO_MAIL.ymis });
  assert.equal(noMail.message, known.message);
  assert.equal(env.mailOutbox.length, mailsAfterKnown, '無登記電郵唔寄信');

  const su = env.call({ action: 'requestPasswordReset', login_id: SUPER_ADMIN_ID_FOR_TESTS });
  assert.equal(su.success, true);
  assert.equal(su.message, known.message, '保留帳號同樣回通用文案');
  assert.equal(env.mailOutbox.length, mailsAfterKnown, '保留帳號唔寄信');
  // 成員有電郵亦可自助重設（roverbadge 成員同樣用密碼登入）
  seedUser(env, MEMBER);
  const m = env.call({ action: 'requestPasswordReset', login_id: MEMBER.email });
  assert.equal(m.success, true);
  assert.equal(lastMail(env).to, MEMBER.email);
});

test('A5 錯碼計次並鎖定；鎖定後正確碼都被拒；密碼不變', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  const { code } = issueCode(env, LEADER.email);
  for (let i = 0; i < 5; i++) {
    const r = confirm(env, LEADER.email, 'ZZZZZZZZ', 'hackpw');
    assert.equal(r.success, false);
    assert.match(r.error, /重設碼不正確或已過期/);
  }
  assert.equal(resetRows(env)[0][7], 'locked');
  assert.equal(resetRows(env)[0][6], 5);
  assert.equal(confirm(env, LEADER.email, code, 'hackpw').success, false, '鎖定後正確碼都拒');
  assert.equal(env.call({ action: 'login', login_id: LEADER.ymis, password: 'hackpw' }).success, false);
  assert.equal(env.call({ action: 'login', login_id: LEADER.ymis, password: LEADER.pwd }).success, true, '原密碼仍然有效');
});

test('A6 過期碼失效（status=expired）', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  const { code } = issueCode(env, LEADER.email);
  env.ss.sheets.get('密碼重設').rows[1][5] = Date.now() - 1; // expires_ms
  const r = confirm(env, LEADER.email, code, 'NewPass!456');
  assert.equal(r.success, false);
  assert.equal(resetRows(env)[0][7], 'expired');
  assert.equal(env.call({ action: 'login', login_id: LEADER.ymis, password: LEADER.pwd }).success, true);
});

test('A7 新申請作廢舊碼；同一帳戶任何時間只一組有效碼', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  const first = issueCode(env, LEADER.email);
  const second = issueCode(env, LEADER.email);
  assert.equal(resetRows(env)[0][7], 'superseded');
  assert.equal(resetRows(env)[1][7], 'pending');
  assert.equal(confirm(env, LEADER.email, first.code, 'NewPass!1').success, false, '舊碼已作廢');
  assert.equal(confirm(env, LEADER.email, second.code, 'NewPass!1').success, true);
});

test('A8 限速：同一帳戶 30 分鐘內最多 3 次', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  for (let i = 0; i < 3; i++) assert.equal(env.call({ action: 'requestPasswordReset', login_id: LEADER.email }).success, true);
  const r4 = env.call({ action: 'requestPasswordReset', login_id: LEADER.email });
  assert.equal(r4.success, false);
  assert.match(r4.error, /頻密/);
  // 其他帳戶唔受影響
  seedUser(env, MEMBER);
  assert.equal(env.call({ action: 'requestPasswordReset', login_id: MEMBER.email }).success, true);
});

test('A9 注入身份欄位（token／ymis／role／target_ymis）唔會改變重設對象', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  seedUser(env, { ...MEMBER, ymis: 'L9999', email: 'other@example.org', role: 'admin', pwd: 'victimpw' });
  const inj = { token: 'admin-token', ymis: 'L9999', target_ymis: 'L9999', role: 'super_admin', apikey: 'fake', password_hash: 'x', code_hash: 'y', user: 'admin' };
  const r = env.call({ action: 'requestPasswordReset', login_id: LEADER.email, ...inj });
  assert.equal(r.success, true);
  const row = resetRows(env)[0];
  assert.equal(row[1], LEADER.ymis, '目標只由電郵解析');
  const code = codeFromMail(lastMail(env));
  const ok = confirm(env, LEADER.email, code, 'NewPass!456', inj);
  assert.equal(ok.success, true);
  const users = env.ss.sheets.get('Users').rows;
  const leaderRow = users.find(r => r[0] === LEADER.ymis);
  const victimRow = users.find(r => r[0] === 'L9999');
  assert.ok(/^pbkdf2\$\d+\$/.test(String(leaderRow[4])), '新密碼應以 PBKDF2 儲存（A3）');
  assert.equal(env.call({ action: 'login', login_id: LEADER.ymis, password: 'NewPass!456' }).success, true, '只改申請帳戶（新密碼可登入）');
  assert.equal(victimRow[4], sha256('victimpw'), '其他帳戶密碼不變');
});

test('A10 成功後舊 session 全部失效＋寫中性操作紀錄（不含重設碼／密碼）', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  const login = env.call({ action: 'login', login_id: LEADER.ymis, password: LEADER.pwd });
  assert.equal(login.success, true);
  const token = login.token;
  const { code } = issueCode(env, LEADER.email);
  assert.equal(confirm(env, LEADER.email, code, 'NewPass!456').success, true);
  const tokens = env.ss.sheets.get('Tokens').rows.slice(1);
  assert.ok(!tokens.some(r => String(r[1]) === LEADER.ymis), '舊 token 列應被清走');
  const loadWithOld = env.call({ action: 'load', token });
  assert.equal(loadWithOld.success, false, '舊 token 已不能用');
  const audit = env.ss.sheets.get('操作紀錄').rows.slice(1).find(r => String(r[2]) === 'password_reset_by_email');
  assert.ok(audit, '要有操作紀錄');
  assert.equal(audit[1], 'system');
  assert.equal(audit[3], LEADER.ymis);
  assert.ok(!String(audit[4]).includes(code) && !String(audit[4]).includes('NewPass!456'));
});

test('A11 確認前帳戶被停用／改電郵 → 作廢並拒絕，密碼不變', () => {
  // 情況 1：申請後被停用
  {
    const env = newEnv();
    seedUser(env, LEADER);
    const { code } = issueCode(env, LEADER.email);
    env.ss.sheets.get('Users').rows.find(r => r[0] === LEADER.ymis)[11] = 'inactive';
    const r = confirm(env, LEADER.email, code, 'NewPass!456');
    assert.equal(r.success, false, JSON.stringify(r));
    assert.equal(resetRows(env)[0][7], 'void');
    assert.equal(env.ss.sheets.get('Users').rows.find(r => r[0] === LEADER.ymis)[4], sha256(LEADER.pwd), '密碼不變');
  }
  // 情況 2：申請後登記電郵被改走
  {
    const env = newEnv();
    seedUser(env, LEADER);
    const { code } = issueCode(env, LEADER.email);
    env.ss.sheets.get('Users').rows.find(r => r[0] === LEADER.ymis)[2] = 'changed@example.org';
    const r = confirm(env, LEADER.email, code, 'NewPass!456');
    assert.equal(r.success, false, JSON.stringify(r));
    assert.equal(resetRows(env)[0][7], 'void');
    assert.equal(env.ss.sheets.get('Users').rows.find(r => r[0] === LEADER.ymis)[4], sha256(LEADER.pwd), '密碼不變');
  }
});

test('A12 舊 Sheet 毋須重跑初始化：第一次申請自動補建「密碼重設」表，既有資料不變', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  env.ss.sheets.delete('密碼重設'); // 模擬舊 Sheet
  const usersBefore = JSON.stringify(env.ss.sheets.get('Users').rows);
  const r = env.call({ action: 'requestPasswordReset', login_id: LEADER.email });
  assert.equal(r.success, true, JSON.stringify(r));
  const sh = env.ss.sheets.get('密碼重設');
  assert.ok(sh, '應自動補建');
  assert.equal(JSON.stringify(sh.rows[0]), JSON.stringify(['reset_id', 'ymis', 'email', 'code_hash', 'created_ms', 'expires_ms', 'attempts', 'status', 'used_at']));
  assert.equal(JSON.stringify(env.ss.sheets.get('Users').rows), usersBefore, 'Users 資料完全不變');
});

test('A13 發信失敗：全團 delivery=unavailable，回應一致唔洩漏有效帳戶；成功發信後清旗標', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  const orig = env.mailApp.sendEmail;
  env.mailApp.sendEmail = () => { throw new Error('MailApp: no permission'); };
  const failed = env.call({ action: 'requestPasswordReset', login_id: LEADER.email });
  assert.equal(failed.success, true);
  assert.equal(failed.delivery, 'unavailable');
  const mails = env.mailOutbox.length;
  const ghost = env.call({ action: 'requestPasswordReset', login_id: 'nobody@example.org' });
  assert.equal(ghost.delivery, 'unavailable', '故障旗標全團共通');
  assert.equal(ghost.message, failed.message);
  assert.equal(env.mailOutbox.length, mails, '失敗唔記入寄件匣');
  // 記錄仍入表（限速一致）但唔存碼？——有帳戶嘅列會嘗試寄信失敗，code_hash 仍記（安全：唔緊要，因為寄唔出）
  env.mailApp.sendEmail = orig;
  const recovered = env.call({ action: 'requestPasswordReset', login_id: LEADER.email });
  assert.equal(recovered.delivery, 'ok');
  assert.equal(env.mailOutbox.length, mails + 1);
});

test('A14 testPasswordResetMail()：有執行者電郵先寄測試信並清旗標；冇電郵就拋錯', () => {
  const env = newEnv();
  const usersBefore = env.ss.sheets.get('Users').rows.length;
  assert.throws(() => env.api.testPasswordResetMail(), /電郵/);
  env.setSessionEmail('gsl@example.org');
  env.scriptProps.set('PWD_RESET_MAIL_ERROR', String(Date.now()));
  const msg = env.api.testPasswordResetMail();
  assert.match(msg, /gsl@example\.org/);
  assert.equal(lastMail(env).to, 'gsl@example.org');
  assert.ok(!env.scriptProps.get('PWD_RESET_MAIL_ERROR'), '測試函式清走故障旗標');
  assert.equal(env.ss.sheets.get('Users').rows.length, usersBefore, '測試函式唔寫帳號資料');
});

test('A15 閂口（ALLOW_LOCAL_LOGIN=false）後兩個新 action 同樣被拒（只收上游 sig）', () => {
  const env = newEnv();
  seedUser(env, LEADER);
  env.scriptProps.set('ALLOW_LOCAL_LOGIN', 'false');
  for (const action of ['requestPasswordReset', 'confirmPasswordReset']) {
    const r = env.call({ action, login_id: LEADER.email, code: 'ABCD1234', new_password: 'NewPass!1' });
    assert.equal(r.success, false);
    assert.equal(r.upstream_only, true);
  }
});

// ---------- B. 靜態一致性（前端／proxy／GS／字典） ----------
test('B1 前端／proxy／Code.gs／版本／字典一致', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const proxySrc = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');
  const gsSrc = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  const gsRelease = fs.readFileSync(path.join(ROOT, 'assets', 'gs-release.js'), 'utf8');
  const tsv = fs.readFileSync(path.join(ROOT, 'i18n_dict.tsv'), 'utf8');

  // 前端有兩步 modal + 兩個 apiRequest 呼叫
  assert.ok(html.includes('id="forgotPasswordModal"') && html.includes('id="fpwStep1"') && html.includes('id="fpwStep2"'));
  assert.ok(html.includes('id="fpwLogin"') && html.includes('id="fpwCode"') && html.includes('id="fpwNew"') && html.includes('id="fpwNew2"'));
  assert.match(html, /apiRequest\('requestPasswordReset'/);
  assert.match(html, /apiRequest\('confirmPasswordReset'/);
  assert.match(html, /onclick="showForgotPasswordModal\(\);return false"/);
  assert.match(html, /Unknown action\|不支援的操作/);

  // proxy：兩個 action 在 PUBLIC_ACTIONS；有剷身份欄位嘅防線
  const pub = proxySrc.match(/const PUBLIC_ACTIONS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(pub && /'requestPasswordReset'/.test(pub[1]) && /'confirmPasswordReset'/.test(pub[1]), 'PUBLIC_ACTIONS 要有兩個新 action');
  assert.match(proxySrc, /action === 'requestPasswordReset' \|\| action === 'confirmPasswordReset'/);
  assert.match(proxySrc, /'token', 'ymis', 'target_ymis', 'role', 'password_hash', 'code_hash', 'user'/);

  // Code.gs：doPost 有路由；版本與前端公告一致（版本號本身由 release-version 測試把關）
  assert.match(gsSrc, /if\(action==='requestPasswordReset'\) return handleRequestPasswordReset\(body\)/);
  assert.match(gsSrc, /if\(action==='confirmPasswordReset'\) return handleConfirmPasswordReset\(body\)/);
  const gsVer=(gsSrc.match(/const GS_VERSION = '([0-9.]+)';/)||[])[1];
  assert.ok(gsVer, 'Code.gs 要有 GS_VERSION');
  assert.ok(gsSrc.includes("const GS_RELEASE_DATE = '2026-11-02';"));
  assert.ok(gsRelease.includes("version: '"+gsVer+"'"), 'gs-release.js 版本要與 Code.gs 一致：'+gsVer);
  assert.match(gsRelease, /releaseDate: '2026-11-02'/);

  // 字典：新 UI 字串中英齊備
  for (const k of ['📧 發送重設碼', '輸入重設碼並設定新密碼', '重設碼（電郵內 8 位）', '💾 設定新密碼', '✅ 密碼已重設，請用新密碼登入']) {
    const row = tsv.split('\n').find(l => l.startsWith(k + '\t'));
    assert.ok(row && row.split('\t')[1].trim() !== '', 'tsv 要有中英對照：' + k);
    assert.ok(html.includes('"' + k + '"'), 'LANG_DICT 要有鍵：' + k);
  }
});

// ---------- C. proxy 防線 + 端到端（真 handler → 真 HTTP → mock GAS） ----------
process.env.ROVERBADGE_PROXY_TEST = '1';
process.env.ROVERBADGE_REGISTRY_TTL_MS = '0';
process.env.ROVERBADGE_PROXY_TIMEOUT_MS = '5000';
const PWR_PORT = parseInt(process.env.PWR_PORT || '3931', 10);
process.env.TROOP_0082_NAME = '忘記密碼測試旅';
process.env.TROOP_0082_BACKEND = `http://127.0.0.1:${PWR_PORT}/exec`;
process.env.TROOP_0082_APIKEY = 'KEY_PWR';

const { default: proxyHandler } = await import('../api/proxy.js');

function mockRes() {
  return {
    headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; },
    json(v) { this.body = v; return this; }
  };
}
async function callProxy(body) {
  const res = mockRes();
  await proxyHandler({ method: 'POST', body }, res);
  return res;
}

test('C1 proxy：兩個新 action 免 token 公開；身份欄位被剷走，apikey 換成 server 端', async () => {
  let sentBody = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sentBody = init && init.body ? JSON.parse(init.body) : null;
    return { status: 200, text: async () => JSON.stringify({ success: true, delivery: 'ok' }) };
  };
  try {
    const res = await callProxy({
      troopId: '0082', action: 'confirmPasswordReset',
      data: {
        login_id: 'a@b.com', code: 'ABCD1234', new_password: 'newpass',
        token: 'stolen-admin-token', ymis: 'L0001', target_ymis: 'L0001', role: 'super_admin',
        password_hash: 'x', code_hash: 'y', user: 'admin', apikey: 'attacker_key', sig: 's', sig_ts: 't', sig_nonce: 'n'
      }
    });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(sentBody.action, 'confirmPasswordReset');
    assert.equal(sentBody.login_id, 'a@b.com');
    assert.equal(sentBody.code, 'ABCD1234');
    assert.equal(sentBody.new_password, 'newpass');
    assert.equal(sentBody.apikey, 'KEY_PWR', 'server 端注入嘅 key');
    for (const k of ['token', 'ymis', 'target_ymis', 'role', 'password_hash', 'code_hash', 'user', 'sig', 'sig_ts', 'sig_nonce', 'attacker_key']) {
      assert.ok(!(k in sentBody), k + ' 唔應該轉發去 GAS');
    }
    // requestPasswordReset 一樣免 token
    const res2 = await callProxy({ troopId: '0082', action: 'requestPasswordReset', data: { login_id: 'a@b.com', token: 'x' } });
    assert.equal(res2.code, 200);
    assert.equal(sentBody.action, 'requestPasswordReset');
    assert.ok(!('token' in sentBody));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('C2 端到端：真 proxy → mock GAS：寄碼 → 錯碼拒絕 → 改密 → 舊密碼失效新密碼可用', async () => {
  const mock = await startMockGas({
    port: PWR_PORT, name: '忘記密碼測試旅', apikey: 'KEY_PWR',
    users: [
      { ymis: '1234567890', name: '團長甲', role: 'group_leader', pass: 'OldPass!123', can_tick: true, email: 'boss@example.org' },
      { ymis: '1234560001', name: '成員乙', role: 'member', pass: 'Member!234', can_tick: false }
    ]
  });
  try {
    // 1) 申請重設碼（免登入）
    const r1 = await callProxy({ troopId: '0082', action: 'requestPasswordReset', data: { login_id: 'boss@example.org' } });
    assert.equal(r1.code, 200);
    assert.equal(r1.body.success, true);
    assert.equal(r1.body.delivery, 'ok');
    assert.ok(!JSON.stringify(r1.body).match(/[0-9A-Z]{4}-[0-9A-Z]{4}/), '回應唔含重設碼');
    const mail = mock.state.sentEmails[mock.state.sentEmails.length - 1];
    assert.equal(mail.to, 'boss@example.org');
    const code = codeFromMail(mail);
    assert.ok(code.length === 8);

    // 2) 未知帳號回應一致（不洩漏）
    const rGhost = await callProxy({ troopId: '0082', action: 'requestPasswordReset', data: { login_id: 'ghost@example.org' } });
    assert.equal(rGhost.body.success, true);
    assert.equal(rGhost.body.message, r1.body.message);

    // 3) 錯碼被拒
    const rWrong = await callProxy({ troopId: '0082', action: 'confirmPasswordReset', data: { login_id: 'boss@example.org', code: 'ZZZZZZZZ', new_password: 'NewPass!456' } });
    assert.equal(rWrong.body.success, false);
    assert.match(rWrong.body.error, /重設碼不正確或已過期/);

    // 4) 短密碼被拒
    const rShort = await callProxy({ troopId: '0082', action: 'confirmPasswordReset', data: { login_id: 'boss@example.org', code, new_password: 'abc' } });
    assert.equal(rShort.body.success, false);
    assert.match(rShort.body.error, /至少4位/);

    // 5) 正確碼重設成功；注入身份欄位無效
    const rOk = await callProxy({
      troopId: '0082', action: 'confirmPasswordReset',
      data: { login_id: 'boss@example.org', code: code.toLowerCase(), new_password: 'NewPass!456', token: 'x', ymis: '1234560001', role: 'super_admin' }
    });
    assert.equal(rOk.body.success, true, JSON.stringify(rOk.body));
    assert.ok(!mock.state.users['1234560001'].pass.includes('NewPass'), '注入嘅 ymis 唔會改到其他帳戶');

    // 6) 舊密碼失效、新密碼可用；舊 session 被清
    const oldLogin = await callProxy({ troopId: '0082', action: 'login', data: { login_id: '1234567890', password: 'OldPass!123' } });
    assert.equal(oldLogin.body.success, false);
    const newLogin = await callProxy({ troopId: '0082', action: 'login', data: { login_id: '1234567890', password: 'NewPass!456' } });
    assert.equal(newLogin.body.success, true);
    assert.equal(newLogin.body.force_change_password, false);

    // 7) 無電郵帳戶：回應一致、唔寄信、不能重設
    const mailsBefore = mock.state.sentEmails.length;
    const rNoMail = await callProxy({ troopId: '0082', action: 'requestPasswordReset', data: { login_id: '1234560001' } });
    assert.equal(rNoMail.body.success, true);
    assert.equal(rNoMail.body.message, r1.body.message);
    assert.equal(mock.state.sentEmails.length, mailsBefore);
  } finally {
    await mock.close();
  }
});
