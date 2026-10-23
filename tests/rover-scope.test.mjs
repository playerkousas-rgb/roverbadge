// 權限範圍與舊版紀錄測試（assets/rover-scope.js），資料全部來自 data/items.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import items from '../data/items.json' with { type: 'json' };
import itemsEnJson from '../data/items_en.json' with { type: 'json' };
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
  assert.equal(S.canTickItem('L3-INT', 'L3-INTL-01', idx), false);
  // 段章代碼放行段內所有項目
  assert.equal(S.canTickItem('L3-CHALLENGE', 'L3-CHALLENGE-01', idx), true);
  assert.equal(S.canTickItem('L3-CHALLENGE', 'L3-CHALLENGE-02', idx), true);
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
  assert.equal(S.segmentDone(intl, { 'L3-INTL-02': '2026-01-01' }), true);
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

// ── 學制（新制／舊制／舊制過渡新制）與選修（pick）完成規則 ──
const S4AWARD = items.oldBadges.find(b => b.id === 'S4-AWARD');
const S4ELECT = S4AWARD.segments.find(s => s.code === 'S4-AWARD-ELECT');

test('學制目錄：新制＝L1–L4；舊制＝L1/L2＋S4；過渡＝L1–L4（S4 只作對照）', () => {
  const ids = scheme => S.schemeBadges(items, scheme).map(b => b.id);
  assert.deepEqual(ids('new'), ['L1', 'L2', 'L3', 'L4']);
  assert.deepEqual(ids('old'), ['L1', 'L2', 'S4-AWARD', 'S4-BP']);
  assert.deepEqual(ids('transition'), ['L1', 'L2', 'L3', 'L4']);
  assert.equal(S.schemeKey(items, 'bogus'), 'new', '未知學制回退為預設新制');
  assert.equal(S.schemeKey(items, undefined), items.schemes.default);
});

test('學制可勾選範圍：舊制成員不可勾新制 L3；過渡成員不可勾 S4', () => {
  const oldIds = S.schemeItemIds(items, 'old');
  const trIds = S.schemeItemIds(items, 'transition');
  assert.ok(oldIds[S4AWARD.segments[0].items[0].id]);
  assert.ok(!oldIds[L3.segments[0].items[0].id], 'old scheme cannot tick new L3');
  const s4Id = S4AWARD.segments[0].items[0].id;
  assert.ok(!trIds[s4Id], 'transition cannot tick S4 directly');
  assert.ok(trIds[L3.segments[0].items[0].id]);
  // OT 三種學制都可勾
  for (const ob of items.otherBadges) {
    assert.ok(oldIds[ob.id] && trIds[ob.id] && S.schemeItemIds(items, 'new')[ob.id]);
  }
});

test('舊版紀錄依學制顯示：S4 紀錄在新制下為舊版（不計完成度）；在過渡下為可核實的對照', () => {
  const s4Id = S4AWARD.segments[0].items[0].id;
  const flat = { [s4Id]: '2026-01-02', 'L3-SCOUT-01': '2026-03-01' };
  const newIdx = S.buildIndex(items, 'new');
  const newRows = S.legacyEntries(flat, newIdx);
  assert.deepEqual(newRows.map(r => r.id), [s4Id]);
  assert.match(newRows[0].reason, /不計入本學制/);
  const trRows = S.legacyEntries(flat, S.buildIndex(items, 'transition'));
  assert.match(trRows[0].reason, /對照過渡/);
  // 舊制成員：L3 紀錄是「第五版項目，不計入」
  const oldRows = S.legacyEntries(flat, S.buildIndex(items, 'old'));
  assert.ok(oldRows.some(r => r.id === 'L3-SCOUT-01' && /第五版/.test(r.reason)));
  assert.ok(!oldRows.some(r => r.id === s4Id), 'S4 is active for old scheme');
});

test('選修段章（pick）：舊制三選一、三選二按數量計算完成', () => {
  assert.equal(S4ELECT.completion, 'pick');
  assert.equal(S4ELECT.pick, 1);
  assert.equal(S.segmentDone(S4ELECT, {}), false);
  assert.equal(S.segmentDone(S4ELECT, { [S4ELECT.items[0].id]: '2026-01-01' }), true);
  const bpElect = items.oldBadges.find(b => b.id === 'S4-BP').segments.find(s => s.code === 'S4-BP-ELECT');
  assert.equal(bpElect.pick, 2);
  const two = bpElect.items.slice(0, 2).reduce((m, it) => (m[it.id] = '2026-01-01', m), {});
  assert.equal(S.segmentDone(bpElect, { [bpElect.items[0].id]: '2026-01-01' }), false, 'one of two is not enough');
  assert.equal(S.segmentDone(bpElect, two), true);
});

test('舊制項目 ID 皆以段章代碼為前綴，且可被權限代碼放行（S4-AWARD、段章、項目）', () => {
  const oldIdx = S.buildIndex(items, 'old');
  const id = S4AWARD.segments[0].items[0].id;
  assert.ok(id.startsWith(S4AWARD.segments[0].code + '-'));
  assert.equal(S.canTickItem('S4-AWARD', id, oldIdx), true);
  assert.equal(S.canTickItem(S4AWARD.segments[0].code, id, oldIdx), true);
  assert.equal(S.canTickItem('L1', id, oldIdx), false);
});

test('權限選單包含舊制獎章（group=old），且不影響現行獎章', () => {
  const opts = S.permissionOptions(items);
  assert.ok(opts.some(o => o.value === 'S4-AWARD' && o.group === 'old'));
  assert.ok(opts.some(o => o.value === 'L3' && o.group === 'badge'));
});

// ── 樂行配套（綱要核對）：獎章獲頒狀態、時限文字、相關表格 ──
const itemsEn = itemsEnJson;

test('獎章獲頒狀態：樂行童軍獎章 7 段中完成 4 段即符合（綱要 p.19）', () => {
  // 每段全部項目完成才算該段完成（INTL／CHALLENGE 為任選一）
  const segFlat = n => Object.fromEntries(L3.segments.slice(0, n).flatMap(seg => seg.items.map(i => [i.id, '2026-01-01'])));
  const st3 = S.badgeAwardStatus(L3, segFlat(3));
  assert.equal(st3.segmentsDone, 3);
  assert.equal(st3.required, 4);
  assert.equal(st3.segmentsTotal, 7);
  assert.equal(st3.awarded, false);
  const st4 = S.badgeAwardStatus(L3, segFlat(4));
  assert.equal(st4.segmentsDone, 4);
  assert.equal(st4.awarded, true);
  // 段章只完成一部分不計入
  const partial = S.badgeAwardStatus(L3, { 'L3-LEADER-01': '2026-01-01' });
  assert.equal(partial.segmentsDone, 0);
});

test('獲頒狀態：沒有 awardRule 的獎章回傳 null（會員章、肩章、貝登堡）', () => {
  const L1b = items.badges.find(b => b.id === 'L1');
  assert.equal(S.badgeAwardStatus(L1b, {}), null);
  assert.equal(S.badgeAwardStatus(items.badges.find(b => b.id === 'L4'), {}), null);
});

test('L4 時限文字與綱要一致：平均於 12 至 18 個月內完成（不再寫「平均 18 個月以上」）', () => {
  const l4 = items.badges.find(b => b.id === 'L4');
  assert.match(l4.description, /平均於12至18個月內完成/);
  assert.doesNotMatch(JSON.stringify(items) + JSON.stringify(itemsEn), /平均18個月以上|18 months\+|18 months\+ on average/);
});

test('L2 肩章簽發人與綱要一致（含助理總部總監（樂行童軍））', () => {
  const l2 = items.badges.find(b => b.id === 'L2');
  assert.match(l2.description, /助理總部總監（樂行童軍）/);
});

test('相關表格 PT/75（延長期限）：中英文資料一致，且官方連結指向 PT/75', () => {
  assert.equal(items.relatedForms.PT75.code, 'PT/75');
  assert.equal(itemsEn.relatedForms.PT75.code, 'PT/75');
  assert.equal(items.relatedForms.PT75.officialUrl, itemsEn.relatedForms.PT75.officialUrl);
  assert.match(items.relatedForms.PT75.officialUrl, /forms\/12470\/PT75\.pdf$/);
  assert.match(items.relatedForms.PT75.appliesTo, /樂行童軍/);
});
