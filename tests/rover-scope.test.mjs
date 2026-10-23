// 權限範圍與舊版紀錄測試（assets/rover-scope.js），資料全部來自 data/items.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import items from '../data/items.json' with { type: 'json' };
import { loadRoverModules } from './browser-module-harness.mjs';

const { RoverScope: S } = loadRoverModules();
const idx = S.buildIndex(items);
const L3 = items.badges.find(b => b.id === 'L3');
const L1 = items.badges.find(b => b.id === 'L1');

test('permission tokens: * allows everything current', () => {
  for (const id of idx.itemIds ? Object.keys(idx.itemIds) : []) {
    assert.equal(S.canTickItem('*', id, idx), true, id);
  }
});

test('permission tokens: badge / segment / item / OTHER granularity', () => {
  // 整個獎章
  assert.equal(S.canTickItem('L1', 'L1-ACT-01', idx), true);
  assert.equal(S.canTickItem('L1', 'L3-SCOUT-01', idx), false);
  // 段章代碼（不可被前綴誤判：L3-INT 不應放行 L3-INTL-*）
  assert.equal(S.canTickItem('L3-INT', 'L3-INT-01', idx), true);
  assert.equal(S.canTickItem('L3-INT', 'L3-INTL-A', idx), false);
  // 段章代碼放行段內所有項目
  assert.equal(S.canTickItem('L3-CHALLENGE', 'L3-CHAL-A', idx), true);
  assert.equal(S.canTickItem('L3-CHALLENGE', 'L3-CHAL-B', idx), true);
  assert.equal(S.canTickItem('L3-CHALLENGE', 'L3-SCOUT-01', idx), false);
  // 單一項目
  assert.equal(S.canTickItem('L3-SCOUT-02', 'L3-SCOUT-02', idx), true);
  assert.equal(S.canTickItem('L3-SCOUT-02', 'L3-SCOUT-03', idx), false);
  // OTHER 只放行其他獎章（OT-*）
  const ot = items.otherBadges[0].id;
  assert.equal(S.canTickItem('OTHER', ot, idx), true);
  assert.equal(S.canTickItem('OTHER', 'L3-SCOUT-01', idx), false);
});

test('permission tokens: unknown / legacy tokens grant nothing and are inert', () => {
  for (const tok of ['', 'NONE', '活動段章', 'L1,活動段章', 'L3-ACT-SCOUT', 'L1-UND-05', 'L1-01']) {
    for (const id of L3.segments.flatMap(s => S.segmentItemIds(s))) {
      assert.equal(S.canTickItem(tok, id, idx), false, `${tok} -> ${id}`);
    }
  }
  // 解析時保留原字串（不因未知代碼而刪除）
  assert.deepEqual(S.parseTokens('L1, 活動段章 ,OTHER'), ['L1', '活動段章', 'OTHER']);
});

test('exec committee default is L1 + OTHER (from items.json)', () => {
  assert.equal(items.permissionDefaults.exec_committee, 'L1,OTHER');
  assert.equal(S.defaultPermissionString('exec_committee', items), 'L1,OTHER');
  assert.equal(S.defaultPermissionString('leader', items), '*');
  assert.equal(S.defaultPermissionString('member', items), '');
  const tokens = S.execDefaultTokens(items);
  assert.ok(S.canTickItem(tokens.join(','), L1.segments[0].items[0].id, idx));
  assert.equal(S.canTickItem(tokens.join(','), L3.segments[0].items[0].id, idx), false);
});

test('permission options are generated from items.json (no hard-coded list)', () => {
  const opts = S.permissionOptions(items);
  const values = opts.map(o => o.value);
  assert.equal(values[0], '*');
  assert.ok(values.includes('OTHER'));
  for (const b of items.badges) {
    assert.ok(values.includes(b.id), b.id);
    for (const s of b.segments) assert.ok(values.includes(s.code), s.code);
  }
  for (const ob of items.otherBadges) assert.ok(values.includes(ob.id), ob.id);
  // 每個段章選項只指向其所屬獎章
  for (const o of opts.filter(o => o.group === 'segment')) {
    assert.equal(idx.segmentCodes[o.value], o.parent);
  }
});

test('index: segment codes and item IDs are unique across the whole catalogue', () => {
  const seenSeg = new Set(), seenItem = new Set();
  for (const b of items.badges) for (const s of b.segments) {
    assert.ok(!seenSeg.has(s.code), 'dup segment ' + s.code); seenSeg.add(s.code);
    for (const id of S.segmentItemIds(s)) {
      assert.ok(!seenItem.has(id), 'dup item ' + id); seenItem.add(id);
    }
  }
  for (const ob of items.otherBadges) {
    assert.ok(!seenItem.has(ob.id), 'dup other ' + ob.id); seenItem.add(ob.id);
  }
});

test('legacy records: kept, labelled, excluded from completion', () => {
  assert.equal(items.legacy.label, '舊版紀錄／不計完成度');
  const flat = { 'L1-ACT-01': '2026-03-01', 'L1-01': '2019-05-05', 'X-999': { date: '2020-01-01', cert: 'C1' } };
  const entries = S.legacyEntries(flat, idx);
  assert.deepEqual(entries.map(e => e.id).sort(), ['L1-01', 'X-999']);
  const l101 = entries.find(e => e.id === 'L1-01');
  assert.equal(l101.known, true);
  assert.equal(l101.date, '2019-05-05');
  assert.equal(entries.find(e => e.id === 'X-999').known, false);
  assert.equal(entries.find(e => e.id === 'X-999').date, '2020-01-01');
  // 現行 ID 不會出現在舊版清單
  assert.ok(!entries.some(e => e.id === 'L1-ACT-01'));
  // 舊版紀錄不計完成度
  assert.equal(S.segmentDone(L1.segments.find(s => s.code === 'L1-ACT'), { 'L1-01': '2019-05-05' }), false);
});

test('segment completion honours completion:"one" (國際視野 甲/乙 任選一, 挑戰 甲/乙 任選一)', () => {
  const intl = L3.segments.find(s => s.code === 'L3-INTL');
  const chal = L3.segments.find(s => s.code === 'L3-CHALLENGE');
  assert.equal(intl.completion, 'one');
  assert.equal(chal.completion, 'one');
  assert.equal(S.segmentDone(intl, { 'L3-INTL-B': '2026-01-01' }), true);
  assert.equal(S.segmentDone(chal, {}), false);
  const health = L3.segments.find(s => s.code === 'L3-HEALTH');
  assert.equal(S.segmentDone(health, { 'L3-HEALTH-01': '2026-01-01' }), false, '身心健康 needs both parts');
});

test('home summaries are generated from items.json', () => {
  const sum = Object.fromEntries(S.levelSummaries(items).map(x => [x.id, x.desc]));
  assert.match(sum.L1, /13項/);
  assert.match(sum.L3, /7段考驗/);
  assert.match(sum.L3, /7項中完成4項/);
  assert.equal(Object.keys(sum).join(','), items.badges.map(b => b.id).join(','));
});
