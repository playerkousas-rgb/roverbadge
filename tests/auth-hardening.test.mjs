// ============================================================
// 登入安全強化回歸測試 — 對應 readme repo PLAYBOOK 硬規則 A3／A5／A17（2026-11-02）
//
//   A3 密碼雜湊：新帳戶／改密碼／重設一律寫 PBKDF2-HMAC-SHA256（>=100k 迭代＋隨機 salt，
//      格式 pbkdf2$<iter>$<salt>$<hash>）；舊單次 SHA-256 hash 仍可登入，並在成功登入時
//      自動升級為 PBKDF2（密碼本身不變）；upsertUser 同時接受兩種 hash 格式（跨節點搬數）
//   A5 登入閘：同一帳號 5 次失敗鎖 15 分鐘（鎖定中連正確密碼都拒），寫審計 login_locked；
//      改密碼後踢走該用戶其他所有 session（保留當前 token）
//   A17 防枚舉：找不到帳號與密碼錯誤回完全相同訊息「帳號或密碼錯誤」
//
// 執行：node --test tests/auth-hardening.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadCodeGs } from './gas-harness.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const isV2 = (h) => /^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/i.test(String(h || ''));

const USER = { ymis: '1234560201', name: '測試甲', email: 't1@example.org', role: 'group_leader', pwd: 'Pass!1234' };

function newEnv() {
  const env = loadCodeGs();
  env.api.initializeSheets();
  return env;
}
function seedUser(env, o, legacy = true) {
  const sh = env.ss.sheets.get('Users');
  const row = new Array(14).fill('');
  row[0] = o.ymis; row[1] = o.name || ''; row[2] = o.email || ''; row[3] = o.role || 'member';
  row[4] = legacy ? sha256(o.pwd || 'oldpw') : String(o.hash || ''); // 舊格式 seed 用 sha256
  row[6] = true;
  row[11] = 'active'; row[12] = '*'; row[13] = false;
  sh.appendRow(row);
}
const login = (env, id, pw) => env.call({ action: 'login', login_id: id, password: pw });
const userRow = (env, ymis) => env.ss.sheets.get('Users').rows.find(r => String(r[0]) === String(ymis));

test('A3 新開戶密碼以 PBKDF2 儲存（非單次 SHA-256），且可用新密碼登入', () => {
  const env = newEnv();
  const root = login(env, '1111111111', 'changeme'); // 內置預設管理員
  assert.equal(root.success, true);
  const r = env.call({ action: 'addUser', token: root.token, ymis: USER.ymis, name: USER.name, email: USER.email, role: 'group_leader', password: USER.pwd });
  assert.equal(r.success, true, JSON.stringify(r));
  const h = userRow(env, USER.ymis)[4];
  assert.ok(isV2(h), 'hash 應為 pbkdf2$ 格式：' + h);
  assert.ok(!/^[0-9a-f]{64}$/.test(h), '唔應再是單次 SHA-256');
  assert.equal(login(env, USER.ymis, USER.pwd).success, true);
  assert.equal(login(env, USER.ymis, 'wrong-pass').success, false);
});

test('A3 舊 SHA-256 帳戶可登入，並在成功登入時自動升級為 PBKDF2（密碼不變）', () => {
  const env = newEnv();
  seedUser(env, USER, true); // legacy sha256
  assert.equal(userRow(env, USER.ymis)[4], sha256(USER.pwd));
  const r = login(env, USER.ymis, USER.pwd);
  assert.equal(r.success, true, JSON.stringify(r));
  const upgraded = userRow(env, USER.ymis)[4];
  assert.ok(isV2(upgraded), '登入後應自動升級：' + upgraded);
  assert.equal(login(env, USER.ymis, USER.pwd).success, true, '升級後同一密碼仍可登入');
  // 再登入唔會再改格式（已是 v2）
  const before = userRow(env, USER.ymis)[4];
  login(env, USER.ymis, USER.pwd);
  assert.equal(userRow(env, USER.ymis)[4], before);
});

test('A3 預設密碼（changeme）無論新舊格式都會觸發首次登入強制改密', () => {
  const env = newEnv();
  // 內置管理員由 initializeSheets 以 v2 建立
  const r1 = login(env, '1111111111', 'changeme');
  assert.equal(r1.success, true);
  assert.equal(r1.force_change_password, true, 'v2 格式的預設密碼應觸發強制改密');
  // 舊格式 seed 的 changeme
  const env2 = newEnv();
  seedUser(env2, { ymis: '1234560299', name: '舊管', email: 'old-admin@example.org', role: 'admin', pwd: 'changeme' }, true);
  const r2 = login(env2, '1234560299', 'changeme');
  assert.equal(r2.success, true);
  assert.equal(r2.force_change_password, true, '舊 SHA-256 格式的預設密碼仍應觸發強制改密');
});

test('A5 連續 5 次登入失敗後鎖定 15 分鐘：鎖定中連正確密碼都被拒，回應訊息統一', () => {
  const env = newEnv();
  seedUser(env, USER, true);
  for (let i = 1; i <= 5; i++) {
    const r = login(env, USER.ymis, 'wrong-' + i);
    assert.equal(r.success, false);
    assert.equal(r.error, '帳號或密碼錯誤', '第 ' + i + ' 次錯誤訊息應統一');
  }
  // 第 6 次即使密碼正確都被鎖定拒絕
  const locked = login(env, USER.ymis, USER.pwd);
  assert.equal(locked.success, false);
  assert.equal(locked.error, '帳號或密碼錯誤', '鎖定中回應與密碼錯誤完全一致（A17）');
  // 審計鏈有 login_locked 記錄（中性 actor）
  const audit = env.ss.sheets.get('操作紀錄').rows.slice(1).filter(r => String(r[2]) === 'login_locked');
  assert.equal(audit.length, 1);
  assert.equal(audit[0][1], 'system');
  // 鎖定期過後（把 until 撥去過去）可再登入
  const key = 'LOGIN_FAIL:' + USER.ymis;
  const rec = JSON.parse(env.scriptProps.get(key));
  env.scriptProps.set(key, JSON.stringify({ f: rec.f, until: Date.now() - 1000 }));
  const after = login(env, USER.ymis, USER.pwd);
  assert.equal(after.success, true, '鎖定期過後應可登入');
  assert.ok(!env.scriptProps.get(key), '成功登入後應清走失敗記錄');
});

test('A17 找不到帳號與密碼錯誤回完全相同訊息（防枚舉）', () => {
  const env = newEnv();
  seedUser(env, USER, true);
  const noUser = login(env, '9999999999', 'whatever1');
  const wrongPw = login(env, USER.ymis, 'whatever1');
  assert.equal(noUser.success, false);
  assert.equal(wrongPw.success, false);
  assert.equal(noUser.error, wrongPw.error, '兩種失敗回應必須完全一致');
  assert.equal(noUser.error, '帳號或密碼錯誤');
});

test('A5 改密碼後：舊密碼失效、其他 session 被踢走、當前 token 保留', () => {
  const env = newEnv();
  seedUser(env, USER, true);
  const s1 = login(env, USER.ymis, USER.pwd);
  assert.equal(s1.success, true);
  // 製造第二個 session（模擬另一部裝置）
  const s2 = login(env, USER.email, USER.pwd);
  assert.equal(s2.success, true);
  assert.notEqual(s1.token, s2.token);
  const change = env.call({ action: 'changePassword', token: s1.token, old_password: USER.pwd, new_password: 'BrandNew!9' });
  assert.equal(change.success, true, JSON.stringify(change));
  // 新密碼以 PBKDF2 儲存
  assert.ok(isV2(userRow(env, USER.ymis)[4]));
  // 舊密碼不能再登入
  assert.equal(login(env, USER.ymis, USER.pwd).success, false);
  // 新密碼可登入
  assert.equal(login(env, USER.ymis, 'BrandNew!9').success, true);
  // 改密碼後：另一個舊 token 失效，當前 token 仍然有效（用需 token 的 POST action 驗）
  const loadOther = env.call({ action: 'getAllUsers', token: s2.token });
  assert.equal(loadOther.success, false, '其他裝置的 session 應被踢走');
  const loadMine = env.call({ action: 'getAllUsers', token: s1.token });
  assert.equal(loadMine.success, true, '當前 session 應保留');
  // 錯的舊密碼改密碼被拒
  const bad = env.call({ action: 'changePassword', token: s1.token, old_password: 'nope-nope', new_password: 'Another!1' });
  assert.equal(bad.success, false);
});

test('A3 upsertUser 同時接受舊 SHA-256 與 PBKDF2 hash，拒絕壞格式（跨節點搬數兼容）', () => {
  const env = newEnv();
  const root = login(env, '1111111111', 'changeme');
  // 舊格式 64-hex 仍可直插（舊節點匯出）
  const r1 = env.api.upsertUser({ ymis: '1234560301', name: '舊搬來', password_hash: sha256('legacy1') }, 'admin');
  assert.equal(r1.success, true, JSON.stringify(r1));
  assert.equal(userRow(env, '1234560301')[4], sha256('legacy1'));
  assert.equal(login(env, '1234560301', 'legacy1').success, true, '匯入的舊 hash 可直接登入');
  // 新格式 pbkdf2$ 直插
  const v2 = 'pbkdf2$120000$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(32);
  const r2 = env.api.upsertUser({ ymis: '1234560302', name: '新搬來', password_hash: v2 }, 'admin');
  assert.equal(r2.success, true, JSON.stringify(r2));
  assert.equal(userRow(env, '1234560302')[4], v2);
  // 壞格式拒
  assert.match(env.api.upsertUser({ ymis: '1234560303', name: '壞', password_hash: 'nope' }, 'x').error, /SHA-256|pbkdf2/);
  // 明文一律拒
  assert.match(env.api.upsertUser({ ymis: '1234560303', name: '壞', password: 'plain' }, 'x').error, /明文/);
});

test('A17 舊版 forgotPassword action 都係中性回應（向後兼容但唔再枚舉帳戶）', () => {
  const env = newEnv();
  seedUser(env, USER, true);
  const noMail = { ymis: '1234560202', name: '無郵乙', email: '', role: 'member', pwd: 'NoMail!1' };
  seedUser(env, noMail, true);
  const rReal = env.call({ action: 'forgotPassword', login_id: USER.ymis });
  const rNoMail = env.call({ action: 'forgotPassword', login_id: noMail.ymis });
  const rGhost = env.call({ action: 'forgotPassword', login_id: '9999999999' });
  assert.equal(JSON.stringify(rReal), JSON.stringify(rNoMail), '有 Email 帳戶回應應與無 Email 一致');
  assert.equal(JSON.stringify(rNoMail), JSON.stringify(rGhost), '無 Email 與不存在帳號回應應完全一致');
  assert.equal(rReal.success, true);
  assert.ok(!('email_hint' in rReal) && !('error' in rReal), '唔應洩漏 email_hint 或錯誤細節');
  // 真實帳戶先會寄信；其他兩個唔會
  assert.equal(env.mailOutbox.length, 1);
  assert.equal(env.mailOutbox[0].to, USER.email);
  // 保留帳號仍然拒絕（唔屬一般枚舉）
  const rSuper = env.call({ action: 'forgotPassword', login_id: env.api.SUPER_ADMIN_ID });
  assert.equal(rSuper.success, false);
});

// ===== 重設密碼授權（前端後台階級一致）＋重設後狀態清理 =====
// 設計：只有 SUPER ADMIN 可以改 ADMIN；admin 不可改 admin；高權限可改低權限（低權限帳號本就由其上級批核／可停用）。
// 重設成功後要清走該帳號的登入失敗計數（否則鎖定期間改完仍登入不到），並踢走該帳號所有舊 session。

const ADMIN2 = { ymis: '1234560401', name: '第二管理員', email: 'admin2@example.org', role: 'admin', pwd: 'Admin2!pw' };
const GL = { ymis: '1234560402', name: '團長乙', email: 'gl@example.org', role: 'group_leader', pwd: 'GroupL!pw' };
const BL = { ymis: '1234560403', name: '副團長丙', email: 'bl@example.org', role: 'branch_leader', pwd: 'BranchL!pw' };
const MEM = { ymis: '1234560404', name: '團員丁', email: '', role: 'member', pwd: 'Member!pw' };

test('重設密碼授權：admin 不可改 admin、副團長不可改團長、團長不可改 admin、成員不可改任何人', () => {
  const env = newEnv();
  const root = login(env, '1111111111', 'changeme'); // 內置 admin
  assert.equal(root.success, true);
  seedUser(env, ADMIN2, true);
  seedUser(env, GL, true);
  seedUser(env, BL, true);
  seedUser(env, MEM, true);
  const admin2Hash = userRow(env, ADMIN2.ymis)[4];

  // admin → admin：拒絕（只有 super_admin 可以）
  const r1 = env.call({ action: 'resetPassword', token: root.token, target_ymis: ADMIN2.ymis, new_password: 'Hijack!1' });
  assert.equal(r1.success, false);
  assert.match(r1.error, /權限不足/, JSON.stringify(r1));

  // 團長(60) → admin(80)：拒絕
  const gl = login(env, GL.ymis, GL.pwd);
  assert.equal(gl.success, true);
  const r2 = env.call({ action: 'resetPassword', token: gl.token, target_ymis: ADMIN2.ymis, new_password: 'Hijack!2' });
  assert.equal(r2.success, false);
  assert.match(r2.error, /權限不足/);

  // 副團長(40) → 團長(60)：拒絕
  const bl = login(env, BL.ymis, BL.pwd);
  assert.equal(bl.success, true);
  const r3 = env.call({ action: 'resetPassword', token: bl.token, target_ymis: GL.ymis, new_password: 'Hijack!3' });
  assert.equal(r3.success, false);
  assert.match(r3.error, /權限不足/);

  // 成員(0) → 任何人：入口即拒
  const mem = login(env, MEM.ymis, MEM.pwd);
  assert.equal(mem.success, true);
  const r4 = env.call({ action: 'resetPassword', token: mem.token, target_ymis: GL.ymis, new_password: 'Hijack!4' });
  assert.equal(r4.success, false);
  assert.match(r4.error, /權限不足/);

  // 被拒後目標帳號完全冇被改動
  assert.equal(userRow(env, ADMIN2.ymis)[4], admin2Hash, '被拒的重設不可改動目標 hash');
  assert.equal(login(env, ADMIN2.ymis, ADMIN2.pwd).success, true, '原密碼仍然有效');
  assert.equal(login(env, ADMIN2.ymis, 'Hijack!1').success, false);
});

test('重設密碼授權：只有 super_admin 可重設 admin 密碼', () => {
  const env = newEnv();
  seedUser(env, ADMIN2, true);
  const su = env.api.getUser(env.api.SUPER_ADMIN_ID);
  assert.equal(su.role, 'super_admin');
  const r = JSON.parse(env.api.handleResetPassword(ADMIN2.ymis, su, 'SuperSet!9').getContent());
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(isV2(userRow(env, ADMIN2.ymis)[4]), '重設後應為 PBKDF2');
  assert.equal(login(env, ADMIN2.ymis, 'SuperSet!9').success, true);
  assert.equal(login(env, ADMIN2.ymis, ADMIN2.pwd).success, false);
  // 保留帳號本身永遠不可被重設
  const deny = JSON.parse(env.api.handleResetPassword(env.api.SUPER_ADMIN_ID, su, 'x!1234').getContent());
  assert.equal(deny.success, false);
});

test('重設密碼成功後：清走登入失敗鎖定、踢走該帳號舊 session、強制首登改密', () => {
  const env = newEnv();
  assert.equal(login(env, '1111111111', 'changeme').success, true);
  seedUser(env, MEM, true);
  seedUser(env, GL, true);
  // 成員先登入一次（建立舊 session）
  const memSession = login(env, MEM.ymis, MEM.pwd);
  assert.equal(memSession.success, true);
  const tokensFor = () => env.ss.sheets.get('Tokens').rows.slice(1).filter(r => String(r[1]) === MEM.ymis).length;
  assert.equal(tokensFor(), 1, '應有一個 session');
  // 連續 5 次錯誤 → 鎖定
  for (let i = 1; i <= 5; i++) login(env, MEM.ymis, 'bad-' + i);
  assert.equal(login(env, MEM.ymis, MEM.pwd).success, false, '鎖定中正確密碼都拒');
  assert.ok(env.scriptProps.get('LOGIN_FAIL:' + MEM.ymis), '應有失敗記錄');
  // 團長（高於 member）重設
  const gl = login(env, GL.ymis, GL.pwd);
  assert.equal(gl.success, true);
  const r = env.call({ action: 'resetPassword', token: gl.token, target_ymis: MEM.ymis, new_password: 'Reset!234' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(isV2(userRow(env, MEM.ymis)[4]), '重設後應為 PBKDF2');
  assert.equal(String(userRow(env, MEM.ymis)[13]).toLowerCase(), 'true', '應設強制首登改密');
  assert.ok(!env.scriptProps.get('LOGIN_FAIL:' + MEM.ymis), '重設後應清走失敗記錄');
  assert.equal(tokensFor(), 0, '重設後應踢走該帳號舊 session');
  // 即刻可以用新密碼登入（不再被鎖）
  const after = login(env, MEM.ymis, 'Reset!234');
  assert.equal(after.success, true, '重設後應可即時登入：' + JSON.stringify(after));
  assert.equal(after.force_change_password, true);
  // 審計有記錄
  const audit = env.ss.sheets.get('操作紀錄').rows.slice(1).filter(row => String(row[2]) === 'set_password');
  assert.ok(audit.length >= 1, '應寫入 set_password 審計');
});
