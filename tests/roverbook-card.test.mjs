// ============================================================
// 個人匯入卡（RBC1）＋ QR 產生器回歸測試（2026-11）
//
// 產品情境：領袖喺「📖 ROVERBOOK 對接 → 📱 4 · 匯出 QR」揀一位成員，
// 系統把「該成員的進度＋頒發」壓成一張卡，放進連結
//   https://<ROVERBOOK>/#rb=RBC1.…
// 再印成二維碼。成員用手機相機掃 → 開 ROVERBOOK → 一按就成為自己的紀錄冊。
//
// 這裡守住四件事：
//   A. 卡內零個資（姓名、電話、電郵、地址、生日、相片、簽名墨跡一律冇）
//   B. 卡 ↔ 權杖 ↔ 網址 三個方向都解得返，而且內容一模一樣（唔會走樣）
//   C. 體積夠細：32 項全滿都可以放進手機相機讀得到的中型 QR
//   D. QR 編碼器輸出穩定（有交叉驗證過的指紋），而且同 ROVERBOOK drop-in 完全一致
//
// 執行：node --test tests/roverbook-card.test.mjs
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadAssetModule, repoRoot } from './browser-module-harness.mjs';

const Bridge = loadAssetModule('assets/roverbook-bridge.js');
const Qr = loadAssetModule('assets/roverbook-qr.js');
const items = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'items.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const SYLLABUS_IDS = items.badges.flatMap((b) => b.segments.flatMap((s) => s.items.map((i) => i.id)));
const SID = '0000081420';

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const matrixKey = (qr) => sha(qr.modules.map((row) => row.map((b) => (b ? 1 : 0)).join('')).join(''));

// 一份「滿載個資」的成員紀錄：用來證明 card 一個欄位都唔會讀
function memberRecord() {
  return {
    scoutId: SID,
    name: '陳大文',
    phone: '91234567',
    email: 'taiman@example.org',
    address: '香港仔某街 1 號',
    dob: '2008-01-02',
    photo: 'data:image/png;base64,PHOTO',
    holderSignature: { png: 'HOLDERSIG' },
    progress: {
      'L1-ACT-01': '2026-03-01',
      'L1-UND-01': '2026/3/2',
      'L1-UND-02': { date: '2026-03-03', assessor: '團長甲', signature: { png: 'SIG' } },
      'not-an-item': '2026-04-06',
      'L3-INT-01': '2026-13-99'
    },
    awards: { L1: '2026-04-01', L2: '2026/5/2', XX: '2026-01-01' }
  };
}

const FORBIDDEN = ['陳大文', '91234567', 'taiman@example.org', '香港仔', '2008-01-02', 'PHOTO', 'HOLDERSIG', 'SIG', '團長甲'];

// ---------- A. 零個資 ----------
test('卡：只取 SCOUT ID／項目／日期／頒發，姓名、電話、相片、簽名一個都唔會入卡', () => {
  const rec = memberRecord();
  const built = Bridge.buildCard({ troopId: '0082', scoutId: rec.scoutId, progress: rec.progress, awards: rec.awards, issuedAt: '2026-11-19' });
  const card = built.card;
  assert.equal(card.schema, Bridge.SCHEMA_CARD);
  assert.equal(card.scoutId, SID);
  assert.deepEqual(Object.keys(card.progress).sort(), ['L1-ACT-01', 'L1-UND-01', 'L1-UND-02']);
  assert.equal(card.progress['L1-UND-01'], '2026-03-02', '2026/3/2 要正規化');
  assert.equal(card.progress['L3-INT-01'], undefined, '不存在的 13 月 99 日要丟棄');
  assert.deepEqual(card.awards, { L1: '2026-04-01', L2: '2026-05-02' });
  // 卡本身唔可以有任何個人資料欄位
  for (const key of Object.keys(card)) {
    assert.ok(Bridge.NEVER_TRANSFER_FIELDS.indexOf(key) < 0, '卡不可有欄位 ' + key);
    assert.notEqual(key, 'name');
  }
  for (const v of FORBIDDEN) assert.ok(!JSON.stringify(card).includes(v), '卡不可含個資：' + v);
  // 逐項說明丟棄了什麼（唔會靜靜雞消失）
  assert.equal(built.dropped.badItemId, 1);
  assert.equal(built.dropped.badDate, 1);
  assert.equal(built.dropped.unknownAward, 1);
});

test('卡：權杖／網址／bookPull JSON 全部掃唔到個資（連 base64 內文都唔可以）', () => {
  const rec = memberRecord();
  const card = Bridge.buildCard({ troopId: '0082', scoutId: rec.scoutId, progress: rec.progress, awards: rec.awards }).card;
  const token = Bridge.encodeCard(card);
  const url = Bridge.cardUrl('https://roverbook.vercel.app', token);
  const pull = Bridge.cardToPull(Bridge.decodeCard(url).card);
  const decodedBytes = Buffer.from(token.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  for (const v of FORBIDDEN) {
    assert.ok(!token.includes(v), '權杖不可含個資：' + v);
    assert.ok(!decodedBytes.includes(v), '二進位內文不可含個資：' + v);
    assert.ok(!JSON.stringify(pull).includes(v), 'bookPull JSON 不可含個資：' + v);
  }
});

// ---------- B. 三個方向都解得返 ----------
test('卡：encode → decode 完全一致（進度、頒發、日期、SCOUT ID、旅團）', () => {
  const rec = memberRecord();
  const card = Bridge.buildCard({ troopId: '0082', scoutId: rec.scoutId, progress: rec.progress, awards: rec.awards, issuedAt: '2026-11-19' }).card;
  const token = Bridge.encodeCard(card);
  const back = Bridge.decodeCard(token);
  assert.equal(back.ok, true);
  assert.deepEqual(back.card.progress, card.progress);
  assert.deepEqual(back.card.awards, card.awards);
  assert.equal(back.card.scoutId, SID);
  assert.equal(back.card.troopId, '0082');
  assert.equal(back.card.issuedAt, '2026-11-19');
  assert.equal(Bridge.encodeCard(back.card), token, '同一張卡永遠得出同一串（列印／核對用）');
});

test('卡：由完整網址、純 hash、夾雜文字都搵得返；壞資料會明確話錯', () => {
  const card = Bridge.buildCard({ troopId: '0082', scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } }).card;
  const token = Bridge.encodeCard(card);
  const url = Bridge.cardUrl('https://roverbook.vercel.app/', token);
  assert.equal(Bridge.decodeCard(url).ok, true);
  assert.equal(Bridge.decodeCard(url.slice(url.indexOf('#'))).ok, true);
  assert.equal(Bridge.decodeCard('幫我掃： ' + token + ' 唔該').ok, true);
  assert.equal(Bridge.decodeCard('https://roverbook.vercel.app/').ok, false);
  assert.equal(Bridge.decodeCard('RBC1.####').ok, false);
  assert.match(Bridge.decodeCard('RBC1.@@@').reason, /RBC1|損壞|找不到/);
  // 截斷的權杖（例如 QR 被遮住一角）
  assert.equal(Bridge.decodeCard(token.slice(0, token.length - 12)).ok, false);
  // 版本未支援：把第一個 byte 由 1 改成 9
  const bytes = Bridge.encodeCardBytes(card);
  bytes[0] = 9;
  const bad = 'RBC1.' + Buffer.from(bytes).toString('base64url');
  assert.match(Bridge.decodeCard(bad).reason, /版本未支援/);
});

test('網址：會清理結尾斜線／舊 hash／缺 https，並只用 hash 傳資料（唔會送去伺服器）', () => {
  const token = 'RBC1.AAAA';
  assert.equal(Bridge.cardUrl('https://roverbook.vercel.app/', token), 'https://roverbook.vercel.app/#rb=' + token);
  assert.equal(Bridge.cardUrl('roverbook.vercel.app/', token), 'https://roverbook.vercel.app/#rb=' + token);
  assert.equal(Bridge.cardUrl('https://example.org/app?x=1#old', token), 'https://example.org/app/#rb=' + token);
  assert.equal(Bridge.cardUrl('', token), Bridge.CARD_DEFAULT_BASE + '/#rb=' + token);
  assert.equal(Bridge.cardUrl('https://x.test', ''), '');
  // 資料只會在 hash 出現一次：問號之前唔可以有權杖
  const url = Bridge.cardUrl('https://roverbook.vercel.app', token);
  assert.ok(url.indexOf('?') < 0 || url.indexOf(token) > url.indexOf('?'), '權杖只能出現在 hash');
});

test('cardToPull：schema／verified 標記齊全，ROVERBOOK 可以直接採用', () => {
  const card = Bridge.buildCard({ troopId: '0082', scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' }, awards: { L1: '2026-04-01' } }).card;
  const pull = Bridge.cardToPull(card);
  assert.equal(pull.schema, 'roverbadge.progress.roverbook.v2');
  assert.equal(pull.verified, true);
  assert.equal(pull.verifiedBy, 'ROVERBADGE');
  assert.equal(pull.source, 'ROVERBADGE');
  assert.deepEqual(pull.progress, { 'L1-ACT-01': '2026-03-01' });
  assert.deepEqual(pull.flatProgress, pull.progress);
  assert.deepEqual(pull.awards, { L1: '2026-04-01' });
  assert.ok(pull.signoffs.every((s) => s.verified === true && s.source === 'ROVERBADGE'));
  assert.equal(pull.privacy.personalData, 'none');
  // 領袖已核實的東西才入 signoffs（頭盔：唔可以有 verified:false）
  assert.ok(pull.signoffs.every((s) => s.verified === true));
});

// ---------- C. 體積 ----------
test('體積：32 項全滿＋3 個獎章仍然放得入中型 QR（手機相機讀得到）', () => {
  const progress = {};
  Bridge.CARD_ITEMS.forEach((id, i) => { progress[id] = '2026-' + String((i % 12) + 1).padStart(2, '0') + '-' + String((i % 27) + 1).padStart(2, '0'); });
  const built = Bridge.buildCard({ troopId: '0082', scoutId: SID, progress, awards: { L1: '2026-04-01', L2: '2026-05-02', L3: '2026-06-03' }, issuedAt: '2026-11-19' });
  const token = Bridge.encodeCard(built.card);
  const url = Bridge.cardUrl('https://roverbook.vercel.app', token);
  assert.equal(Object.keys(built.card.progress).length, 32);
  assert.ok(token.length < 200, '32 項權杖應 < 200 字元，實際 ' + token.length);
  assert.ok(url.length < 240, '完整網址應 < 240 字元，實際 ' + url.length);
  const qr = Qr.encode(url, { ecl: 'M' });
  assert.ok(qr.version <= 12, 'QR 版本應 ≤ 12，實際 ' + qr.version);
  assert.ok(qr.size <= 65, 'QR 邊長應 ≤ 65 格，實際 ' + qr.size);
  // 空白卡（未有任何進度）一樣要有用：綁定 SCOUT ID
  const blank = Bridge.decodeCard(Bridge.encodeCard(Bridge.buildCard({ troopId: '0082', scoutId: SID }).card));
  assert.equal(blank.ok, true);
  assert.equal(blank.card.scoutId, SID);
  assert.deepEqual(blank.card.progress, {});
});

test('索引表：同 data/items.json 的 32 項一模一樣（綱要改版就要更新，唔可以靜靜雞解錯）', () => {
  assert.equal(Bridge.CARD_ITEMS.length, SYLLABUS_IDS.length);
  assert.deepEqual([...Bridge.CARD_ITEMS].sort(), [...SYLLABUS_IDS].sort());
  assert.equal(new Set(Bridge.CARD_ITEMS).size, Bridge.CARD_ITEMS.length, '索引表不可有重複');
  assert.deepEqual(Bridge.CARD_AWARD_CODES, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
  // 綱要以外嘅項目要「逃生門」照樣過得去（未知 index → 直接寫 ID）
  const extra = Bridge.buildCard({ troopId: '0082', scoutId: SID, progress: { 'OT-CUSTOM-01': '2026-03-01' } }).card;
  assert.deepEqual(Bridge.decodeCard(Bridge.encodeCard(extra)).card.progress, { 'OT-CUSTOM-01': '2026-03-01' });
  // 1999 年以前／2099 年以後唔在卡格式範圍（u16 日數），唔會寫入錯誤日期
  assert.equal(Bridge.buildCard({ troopId: '0082', scoutId: SID, progress: { 'L1-ACT-01': '1999-12-31' } }).card.progress['L1-ACT-01'], undefined);
});

// ---------- D. QR 編碼器 ----------
test('QR：版本與邊長符合規格，三個定位圖案齊全，SVG 有靜區', () => {
  const qr = Qr.encode('HELLO RBC1', { ecl: 'M' });
  assert.equal(qr.size, qr.version * 4 + 17);
  assert.equal(qr.modules.length, qr.size);
  assert.ok(qr.modules.every((row) => row.length === qr.size));
  // 左上定位圖案：7×7 外框 + 3×3 核心
  for (let i = 0; i < 7; i++) {
    assert.equal(qr.modules[0][i], true);
    assert.equal(qr.modules[6][i], true);
    assert.equal(qr.modules[i][0], true);
    assert.equal(qr.modules[i][6], true);
  }
  assert.equal(qr.modules[3][3], true, '定位圖案核心');
  assert.equal(qr.modules[1][1], false, '定位圖案白色內圈');
  // 右上／左下定位圖案
  assert.equal(qr.modules[0][qr.size - 1], true);
  assert.equal(qr.modules[qr.size - 1][0], true);
  // 時間圖案（第 6 行／列梅花間竹）
  assert.equal(qr.modules[6][8], true);
  assert.equal(qr.modules[6][9], false);
  const svg = Qr.svg('HELLO RBC1', { ecl: 'M', margin: 4 });
  const viewBox = /viewBox="0 0 (\d+) \d+"/.exec(svg);
  assert.ok(viewBox, 'SVG 要有 viewBox');
  assert.equal(Number(viewBox[1]), qr.size + 8, '靜區 4 格');
  assert.ok(svg.indexOf('<path') > 0 && svg.indexOf('role="img"') > 0);
});

test('QR：同一輸入輸出穩定（已用獨立解碼器 jsQR 交叉驗證過的指紋）', () => {
  // 指紋由 JS 實作外的解碼器（jsQR）驗證過「解得出原文」，鎖住將來唔會靜靜雞改壞。
  const url = 'https://roverbook.vercel.app/#rb=RBC1.AQAEMDA4MgoxMjM0NTY3ODkwJlsAAwAlVAElVRgllQEAJXM';
  const qr = Qr.encode(url, { ecl: 'M' });
  assert.equal(qr.version, 6);
  assert.equal(qr.mask, 2);
  assert.equal(matrixKey(qr), 'a002ddec544f30bb659edb5445369667984d70ea27256ba66fe2daa83ed5ef79');
  const small = Qr.encode('HELLO RBC1', { ecl: 'M' });
  assert.equal(matrixKey(small), '51f95f785601715cbf571b2af5abb46950a922d1789f9a1640c8ed536780b24f');
  // 8 個遮罩都可以畫（唔會因為遮罩而爆），選擇最低罰分
  const big = Qr.encode('x'.repeat(400), { ecl: 'H' });
  assert.ok(big.mask >= 0 && big.mask <= 7);
  // 內容太長要明確報錯，唔可以出半截 QR
  assert.throws(() => Qr.encode('x'.repeat(5000), { ecl: 'H' }), /太長/);
});

test('QR：完整卡網址的矩陣沒有超過手機相機友善範圍（≤ 73×73）', () => {
  const progress = {};
  Bridge.CARD_ITEMS.forEach((id) => { progress[id] = '2026-06-01'; });
  const url = Bridge.cardUrl('https://roverbook.vercel.app', Bridge.encodeCard(Bridge.buildCard({ troopId: '0082', scoutId: SID, progress, awards: { L1: '2026-04-01' } }).card));
  const qr = Qr.encode(url, { ecl: 'M' });
  assert.ok(qr.size <= 73, '邊長 ' + qr.size);
});

// ---------- E. 接線（index.html／drop-in） ----------
test('前端：ROVERBOOK 對接有第 4 步、載入 QR 模組、只對領袖顯示結果', () => {
  assert.ok(indexHtml.includes('<script src="assets/roverbook-qr.js"></script>'));
  assert.ok(indexHtml.includes('<script src="assets/roverbook-bridge.js"></script>'));
  assert.ok(
    indexHtml.indexOf('<script src="assets/roverbook-bridge.js"></script>') <
    indexHtml.indexOf('<script src="assets/roverbook-qr.js"></script>'),
    '先載入 bridge 再載入 QR'
  );
  assert.ok(indexHtml.includes("['card', '📱 4 · 匯出 QR（交給成員）']"));
  for (const fn of ['function bookCardHtml', 'function bookCardGenerate', 'function bookBuildCardFor', 'function bookCardCopyLink']) {
    assert.ok(indexHtml.includes(fn), 'index.html 缺少 ' + fn);
  }
  // 領袖以外唔會見到產生器（伺服器端仍然係唯讀／冇新寫入 action）
  assert.match(indexHtml, /function bookCardHtml\(\) \{\s*if \(!bookIsLeader\(\)\)/);
  // 打印區 + 私隱說明（照抄給家長／成員）
  assert.ok(indexHtml.includes('class="print-area"'));
  assert.match(indexHtml, /QR 內只有旅團編號、SCOUT ID/);
  // 沒有任何新 apiRequest action（純前端產生，唔會多開一條後端寫入路）
  const cardSeg = indexHtml.slice(indexHtml.indexOf('function bookCardHtml'), indexHtml.indexOf('async function bookLoadRoster'));
  assert.ok(!/apiRequest\(/.test(cardSeg), '產生 QR 不應呼叫任何後端 action');
});

test('文件：QR 匯出有獨立文件，並在對接文件與 README 有入口', () => {
  const doc = read('docs/ROVERBOOK_QR_EXPORT.md');
  for (const k of ['RBC1', '#rb=', 'roverbadge.card.v1', 'jsQR', '個人資料', '匯入卡']) {
    assert.ok(doc.includes(k), '文件缺少 ' + k);
  }
  assert.match(read('docs/ROVERBOOK_BRIDGE.md'), /ROVERBOOK_QR_EXPORT\.md/);
  assert.match(read('README.md'), /匯出 QR|ROVERBOOK_QR_EXPORT/);
});

test('drop-in：ROVERBOOK 端拿到的模組同核心完全一致（卡格式唔會兩邊走樣）', () => {
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'roverbook-dropin.mjs')], { cwd: repoRoot, stdio: 'pipe' });
  const fixtures = JSON.parse(read('dist/roverbook/bridge-fixtures.json'));
  const card = Bridge.buildCard({
    troopId: '0082', scoutId: '1234567890', issuedAt: '2026-11-19',
    progress: { 'L1-ACT-01': '2026-03-01', 'L1-UND-01': '2026-03-02', 'L3-INT-01': '2026-05-05' },
    awards: { L1: '2026-04-01' }
  }).card;
  const token = Bridge.encodeCard(card);
  assert.equal(fixtures.card.token, token);
  assert.equal(fixtures.card.url, Bridge.cardUrl('https://roverbook.vercel.app', token));
  assert.deepEqual(fixtures.card.decoded, Bridge.decodeCard(token).card);
  assert.deepEqual(fixtures.card.pull.progress, card.progress);
  assert.equal(fixtures.card.pull.verified, true);
  assert.deepEqual(fixtures.card.itemIds, Bridge.CARD_ITEMS);
  assert.ok(!JSON.stringify(fixtures.card).includes('陳大文'));
  // PATCH.md 要講清楚 ROVERBOOK 端點樣接（唔係得個講字）
  const patch = read('dist/roverbook/PATCH.md');
  for (const k of ['#rb=', 'ImportCard', 'cardToPull', 'importFromRoverBadge']) {
    assert.ok(patch.includes(k), 'PATCH.md 缺少 ' + k);
  }
});
