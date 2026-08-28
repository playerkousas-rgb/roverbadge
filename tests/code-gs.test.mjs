// 直接執行 apps-script/Code.gs（真實後端程式碼）的測試
// 重點：v8.5 系統管理帳號（super_admin）改為「程式碼零憑證」
//   - initializeSheets() 的彈框不再出現任何系統管理帳號資訊（這是本次修正的重點）
//   - Code.gs 內不再有任何寫死的超管帳號／密碼；未執行 setSuperAdmin() 就沒有超管帳號
//   - 憑證只存 Script Properties（密碼只存 SHA-256 雜湊）
// 執行：node tests/code-gs.test.mjs
import fs from 'fs';
import crypto from 'crypto';
import { loadCodeGs, CODE_GS_PATH } from './gas-harness.mjs';

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// ================== 1. 原始碼層面：不再有任何寫死的超管憑證 ==================
console.log('\n【1】Code.gs 原始碼不含任何寫死的系統管理帳號／密碼');
{
  const src = fs.readFileSync(CODE_GS_PATH, 'utf8');
  check('Code.gs 不含舊版帳號字串 sheep', !/sheep/i.test(src));
  check('Code.gs 不含舊版密碼 0728', !src.includes('0728'));
  check('Code.gs 不含 SUPER_ADMIN_YMIS / SUPER_ADMIN_PASS 常量', !/SUPER_ADMIN_(YMIS|PASS)\b/.test(src));
  check('Code.gs 只以 Script Properties 鍵名形式引用超管設定',
    src.includes("SUPER_ADMIN_USER_PROP = 'SUPER_ADMIN_USER'") && src.includes("SUPER_ADMIN_HASH_PROP = 'SUPER_ADMIN_PASS_HASH'"));
}

// ================== 2. initializeSheets() 彈框內容（本次修正重點）==================
console.log('\n【2】執行真實 initializeSheets()：完成提示不會跳出系統管理帳號');
const SU_USER = 'sysop_rover';
const SU_PASS = 'S3cret-Pass-2026';
const env = loadCodeGs({ promptAnswers: [SU_USER, SU_PASS, SU_PASS] });
let initResult;
{
  initResult = env.api.initializeSheets();
  check('initializeSheets() 執行成功並回傳 API Key', initResult && initResult.success === true && typeof initResult.apiKey === 'string' && initResult.apiKey.length > 10);
  check('initializeSheets() 只彈出一個提示框', env.ui.alerts.length === 1, `(實際 ${env.ui.alerts.length})`);
  const alertText = env.ui.alerts.map(a => `${a.title}\n${a.msg}`).join('\n');
  console.log('  ── 彈框內容 ──\n' + alertText.split('\n').map(l => '     ' + l).join('\n'));
  check('彈框仍顯示 API Key', alertText.includes(initResult.apiKey));
  check('彈框仍顯示部署 URL', alertText.includes('script.google.com'));
  check('彈框仍顯示本旅團管理員帳號', alertText.includes('1111111111'));
  check('彈框完全沒有提及超管／系統管理帳號',
    !/超管|super[_ ]?admin|SUPER_ADMIN|系統管理/i.test(alertText));
  check('彈框沒有出現任何舊版憑證字串', !/sheep|0728/i.test(alertText));
  check('初始化過程沒有任何輸入框（prompt）', env.ui.prompts.length === 0);
  check('initializeSheets() 回傳值不含系統管理帳號資訊',
    JSON.stringify(initResult) && !/超管|super_admin|SUPER_ADMIN|sheep/i.test(JSON.stringify(initResult)));
}

// ================== 3. 預設狀態：這個旅團沒有超管帳號，也沒有預設後門 ==================
console.log('\n【3】未執行 setSuperAdmin()：沒有任何超管帳號可用');
{
  check('getSuperAdminStatus() 回報未啟用（且不含任何憑證欄位）',
    env.api.getSuperAdminStatus().enabled === false && Object.keys(env.api.getSuperAdminStatus()).join(',') === 'success,enabled');
  check('isSuperAdminEnabled() 為 false', env.api.isSuperAdminEnabled() === false);
  const legacy = env.call({ action: 'login', login_id: 'sheep', password: '0728' });
  check('舊版寫死帳號 sheep / 0728 登入失敗', legacy.success === false, JSON.stringify(legacy));
  check('getUser(sheep) 查無此人', env.api.getUser('sheep') === null);
  const guess = env.call({ action: 'login', login_id: 'admin', password: 'admin' });
  check('亂猜帳號密碼登入失敗', guess.success === false);
  const adminOk = env.call({ action: 'login', login_id: '1111111111', password: 'changeme' });
  check('初始化建立的旅團管理員帳號仍可正常登入（回歸）', adminOk.success === true && adminOk.user.role === 'admin');
}

// ================== 4. 執行真實 setSuperAdmin()：憑證只存雜湊 ==================
console.log('\n【4】執行真實 setSuperAdmin()（3 個 prompt：帳號／密碼／確認密碼）');
{
  const before = env.ui.alerts.length;
  const res = env.api.setSuperAdmin();
  check('setSuperAdmin() 執行成功', res && res.success === true, JSON.stringify(res));
  check('setSuperAdmin() 依序問了 3 個問題', env.ui.prompts.length === 3, `(實際 ${env.ui.prompts.length})`);
  check('Script Properties 存有帳號', env.scriptProps.get('SUPER_ADMIN_USER') === SU_USER);
  check('Script Properties 只存密碼 SHA-256 雜湊（非明文）',
    env.scriptProps.get('SUPER_ADMIN_PASS_HASH') === sha256(SU_PASS) && !Array.from(env.scriptProps.values()).includes(SU_PASS));
  const setupAlerts = env.ui.alerts.slice(before).map(a => `${a.title}\n${a.msg}`).join('\n');
  check('設定完成的提示不會回顯密碼', !setupAlerts.includes(SU_PASS));
  check('設定完成的提示不含舊版憑證', !/sheep|0728/i.test(setupAlerts));
  check('getSuperAdminStatus() 只回 enabled，不回傳帳號／密碼／雜湊',
    env.api.getSuperAdminStatus().enabled === true && !JSON.stringify(env.api.getSuperAdminStatus()).includes(SU_USER));
}

// ================== 5. 用新憑證登入（走真實 doPost 路由）==================
console.log('\n【5】用新設定的憑證登入（doPost → handleLogin）');
let suToken = '';
{
  const ok = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  check('新憑證登入成功且為 super_admin', ok.success === true && ok.user && ok.user.role === 'super_admin');
  check('登入回應不含密碼字串', !JSON.stringify(ok).includes(SU_PASS));
  suToken = ok.token || '';
  check('登入取得 token', typeof suToken === 'string' && suToken.length > 10);
  const bad = env.call({ action: 'login', login_id: SU_USER, password: 'wrong-password' });
  check('密碼錯誤被拒', bad.success === false);
  const upper = env.call({ action: 'login', login_id: SU_USER.toUpperCase(), password: SU_PASS });
  check('帳號大小寫不敏感', upper.success === true);
  const legacy = env.call({ action: 'login', login_id: 'sheep', password: '0728' });
  check('設定新超管後，舊版 sheep / 0728 仍然無效', legacy.success === false);
}

// ================== 6. 任何名單都不出現系統管理帳號 ==================
console.log('\n【6】用戶名單／成員名單一律不出現系統管理帳號');
{
  const users = env.ss.getSheetByName('Users');
  // 模擬舊版殘留列：role=super_admin 的列，以及一列 YMIS 等於系統管理帳號的列
  users.appendRow(['legacy_sysop', '系統管理員', '', 'super_admin', sha256('legacy'), 'b4', true, 'system', '', '', '', 'active', '*']);
  users.appendRow([SU_USER, '系統管理員', '', 'admin', sha256('x'), 'b4', true, 'system', '', '', '', 'active', '*']);
  const all = env.api.getAllUsers();
  check('getAllUsers() 不含 role=super_admin 的殘留列', !all.some(u => u.role === 'super_admin'));
  check('getAllUsers() 不含系統管理帳號本身', !all.some(u => String(u.ymis).toLowerCase() === SU_USER));
  const members = env.api.getMembers();
  check('getMembers() 不含系統管理帳號／殘留列',
    !members.some(m => String(m.ymis).toLowerCase() === SU_USER || String(m.ymis) === 'legacy_sysop'));
  const listResp = env.call({ action: 'getAllUsers', token: suToken });
  check('doPost getAllUsers（超管本人查看）同樣過濾',
    listResp.success === true && !listResp.users.some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));
  const loadResp = env.get({ action: 'load' });
  check('load 回傳的 members 不含系統管理帳號',
    loadResp.success === true && !loadResp.members.some(m => String(m.ymis).toLowerCase() === SU_USER));
}

// ================== 7. 防護：不能停用／重設／改角色／自行改密碼／開戶 ==================
console.log('\n【7】系統管理帳號防護（且錯誤訊息不洩漏密碼）');
{
  const deact = env.call({ action: 'deactivateUser', token: suToken, target_ymis: SU_USER });
  check('不能停用系統管理員帳號', deact.success === false && /不能停用系統管理員/.test(deact.error || ''), JSON.stringify(deact));
  const rst = env.call({ action: 'resetPassword', token: suToken, target_ymis: SU_USER });
  check('不能重設系統管理員密碼', rst.success === false && /不能重設系統管理員/.test(rst.error || ''));
  const role = env.call({ action: 'updateUserRole', token: suToken, target_ymis: SU_USER, new_role: 'member' });
  check('不能更改系統管理員帳號的角色', role.success === false && /不能更改系統管理員/.test(role.error || ''));
  const cp = env.call({ action: 'changePassword', token: suToken, old_password: SU_PASS, new_password: 'abcd' });
  check('系統管理員不能自行更改密碼', cp.success === false, JSON.stringify(cp));
  check('錯誤訊息不含任何密碼字串（舊版曾回「密碼固定為 0728」）',
    !/0728|S3cret-Pass-2026/.test(JSON.stringify(cp)));
  const addM = env.call({ action: 'addMember', token: suToken, ymis: SU_USER, name: 'X' });
  check('不能以系統管理帳號為 YMIS 新增成員', addM.success === false);
  const addUser = env.call({ action: 'addUser', token: suToken, ymis: SU_USER, name: 'X' });
  check('不能以系統管理帳號開新帳號', addUser.success === false);
}

// ================== 8. removeSuperAdminRows() / clearSuperAdmin() ==================
console.log('\n【8】removeSuperAdminRows() 清殘留列；clearSuperAdmin() 停用帳號');
{
  const rm = env.api.removeSuperAdminRows();
  check('removeSuperAdminRows() 移除 2 列殘留（super_admin 列 + 同名列）', rm.removed === 2, JSON.stringify(rm));
  check('removeSuperAdminRows() 訊息不含憑證', !/sheep|0728|S3cret/i.test(rm.message || ''));
  check('Users 表已無 super_admin 列', !env.api.getAllUsers().some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));

  env.api.clearSuperAdmin();
  check('clearSuperAdmin() 後 Script Properties 已清空',
    env.scriptProps.get('SUPER_ADMIN_USER') === undefined && env.scriptProps.get('SUPER_ADMIN_PASS_HASH') === undefined);
  const after = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  check('clearSuperAdmin() 後系統管理帳號登入失效', after.success === false);
  const normal = env.call({ action: 'login', login_id: '1111111111', password: 'changeme' });
  check('clearSuperAdmin() 不影響一般帳號登入', normal.success === true);
}

// ================== 9. setSuperAdmin() 輸入驗證 ==================
console.log('\n【9】setSuperAdmin() 輸入驗證');
{
  const e2 = loadCodeGs({ promptAnswers: ['1234567890', 'whatever', 'whatever'] });
  const r1 = e2.api.setSuperAdmin();
  check('拒絕 10 位數字帳號（避免與 YMIS 衝突）', r1.success === false && /10 位數字/.test(r1.error || ''), JSON.stringify(r1));
  const e3 = loadCodeGs({ promptAnswers: ['sysop', 'short', 'short'] });
  const r2 = e3.api.setSuperAdmin();
  check('拒絕少於 8 位的密碼', r2.success === false && /最少 8 位/.test(r2.error || ''), JSON.stringify(r2));
  const e4 = loadCodeGs({ promptAnswers: ['sysop', 'LongEnough-1', 'LongEnough-2'] });
  const r3 = e4.api.setSuperAdmin();
  check('兩次密碼不一致被拒', r3.success === false && /不一致/.test(r3.error || ''));
  const e5 = loadCodeGs({ promptAnswers: [null] });
  const r4 = e5.api.setSuperAdmin();
  check('按取消不會寫入任何憑證', r4.success === false && r4.cancelled === true && e5.api.isSuperAdminEnabled() === false);
  check('被拒的設定不會殘留半套憑證', e4.api.isSuperAdminEnabled() === false && e3.api.isSuperAdminEnabled() === false);
}

// ================== 10. 單次執行內快取不會殘留舊憑證 ==================
console.log('\n【10】Script Properties 快取：設定／停用後立即生效（無 stale cache）');
{
  const e6 = loadCodeGs({ promptAnswers: ['sysop_x', 'LongEnough-9', 'LongEnough-9'] });
  e6.api.initializeSheets();
  e6.api.setSuperAdmin();
  const users = e6.ss.getSheetByName('Users');
  // 先讀一次名單（觸發快取），再停用系統管理帳號，然後寫入同名列
  e6.api.getAllUsers();
  e6.api.clearSuperAdmin();
  users.appendRow(['sysop_x', '同名一般帳號', '', 'admin', sha256('pw'), 'b4', true, 'system', '', '', '', 'active', '*']);
  const after = e6.api.getAllUsers();
  check('停用後同名帳號不再被當成系統管理帳號隱藏（快取已失效）',
    after.some(u => u.ymis === 'sysop_x'), JSON.stringify(after.map(u => u.ymis)));
  check('停用後該帳號可用一般流程登入（回歸）',
    e6.call({ action: 'login', login_id: '1111111111', password: 'changeme' }).success === true);
}

console.log('\n========================================');
console.log(`Code.gs 實測結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
