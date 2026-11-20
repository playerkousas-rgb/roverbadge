// 可勾選（can_tick）撤銷測試：在 Node 內執行真實的 apps-script/Code.gs（經 doPost 路由）。
// 規則（團長決定）：撤銷「可勾選」後，即使角色為領袖，亦不可勾選、審批或直接修改紀錄；
// 仍可查看。恢復後權限即時生效。測試資料由 data/items.json 生成的目錄取得。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCodeGs } from './gas-harness.mjs';

const env = loadCodeGs();
env.api.initializeSheets();

const CAT = env.api.ITEM_CATALOG_;
const newL1 = Object.keys(CAT).find(id => CAT[id].b === 'L1' && CAT[id].t.includes('n'));
const otId = Object.keys(CAT).find(id => CAT[id].o === 1);
assert.ok(newL1 && otId, '目錄內需有 L1 與 OT 項目');

const USER_COLS = ['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status', 'allowed_badges', 'force_change_password'];
function seedUser(ymis, role, canTick, allowed = '') {
  const row = USER_COLS.map(() => '');
  row[0] = ymis; row[1] = ymis; row[2] = ymis + '@test'; row[3] = role; row[6] = canTick; row[11] = 'active'; row[12] = allowed; row[13] = false;
  env.ss.getSheetByName('Users').appendRow(row);
  return env.api.createToken(ymis);
}
const MEMBER_Y = '3000000001';
const T = {
  member: seedUser(MEMBER_Y, 'member', false),
  // 撤銷勾選的領袖（角色仍為領袖）
  revoked: seedUser('4000000001', 'group_leader', false, '*'),
  // 可勾選的領袖（對照組）
  active: seedUser('4000000002', 'group_leader', true, '*'),
  revokedExec: seedUser('4000000003', 'exec_committee', false, 'L1,OTHER'),
  // 可改任何角色的管理員（用嚟驗證 updatePermissions 只改權限欄位）
  admin: seedUser('5000000000', 'admin', true, '*')
};
const setTick = (ymis, v) => {
  const row = env.ss.getSheetByName('Users').rows.find(r => r[0] === ymis);
  row[6] = v;
};
const progressRows = () => env.ss.getSheetByName('進度追蹤').rows.filter(r => r[0] !== 'YMIS');
const change = (ymis, itemId) => ({ ymis, itemId, date: '2026-10-01' });
const denied = r => r && r.success === false;

// 先建立一筆成員申請（由可勾選領袖審批前使用）
const memberReq = env.call({ action: 'requestComplete', token: T.member, itemId: newL1, itemName: 'x' });
assert.equal(memberReq.success, true, memberReq.error);
const REQ = memberReq.request_id;

// 先建立一筆日誌（以便測試 delete/review）
const logRec = env.call({ action: 'saveLogRecord', token: T.active, records: [{ ymis: MEMBER_Y, date: '2026-10-01', type: 'activity', title: 'seed', hours: 1 }] });
assert.equal(logRec.success, true, logRec.error);

test('撤銷勾選的領袖：進度勾選（save）被拒，且不寫入任何列', () => {
  const before = progressRows().length;
  const r = env.call({ action: 'save', token: T.revoked, changes: [change(MEMBER_Y, newL1)] });
  assert.ok(denied(r), '撤銷後不可勾選');
  assert.match(r.error, /權限不足/);
  assert.equal(progressRows().length, before);
});

test('撤銷勾選的領袖：APIKEY 不可繞過撤銷（有效 token 即以用戶身分判斷）', () => {
  const before = progressRows().length;
  const r = env.call({ action: 'save', apikey: env.api.getApiKey(), token: T.revoked, changes: [change(MEMBER_Y, newL1)] });
  assert.ok(denied(r));
  assert.equal(progressRows().length, before);
});

test('撤銷勾選的領袖：其他獎章（saveOtherBadge）被拒', () => {
  const r = env.call({ action: 'saveOtherBadge', token: T.revoked, records: [{ ymis: MEMBER_Y, badgeId: otId, name: 'x', date: '2026-10-01' }] });
  assert.ok(denied(r), '撤銷後不可寫其他獎章');
});

test('撤銷勾選的領袖：審批成員申請（reviewRequest）被拒，申請仍為待處理', () => {
  const r = env.call({ action: 'reviewRequest', token: T.revoked, request_id: REQ, decision: 'approved' });
  assert.ok(denied(r));
  assert.match(r.error, /權限不足/);
});

test('撤銷勾選的領袖：日誌新增（saveLogRecord）、刪除（deleteLogRecord）、審批（reviewLogRequest）均被拒', () => {
  const add = env.call({ action: 'saveLogRecord', token: T.revoked, records: [{ ymis: MEMBER_Y, date: '2026-10-02', type: 'activity', title: 'x', hours: 1 }] });
  assert.ok(denied(add), '撤銷後不可直接新增日誌');
  const del = env.call({ action: 'deleteLogRecord', token: T.revoked, record_id: 'anything' });
  assert.ok(denied(del), '撤銷後不可直接刪除日誌');
  const rv = env.call({ action: 'reviewLogRequest', token: T.revoked, request_id: 'anything', decision: 'approved' });
  assert.ok(denied(rv), '撤銷後不可審批日誌申請');
});

test('撤銷勾選的領袖：待審日誌清單 canApprove 為 false', () => {
  const r = env.call({ action: 'getPendingLogRequests', token: T.revoked });
  assert.equal(r.success, true);
  assert.equal(r.canApprove, false);
});

test('撤銷勾選的領袖：仍可查看（load、getLogRecords）', () => {
  const r = env.get({ action: 'load', token: T.revoked });
  assert.equal(r.success, true, r.error);
  const l = env.call({ action: 'getLogRecords', token: T.revoked });
  assert.equal(l.success, true, l.error);
});

test('撤銷勾選的領袖：不可為他人設定學制（setScheme），本人仍可', () => {
  assert.ok(denied(env.call({ action: 'setScheme', token: T.revoked, scheme: 'old', target_ymis: MEMBER_Y })), '他人學制須可勾選領袖');
  assert.equal(env.call({ action: 'setScheme', token: T.revoked, scheme: 'new', target_ymis: '4000000001' }).success, true, '本人可設定自己');
});

test('撤銷勾選的領袖（管委）：即使角色預設為 L1,OTHER 亦不可勾選 L1', () => {
  const r = env.call({ action: 'save', token: T.revokedExec, changes: [change(MEMBER_Y, newL1)] });
  assert.ok(denied(r));
});

test('對照：可勾選的領袖可正常勾選、審批、寫日誌（確認測試本身有效）', () => {
  const ok = env.call({ action: 'save', token: T.active, changes: [change(MEMBER_Y, newL1)] });
  assert.equal(ok.success, true, ok.error);
  const rv = env.call({ action: 'reviewRequest', token: T.active, request_id: REQ, decision: 'approved' });
  assert.equal(rv.success, true, rv.error);
});

test('恢復勾選權限後，撤銷的領袖立即可以勾選（不需重新登入）', () => {
  setTick('4000000001', true);
  const r = env.call({ action: 'save', token: T.revoked, changes: [change(MEMBER_Y, newL1)] });
  assert.equal(r.success, true, r.error);
  setTick('4000000001', false);
  assert.ok(denied(env.call({ action: 'save', token: T.revoked, changes: [change(MEMBER_Y, newL1)] })), '再次撤銷後即時生效');
});

test('can_tick 讀取：getUser 回傳布林值（空白儲存格視為 false）', () => {
  const u = env.api.getUser('4000000002');
  assert.equal(u.can_tick, true);
  const v = env.api.getUser('4000000001');
  assert.equal(v.can_tick, false);
  // 空白儲存格：不可因為空白而獲得權限
  const blank = seedUser('4000000009', 'group_leader', '', '*');
  assert.equal(env.api.getUser('4000000009').can_tick, false);
  assert.ok(denied(env.call({ action: 'save', token: blank, changes: [change(MEMBER_Y, newL1)] })));
});

// ---- 角色／開關更新契約：缺欄位＝唔寫，唔好再清空 role／can_tick（CubBadge 同款 bug）----
const userRow = ymis => env.ss.getSheetByName('Users').rows.find(r => r[0] === ymis);

test('updatePermissions 只帶 allowed_badges：不改 role、不清空 can_tick，回包回報原值', () => {
  const ymis = '4000000002';
  const row = userRow(ymis);
  const before = { role: row[3], can_tick: row[6], allowed: row[12] };
  assert.equal(before.role, 'group_leader');
  assert.equal(before.can_tick, true);

  // 路由 1596：new_role 經 body.new_role||null 傳入 → null＝「冇提供」
  const r = env.call({ action: 'updatePermissions', token: T.admin, target_ymis: ymis, allowed_badges: 'L1' });
  assert.equal(r.success, true, r.error);
  assert.deepEqual({ role: r.role, can_tick: r.can_tick }, { role: before.role, can_tick: true });
  assert.equal(row[3], before.role, 'role 不可被寫成空白（＝降級 member）');
  assert.equal(row[6], before.can_tick, 'can_tick 不可被清空');
  assert.equal(row[12], 'L1', 'allowed_badges 仍按提供值寫入');

  // 路由 1592／597：updateUserRole 完全冇帶新角色／開關時亦一樣
  row[12] = 'L1,OTHER';
  const r2 = env.call({ action: 'updateUserRole', token: T.admin, target_ymis: ymis });
  assert.equal(r2.success, true, r2.error);
  assert.deepEqual({ role: r2.role, can_tick: r2.can_tick }, { role: before.role, can_tick: true });
  assert.equal(row[3], before.role);
  assert.equal(row[6], before.can_tick);
  assert.equal(row[12], 'L1,OTHER', '冇提供 allowed_badges 亦不可覆蓋');
});

test('無效角色被拒，且 role／can_tick／allowed_badges 原值完全不動', () => {
  const ymis = '4000000002';
  const row = userRow(ymis);
  const before = row.slice();
  for (const badRole of ['hacker', 'super_admin']) {
    const r = env.call({ action: 'updateUserRole', token: T.admin, target_ymis: ymis, new_role: badRole, can_tick: false, allowed_badges: 'NONE' });
    assert.equal(r.success, false, `${badRole} 必須被拒`);
    assert.match(r.error, /無效角色/);
    assert.deepEqual(row, before, '被拒後任何欄位都不可寫入');
  }
});

test('can_tick 只在明確提供時寫：false 可收回；之後只改權限不會悄悄還原', () => {
  const ymis = '4000000002';
  const row = userRow(ymis);
  const off = env.call({ action: 'updatePermissions', token: T.admin, target_ymis: ymis, can_tick: false });
  assert.equal(off.success, true, off.error);
  assert.equal(off.can_tick, false);
  assert.equal(off.role, 'group_leader', '只改開關時角色保持不變');
  assert.equal(row[6], false);
  const badgesOnly = env.call({ action: 'updatePermissions', token: T.admin, target_ymis: ymis, allowed_badges: '*' });
  assert.equal(badgesOnly.success, true, badgesOnly.error);
  assert.equal(badgesOnly.can_tick, false, '冇提供 can_tick 時應回報原值');
  assert.equal(row[6], false, '只改 allowed_badges 不可把已收回的開關還原');
  const on = env.call({ action: 'updatePermissions', token: T.admin, target_ymis: ymis, can_tick: true });
  assert.equal(on.success, true, on.error);
  assert.equal(on.can_tick, true);
  assert.equal(row[3], 'group_leader');
  assert.equal(row[6], true);
});

test('明確改角色時才補 allowed_badges 預設，且只補空白、不覆蓋已有值', () => {
  const ymis = '6000000001';
  seedUser(ymis, 'member', false, '');
  const row = userRow(ymis);
  const changed = env.call({ action: 'updateUserRole', token: T.admin, target_ymis: ymis, new_role: 'exec_committee' });
  assert.equal(changed.success, true, changed.error);
  assert.equal(row[3], 'exec_committee');
  assert.equal(row[6], false, '冇提供 can_tick 時保持原值');
  assert.equal(row[12], 'L1,OTHER', '空白者補執委預設');
  row[12] = 'L1';
  const again = env.call({ action: 'updateUserRole', token: T.admin, target_ymis: ymis, new_role: 'branch_leader' });
  assert.equal(again.success, true, again.error);
  assert.equal(row[12], 'L1', '已有自訂範圍不可被預設覆蓋');
  assert.equal(again.role, 'branch_leader');
  assert.equal(again.can_tick, false);
});

test('member 行不渲染「授權」勾選按鈕，且前端角色規則與後端 canUserTick 一致', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const section = html.slice(html.indexOf('async function loadUsers(){'), html.indexOf('async function toggleCanTick('));
  assert.ok(section.length > 0, '找不到 loadUsers 區段');
  const toggleLine = section.split('\n').find(line => line.includes('toggleCanTick('));
  assert.ok(toggleLine, '找不到授權勾選按鈕');
  assert.match(toggleLine, /if\(canUserTickRole\(u\.role\)\)\s*actionBtns\.push\(/, 'member 不可出現授權勾選按鈕');
  const rolesOf = s => (s.match(/'[^']+'/g) || []).map(x => x.slice(1, -1));
  const backend = rolesOf(gs.match(/const CAN_TICK_ROLES = \[([^\]]+)\]/)[1]);
  const front = rolesOf(html.match(/function canUserTickRole\(role\)\{ return \[([^\]]+)\]\.includes\(role\); \}/)[1]);
  assert.deepEqual(front, backend, '前後端可勾選角色必須一致');
});
