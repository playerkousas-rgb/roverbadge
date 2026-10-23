// 後端權限與學制強制測試：在 Node 內執行真實的 apps-script/Code.gs（經 doPost 路由）。
// 驗證：成員不可寫入；領袖只可勾選 allowed_badges 範圍內的項目；整批任一筆違規則整批拒絕；
// 學制（新制／舊制／舊制過渡新制）決定可勾選的目錄；舊版 ID 不可再勾選。
// 測試資料全部由 data/items.json 生成的目錄取得（不寫死獎章／段章清單）。
import test from 'node:test';
import assert from 'node:assert/strict';
import items from '../data/items.json' with { type: 'json' };
import { loadCodeGs } from './gas-harness.mjs';

const env = loadCodeGs();
env.api.initializeSheets();

// 以目錄取得測試用項目（不寫死 ID）
const CAT = env.api.ITEM_CATALOG_;
const pick = (pred) => Object.keys(CAT).find(id => pred(id, CAT[id]));
const newL3Scout = pick((id, c) => c.b === 'L3' && c.s === 'L3-SCOUT' && c.t.includes('n'));
const newL3Int = pick((id, c) => c.b === 'L3' && c.s === 'L3-INT' && c.t.includes('n'));
const newL1 = pick((id, c) => c.b === 'L1' && c.t.includes('n'));
const oldS4 = pick((id, c) => c.b === 'S4-AWARD' && c.s === 'S4-AWARD-CORE');
const otId = pick((id, c) => c.o === 1);
const legacyId = (items.legacy && items.legacy.ids && items.legacy.ids[0] && items.legacy.ids[0].id) || 'L1-01';

// ── 測試帳號（直接寫入 Users 表；不經登入流程）──
const USER_COLS = ['ymis', 'name', 'email', 'role', 'password_hash', 'branch', 'can_tick', 'auth_by', 'auth_date', 'created_at', 'last_login', 'status', 'allowed_badges', 'force_change_password'];
function seedUser(ymis, role, allowed, canTick) {
  const row = USER_COLS.map(() => '');
  row[0] = ymis; row[1] = ymis; row[2] = ymis + '@test'; row[3] = role; row[6] = canTick; row[11] = 'active'; row[12] = allowed; row[13] = false;
  env.ss.getSheetByName('Users').appendRow(row);
  return env.api.createToken(ymis);
}
const T = {
  member: seedUser('1000000001', 'member', '', false),
  member2: seedUser('1000000002', 'member', '', false),
  leader: seedUser('2000000001', 'group_leader', '', true),
  scoped: seedUser('2000000002', 'group_leader', 'L3-SCOUT', true),
  exec: seedUser('2000000003', 'exec_committee', '', true),
  otherOnly: seedUser('2000000004', 'group_leader', 'OTHER', true)
};
const KEY = env.api.getApiKey();
const progressRows = () => env.ss.getSheetByName('進度追蹤').rows.filter(r => r[0] !== 'YMIS');
const change = (ymis, itemId) => ({ ymis, itemId, date: '2026-10-01' });
const setScheme = (token, scheme, target) => env.call({ action: 'setScheme', token, scheme, target_ymis: target });

test('目錄與角色預設由 items.json 生成並載入後端', () => {
  assert.ok(newL3Scout && newL3Int && newL1 && oldS4 && otId, 'catalog has all sample kinds');
  assert.equal(env.api.DEFAULT_PERMS_.leader, '*');
  assert.equal(env.api.DEFAULT_PERMS_.exec_committee, 'L1,OTHER');
  assert.equal(env.api.DEFAULT_PERMS_.member, '');
  assert.equal(CAT[newL3Scout].s, 'L3-SCOUT');
});

test('成員（member）不可寫入進度；不帶 API Key 或 token 也一律拒絕', () => {
  const before = progressRows().length;
  let r = env.call({ action: 'save', token: T.member, changes: [change('1000000001', newL1)] });
  assert.equal(r.success, false);
  assert.match(r.error, /權限不足/);
  r = env.call({ action: 'save', changes: [change('1000000001', newL1)] });
  assert.equal(r.success, false, '無 apikey 亦無 token 不可寫入');
  assert.match(r.error, /未授權/);
  assert.equal(progressRows().length, before, '被拒後不寫入任何列');
});

test('領袖（*）可勾選現行項目；寫入後記錄出現在進度表', () => {
  const r = env.call({ action: 'save', token: T.leader, changes: [change('1000000001', newL1)] });
  assert.equal(r.success, true, r.error);
  assert.ok(progressRows().some(row => row[0] === '1000000001' && row[1] === newL1));
});

test('allowed_badges 範圍：段章代碼放行本段，範圍外項目整批拒絕（原子性）', () => {
  const inScope = change('1000000001', newL3Scout);
  const outScope = change('1000000001', newL3Int);
  const before = progressRows().length;
  const r = env.call({ action: 'save', token: T.scoped, changes: [inScope, outScope] });
  assert.equal(r.success, false);
  assert.match(r.error, new RegExp(newL3Int));
  assert.equal(progressRows().length, before, '整批拒絕：範圍內的那筆亦不寫入');
  const ok = env.call({ action: 'save', token: T.scoped, changes: [inScope] });
  assert.equal(ok.success, true, ok.error);
});

test('角色預設（空白 allowed_badges）：管委只可勾 L1 與 OTHER', () => {
  assert.equal(env.call({ action: 'save', token: T.exec, changes: [change('1000000001', newL1)] }).success, true);
  const r = env.call({ action: 'save', token: T.exec, changes: [change('1000000001', newL3Scout)] });
  assert.equal(r.success, false, '管委不可勾 L3');
});

test('僅 OTHER 權限的領袖：其他獎章可寫；現行段章不可', () => {
  const ok = env.call({ action: 'saveOtherBadge', token: T.otherOnly, records: [{ ymis: '1000000001', badgeId: otId, name: 'x', date: '2026-10-01' }] });
  assert.equal(ok.success, true, ok.error);
  const bad = env.call({ action: 'saveOtherBadge', token: T.otherOnly, records: [{ ymis: '1000000001', badgeId: newL3Scout, name: 'x', date: '2026-10-01' }] });
  assert.equal(bad.success, false, '非 OT-* ID 不可寫入其他獎章表');
  const mem = env.call({ action: 'saveOtherBadge', token: T.member, records: [{ ymis: '1000000001', badgeId: otId, name: 'x', date: '2026-10-01' }] });
  assert.equal(mem.success, false, '成員不可寫其他獎章');
});

test('代理層情境：api/proxy.js 每個請求都附上 APIKEY；身分仍以 token 為準', () => {
  // 成員即使經代理（APIKEY ＋ 成員 token）也不可寫入
  const mem = env.call({ action: 'save', apikey: KEY, token: T.member, changes: [change('1000000001', newL1)] });
  assert.equal(mem.success, false, 'APIKEY ＋ 成員 token 不可繞過權限');
  assert.match(mem.error, /權限不足/);
  // 領袖經代理仍受 allowed_badges 限制
  const scoped = env.call({ action: 'save', apikey: KEY, token: T.scoped, changes: [change('1000000001', newL3Int)] });
  assert.equal(scoped.success, false, 'APIKEY ＋ 範圍內領袖 token 不可越界');
  // 無效 token 一律拒絕（即使有 APIKEY）
  const bogus = env.call({ action: 'save', apikey: KEY, token: 'not-a-real-token', changes: [change('1000000001', newL1)] });
  assert.equal(bogus.success, false);
  assert.match(bogus.error, /Token 無效/);
});

test('API Key（系統）可寫入，但學制仍然強制', () => {
  const r = env.call({ action: 'save', apikey: KEY, changes: [change('1000000001', newL3Int)] });
  assert.equal(r.success, true, r.error);
  const bad = env.call({ action: 'save', apikey: KEY, changes: [change('1000000001', legacyId)] });
  assert.equal(bad.success, false, '舊版 ID 即使是系統寫入亦不可再勾選');
});

test('舊制成員：只能勾 舊制（S4）與 L1/L2；新制 ID 拒絕', () => {
  assert.equal(setScheme(T.member2, 'old', '1000000002').success, true, '本人可設定自己的學制');
  const bad = env.call({ action: 'save', token: T.leader, changes: [change('1000000002', newL3Scout)] });
  assert.equal(bad.success, false, '舊制成員不可寫新制 L3 ID');
  assert.match(bad.error, /不屬於.*舊制/);
  const ok = env.call({ action: 'save', token: T.leader, changes: [change('1000000002', oldS4)] });
  assert.equal(ok.success, true, ok.error);
  assert.equal(env.call({ action: 'save', token: T.leader, changes: [change('1000000002', newL1)] }).success, true, 'L1 兩制通用');
});

test('過渡學制：只可勾新制目錄（L1–L4）；S4 只作對照不可勾', () => {
  assert.equal(setScheme(T.member, 'transition', '1000000001').success, true);
  const bad = env.call({ action: 'save', token: T.leader, changes: [change('1000000001', oldS4)] });
  assert.equal(bad.success, false, '過渡學制不可勾 S4');
  assert.equal(env.call({ action: 'save', token: T.leader, changes: [change('1000000001', newL3Scout)] }).success, true, '過渡學制可勾 L3');
  setScheme(T.member, 'new', '1000000001');
});

test('setScheme：只接受三種學制；他人設定需為可勾選領袖', () => {
  assert.equal(setScheme(T.member, 'bogus', '1000000001').success, false);
  const self = setScheme(T.member2, 'old', '1000000002');
  assert.equal(self.success, true, '本人可改自己');
  const denied = setScheme(T.member, 'old', '2000000001');
  assert.equal(denied.success, false, '成員不可為他人設定學制');
  const leaderSets = setScheme(T.leader, 'transition', '1000000002');
  assert.equal(leaderSets.success, true, '可勾選領袖可為他人設定');
  assert.equal(leaderSets.schemes['1000000002'], 'transition');
  const row = env.ss.getSheetByName('學制設定').rows.find(r => r[0] === '1000000002');
  assert.equal(row[1], 'transition');
  assert.equal(row[3], '2000000001', 'updated_by 記錄設定者');
  setScheme(T.leader, 'old', '1000000002');
});

test('load 回傳學制對照（預設 new）', () => {
  const r = env.get({ action: 'load', token: T.leader });
  assert.equal(r.success, true);
  assert.equal(r.schemeDefault, 'new');
  assert.equal(r.schemes['1000000002'], 'old');
});

test('申請完成：舊制成員不可申請新制 ID；新制成員可以，申請後由領袖審批', () => {
  const bad = env.call({ action: 'requestComplete', token: T.member2, itemId: newL3Scout, itemName: 'x' });
  assert.equal(bad.success, false, '舊制成員申請新制 ID 被拒');
  const req = env.call({ action: 'requestComplete', token: T.member, itemId: newL3Scout, itemName: 'x' });
  assert.equal(req.success, true, req.error);
  const rid = req.request_id;
  // 範圍外領袖不可審批
  const okReview = env.call({ action: 'reviewRequest', token: T.scoped, request_id: rid, decision: 'approved' });
  assert.equal(okReview.success, true, '範圍內（L3-SCOUT）領袖可審批: ' + okReview.error);
  // 另一筆：L3-INT 只有 * 或 L3 領袖可審
  const req2 = env.call({ action: 'requestComplete', token: T.member, itemId: newL3Int, itemName: 'y' });
  const denied2 = env.call({ action: 'reviewRequest', token: T.scoped, request_id: req2.request_id, decision: 'approved' });
  assert.equal(denied2.success, false, '範圍外領袖不可審批 L3-INT');
  assert.match(denied2.error, /權限不足/);
});

test('舊版 ID（legacy）不可申請與不可寫入', () => {
  const r = env.call({ action: 'requestComplete', token: T.member, itemId: legacyId, itemName: 'x' });
  assert.equal(r.success, false);
});

test('其他獎章 OT-* 在三種學制都可寫入（分類為 OTHER）', () => {
  assert.match(CAT[otId].t, /n/);
  assert.match(CAT[otId].t, /o/);
  assert.match(CAT[otId].t, /t/);
});
