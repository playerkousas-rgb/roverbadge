// 直接執行 apps-script/Code.gs（真實後端程式碼）的測試
// 規格（v8.9）：系統保留帳號（super_admin 角色）的密碼不在 Code.gs：
//   1. Code.gs 只保留一行帳號識別字宣告（SUPER_ADMIN_ID），不含任何密碼／密碼比對
//   2. login 不再接受保留帳號；superTicketLogin 向固定中央驗證端點驗票後才建立 session
//   3. Google Sheet 完全冇蹤跡（Users 表冇這列，Tokens 表以中性代號儲存）
//   4. 初始 setup（initializeSheets）小視窗／用戶名單／成員名單／API 回應都不出現帳號
// 中央驗證端點用「真正的 api/_super.js 驗票邏輯」模擬（等同正式環境的 /api/verify-super-ticket）。
// 執行：node tests/code-gs.test.mjs
import fs from 'fs';
import crypto from 'crypto';
import { loadCodeGs, CODE_GS_PATH } from './gas-harness.mjs';

// SUPER_KEY 政策測試用（4 字元；必須在 import _super.js 前設定）
process.env.SUPER_KEY = '9876';
const { issueSuperTicket, verifySuperTicket } = await import('../api/_super.js');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// harness 的 ScriptApp URL（getOwnBackendUrl() 會回傳這個；票據必須綁定同一 URL）
const HARNESS_EXEC = 'https://script.google.com/macros/s/HARNESS/exec';
const DEFAULT_VERIFY_URL = 'https://roverbadge.vercel.app/api/verify-super-ticket';

// 中央驗證端點（mock）：用真正的 verifySuperTicket 驗票（含時效 + 後端綁定）
const verifyCalls = [];
const env = loadCodeGs({
  urlFetchHandler: (url, opts) => {
    verifyCalls.push({ url, payload: opts && opts.payload });
    let body = {};
    try { body = JSON.parse(opts.payload); } catch (e) { /* ignore */ }
    const p = verifySuperTicket(body.ticket, body.backend);
    return { code: 200, content: JSON.stringify(p ? { valid: true, login_id: p.id } : { valid: false }) };
  }
});

// 保留帳號識別字由 Code.gs 本身提供（測試不另行寫死）
const SU_USER = env.api.SUPER_ADMIN_ID;

// 中央管理登入（走真實 doPost → handleSuperTicketLogin → mock 中央端點）
function suLogin(loginId = SU_USER, backend = HARNESS_EXEC) {
  const ticket = issueSuperTicket({ loginId, troopId: '0082', backend });
  return env.call({ action: 'superTicketLogin', superTicket: ticket });
}

// 把整份 Sheet 所有儲存格掃一次，找出保留帳號的蹤跡
function scanSheets() {
  const hits = [];
  for (const [name, sheet] of env.ss.sheets.entries()) {
    sheet.rows.forEach((row, r) => row.forEach((cell, c) => {
      const v = String(cell === undefined || cell === null ? '' : cell);
      if (v.toLowerCase().includes(SU_USER)) hits.push(`${name}!R${r + 1}C${c + 1}=${v}`);
    }));
  }
  return hits;
}

// ================== 1. Code.gs 不含任何密碼；帳號只有一行宣告 ==================
console.log('\n【1】Code.gs 只有帳號識別字一行宣告，沒有任何密碼');
{
  check('Code.gs 內有 SUPER_ADMIN_ID 宣告（保留帳號確實存在）', typeof SU_USER === 'string' && SU_USER.length > 0);
  const src = fs.readFileSync(CODE_GS_PATH, 'utf8');
  check('帳號識別字在原始碼只宣告一次', (src.match(/SUPER_ADMIN_ID\s*=/g) || []).length === 1);
  check(`帳號字串 '${SU_USER}' 在原始碼只出現一次（該行宣告）`,
    (src.match(new RegExp(`'${SU_USER}'`, 'g')) || []).length === 1);
  check('沒有 getSuperAdminPass / SUPER_ADMIN_PASS 等密碼來源', !/getSuperAdminPass|SUPER_ADMIN_PASS/i.test(src));
  check('沒有舊密碼字樣（0728）', !src.includes('0728'));
  check('handleLogin 不再比對保留帳號密碼（舊密碼入口已移除）',
    /isSuperAdminId\(loginId\)\)\{\s*\n\s*return jsonResponse\(\{success:false/.test(src));
  check('中央驗證端點是 https 常量（可信設定，不由請求指定）',
    /const SUPER_TICKET_VERIFY_URL = 'https:\/\//.test(src));
}

// ================== 2. 初始 setup 的小視窗 ==================
console.log('\n【2】執行真實 initializeSheets()：setup 小視窗唔提保留帳號');
{
  const initResult = env.api.initializeSheets();
  check('initializeSheets() 執行成功並回傳 API Key',
    initResult && initResult.success === true && typeof initResult.apiKey === 'string' && initResult.apiKey.length > 10);
  check('初始化只彈出一個小視窗', env.ui.alerts.length === 1, `(實際 ${env.ui.alerts.length})`);
  const alertText = env.ui.alerts.map(a => `${a.title}\n${a.msg}`).join('\n');
  check('小視窗仍有 API Key', alertText.includes(initResult.apiKey));
  check('小視窗仍有部署 URL', alertText.includes('script.google.com'));
  check('小視窗仍有本旅團管理員帳號', alertText.includes('1111111111'));
  check('小視窗完全冇提保留帳號／系統管理帳號', !/超管|super[_ ]?admin|SUPER_ADMIN|系統管理/i.test(alertText));
  check('小視窗冇出現帳號識別字', !alertText.toLowerCase().includes(SU_USER));
  check('初始化過程冇任何輸入框（prompt）', env.ui.prompts.length === 0);
  check('initializeSheets() 回傳值冇保留帳號資訊', !/超管|super_admin/i.test(JSON.stringify(initResult)));
}

// ================== 3. 登入：舊密碼入口已封閉；票據驗票先有 session ==================
console.log('\n【3】superTicketLogin 中央驗票');
{
  // 舊密碼入口：login 一律拒絕保留帳號（不論密碼）
  const oldEntry = env.call({ action: 'login', login_id: SU_USER, password: '0728' });
  check('login 不再接受保留帳號（舊密碼入口已移除）', oldEntry.success === false, JSON.stringify(oldEntry));
  check('login 拒絕訊息為一般用語', /帳號或密碼錯誤/.test(oldEntry.error || ''), JSON.stringify(oldEntry));

  // 垃圾票據
  const bad1 = env.call({ action: 'superTicketLogin', superTicket: 'garbage' });
  check('過短票據被拒', bad1.success === false, JSON.stringify(bad1));
  const bad2 = env.call({ action: 'superTicketLogin', superTicket: 'x'.repeat(64) });
  check('無效票據被拒（一般用語，不洩漏原因）', bad2.success === false && /帳號或密碼錯誤/.test(bad2.error || ''), JSON.stringify(bad2));

  // 有效票據 → 成功建立 session
  const ok = suLogin();
  check('有效票據 → 登入成功（role=super_admin）', ok.success === true && ok.user.role === 'super_admin' && typeof ok.token === 'string', JSON.stringify(ok));
  check('驗票請求打到固定中央端點（Code.gs 常量）', verifyCalls.some(c => c.url === DEFAULT_VERIFY_URL), JSON.stringify(verifyCalls.map(c => c.url)));
  const sentPayload = JSON.parse(verifyCalls[verifyCalls.length - 1].payload);
  check('驗票請求附帶自身 /exec URL（後端綁定核對用）', sentPayload.backend === HARNESS_EXEC, JSON.stringify(sentPayload));
  // force_change_password 是合法欄位名；這裡檢查的是「不含密碼『值』／憑證」
  check('登入回應不含密碼值或 SUPER_KEY',
    !JSON.stringify(ok).includes(process.env.SUPER_KEY) && !/"(password|pass|apikey|superTicket)"\s*:/.test(JSON.stringify(ok)),
    JSON.stringify(ok));

  // 票據綁定後端：為「另一旅團後端」簽發的票據不能在本後端使用
  const wrongBackend = suLogin(SU_USER, 'https://script.google.com/macros/s/OTHERTROOPEXEC00/exec');
  check('綁定其他後端的票據被拒（票據不可跨旅團）', wrongBackend.success === false, JSON.stringify(wrongBackend));

  // 帳號大小寫不敏感（驗票回傳 login_id 經 isSuperAdminId 比對）
  const upper = suLogin(SU_USER.toUpperCase());
  check('驗票 login_id 大小寫不敏感', upper.success === true, JSON.stringify(upper));

  // Tokens 表以中性代號儲存
  const tokens = env.ss.getSheetByName('Tokens');
  check('Tokens 表以中性代號儲存 session（唔出現帳號）',
    tokens.rows.slice(1).some(r => String(r[1]) === '__sys__') && !tokens.rows.slice(1).some(r => String(r[1]).toLowerCase() === SU_USER),
    JSON.stringify(tokens.rows.slice(1)));
  const viaToken = env.call({ action: 'getAllUsers', token: ok.token });
  check('session token 可正常通過驗證（還原正常）', viaToken.success === true && Array.isArray(viaToken.users));

  const hits = scanSheets();
  check('掃描全部工作表所有儲存格：搵唔到帳號識別字', hits.length === 0, hits.join(', '));
}

// ================== 4. 名單／API 回應都不外洩 ==================
console.log('\n【4】用戶名單／成員名單／API 回應都不出現保留帳號');
{
  const users = env.ss.getSheetByName('Users');
  // 模擬舊版殘留：Users 表入面有一列 super_admin
  users.appendRow([SU_USER, '系統管理員', '', 'super_admin', sha256('legacy'), 'b4', true, 'system', '', '', '', 'active', '*']);
  users.appendRow(['legacy_sysop', '舊版殘留', '', 'super_admin', sha256('x'), 'b4', true, 'system', '', '', '', 'active', '*']);

  const all = env.api.getAllUsers();
  check('getAllUsers() 冇 super_admin 列', !all.some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));
  const members = env.api.getMembers();
  check('getMembers() 冇保留帳號／殘留列',
    !members.some(m => String(m.ymis).toLowerCase() === SU_USER || String(m.ymis) === 'legacy_sysop'));

  const login = suLogin();
  const listSelf = env.call({ action: 'getAllUsers', token: login.token });
  check('doPost getAllUsers（本人查看）一樣過濾',
    listSelf.success === true && !listSelf.users.some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));
  const loadResp = env.get({ action: 'load' });
  check('load 回傳的 members 冇保留帳號', loadResp.success === true && !loadResp.members.some(m => String(m.ymis).toLowerCase() === SU_USER));

  // 登入回應本身要回傳身分（前端需要 currentUser.ymis），只回給剛通過驗票的本人；
  // 除此之外任何回應／錯誤訊息都不應出現帳號
  check('登入成功時只回傳本人身分（前端需要 ymis）',
    login.success === true && login.user.ymis === SU_USER && login.user.name === '系統管理員');
  const others = [listSelf, loadResp,
    env.call({ action: 'login', login_id: SU_USER, password: 'wrong' }),
    env.call({ action: 'login', login_id: '1111111111', password: 'changeme' }),
    env.call({ action: 'changePassword', token: login.token, old_password: 'x', new_password: 'abcd' }),
    env.call({ action: 'resetPassword', token: login.token, target_ymis: SU_USER }),
    env.call({ action: 'deactivateUser', token: login.token, target_ymis: SU_USER }),
    env.call({ action: 'updateUserRole', token: login.token, target_ymis: SU_USER, new_role: 'member' }),
    env.api.getAllUsers(), env.api.getMembers(), env.api.getUser(SU_USER) && { hidden: true }
  ].map(o => JSON.stringify(o)).join('\n');
  check('除登入回應外，任何 API 回應／錯誤訊息都不含帳號識別字', !others.toLowerCase().includes(SU_USER), others);
  check('所有彈框內容都不含帳號識別字',
    !env.ui.alerts.map(a => `${a.title}${a.msg}`).join('\n').toLowerCase().includes(SU_USER));
}

// ================== 5. 防護：不能停用／重設／改角色／自行改密碼／開戶 ==================
console.log('\n【5】保留帳號防護');
{
  const login = suLogin();
  const tk = login.token;
  const deact = env.call({ action: 'deactivateUser', token: tk, target_ymis: SU_USER });
  check('不能停用系統管理員帳號', deact.success === false && /不能停用系統管理員/.test(deact.error || ''), JSON.stringify(deact));
  const rst = env.call({ action: 'resetPassword', token: tk, target_ymis: SU_USER });
  check('不能重設系統管理員密碼', rst.success === false && /不能重設系統管理員/.test(rst.error || ''));
  const role = env.call({ action: 'updateUserRole', token: tk, target_ymis: SU_USER, new_role: 'member' });
  check('不能更改系統管理員帳號的角色', role.success === false && /不能更改系統管理員/.test(role.error || ''));
  const cp = env.call({ action: 'changePassword', token: tk, old_password: 'x', new_password: 'abcd' });
  check('保留帳號不能經 changePassword 改密碼', cp.success === false, JSON.stringify(cp));
  check('錯誤訊息為一般用語（不含憑證細節）', !/SUPER_KEY|票據|ticket/i.test(cp.error || ''));
  const addM = env.call({ action: 'addMember', token: tk, ymis: SU_USER, name: 'X' });
  check('不能以保留帳號為 YMIS 新增成員', addM.success === false);
  const addU = env.call({ action: 'addUser', token: tk, ymis: SU_USER, name: 'X' });
  check('不能以保留帳號開新帳號', addU.success === false);
  const fp = env.call({ action: 'forgotPassword', login_id: SU_USER });
  check('保留帳號不可自助找回密碼', fp.success === false, JSON.stringify(fp));
}

// ================== 6. 中央端點 URL 設定 + 不讀寫 Sheet 的連線測試 ==================
console.log('\n【6】中央驗證端點設定與 testCentralVerify()');
{
  check('預設使用 Code.gs 常量（https）', env.api.getCentralVerifyUrl() === DEFAULT_VERIFY_URL);
  env.scriptProps.set('CENTRAL_VERIFY_URL', 'https://custom.example.org/api/verify-super-ticket');
  check('Script Properties 可覆寫（部署者可信設定）', env.api.getCentralVerifyUrl() === 'https://custom.example.org/api/verify-super-ticket');
  env.scriptProps.set('CENTRAL_VERIFY_URL', 'http://insecure.example.org/x');
  check('非 https 的覆寫被忽略（回落常量）', env.api.getCentralVerifyUrl() === DEFAULT_VERIFY_URL);
  env.scriptProps.delete('CENTRAL_VERIFY_URL');

  const before = JSON.stringify([...env.ss.sheets.keys()]);
  const t = env.api.testCentralVerify();
  check('testCentralVerify() 回傳成功（mock 端點 200）', t.success === true, JSON.stringify(t));
  const after = JSON.stringify([...env.ss.sheets.keys()]);
  check('testCentralVerify() 不讀寫任何工作表（工作表清單不變）', before === after);
}

// ================== 7. 回歸：一般帳號／初始化功能正常 ==================
console.log('\n【7】回歸檢查');
{
  const admin = env.call({ action: 'login', login_id: '1111111111', password: 'changeme' });
  check('初始化建立的旅團管理員可正常登入', admin.success === true && admin.user.role === 'admin');
  const tokens = env.ss.getSheetByName('Tokens');
  check('一般帳號的 Tokens 列照舊寫入帳號（只有保留帳號用中性代號）',
    tokens.rows.slice(1).some(r => String(r[1]) === '1111111111'));
  // 再種一列舊版殘留，驗證清理函式（連同【4】留下的殘留列一併計）
  const uSheet = env.ss.getSheetByName('Users');
  uSheet.appendRow(['legacy_sysop2', '舊版殘留', '', 'super_admin', sha256('y'), 'b4', true, 'system', '', '', '', 'active', '*']);
  const residue = uSheet.rows.slice(1).filter(r => String(r[3]) === 'super_admin' || String(r[0]).toLowerCase() === SU_USER).length;
  check('測試環境確實有殘留列可清', residue >= 1, `殘留 ${residue} 列`);
  const rm = env.api.removeSuperAdminRows();
  check('removeSuperAdminRows() 清走全部殘留的 super_admin 列', rm.removed === residue, `removed=${rm.removed}, 應為 ${residue}`);
  check('清完之後 Users 表再冇 super_admin 列', !env.api.getAllUsers().some(u => u.role === 'super_admin'));
  const again = suLogin();
  check('清走殘留列後中央登入照樣有效（唔靠 Sheet）', again.success === true && again.user.role === 'super_admin');
  check('保留帳號仍然有最高權限（可讀全團名單）',
    env.call({ action: 'getAllUsers', token: again.token }).success === true);
}

// ================== 8. 保留帳號做行政操作後，Sheet 仍然冇蹤跡 ==================
console.log('\n【8】保留帳號做行政操作（寫入操作紀錄）後，Sheet 仍然冇帳號');
{
  const login = suLogin();
  const rst = env.call({ action: 'resetPassword', token: login.token, target_ymis: '1111111111' });
  check('可執行行政操作（重設成員密碼）', rst.success === true && typeof rst.temp_password === 'string', JSON.stringify(rst));
  const audit = env.ss.getSheetByName('操作紀錄');
  check('操作紀錄有寫入這筆操作', !!audit && audit.rows.length >= 2, JSON.stringify(audit && audit.rows));
  check('操作紀錄嘅「操作者」欄寫顯示名稱，唔係帳號',
    audit.rows.slice(1).some(r => String(r[1]) === '系統管理員') && !audit.rows.slice(1).some(r => String(r[1]).toLowerCase() === SU_USER),
    JSON.stringify(audit.rows.slice(1)));
  const hits = scanSheets();
  check('再掃一次全部工作表所有儲存格：仍然搵唔到帳號識別字', hits.length === 0, hits.join(', '));
}

// ================== 9. v8.7 團長唯一／領袖免 YMIS／批核密碼 1234＋強制改密 ==================
console.log('\n【9】v8.7 團長唯一鎖、領袖免 YMIS、批核預設密碼 1234、首次登入強制改密');
{
  const su = suLogin();
  const tk = su.token;
  check('中央登入可執行行政測試', su.success === true);

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
  check('可開支部領袖（自訂密碼）', bl.success === true);
  const blLogin = env.call({ action: 'login', login_id: 'bl-d@x.com', password: 'PassB!234' });
  check('自訂密碼開戶不強制改密', blLogin.success === true && blLogin.force_change_password === false, JSON.stringify(blLogin));
  const blAddAdmin = env.call({ action: 'addUser', token: blLogin.token, ymis: '1234567005', name: 'X', email: 'x-admin@x.com', role: 'admin', password: '1234' });
  check('支部領袖不可開管理員', blAddAdmin.success === false && /權限不足/.test(blAddAdmin.error || ''), JSON.stringify(blAddAdmin));

  const suAddAdmin = env.call({ action: 'addUser', token: tk, ymis: '1234567006', name: '新管理員', email: 'new-admin@x.com', role: 'admin', password: '1234' });
  check('保留帳號可開管理員', suAddAdmin.success === true, JSON.stringify(suAddAdmin));

  const suFmt = env.call({ action: 'addUser', token: tk, ymis: SU_USER, name: 'X' });
  check('以保留帳號開戶被拒（格式／保留帳號）', suFmt.success === false);

  const defMem = env.call({ action: 'addUser', token: tk, ymis: '1234567007', name: '成員戊', email: 'mem-e@x.com', role: 'member', password: '1234' });
  const defLogin = env.call({ action: 'login', login_id: '1234567007', password: '1234' });
  check('預設密碼 1234 首次登入須改密', defMem.success === true && defLogin.success === true && defLogin.force_change_password === true);

  const promote = env.call({ action: 'updateUserRole', token: tk, target_ymis: '1234567004', new_role: 'group_leader', can_tick: true });
  check('已有團長時不能再升另一人為團長', promote.success === false && /團長只能有一位/.test(promote.error || ''), JSON.stringify(promote));
}

console.log('\n【10】v8.8 唯一性／三區名單／自設密碼／找回密碼／恢復／刪除（真實 Code.gs）');
{
  const su = suLogin();
  const tk = su.token;
  check('中央登入可執行 v8.8 測試', su.success === true);

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
