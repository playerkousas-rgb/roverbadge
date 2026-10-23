// 表格產生器測試：以 Node harness 實際執行 assets/forms.js，檢查輸出內容。
// 資料全部來自 data/items.json；測試不寫死任何獎章／段章清單。
import test from 'node:test';
import assert from 'node:assert/strict';
import items from '../data/items.json' with { type: 'json' };
import { loadRoverModules } from './browser-module-harness.mjs';

const { RoverScope, RoverForms } = loadRoverModules();
const L3 = items.badges.find(b => b.id === 'L3');
const l3ItemIds = L3.segments.flatMap(s => RoverScope.segmentItemIds(s));

// 一個已完成多數項目的成員（僅用於檢查帶入資料）
const flat = {
  'L3-LEADER-01': '2026-01-10', 'L3-LEADER-02': '2026-02-10',
  'L3-SCOUT-01': '2026-03-01', 'L3-SCOUT-02': '2026-03-02', 'L3-SCOUT-03': '2026-03-03',
  'L3-SERVICE-01': '2026-04-01', 'L3-SERVICE-02': '2026-04-05', 'L3-SERVICE-03': '2026-04-09',
  'L3-INTL-B': '2026-05-01',
  'L3-INT-01': '2026-06-01',
  'L3-HEALTH-01': '2026-07-01', 'L3-HEALTH-02': '2026-07-20',
  'L3-CHAL-A': '2026-08-01',
  // 舊版 ID：必須保留、不計完成度
  'L1-01': '2019-05-05'
};
const member = { name: '測試<b>成員</b>', ymis: 'L9999' };
const ctx = (extra = {}) => ({ items, flat, member, troopName: '測試樂行團', today: '2026-10-23', ...extra });

const countChecked = html => (html.match(/☑/g) || []).length;

test('PT/21 rows follow the 5th Edition seven L3 segments (choose 4 of 7)', () => {
  const rows = RoverForms.resolveRows(items.forms.PT21, items);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map(r => r.segment), L3.segments.map(s => s.code));
  assert.equal(items.forms.PT21.rule.count, 4);
  assert.equal(items.forms.PT21.rule.of, 7);
});

test('PT/22 has 8 rows (服務 split into 2), requires certificate no., choose 3 of 7', () => {
  const rows = RoverForms.resolveRows(items.forms.PT22, items);
  assert.equal(rows.length, 8);
  const service = rows.filter(r => r.segment === 'L3-SERVICE');
  assert.equal(service.length, 2, '服務 appears twice');
  assert.match(service[0].hint, /急救證書編號/);
  assert.equal(service[0].itemIds.length, 1);
  assert.deepEqual(service[1].itemIds, ['L3-SERVICE-02', 'L3-SERVICE-03']);
  assert.equal(items.forms.PT22.certField.required, true);
  assert.equal(items.forms.PT22.rule.count, 3);
});

test('PT/69 rows cover every L3 item (no item left out of the application)', () => {
  const rows = RoverForms.resolveRows(items.forms.PT69, items);
  const covered = rows.flatMap(r => r.itemIds);
  assert.deepEqual([...new Set(covered)].sort(), [...l3ItemIds].sort());
  assert.equal(l3ItemIds.length, 15, 'L3 has 15 items across 7 segments');
  assert.equal(items.forms.PT69.prefillDates, false);
  assert.equal(items.forms.PT69.awardChoice, true);
  assert.equal(items.forms.PT69.progressTicks, false, 'plan form: no completion ticks');
});

test('PT/21 output: ticks and dates come from progress, names are escaped', () => {
  const html = RoverForms.buildForm('PT21', ctx());
  // 期望值由同一份 rows 與進度資料推算（不寫死）
  const expectDone = RoverForms.doneSegmentCount(RoverForms.resolveRows(items.forms.PT21, items), flat);
  assert.equal(countChecked(html), expectDone, 'one ☑ per completed row');
  assert.ok(html.includes('測試&lt;b&gt;成員&lt;/b&gt;'), 'member name escaped');
  assert.ok(!html.includes('<b>成員</b>'), 'no raw HTML from member name');
  assert.ok(html.includes('2026-04-09'), 'services row prefilled with latest date of its items');
  assert.ok(html.includes('type="date" value="2026-10-23"'), 'application date filled');
  assert.ok(html.includes(items.forms.PT21.officialUrl), 'links to the new 5th Edition PDF');
  assert.ok(!html.includes('article_attach'), 'legacy (4th Edition) PDF is not used');
});

test('PT/21 counts only completed segments; legacy IDs do not count', () => {
  const onlyLegacy = { 'L1-01': '2019-05-05', 'L2-SKILL-01': '2019-01-01', 'L3-ACT-SCOUT': '2019-01-01' };
  const rows = RoverForms.resolveRows(items.forms.PT21, items);
  assert.equal(RoverForms.doneSegmentCount(rows, onlyLegacy), 0);
  const html = RoverForms.buildForm('PT21', ctx({ flat: onlyLegacy }));
  assert.equal(countChecked(html), 0);
});

test('PT/69 never pre-fills completion dates and offers the L3/L4 award choice', () => {
  const html = RoverForms.buildForm('PT69', ctx());
  assert.ok(!html.includes('2026-04-09'), 'no pre-filled date');
  assert.ok(!html.includes('2026-03-03'), 'no pre-filled date');
  assert.ok(!html.includes('☑'), 'plan form shows no completion ticks');
  for (const b of items.badges.filter(b => b.id === 'L3' || b.id === 'L4')) {
    assert.ok(html.includes(b.name), `award choice includes ${b.name}`);
  }
  assert.ok(html.includes('申請獎章 Award applied for'));
});

test('signing stages are read from items.json', () => {
  const html = RoverForms.buildForm('PT22', ctx());
  for (const st of items.forms.PT22.stages) {
    assert.ok(html.includes(RoverForms.escapeHtml(st.signer)), `signer ${st.signer}`);
  }
  assert.ok(html.includes('地域印') || html.includes('Regional Stamp'));
});

test('legacy (4th Edition) forms are link-only and cannot be generated', () => {
  assert.throws(() => RoverForms.buildForm('PT21_LEGACY', ctx()), /unknown form/);
  assert.ok(!RoverForms.formButtonsHtml(items).includes(items.legacyForms.PT21.officialUrl), 'no legacy button');
  const links = RoverForms.officialLinksHtml(items);
  for (const key of Object.keys(items.legacyForms)) {
    assert.ok(links.includes(items.legacyForms[key].officialUrl), `legacy link ${key}`);
  }
  assert.ok(links.includes('舊制（第四版）'));
  assert.ok(links.includes(items.forms.PT22.officialUrl));
});

test('form buttons are generated from items.json (no hard-coded form list)', () => {
  const html = RoverForms.formButtonsHtml(items);
  for (const key of Object.keys(items.forms)) {
    assert.ok(html.includes(`generatePrintableForm('${key}')`), key);
  }
});

test('resolveRows rejects an item that is not in its segment', () => {
  const broken = structuredClone(items);
  broken.forms.PT22.rows[0] = { segment: 'L3-LEADER', items: ['L3-SCOUT-01'] };
  assert.throws(() => RoverForms.resolveRows(broken.forms.PT22, broken), /not in L3-LEADER/);
});

test('resolveRows rejects an unknown segment', () => {
  const broken = structuredClone(items);
  broken.forms.PT21.rows = [{ segment: 'L6-NOPE' }];
  assert.throws(() => RoverForms.resolveRows(broken.forms.PT21, broken), /unknown segment/);
});
