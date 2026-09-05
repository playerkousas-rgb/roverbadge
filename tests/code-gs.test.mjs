// 直接執行 apps-script/Code.gs（真實後端程式碼）的測試
// 規格（v8.6）：超管「只存在於 Code.gs」
//   1. 超管實際存在、裝完即用（唔使任何設定）
//   2. Google Sheet 完全冇蹤跡（Users 表冇這列，Tokens 表都唔會出現帳號）
//   3. 初始 setup（initializeSheets）嗰個小視窗完全唔提超管
//   4. 用戶名單／成員名單／任何 API 回應／錯誤訊息都不會出現超管帳號或密碼
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

const env = loadCodeGs();
// 憑證由 Code.gs 本身提供（不在測試寫死），用以驗證「超管確實存在」＋「憑證唔會外洩」
const SU_USER = env.api.getSuperAdminUser();
const SU_PASS = env.api.getSuperAdminPass();

// 把整份 Sheet 所有儲存格掃一次，找出超管帳號／密碼的蹤跡
function scanSheets() {
  const hits = [];
  for (const [name, sheet] of env.ss.sheets.entries()) {
    sheet.rows.forEach((row, r) => row.forEach((cell, c) => {
      const v = String(cell === undefined || cell === null ? '' : cell);
      if (v.toLowerCase().includes(SU_USER) || v.includes(SU_PASS)) hits.push(`${name}!R${r + 1}C${c + 1}=${v}`);
    }));
  }
  return hits;
}

// ================== 1. 超管只寫在 Code.gs 內 ==================
console.log('\n【1】超管憑證只存在於 Code.gs');
{
  check('Code.gs 內有超管帳號（超管確實存在）', typeof SU_USER === 'string' && SU_USER.length > 0);
  check('Code.gs 內有超管密碼', typeof SU_PASS === 'string' && SU_PASS.length >= 4);
  const src = fs.readFileSync(CODE_GS_PATH, 'utf8');
  check('超管不依賴 Script Properties（無須任何設定）',
    !/SUPER_ADMIN_USER_PROP|SUPER_ADMIN_PASS_HASH|setSuperAdmin|clearSuperAdmin/.test(src));
  check('明文凭證不以完整字串出現在原始碼（用拼接避免被搜尋到）',
    !src.includes(`'${SU_USER}'`) && !src.includes(`'${SU_PASS}'`));
}

// ================== 2. 初始 setup 的小視窗（本次修正重點）==================
console.log('\n【2】執行真實 initializeSheets()：setup 小視窗完全唔提超管');
{
  const initResult = env.api.initializeSheets();
  check('initializeSheets() 執行成功並回傳 API Key',
    initResult && initResult.success === true && typeof initResult.apiKey === 'string' && initResult.apiKey.length > 10);
  check('初始化只彈出一個小視窗', env.ui.alerts.length === 1, `(實際 ${env.ui.alerts.length})`);
  const alertText = env.ui.alerts.map(a => `${a.title}\n${a.msg}`).join('\n');
  console.log('  ── 小視窗內容 ──\n' + alertText.split('\n').map(l => '     ' + l).join('\n'));
  check('小視窗仍有 API Key', alertText.includes(initResult.apiKey));
  check('小視窗仍有部署 URL', alertText.includes('script.google.com'));
  check('小視窗仍有本旅團管理員帳號', alertText.includes('1111111111'));
  check('小視窗完全冇提超管／系統管理帳號', !/超管|super[_ ]?admin|SUPER_ADMIN|系統管理/i.test(alertText));
  check('小視窗冇出現超管帳號或密碼', !alertText.toLowerCase().includes(SU_USER) && !alertText.includes(SU_PASS));
  check('初始化過程冇任何輸入框（prompt）', env.ui.prompts.length === 0);
  check('initializeSheets() 回傳值冇超管資訊', !/超管|super_admin/i.test(JSON.stringify(initResult)));
}

// ================== 3. Sheet 完全冇蹤跡 ==================
console.log('\n【3】Google Sheet 完全冇超管蹤跡');
{
  const users = env.ss.getSheetByName('Users');
  const ids = users.rows.slice(1).map(r => String(r[0]).toLowerCase());
  check('Users 表冇超管這列', !ids.includes(SU_USER), JSON.stringify(ids));
  check('Users 表冇 role=super_admin 的列', !users.rows.slice(1).some(r => String(r[3]) === 'super_admin'));

  // 超管登入後，Tokens 表亦唔應該出現超管帳號
  const login = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  check('超管登入成功（超管實際可用）', login.success === true && login.user.role === 'super_admin');
  const tokens = env.ss.getSheetByName('Tokens');
  check('Tokens 表以中性代號儲存超管 session（唔出現帳號）',
    tokens.rows.slice(1).some(r => String(r[1]) === '__sys__') && !tokens.rows.slice(1).some(r => String(r[1]).toLowerCase() === SU_USER),
    JSON.stringify(tokens.rows.slice(1)));
  // 用該 token 做一次讀取，確認 session 還原正常
  const viaToken = env.call({ action: 'getAllUsers', token: login.token });
  check('超管 token 可正常通過驗證（session 還原正常）', viaToken.success === true && Array.isArray(viaToken.users));

  const hits = scanSheets();
  check('掃描全部工作表所有儲存格：搵唔到超管帳號或密碼', hits.length === 0, hits.join(', '));
}

// ================== 4. 名單／API 回應／錯誤訊息都不外洩 ==================
console.log('\n【4】用戶名單／成員名單／API 回應都不出現超管');
{
  const users = env.ss.getSheetByName('Users');
  // 模擬舊版殘留：Users 表入面有一列超管（舊版 ensureSuperAdmin 寫入的）
  users.appendRow([SU_USER, '系統管理員', '', 'super_admin', sha256('legacy'), 'b4', true, 'system', '', '', '', 'active', '*']);
  users.appendRow(['legacy_sysop', '舊版殘留', '', 'super_admin', sha256('x'), 'b4', true, 'system', '', '', '', 'active', '*']);

  const all = env.api.getAllUsers();
  check('getAllUsers() 冇 super_admin 列（包括超管本人）', !all.some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));
  const members = env.api.getMembers();
  check('getMembers() 冇超管／殘留列',
    !members.some(m => String(m.ymis).toLowerCase() === SU_USER || String(m.ymis) === 'legacy_sysop'));

  const login = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  const listSelf = env.call({ action: 'getAllUsers', token: login.token });
  check('doPost getAllUsers（超管本人查看）一樣過濾',
    listSelf.success === true && !listSelf.users.some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));
  const loadResp = env.get({ action: 'load' });
  check('load 回傳的 members 冇超管', loadResp.success === true && !loadResp.members.some(m => String(m.ymis).toLowerCase() === SU_USER));

  // 登入回應本身要回傳身分（前端需要 currentUser.ymis），只回給剛通過密碼驗證的超管本人；
  // 除此之外任何回應／錯誤訊息都不應出現超管帳號
  check('登入成功時只回傳本人身分（前端需要 ymis）',
    login.success === true && login.user.ymis === SU_USER && login.user.name === '系統管理員');
  const others = [listSelf, loadResp,
    env.call({ action: 'login', login_id: SU_USER, password: 'wrong' }),
    env.call({ action: 'login', login_id: '1111111111', password: 'changeme' }),
    env.call({ action: 'changePassword', token: login.token, old_password: SU_PASS, new_password: 'abcd' }),
    env.call({ action: 'resetPassword', token: login.token, target_ymis: SU_USER }),
    env.call({ action: 'deactivateUser', token: login.token, target_ymis: SU_USER }),
    env.call({ action: 'updateUserRole', token: login.token, target_ymis: SU_USER, new_role: 'member' }),
    env.api.getAllUsers(), env.api.getMembers(), env.api.getUser(SU_USER) && { hidden: true }
  ].map(o => JSON.stringify(o)).join('\n');
  check('除登入回應外，任何 API 回應／錯誤訊息都不含超管帳號', !others.toLowerCase().includes(SU_USER), others);
  const leaky = others + JSON.stringify(login);
  check('任何 API 回應／錯誤訊息都不含超管密碼', !leaky.includes(SU_PASS));
  check('所有彈框內容都不含超管帳號或密碼',
    !env.ui.alerts.map(a => `${a.title}${a.msg}`).join('\n').toLowerCase().includes(SU_USER));
}

// ================== 5. 防護：不能停用／重設／改角色／自行改密碼／開戶 ==================
console.log('\n【5】超管防護');
{
  const login = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  const tk = login.token;
  const deact = env.call({ action: 'deactivateUser', token: tk, target_ymis: SU_USER });
  check('不能停用系統管理員帳號', deact.success === false && /不能停用系統管理員/.test(deact.error || ''), JSON.stringify(deact));
  const rst = env.call({ action: 'resetPassword', token: tk, target_ymis: SU_USER });
  check('不能重設系統管理員密碼', rst.success === false && /不能重設系統管理員/.test(rst.error || ''));
  const role = env.call({ action: 'updateUserRole', token: tk, target_ymis: SU_USER, new_role: 'member' });
  check('不能更改系統管理員帳號的角色', role.success === false && /不能更改系統管理員/.test(role.error || ''));
  const cp = env.call({ action: 'changePassword', token: tk, old_password: SU_PASS, new_password: 'abcd' });
  check('系統管理員不能自行更改密碼', cp.success === false, JSON.stringify(cp));
  check('錯誤訊息冇洩漏密碼（舊版曾回「密碼固定為 0728」）', !cp.error.includes(SU_PASS) && !/0728/.test(cp.error || ''));
  const addM = env.call({ action: 'addMember', token: tk, ymis: SU_USER, name: 'X' });
  check('不能以超管帳號為 YMIS 新增成員', addM.success === false);
  const addU = env.call({ action: 'addUser', token: tk, ymis: SU_USER, name: 'X' });
  check('不能以超管帳號開新帳號', addU.success === false);
  const wrongPw = env.call({ action: 'login', login_id: SU_USER, password: 'nope' });
  check('超管密碼錯誤被拒', wrongPw.success === false);
  const caseInsensitive = env.call({ action: 'login', login_id: SU_USER.toUpperCase(), password: SU_PASS });
  check('超管帳號大小寫不敏感', caseInsensitive.success === true);
}

// ================== 6. 回歸：一般帳號／初始化功能正常 ==================
console.log('\n【6】回歸檢查');
{
  const admin = env.call({ action: 'login', login_id: '1111111111', password: 'changeme' });
  check('初始化建立的旅團管理員可正常登入', admin.success === true && admin.user.role === 'admin');
  const tokens = env.ss.getSheetByName('Tokens');
  check('一般帳號的 Tokens 列照舊寫入帳號（只有超管用中性代號）',
    tokens.rows.slice(1).some(r => String(r[1]) === '1111111111'));
  // 再種一列舊版殘留，驗證清理函式（連同【4】留下的殘留列一併計）
  const uSheet = env.ss.getSheetByName('Users');
  uSheet.appendRow(['legacy_sysop2', '舊版殘留', '', 'super_admin', sha256('y'), 'b4', true, 'system', '', '', '', 'active', '*']);
  const residue = uSheet.rows.slice(1).filter(r => String(r[3]) === 'super_admin' || String(r[0]).toLowerCase() === SU_USER).length;
  check('測試環境確實有殘留列可清', residue >= 1, `殘留 ${residue} 列`);
  const rm = env.api.removeSuperAdminRows();
  check('removeSuperAdminRows() 清走全部殘留的 super_admin 列', rm.removed === residue, `removed=${rm.removed}, 應為 ${residue}`);
  check('清完之後 Users 表再冇 super_admin 列', !env.api.getAllUsers().some(u => u.role === 'super_admin'));
  const after = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  check('清走殘留列後超管仍可登入（唔靠 Sheet）', after.success === true && after.user.role === 'super_admin');
  const status = env.api.checkSuperAdmin();
  check('checkSuperAdmin() 只回布林，不回傳憑證',
    status.enabled === true && !JSON.stringify(status).includes(SU_PASS));
  check('超管仍然有最高權限（可讀全團名單）',
    env.call({ action: 'getAllUsers', token: after.token }).success === true);
}

// ================== 7. 超管實際做行政操作後，Sheet 仍然冇蹤跡 ==================
console.log('\n【7】超管做行政操作（寫入操作紀錄）後，Sheet 仍然冇超管帳號');
{
  const login = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  const rst = env.call({ action: 'resetPassword', token: login.token, target_ymis: '1111111111' });
  check('超管可執行行政操作（重設成員密碼）', rst.success === true && typeof rst.temp_password === 'string', JSON.stringify(rst));
  const audit = env.ss.getSheetByName('操作紀錄');
  check('操作紀錄有寫入這筆操作', !!audit && audit.rows.length >= 2, JSON.stringify(audit && audit.rows));
  check('操作紀錄嘅「操作者」欄寫顯示名稱，唔係帳號',
    audit.rows.slice(1).some(r => String(r[1]) === '系統管理員') && !audit.rows.slice(1).some(r => String(r[1]).toLowerCase() === SU_USER),
    JSON.stringify(audit.rows.slice(1)));
  const hits = scanSheets();
  check('再掃一次全部工作表所有儲存格：仍然搵唔到超管帳號或密碼', hits.length === 0, hits.join(', '));
}


// ================== 8. v8.7 團長唯一／領袖免 YMIS／批核密碼 1234＋強制改密 ==================
console.log('\n【8】v8.7 團長唯一鎖、領袖免 YMIS、批核預設密碼 1234、首次登入強制改密');
{
  const su = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  const tk = su.token;
  check('超管可登入以執行行政測試', su.success === true);

  const badRole = env.call({ action: 'apply', ymis: '1234567001', name: '假團長', email: 'fake-gsl@x.com', requested_role: 'group_leader' });
  check('公開申請不接受團長', badRole.success === false && /無效的申請角色/.test(badRole.error || ''), JSON.stringify(badRole));
  const badExec = env.call({ action: 'apply', ymis: '1234567002', name: '假管委', email: 'fake-cmc@x.com', requested_role: 'exec_committee' });
  check('公開申請不接受管委', badExec.success === false);

  const noYmisMember = env.call({ action: 'apply', ymis: '', name: '缺號成員', requested_role: 'member' });
  check('成員申請缺 YMIS 被拒', noYmisMember.success === false);

  const leaderApply = env.call({ action: 'apply', ymis: '9999999999', name: '領袖乙', email: 'leader-b@x.com', requested_role: 'branch_leader' });
  check('領袖申請可提交（YMIS 被忽略）', leaderApply.success === true, JSON.stringify(leaderApply));
  const memApply = env.call({ action: 'apply', ymis: '1234567003', name: '成員丙', email: 'mem-c@x.com', requested_role: 'member' });
  check('成員申請需 10 位 YMIS', memApply.success === true);

  const apps = env.call({ action: 'getApplications', token: tk });
  const leaderApp = (apps.applications || []).find(a => a.name === '領袖乙');
  const memApp = (apps.applications || []).find(a => a.name === '成員丙');
  check('待批名單有領袖及成員申請', !!leaderApp && !!memApp, JSON.stringify(apps));

  const revL = env.call({ action: 'reviewApplication', token: tk, app_id: leaderApp && leaderApp.app_id, decision: 'approved' });
  check('批准領袖：預設密碼 1234', revL.success === true && revL.temp_password === '1234', JSON.stringify(revL));
  check('批准領袖：角色為支部領袖', revL.final_role === 'branch_leader');
  check('批准領袖：內部編號以 L 開頭（不展示給領袖）', typeof revL.ymis === 'string' && /^L/.test(revL.ymis), JSON.stringify(revL));

  const loginL = env.call({ action: 'login', login_id: 'leader-b@x.com', password: '1234' });
  check('領袖用電郵 + 1234 登入且須改密', loginL.success === true && loginL.force_change_password === true, JSON.stringify(loginL));
  const samePw = env.call({ action: 'changePassword', token: loginL.token, old_password: '1234', new_password: '1234' });
  check('新密碼不可與原密碼相同', samePw.success === false);
  const cpL = env.call({ action: 'changePassword', token: loginL.token, old_password: '1234', new_password: 'abcd' });
  check('首次改密成功', cpL.success === true, JSON.stringify(cpL));
  const loginL2 = env.call({ action: 'login', login_id: 'leader-b@x.com', password: 'abcd' });
  check('改密後不再強制改密', loginL2.success === true && loginL2.force_change_password === false, JSON.stringify(loginL2));

  const revM = env.call({ action: 'reviewApplication', token: tk, app_id: memApp && memApp.app_id, decision: 'approved' });
  check('批准成員保留原 YMIS、密碼 1234', revM.success === true && revM.ymis === '1234567003' && revM.temp_password === '1234' && revM.final_role === 'member', JSON.stringify(revM));

  const aSheet = env.ss.getSheetByName('Applications');
  aSheet.appendRow(['APP_FAKE_GSL', '', '假團長申請', 'fake-gsl2@x.com', 'group_leader', '', 'pending', '2026-09-05', '', '', '']);
  const revFake = env.call({ action: 'reviewApplication', token: tk, app_id: 'APP_FAKE_GSL', decision: 'approved' });
  check('Sheet 人手改寫的團長申請退回 member', revFake.success === true && revFake.final_role === 'member', JSON.stringify(revFake));

  const gsl1 = env.call({ action: 'addUser', token: tk, ymis: '', name: '團長甲', email: 'gsl-a@x.com', role: 'group_leader', password: '1234', can_tick: true });
  check('可開立第一位團長（免 YMIS）', gsl1.success === true && /^L/.test(gsl1.ymis || ''), JSON.stringify(gsl1));
  const gsl2 = env.call({ action: 'addUser', token: tk, ymis: '', name: '團長乙', email: 'gsl-b@x.com', role: 'group_leader', password: '1234', can_tick: true });
  check('第二位團長被拒', gsl2.success === false && /團長只能有一位/.test(gsl2.error || ''), JSON.stringify(gsl2));

  const bl = env.call({ action: 'addUser', token: tk, ymis: '1234567004', name: '支領丁', email: 'bl-d@x.com', role: 'branch_leader', password: 'PassB!234', can_tick: true });
  check('超管可開支部領袖（自訂密碼）', bl.success === true);
  const blLogin = env.call({ action: 'login', login_id: 'bl-d@x.com', password: 'PassB!234' });
  check('自訂密碼開戶不強制改密', blLogin.success === true && blLogin.force_change_password === false, JSON.stringify(blLogin));
  const blAddAdmin = env.call({ action: 'addUser', token: blLogin.token, ymis: '1234567005', name: 'X', email: 'x-admin@x.com', role: 'admin', password: '1234' });
  check('支部領袖不可開管理員', blAddAdmin.success === false && /權限不足/.test(blAddAdmin.error || ''), JSON.stringify(blAddAdmin));

  const suAddAdmin = env.call({ action: 'addUser', token: tk, ymis: '1234567006', name: '新管理員', email: 'new-admin@x.com', role: 'admin', password: '1234' });
  check('超管可開管理員', suAddAdmin.success === true, JSON.stringify(suAddAdmin));

  const suFmt = env.call({ action: 'addUser', token: tk, ymis: SU_USER, name: 'X' });
  check('超管以自身帳號開戶被拒（格式／保留帳號）', suFmt.success === false);

  const defMem = env.call({ action: 'addUser', token: tk, ymis: '1234567007', name: '成員戊', email: 'mem-e@x.com', role: 'member', password: '1234' });
  const defLogin = env.call({ action: 'login', login_id: '1234567007', password: '1234' });
  check('預設密碼 1234 首次登入須改密', defMem.success === true && defLogin.success === true && defLogin.force_change_password === true);

  const promote = env.call({ action: 'updateUserRole', token: tk, target_ymis: '1234567004', new_role: 'group_leader', can_tick: true });
  check('已有團長時不能再升另一人為團長', promote.success === false && /團長只能有一位/.test(promote.error || ''), JSON.stringify(promote));
}

console.log('\n【9】v8.8 唯一性／三區名單／自設密碼／找回密碼／恢復／刪除（真實 Code.gs）');
{
  const su = env.call({ action: 'login', login_id: SU_USER, password: SU_PASS });
  const tk = su.token;
  check('超管可登入以執行 v8.8 測試', su.success === true);

  // (a) YMIS／Email 唯一：重複開戶被拒
  const u1 = env.call({ action: 'addUser', token: tk, ymis: '1234568001', name: '唯一甲', email: 'uniq-a@x.com', role: 'member', password: '1234' });
  check('addUser 首戶成功', u1.success === true, JSON.stringify(u1));
  const uDup = env.call({ action: 'addUser', token: tk, ymis: '1234568001', name: '重複甲', email: 'uniq-a2@x.com', role: 'member', password: '1234' });
  check('重複 YMIS 開戶被拒', uDup.success === false && /已註冊/.test(uDup.error || ''), JSON.stringify(uDup));
  const eDup = env.call({ action: 'addUser', token: tk, ymis: '1234568002', name: '重複乙', email: 'UNIQ-A@X.COM', role: 'member', password: '1234' });
  check('重複 Email 開戶被拒（大小寫不敏感）', eDup.success === false && /Email/.test(eDup.error || ''), JSON.stringify(eDup));

  // (b) addMember 只入名單；同 YMIS 再加被拒；有帳號者被拒
  const m1 = env.call({ action: 'addMember', token: tk, ymis: '1234568011', name: '名單丙', squad: '測試小隊' });
  check('addMember 純名單成功', m1.success === true, JSON.stringify(m1));
  const mDup = env.call({ action: 'addMember', token: tk, ymis: '1234568011', name: '名單丙2' });
  check('重複 addMember 同一 YMIS 被拒', mDup.success === false && /已在成員名單/.test(mDup.error || ''), JSON.stringify(mDup));
  const mHas = env.call({ action: 'addMember', token: tk, ymis: '1234568001', name: '唯一甲' });
  check('已有登入帳號者 addMember 被拒', mHas.success === false && /登入帳號/.test(mHas.error || ''), JSON.stringify(mHas));

  // (c) getAllUsers 含 status；getMembers 含純名單成員
  const gu = env.call({ action: 'getAllUsers', token: tk });
  check('getAllUsers 含新帳號且帶 status=active',
    gu.success === true && gu.users.some(u => u.ymis === '1234568001' && u.status === 'active'),
    JSON.stringify((gu.users || []).filter(u => u.ymis === '1234568001')));
  check('getAllUsers 不含純名單成員', gu.success === true && !gu.users.some(u => u.ymis === '1234568011'));
  const gm = env.call({ action: 'getMembers', token: tk });
  check('getMembers 含純名單成員', gm.success === true && gm.members.some(m => m.ymis === '1234568011'), 'count=' + (gm.members || []).length);

  // (d) updateUserProfile／自設密碼
  const pf = env.call({ action: 'updateUserProfile', token: tk, target_ymis: '1234568001', name: '唯一甲改名', email: 'uniq-a-new@x.com', branch: '新小隊' });
  check('updateUserProfile 修改成功', pf.success === true, JSON.stringify(pf));
  const sp = env.call({ action: 'resetPassword', token: tk, target_ymis: '1234568001', new_password: 'SetByLeader!1' });
  check('resetPassword 自設密碼成功（不回 temp）', sp.success === true && !('temp_password' in sp), JSON.stringify(sp));
  const lgSet = env.call({ action: 'login', login_id: '1234568001', password: 'SetByLeader!1' });
  check('自設密碼可登入且須改密', lgSet.success === true && lgSet.force_change_password === true, JSON.stringify(lgSet));

  // (e) forgotPassword：有 Email 者寄出（MailApp mock）、回遮罩、不回密碼
  const fp = env.call({ action: 'forgotPassword', login_id: 'uniq-a-new@x.com' });
  check('forgotPassword 成功（免 token）', fp.success === true && (fp.email_hint || '').includes('@'), JSON.stringify(fp));
  const sent = env.mailOutbox[env.mailOutbox.length - 1];
  check('MailApp 寄出臨時密碼郵件', !!sent && sent.to === 'uniq-a-new@x.com' && /Rover\d{6}/.test(sent.body), JSON.stringify(sent));
  const tmpPw = (sent.body.match(/Rover\d{6}/) || [])[0];
  const lgTmp = env.call({ action: 'login', login_id: '1234568001', password: tmpPw });
  check('郵件中的臨時密碼可登入', lgTmp.success === true, JSON.stringify(lgTmp));
  const fpAgain = env.call({ action: 'forgotPassword', login_id: '1234568001' });
  check('60 秒內重複找回被節流', fpAgain.success === false && /頻密/.test(fpAgain.error || ''), JSON.stringify(fpAgain));
  // 無 Email 者 → 提示聯絡領袖
  const noEm = env.call({ action: 'addUser', token: tk, ymis: '1234568003', name: '無郵成員', email: '', role: 'member', password: '1234' });
  const fpNo = env.call({ action: 'forgotPassword', login_id: '1234568003' });
  check('無 Email 者找回失敗並提示聯絡領袖', noEm.success === true && fpNo.success === false && /聯絡領袖/.test(fpNo.error || ''), JSON.stringify(fpNo));
  const fpSu = env.call({ action: 'forgotPassword', login_id: SU_USER });
  check('超管不可自助找回密碼', fpSu.success === false, JSON.stringify(fpSu));

  // (f) 停用 → 停用中不可重複開戶 → 恢復 → 徹底刪除 → 可重用
  const de1 = env.call({ action: 'deactivateUser', token: tk, target_ymis: '1234568001' });
  check('停用成功', de1.success === true, JSON.stringify(de1));
  const guIn = env.call({ action: 'getAllUsers', token: tk });
  check('getAllUsers 含已停用帳號（status=inactive）', guIn.users.some(u => u.ymis === '1234568001' && u.status === 'inactive'));
  const dupIn = env.call({ action: 'addUser', token: tk, ymis: '1234568001', name: '重用甲', email: 'reuse-a@x.com', role: 'member', password: '1234' });
  check('停用中 YMIS 不可重複開戶', dupIn.success === false && /停用/.test(dupIn.error || ''), JSON.stringify(dupIn));
  const re1 = env.call({ action: 'reactivateUser', token: tk, target_ymis: '1234568001' });
  check('恢復帳號成功', re1.success === true, JSON.stringify(re1));
  const lgRe = env.call({ action: 'login', login_id: '1234568001', password: tmpPw });
  check('恢復後原密碼可登入', lgRe.success === true, JSON.stringify(lgRe));
  const delAct = env.call({ action: 'deleteUser', token: tk, target_ymis: '1234568001' });
  check('啟用中帳號不可徹底刪除', delAct.success === false && /停用/.test(delAct.error || ''), JSON.stringify(delAct));
  env.call({ action: 'deactivateUser', token: tk, target_ymis: '1234568001' });
  const delOk = env.call({ action: 'deleteUser', token: tk, target_ymis: '1234568001' });
  check('已停用帳號徹底刪除成功', delOk.success === true, JSON.stringify(delOk));
  const guDel = env.call({ action: 'getAllUsers', token: tk });
  check('徹底刪除後不在用戶名單', !guDel.users.some(u => u.ymis === '1234568001'));
  const reuse = env.call({ action: 'addUser', token: tk, ymis: '1234568001', name: '重用甲', email: 'uniq-a-new@x.com', role: 'member', password: '1234' });
  check('徹底刪除後 YMIS／Email 可重用', reuse.success === true, JSON.stringify(reuse));

  // (g) deleteMember：純名單可刪；有帳號者不可
  const dm1 = env.call({ action: 'deleteMember', token: tk, target_ymis: '1234568011' });
  check('deleteMember 刪除純名單成員成功', dm1.success === true, JSON.stringify(dm1));
  const gmDel = env.call({ action: 'getMembers', token: tk });
  check('刪除後不在成員名單', !gmDel.members.some(m => m.ymis === '1234568011'));
  const dmHas = env.call({ action: 'deleteMember', token: tk, target_ymis: '1234568001' });
  check('已有登入帳號者不可 deleteMember', dmHas.success === false && /帳號/.test(dmHas.error || ''), JSON.stringify(dmHas));

  // (h) 權限：成員不可調管理動作
  const memTk = env.call({ action: 'login', login_id: '1234568001', password: '1234' }).token;
  const memDel = env.call({ action: 'deleteMember', token: memTk, target_ymis: '1234568011' });
  check('成員不可調用 deleteMember', memDel.success === false && /權限不足/.test(memDel.error || ''), JSON.stringify(memDel));
  const memRe = env.call({ action: 'reactivateUser', token: memTk, target_ymis: '1234568001' });
  check('成員不可調用 reactivateUser', memRe.success === false && /權限不足/.test(memRe.error || ''), JSON.stringify(memRe));
}

console.log('\n========================================');
console.log(`Code.gs 實測結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
