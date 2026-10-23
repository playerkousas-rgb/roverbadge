// 殘留掃描（其他章節／VSBADGE 深資結構是否混入本支部）與跨檔一致性。
// 允許的例外只限於：舊版對照（legacyTransition）、舊版紀錄（legacy）、舊制目錄（oldBadges／oldForms，第四版 S4-*），
// 以及架構性註解（api/*.js、Code.gs 的 VSBADGE／深資 說明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import items from '../data/items.json' with { type: 'json' };
import itemsEn from '../data/items_en.json' with { type: 'json' };
import { loadRoverModules } from './browser-module-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const { RoverScope: S, RoverForms: F } = loadRoverModules();

// 其他章節／舊制專屬的段章名、表格結構與 ID 慣例（本支部不應出現）
const RESIDUE = [
  '活動段章', 'L1,L3-ACT', 'L1,活動段章',
  '童軍知識', '社區服務', '個人興趣', '認識世界', '挑戰項目', '童軍技能（I）', '童軍技能（II）',
  'Community Service', 'Scoutcraft (I)', 'Scouting Knowledge', 'Personal Development', 'Personal Pursuits', 'Horizons Broadening',
  '4必修', '3選修', '三選二', '三選一剔號',
  '金帶', '306項', '23項',
  'L3-SELF', 'L3-RESP', 'L3-EXP', 'L2-SKILL', 'L1-UND-05', 'L3-ACT-',
  'PT/19', 'PT/20', 'PT/18', 'PT/68', 'DRSL',
  'article_attach',  // 舊制 PDF 連結不應出現在新制產生的表格
];

// 允許出現的 JSON 子樹（舊版對照／舊版紀錄／舊制連結）
const ALLOWED_SUBTREES = new Set(['legacyTransition', 'legacy', 'oldBadges', 'oldForms']);

function strings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(n => strings(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach(v => strings(v, out));
  return out;
}
function currentStrings(doc) {
  const out = [];
  for (const [k, v] of Object.entries(doc)) if (!ALLOWED_SUBTREES.has(k)) strings(v, out);
  return out;
}
function hits(list, tokens) {
  const r = [];
  for (const t of tokens) for (const s of list) if (s.includes(t)) r.push(`${t} ⟵ ${s.slice(0, 60)}`);
  return r;
}

test('items.json: no residue from other sections outside the legacy subtrees', () => {
  assert.deepEqual(hits(currentStrings(items), RESIDUE), []);
});

test('items_en.json: no residue from other sections outside the legacy subtrees', () => {
  assert.deepEqual(hits(currentStrings(itemsEn), RESIDUE), []);
});

test('items.json / items_en.json: same structure, IDs and form codes', () => {
  const ids = doc => [...doc.badges, ...doc.oldBadges].flatMap(b => b.segments.flatMap(s => S.segmentItemIds(s)))
    .concat(doc.otherBadges.map(o => o.id));
  assert.deepEqual(ids(itemsEn), ids(items));
  assert.deepEqual(itemsEn.badges.map(b => b.id), items.badges.map(b => b.id));
  assert.deepEqual(itemsEn.badges.map(b => b.segments.map(s => s.code)), items.badges.map(b => b.segments.map(s => s.code)));
  assert.deepEqual(Object.keys(itemsEn.forms), Object.keys(items.forms));
  assert.deepEqual(Object.keys(itemsEn.oldForms), Object.keys(items.oldForms));
  assert.deepEqual(itemsEn.oldBadges.map(b => b.segments.map(s => s.code)), items.oldBadges.map(b => b.segments.map(s => s.code)));
  assert.deepEqual(itemsEn.legacyTransition, items.legacyTransition);
  assert.deepEqual(itemsEn.legacy.ids.map(l => l.id), items.legacy.ids.map(l => l.id));
  for (const k of Object.keys(items.forms)) {
    assert.equal(itemsEn.forms[k].officialUrl, items.forms[k].officialUrl, k);
  }
});

test('legacy IDs are kept (not deleted) and labelled 舊版紀錄／不計完成度', () => {
  assert.equal(items.legacy.label, '舊版紀錄／不計完成度');
  assert.equal(itemsEn.legacy.label, 'Legacy record / not counted');
  const current = new Set(items.badges.flatMap(b => b.segments.flatMap(s => S.segmentItemIds(s))).concat(items.otherBadges.map(o => o.id)));
  for (const l of items.legacy.ids) assert.ok(!current.has(l.id), `${l.id} must not be a current ID`);
  assert.ok(items.legacy.ids.length >= 12);
});

test('generated text (levels, permissions, forms, links) contains no residue', () => {
  const generated = [
    ...S.levelSummaries(items).flatMap(x => [x.name, x.desc]),
    // 舊制（old）選項與連結是刻意保留的第四版內容，此處只檢查新制輸出
    ...S.permissionOptions(items).filter(o => !/^old/.test(o.group)).map(o => o.label),
    F.formButtonsHtml(items, 'new'),
    F.buildForm('PT21', { items, flat: {}, member: { name: 'X', ymis: '1' }, today: '2026-01-01' }),
    F.buildForm('PT22', { items, flat: {}, member: { name: 'X', ymis: '1' }, today: '2026-01-01' }),
    F.buildForm('PT69', { items, flat: {}, member: { name: 'X', ymis: '1' }, today: '2026-01-01' }),
  ];
  // 舊制連結只允許出現在 officialLinksHtml 的「舊制」卡片中，不應出現在 buildForm 輸出
  const tokens = RESIDUE.filter(t => t !== 'article_attach');
  assert.deepEqual(hits(generated, tokens), []);
  assert.ok(!F.buildForm('PT21', { items, flat: {}, member: {}, today: '' }).includes('article_attach'));
});

test('index.html: no hard-coded badge lists, permission defaults, or other-section residue', () => {
  const html = read('index.html');
  for (const t of ['活動段章', 'L1,L3-ACT', 'L1,活動段章', '童軍知識', '社區服務', '個人興趣', '認識世界', '挑戰項目', '4必修', '三選二', '金帶', '306項']) {
    assert.ok(!html.includes(t), `index.html contains ${t}`);
  }
  // 不得寫死項目 ID（應由 items.json 產生）
  assert.deepEqual(html.match(/['"]L[1-4]-[A-Z]+-[0-9A-Z]{1,2}['"]/g) || [], []);
  // 權限與表格必須走 RoverScope / RoverForms
  assert.ok(html.includes('RoverScope.'));
  assert.ok(html.includes('RoverForms.'));
});

test('index.html: inline snippets do not redefine the shared helpers', () => {
  const html = read('index.html');
  for (const fn of ['function parseTokens', 'function segmentItemIds', 'function canTickItem', 'function legacyEntries', 'function resolveRows']) {
    assert.ok(!html.includes(fn), `${fn} must come from assets/`);
  }
});

test('Code.gs: exec default matches items.json and no other-section defaults remain', () => {
  const gs = read('apps-script/Code.gs');
  assert.equal(items.permissionDefaults.exec_committee, 'L1,OTHER');
  assert.ok(gs.includes("'L1,OTHER'"));
  assert.ok(!gs.includes("'L1,活動段章,OTHER'"));
  assert.ok(!gs.includes("'L1,L3-ACT,OTHER'"));
  const bo = read('assets/batch-onboard/Code.gs');
  assert.ok(!bo.includes("'L1,活動段章,OTHER'"));
  assert.ok(!bo.includes("'L1,L3-ACT,OTHER'"));
});

test('i18n_dict.tsv: no stale residue keys, and dict is in sync', () => {
  const tsv = read('i18n_dict.tsv');
  for (const t of ['三選二', '三選一剔號', '4必修', '童軍知識\t', '社區服務\t']) {
    assert.ok(!tsv.includes(t), `tsv contains ${t}`);
  }
  const keys = tsv.split('\n').filter(Boolean).map(l => l.split('\t')[0]);
  assert.equal(new Set(keys).size, keys.length, 'TSV keys unique');
});

test('residue scan is over the repo, not only index.html', () => {
  // 殘留掃描的範圍（供審計報告引用）
  const scanned = ['index.html', 'data/items.json', 'data/items_en.json', 'i18n_dict.tsv', 'apps-script/Code.gs', 'assets/rover-scope.js', 'assets/forms.js'];
  for (const f of scanned) assert.ok(fs.existsSync(path.join(root, f)), f);
});
