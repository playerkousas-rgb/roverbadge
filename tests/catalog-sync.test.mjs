// 目錄同步測試：
//  1. apps-script/Code.gs 的 ITEM_CATALOG_ 區塊必須等於 scripts/gen-backend-catalog.mjs 由 items.json 生成的結果
//  2. 後端目錄涵蓋所有段章項目與其他獎章，且不多出任何 ID
//  3. ID 規則：每個項目 ID 必須以所屬段章代碼為前綴（例如 L3-SCOUT-01 屬 L3-SCOUT）
//  4. 段章代碼與項目 ID 在整份目錄內唯一
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import items from '../data/items.json' with { type: 'json' };
import { buildBlock, buildCatalog, extractBlock, CODE_GS_PATH } from '../scripts/gen-backend-catalog.mjs';
import { loadCodeGs } from './gas-harness.mjs';

const code = fs.readFileSync(CODE_GS_PATH, 'utf8');
const allBadges = [...(items.badges || []), ...(items.oldBadges || [])];

test('Code.gs ITEM_CATALOG 區塊與 items.json 一致（請執行 node scripts/gen-backend-catalog.mjs）', () => {
  const current = extractBlock(code);
  assert.ok(current, 'Code.gs has the GENERATED:ITEM_CATALOG markers');
  assert.equal(current, buildBlock(items), 'Code.gs block is stale; run node scripts/gen-backend-catalog.mjs');
});

test('後端目錄涵蓋所有段章項目與其他獎章（不多、不少）', () => {
  const expected = new Set();
  for (const b of allBadges) for (const s of b.segments || []) for (const it of s.items) {
    const ids = it.subItems && it.subItems.length ? it.subItems.map(x => x.id) : [it.id];
    ids.forEach(id => expected.add(id));
  }
  (items.otherBadges || []).forEach(ob => expected.add(ob.id));
  const env = loadCodeGs();
  const have = new Set(Object.keys(env.api.ITEM_CATALOG_));
  assert.deepEqual([...have].filter(x => !expected.has(x)), [], 'extra IDs in backend catalog');
  assert.deepEqual([...expected].filter(x => !have.has(x)), [], 'missing IDs in backend catalog');
});

test('ID 規則：項目 ID 以所屬段章代碼為前綴', () => {
  const bad = [];
  for (const b of allBadges) for (const s of b.segments || []) for (const it of s.items) {
    const ids = it.subItems && it.subItems.length ? it.subItems.map(x => x.id) : [it.id];
    for (const id of ids) if (!id.startsWith(s.code + '-')) bad.push(`${id} in ${s.code}`);
  }
  assert.deepEqual(bad, [], 'every item ID must start with its segment code');
});

test('ID 唯一：段章代碼與項目 ID 在整份目錄內不重複', () => {
  const segs = new Set(), ids = new Set();
  for (const b of allBadges) for (const s of b.segments || []) {
    assert.ok(!segs.has(s.code), 'duplicate segment ' + s.code); segs.add(s.code);
    for (const it of s.items) {
      const list = it.subItems && it.subItems.length ? it.subItems.map(x => x.id) : [it.id];
      for (const id of list) { assert.ok(!ids.has(id), 'duplicate item ' + id); ids.add(id); }
    }
  }
  for (const ob of items.otherBadges || []) { assert.ok(!ids.has(ob.id), 'dup other ' + ob.id); ids.add(ob.id); }
});

test('學制字母：新制=L1–L4＋OT，舊制=L1/L2＋S4＋OT，過渡=L1–L4＋OT；S4 只在舊制可勾', () => {
  const cat = buildCatalog(items);
  for (const b of items.badges) for (const s of b.segments) for (const it of s.items) {
    if (cat[it.id]) assert.match(cat[it.id].t, /n/, `${it.id} tickable in new scheme`);
  }
  for (const b of items.oldBadges) for (const s of b.segments) for (const it of s.items) {
    assert.equal(cat[it.id].t, 'o', `${it.id} is old-scheme only`);
  }
  for (const ob of items.otherBadges) assert.equal(cat[ob.id].t, 'not', 'OT tickable in all schemes');
  assert.equal(cat['L1-ACT-01'].t, 'not', 'L1 tickable in all schemes');
});

test('後端與前端使用同一份 items.json（DEFAULT_PERMS_ 與 permissionDefaults 一致）', () => {
  const env = loadCodeGs();
  assert.equal(env.api.DEFAULT_PERMS_.leader, items.permissionDefaults.leader);
  assert.equal(env.api.DEFAULT_PERMS_.exec_committee, items.permissionDefaults.exec_committee);
  assert.equal(env.api.DEFAULT_PERMS_.member, items.permissionDefaults.member);
});
