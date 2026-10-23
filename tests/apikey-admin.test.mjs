// APIKEY 不可作為管理員身分的回歸測試（Decision 5 之後）。
// 規則：
//   · 完全沒有 token、只有有效 APIKEY ＝ 系統操作（批量開戶工具「方法 A」即是此路徑，保留）
//   · 帶 token（不論有效與否）＝ 身分以 token 為準；無效 token 一律拒絕，不得以 APIKEY 補救
// 過往缺陷：addMember 對無效 token 放行，再以 APIKEY 後備提升為 admin，但 const 重新賦值導致 TypeError。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './gas-harness.mjs';

const env = loadCodeGs();
env.api.initializeSheets();
const KEY = env.api.getApiKey();

const USER_COLS = ['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status', 'allowed_badges', 'force_change_password'];
function seedUser(ymis, role) {
  const row = USER_COLS.map(() => '');
  row[0] = ymis; row[1] = ymis; row[2] = ymis + '@test'; row[3] = role; row[6] = true; row[11] = 'active'; row[12] = ''; row[13] = false;
  env.ss.getSheetByName('Users').appendRow(row);
  return env.api.createToken(ymis);
}
const MEMBER = seedUser('5000000001', 'member');
const LEADER = seedUser('5000000002', 'group_leader');
const userRow = ymis => env.ss.getSheetByName('Users').rows.find(r => r[0] === ymis);
const rosterRow = ymis => (env.ss.getSheetByName('成員名單') || { rows: [] }).rows.find(r => r[0] === ymis);

test('只有有效 APIKEY、沒有 token（批量開戶工具方法 A）仍可開立帳號', () => {
  const r = env.call({ action: 'addUser', apikey: KEY, ymis: '6000000001', name: '批量甲', email: 'batch-a@x.org', role: 'member', password: '1234' });
  assert.equal(r.success, true, r.error);
  assert.ok(userRow('6000000001'), '應寫入 Users');
});

test('無效 token ＋ 有效 APIKEY：addUser 拒絕（不得以 APIKEY 提升為管理員）', () => {
  const r = env.call({ action: 'addUser', apikey: KEY, token: 'garbage-token-xyz', ymis: '6000000002', name: '偽造', email: 'fake-u@x.org', role: 'member', password: '1234' });
  assert.equal(r.success, false);
  assert.match(r.error, /Token 無效/);
  assert.equal(userRow('6000000002'), undefined);
});

test('無效 token ＋ 有效 APIKEY：addMember 拒絕（原先會因 const 錯誤回傳 TypeError）', () => {
  const r = env.call({ action: 'addMember', apikey: KEY, token: 'garbage-token-xyz', ymis: '6000000003', name: '偽造名單' });
  assert.equal(r.success, false);
  assert.doesNotMatch(String(r.error), /TypeError/, '不可再出現程式錯誤');
  assert.match(r.error, /Token 無效/);
  assert.equal(rosterRow('6000000003'), undefined);
});

test('成員 token ＋ APIKEY：addUser／addMember 皆拒絕（身分以 token 為準）', () => {
  const u = env.call({ action: 'addUser', apikey: KEY, token: MEMBER, ymis: '6000000004', name: 'x', email: 'x4@x.org', role: 'member', password: '1234' });
  assert.equal(u.success, false);
  assert.match(u.error, /只有領袖/);
  const m = env.call({ action: 'addMember', apikey: KEY, token: MEMBER, ymis: '6000000005', name: 'x' });
  assert.equal(m.success, false);
  assert.match(m.error, /只有領袖/);
});

test('領袖 token 仍可開立帳號（對照組）', () => {
  const r = env.call({ action: 'addUser', token: LEADER, ymis: '6000000006', name: '領袖新增', email: 'x6@x.org', role: 'member', password: '1234' });
  assert.equal(r.success, true, r.error);
});

test('沒有 token、沒有 APIKEY：addUser／addMember 皆拒絕', () => {
  assert.equal(env.call({ action: 'addUser', ymis: '6000000007', name: 'x', email: 'x7@x.org', role: 'member', password: '1234' }).success, false);
  assert.equal(env.call({ action: 'addMember', ymis: '6000000008', name: 'x' }).success, false);
});
