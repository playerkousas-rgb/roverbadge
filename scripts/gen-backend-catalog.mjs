#!/usr/bin/env node
// 產生 apps-script/Code.gs 內的 ITEM_CATALOG_ / DEFAULT_PERMS_ 區塊（來源：data/items.json）。
//
// 為什麼要產生：Apps Script 讀不到 repo 內的 JSON，後端要知道「每個項目屬於哪個獎章／段章、
// 哪個學制可勾選」才能強制 allowed_badges 與學制範圍。這份對照表由 items.json 機械產生，
// 手改無效；tests/catalog-sync.test.mjs 會檢查 Code.gs 與 items.json 是否一致。
//
// 用法：
//   node scripts/gen-backend-catalog.mjs           寫入 apps-script/Code.gs
//   node scripts/gen-backend-catalog.mjs --check   只檢查，不一致則以非零結束碼退出
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const ITEMS_PATH = path.join(ROOT, 'data', 'items.json');
export const CODE_GS_PATH = path.join(ROOT, 'apps-script', 'Code.gs');

export const BEGIN_MARK = '// >>> GENERATED:ITEM_CATALOG（scripts/gen-backend-catalog.mjs 由 data/items.json 產生，勿手改）';
export const END_MARK = '// <<< GENERATED:ITEM_CATALOG';

// 學制代碼 → 目錄字母（ITEM_CATALOG_ 內 t 欄位的字母）
const SCHEME_LETTER = { new: 'n', old: 'o', transition: 't' };
const SCHEME_ORDER = ['new', 'old', 'transition'];

function allBadges(items) {
  return (items.badges || []).concat(items.oldBadges || []);
}

// 回傳 { 項目ID: { t, s, b, o } }
// t：可勾選的學制字母（n=新制 o=舊制 t=過渡）；s：段章代碼；b：獎章 ID；o：1 = 其他獎章（OT-*）
export function buildCatalog(items) {
  const lists = (items.schemes && items.schemes.list) || {};
  for (const k of Object.keys(lists)) {
    if (!SCHEME_LETTER[k]) throw new Error(`gen-backend-catalog: 未知學制 ${k}（請更新 SCHEME_LETTER）`);
  }
  const catalog = {};
  const lettersFor = (badgeId, isOther) => {
    if (isOther) return SCHEME_ORDER.map(k => SCHEME_LETTER[k]).join('');
    return SCHEME_ORDER.filter(k => (lists[k] && lists[k].catalogBadges || []).includes(badgeId))
      .map(k => SCHEME_LETTER[k]).join('');
  };
  for (const b of allBadges(items)) {
    const t = lettersFor(b.id, false);
    for (const s of b.segments || []) {
      for (const it of s.items || []) {
        const ids = it.subItems && it.subItems.length ? it.subItems.map(x => x.id) : [it.id];
        for (const id of ids) {
          if (catalog[id]) throw new Error(`gen-backend-catalog: 項目 ID 重複 ${id}`);
          catalog[id] = { t, s: s.code, b: b.id, o: 0 };
        }
      }
    }
  }
  for (const ob of items.otherBadges || []) {
    if (catalog[ob.id]) throw new Error(`gen-backend-catalog: 項目 ID 重複 ${ob.id}`);
    catalog[ob.id] = { t: lettersFor('', true), s: '', b: '', o: 1 };
  }
  return catalog;
}

// 把目錄轉成 Apps Script 原始碼（每項一行，便於 diff）
export function buildBlock(items) {
  const catalog = buildCatalog(items);
  const pd = items.permissionDefaults || {};
  const lines = [];
  lines.push(BEGIN_MARK);
  lines.push('// 學制字母：n=新制 o=舊制 t=舊制過渡新制。字母只表示「該學制可勾選」。');
  lines.push('var ITEM_CATALOG_ = {');
  for (const id of Object.keys(catalog)) {
    const c = catalog[id];
    lines.push(`  ${JSON.stringify(id)}: { t: ${JSON.stringify(c.t)}, s: ${JSON.stringify(c.s)}, b: ${JSON.stringify(c.b)}, o: ${c.o} },`);
  }
  lines.push('};');
  lines.push('// 角色預設 allowed_badges（與 items.json permissionDefaults 相同；空白 allowed_badges 時使用）');
  lines.push('var DEFAULT_PERMS_ = {');
  lines.push(`  leader: ${JSON.stringify(pd.leader === undefined ? '*' : pd.leader)},`);
  lines.push(`  exec_committee: ${JSON.stringify(pd.exec_committee === undefined ? '' : pd.exec_committee)},`);
  lines.push(`  member: ${JSON.stringify(pd.member === undefined ? '' : pd.member)}`);
  lines.push('};');
  lines.push(END_MARK);
  return lines.join('\n');
}

// 在 Code.gs 原始碼中替換標記區塊；找不到標記即丟錯（避免寫到錯的地方）
export function spliceBlock(code, block) {
  const b = code.indexOf(BEGIN_MARK);
  const e = code.indexOf(END_MARK);
  if (b < 0 || e < 0 || e < b) throw new Error('Code.gs 缺少 ITEM_CATALOG 標記區塊');
  if (code.indexOf(BEGIN_MARK, b + 1) >= 0) throw new Error('Code.gs 有多個 ITEM_CATALOG 標記區塊');
  const endLine = code.indexOf('\n', e);
  const tail = endLine < 0 ? '' : code.slice(endLine);
  return code.slice(0, b) + block + tail;
}

export function extractBlock(code) {
  const b = code.indexOf(BEGIN_MARK);
  const e = code.indexOf(END_MARK);
  if (b < 0 || e < 0) return null;
  return code.slice(b, e + END_MARK.length);
}

function main() {
  const items = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));
  const code = fs.readFileSync(CODE_GS_PATH, 'utf8');
  const block = buildBlock(items);
  if (process.argv.includes('--check')) {
    const cur = extractBlock(code);
    if (cur !== block) {
      console.error('❌ apps-script/Code.gs 的 ITEM_CATALOG 區塊與 data/items.json 不一致；請執行 node scripts/gen-backend-catalog.mjs');
      process.exit(1);
    }
    console.log('✅ ITEM_CATALOG 區塊與 items.json 一致');
    return;
  }
  fs.writeFileSync(CODE_GS_PATH, spliceBlock(code, block));
  console.log(`✅ 已寫入 ${Object.keys(buildCatalog(items)).length} 個項目到 apps-script/Code.gs`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
