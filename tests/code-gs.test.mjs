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

console.log('\n========================================');
console.log(`Code.gs 實測結果：${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
