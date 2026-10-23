// 可勾選（can_tick）撤銷測試：在 Node 內執行真實的 apps-script/Code.gs（經 doPost 路由）。
// 規則（團長決定）：撤銷「可勾選」後，即使角色為領袖，亦不可勾選、審批或直接修改紀錄；
// 仍可查看。恢復後權限即時生效。測試資料由 data/items.json 生成的目錄取得。
import test from 'node:test';
import assert from 'node:assert/strict';
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
  revokedExec: seedUser('4000000003', 'exec_committee', false, 'L1,OTHER')
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
