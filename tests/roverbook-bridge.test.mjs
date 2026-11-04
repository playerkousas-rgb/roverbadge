// ============================================================
// ROVERBOOK 對接回歸測試（GS 5.4.0，2026-11-04）
//
// 產品決定（三條鐵律）：
//   ① 成員個人資料只留在成員自己的手機（電話／電郵／地址／相片／簽名墨跡永不入 BADGE）
//   ② ROVERBADGE 只記進度，方便領袖一次過統管
//   ③ 頒發只由領袖一次過做（bookAward 需可勾選權限），成員只收到唯讀結果
//
// 這裡同時驗：
//   A. 純邏輯（assets/roverbook-bridge.js）：剝個資、日期正規化、核簽／頒發格式
//   B. 後端（真跑 apps-script/Code.gs）：三張新表只存進度、個資永遠入唔到、權限、一次過頒發
//   C. 代理層：新 action 全部在白名單（書籤式前端呼叫唔會被 400 擋）
//
// 執行：node --test tests/roverbook-bridge.test.mjs
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCodeGs } from './gas-harness.mjs';
import { loadAssetModule, repoRoot } from './browser-module-harness.mjs';

const Bridge = loadAssetModule('assets/roverbook-bridge.js');
const codeSrc = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const proxySrc = fs.readFileSync(new URL('../api/proxy.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const SID = '1234567890';
const SID2 = '1234567891';
// 成員手機上一份「真實」的紀錄冊：滿載個資，用來證明剝得乾淨
function memberBook() {
  return {
    member: {
      nameZh: '陳大文', nameEn: 'Chan Tai Man', scoutId: SID, memberNo: SID,
      phone: '91234567', email: 'taiman@example.org', address: '香港仔某街 1 號',
      dob: '2008-01-02', photo: 'data:image/png;base64,PHOTO', bloodType: 'O+',
      emergencyName: '陳太', emergencyPhone: '98765432', group: '第 82 旅', crew: '海狸'
    },
    progress: {
      'L1-ACT-01': { date: '2026-03-01', assessor: '團長甲', signature: { png: 'SIG' } },
      'L1-UND-01': { date: '2026/3/2' },
      'L2-SKL-01': { date: '2026-04-05', assessor: '副團長乙' },
      'not-an-item': { date: '2026-04-06' },
      'L1-UND-02': { date: '2026-13-99' }
    },
    badges: { L1: { date: '2026-04-01' }, L2: { date: '' }, XX: { date: '2026-05-01' } },
    holderSignature: { png: 'HOLDERSIG' }
  };
}

// ---------- A. 純邏輯 ----------
test('bridge：只取 SCOUT ID／項目／日期，姓名、電話、電郵、地址、相片、簽名全部剝走', () => {
  const r = Bridge.fromRoverBook(memberBook());
  assert.equal(r.ok, true);
  assert.equal(r.scoutId, SID);
  assert.deepEqual(Object.keys(r.progress).sort(), ['L1-ACT-01', 'L1-UND-01', 'L2-SKL-01']);
  // 日期正規化：2026/3/2 → 2026-03-02；13 月 99 日 → 丟棄
  assert.equal(r.progress['L1-UND-01'], '2026-03-02');
  assert.equal(r.dropped.badItemId, 1, 'not-an-item 應被丟棄');
  assert.equal(r.dropped.badDate, 1, '2026-13-99 應被丟棄');
  // 輸出物件本身唔可以含任何個資值
  const json = JSON.stringify({ progress: r.progress, changes: r.changes, awards: r.awards, assessors: r.assessors });
  ['陳大文', 'Chan Tai Man', '91234567', 'taiman@example.org', '香港仔', '2008-01-02', 'PHOTO', 'SIG', 'HOLDERSIG', '98765432']
    .forEach(v => assert.ok(!json.includes(v), '輸出不可含個資：' + v));
  // 但要明確報告「剝走了什麼」，方便審核
  assert.ok(r.privacy.removedCount >= 10, 'privacy report 應列出剝走的欄位：' + JSON.stringify(r.privacy));
  for (const f of ['phone', 'email', 'photo', 'signature', 'holderSignature', 'dob']) {
    assert.ok(r.privacy.removedFields.includes(f), 'privacy report 缺少 ' + f);
  }
  // 頒發只取 L1…L4 且有日期
  assert.deepEqual(r.awards, { L1: '2026-04-01' });
});

test('bridge：ROVERBOOK 的 assessor（領袖姓名）只在該項目有進度時才帶', () => {
  const r = Bridge.fromRoverBook(memberBook());
  assert.equal(r.assessors['L1-ACT-01'], '團長甲');
  assert.equal(r.assessors['L2-SKL-01'], '副團長乙');
  assert.equal(r.assessors['not-an-item'], undefined);
});

test('bridge：核簽單格式 roverbadge.signoff.v2，唔會附上簽名墨跡', () => {
  const s = Bridge.buildSignoff({
    scoutId: SID, leaderName: '團長甲', leaderTitle: '樂行童軍團長', date: '2026-03-05',
    items: [
      { id: 'L1-ACT-01', date: '2026-03-01' },
      { id: 'L2-SKL-01', date: '2026-04-05' },
      { id: 'bad id', date: '2026-03-01' },
      { id: 'L1-UND-01', date: 'not-a-date' }
    ]
  });
  assert.equal(s.schema, Bridge.SCHEMA_SIGNOFF);
  assert.equal(s.items.length, 2);
  assert.equal(s.leader.ink, null, '回傳碼不得包含簽名墨跡');
  assert.equal(s.privacy.ink, 'withheld');
  const parsed = Bridge.parseSignoff(s);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.scoutId, SID);
  // 有墨跡的舊式核簽（帶 png）一樣可以解析，但唔會被回傳
  const legacy = { ...s, leader: { ...s.leader, png: 'data:image/png;base64,SIG' } };
  const parsed2 = Bridge.parseSignoff(legacy);
  assert.ok(!JSON.stringify(parsed2).includes('SIG'), '解析時不可帶出墨跡');
});

test('bridge：ROVERBADGE → ROVERBOOK 只匯出進度，唔會夾帶個資', () => {
  const out = Bridge.toRoverBook({
    troopId: '0082',
    progress: { [SID]: { 'L1-ACT-01': '2026-03-01', BAD: '2026-01-01' } },
    awards: { [SID]: { L1: '2026-04-01' } }
  }, { scoutId: SID });
  assert.equal(out.schema, Bridge.SCHEMA_PROGRESS_V2);
  assert.deepEqual(out.progress, { 'L1-ACT-01': '2026-03-01' });
  assert.deepEqual(out.awards, { L1: '2026-04-01' });
  assert.deepEqual(Object.keys(out).sort(), ['awards', 'exportedAt', 'privacy', 'progress', 'schema', 'scoutId', 'signoffs', 'source', 'troopId', 'v', 'verified', 'verifiedBy']);
  // 由 BADGE 匯出＝領袖核實過：BOOK 可以無條件採用（有 verified + 受信來源）
  assert.equal(out.verified, true);
  assert.ok(out.signoffs.every(x => x.verified === true && x.source === 'ROVERBADGE'));
});

test('bridge：sanitizeBridgePayload（代理層最後一道）只放行 scoutId／progress／grants', () => {
  const { payload } = Bridge.sanitizeBridgePayload({
    scoutId: SID, phone: '91234567', nameZh: '陳大文', photo: 'x',
    progress: { 'L1-ACT-01': '2026-03-01' },
    awards: [{ scoutId: SID, badgeId: 'L1', date: '2026-04-01' }]
  });
  assert.deepEqual(Object.keys(payload).sort(), ['grants', 'progress', 'scoutId']);
  assert.equal(payload.grants.length, 1);
});

// ---------- A2. 信任邊界（雙向） ----------
test('信任：BADGE → BOOK 只信領袖核實過的項目，未核實的不錄入', () => {
  const book = { progress: { 'L1-ACT-01': '2026-03-01' }, awards: {} };
  const exported = {
    schema: 'roverbadge.progress.roverbook.v2', verified: true,
    signoffs: [
      { id: 'L1-ACT-01', date: '2026-02-01', verified: true },   // 較舊 → 唔覆寫手機上的
      { id: 'L1-UND-01', date: '2026-04-01', verified: true },   // 新 → 錄入
      { id: 'L1-UND-02', date: '2026-04-02', verified: false }   // BADGE 都話未核實 → 唔錄入
    ],
    awards: { L1: '2026-05-01' }
  };
  const r = Bridge.applySignoff(book, exported);
  assert.equal(r.progress['L1-ACT-01'], '2026-03-01', '只加不減：較舊唔可以蓋走手機紀錄');
  assert.equal(r.progress['L1-UND-01'], '2026-04-01', '領袖核實過嘅新項目要錄入');
  assert.equal(r.progress['L1-UND-02'], undefined, 'BADGE 標示未核實 → 不錄入');
  assert.equal(r.awards.L1, '2026-05-01');
  assert.equal(r.applied, 1);
  assert.equal(r.kept, 1);
  assert.ok(r.notes.some(n => n.itemId === 'L1-UND-02'));
});

test('信任：BOOK → BADGE 一律唔信成員自稱 verified（只會變待批）', () => {
  const fake = {
    member: { scoutId: SID },
    progress: {
      // 成員自己偽造「領袖已簽」——連來源都照抄
      'L1-ACT-01': { date: '2026-03-01', verified: true, source: 'ROVERBADGE', assessor: '團長甲' },
      // 完全冇核實資料
      'L1-UND-01': '2026-03-02',
      // verification 子物件寫法
      'L1-UND-02': { date: '2026-03-03', verification: { by: '團長甲', source: 'roverbadge/signoff' } }
    }
  };
  const r = Bridge.fromRoverBook(fake);
  // 分類：有 trusted 來源＋verified 才算 leader-signed（仍然只係「BOOK 聲稱」）
  assert.deepEqual(Object.keys(r.verified), ['L1-ACT-01', 'L1-UND-02']);
  assert.deepEqual(Object.keys(r.claims), ['L1-UND-01']);
  // 但兩種都有 trust 標記，BADGE 端一律入待批，唔會自動完成
  const byId = Object.fromEntries(r.changes.map(c => [c.itemId, c.trust]));
  assert.equal(byId['L1-ACT-01'], Bridge.TRUST_BASIS.SIGNED_BY_LEADER);
  assert.equal(byId['L1-UND-01'], Bridge.TRUST_BASIS.MEMBER_CLAIM);
  // trustOf：冇來源嘅 verified 一律唔信
  assert.equal(Bridge.trustOf({ date: '2026-01-01', verified: true }).verified, false);
  assert.equal(Bridge.trustOf('2026-01-01').verified, false);
});

// ---------- B. 後端（真跑 Code.gs） ----------
function leaderEnv() {
  const env = loadCodeGs();
  env.api.initializeSheets();
  const login = env.call({ action: 'login', login_id: '1111111111', password: 'changeme' });
  assert.equal(login.success, true, JSON.stringify(login));
  const add = env.call({
    action: 'addUser', token: login.token, ymis: SID, name: '陳大文',
    email: 'taiman@example.org', role: 'member', password: 'Member!1234'
  });
  assert.equal(add.success, true, JSON.stringify(add));
  // 第二位成員（測試多成員一次過頒發）
  env.call({
    action: 'addUser', token: login.token, ymis: SID2, name: '李小明',
    email: 'siuming@example.org', role: 'member', password: 'Member!1234'
  });
  return { env, token: login.token };
}

test('後端：initializeSheets 建立「紀錄冊核簽／紀錄冊頒發」而且沒有任何個資欄位', () => {
  const { env } = leaderEnv();
  for (const name of ['紀錄冊核簽', '紀錄冊頒發']) {
    const sh = env.ss.sheets.get(name);
    assert.ok(sh, '缺少工作表 ' + name);
    const header = sh.rows[0].join('|');
    for (const bad of ['電話', '電郵', 'email', 'phone', '地址', '相片', 'photo', '簽名']) {
      assert.ok(!header.includes(bad), name + ' 表頭不應有個人資料欄位：' + bad);
    }
  }
});

test('後端 bookSync：只入「紀錄冊待批」，個資一律唔會入表（包括請求夾帶）', () => {
  const { env, token } = leaderEnv();
  const book = memberBook();
  const r = env.call({
    action: 'bookSync', token,
    scoutId: SID,
    progress: {
      'L1-ACT-01': '2026-03-01',
      'L1-UND-01': { date: '2026-03-02', assessor: '團長甲' },
      'L1-UND-02': '2026-13-99',        // 壞日期
      'hack-item': '2026-03-01'          // 唔像項目 ID
    },
    // 惡意／不小心夾帶的個資
    member: book.member, phone: book.member.phone, photo: book.member.photo,
    holderSignature: book.holderSignature, nameZh: book.member.nameZh
  });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.staged, 2, '只應有 2 項有效進度入待批');
  assert.equal(r.needsConfirm, true);
  assert.ok(r.rejected.length >= 2, '壞項目／壞日期要被拒絕：' + JSON.stringify(r.rejected));
  assert.ok(r.privacy.removedCount >= 5, '應報告剝走的個資欄位：' + JSON.stringify(r.privacy));

  // ★ 關鍵：成員交上嚟嘅資料**唔可以**變成正式進度或核簽
  assert.deepEqual(r.progress, {}, 'BOOK 交上嚟唔可以當成已完成');
  assert.equal((env.ss.sheets.get('紀錄冊核簽').rows.length), 1, '核簽表仍只有表頭（未 CONFIRM）');
  assert.equal((env.ss.sheets.get('進度追蹤').rows.length), 1, '進度追蹤仍只有表頭（未 CONFIRM）');
  assert.equal(env.ss.sheets.get('紀錄冊待批').rows.length, 3, '表頭 + 2 筆待批');
  assert.deepEqual(r.pending, { 'L1-ACT-01': '2026-03-01', 'L1-UND-01': '2026-03-02' });

  // 只檢查「由 ROVERBOOK 寫入」的四張表；Users 表的電郵是領袖自己開戶時填的，與 ROVERBOOK 無關
  const dump = ['紀錄冊待批', '紀錄冊核簽', '紀錄冊頒發', '進度追蹤']
    .map(n => { const sh = env.ss.sheets.get(n); return sh ? n + '\n' + sh.rows.map(r2 => r2.join('\u0001')).join('\n') : ''; }).join('\n');
  for (const v of [book.member.phone, book.member.email, book.member.address, book.member.dob,
    book.member.emergencyName, book.member.emergencyPhone, 'PHOTO', 'HOLDERSIG']) {
    assert.ok(!dump.includes(v), '試算表不可含成員個資：' + v);
  }
  // 但 SCOUT ID、項目、日期要寫入（領袖要一次過統管）
  assert.ok(dump.includes(SID) && dump.includes('L1-ACT-01') && dump.includes('2026-03-01'));
});

test('後端 bookSync：BOOK 自稱「領袖已簽」都只入待批，唔會自動完成', () => {
  const { env, token } = leaderEnv();
  const r = env.call({
    action: 'bookSync', token, scoutId: SID,
    progress: {
      'L1-ACT-01': { date: '2026-03-01', verified: true, source: 'ROVERBADGE', assessor: '團長甲' },
      'L1-UND-01': { date: '2026-03-02' }
    }
  });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.staged, 2, '兩項都要入待批');
  assert.equal(r.leaderSignedCount, 1, 'BOOK 聲稱領袖已簽的一項要標示出來（方便領袖快速確認）');
  assert.equal(r.memberClaimCount, 1);
  assert.deepEqual(r.progress, {}, '無論聲稱與否，都唔會自動變成完成');
  assert.equal(env.ss.sheets.get('進度追蹤').rows.length, 1, '進度追蹤仍然只有表頭');
  const pend = env.call({ action: 'bookPending', token, scoutId: SID });
  const t = Object.fromEntries(pend.pending.map(x => [x.itemId, x.trust]));
  assert.equal(t['L1-ACT-01'], 'leader-signed');
  assert.equal(t['L1-UND-01'], 'member-claim');
  // 冇 verified 欄位／來源唔受信 → member-claim
  const r2 = env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-UND-02': { date: '2026-03-03', verified: true, source: 'my-own-phone' } } });
  assert.equal(r2.memberClaimCount, 1);
});

test('後端 bookConfirm：領袖 CONFIRM 之後才寫入正式進度，並產生核簽', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01', 'L1-UND-01': '2026-03-02' } });
  const pend = env.call({ action: 'bookPending', token, scoutId: SID });
  assert.equal(pend.count, 2, JSON.stringify(pend));
  // 只批准其中一項
  const r1 = env.call({ action: 'bookConfirm', token, pendingIds: [pend.pending[0].pendingId] });
  assert.equal(r1.success, true, JSON.stringify(r1));
  assert.equal(r1.approved, 1);
  const prog1 = env.call({ action: 'bookRoster', token }).members[SID] || {};
  assert.equal(Object.keys(prog1).length, 1, '只應入帳已確認的一項');
  // 再一次過批准其餘
  const r2 = env.call({ action: 'bookConfirm', token, scoutId: SID });
  assert.equal(r2.approved, 1);
  const prog2 = env.call({ action: 'bookRoster', token }).members[SID];
  assert.deepEqual(prog2, { 'L1-ACT-01': '2026-03-01', 'L1-UND-01': '2026-03-02' });
  const signoffs = env.ss.sheets.get('紀錄冊核簽').rows.slice(1);
  assert.equal(signoffs.length, 2, 'CONFIRM 才寫核簽（成員自己簽唔算）');
  assert.equal(env.call({ action: 'bookPending', token, scoutId: SID }).count, 0, '待批清單應清空');
});

test('後端 bookConfirm：較舊日期唔會回寫（只加不減），領袖可選擇覆寫', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'save', token, changes: [{ ymis: SID, itemId: 'L1-ACT-01', date: '2026-06-01' }] });
  const sync = env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
  assert.equal(sync.staged, 0, '較舊日期唔應入待批：' + JSON.stringify(sync));
  assert.equal(sync.older.length, 1);
  assert.equal(sync.older[0].existing, '2026-06-01');
  // 就算有人手動把舊日期塞入待批，CONFIRM 都會守住（預設不覆寫）
  const sh = env.ss.sheets.get('紀錄冊待批');
  sh.appendRow(['BP_manual', SID, 'L1-ACT-01', '2026-03-01', 'ROVERBOOK', '', 'pending', 'older', '', '', '', '']);
  const c = env.call({ action: 'bookConfirm', token, pendingIds: ['BP_manual'] });
  assert.equal(c.approved, 0, '預設唔可以蓋走較後日期');
  assert.equal((env.call({ action: 'bookRoster', token }).members[SID])['L1-ACT-01'], '2026-06-01');
  // 領袖明確 overwrite 才可以改（「可以改」）
  sh.appendRow(['BP_manual2', SID, 'L1-ACT-01', '2026-03-01', 'ROVERBOOK', '', 'pending', 'older', '', '', '', '']);
  const c2 = env.call({ action: 'bookConfirm', token, pendingIds: ['BP_manual2'], overwrite: true });
  assert.equal(c2.approved, 1);
  assert.equal((env.call({ action: 'bookRoster', token }).members[SID])['L1-ACT-01'], '2026-03-01');
});

test('後端 bookConfirm：成員無權確認（唔可以自己批自己）', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
  const m = env.call({ action: 'login', login_id: SID, password: 'Member!1234' });
  const pid = env.call({ action: 'bookPending', token, scoutId: SID }).pending[0].pendingId;
  const r = env.call({ action: 'bookConfirm', token: m.token, pendingIds: [pid] });
  assert.equal(r.success, false);
  assert.match(r.error, /權限不足/);
  // 成員亦只可以讀自己的待批
  const other = env.call({ action: 'bookPending', token: m.token, scoutId: SID2 });
  assert.equal(other.success, false);
  assert.equal(env.call({ action: 'bookRoster', token }).members[SID], undefined, '未 CONFIRM 前不可見於進度一覽');
});

test('後端 bookSync：未知／已停用項目、壞日期一律拒絕（防止亂寫進度）', () => {
  const { env, token } = leaderEnv();
  const r = env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L9-XYZ-99': '2026-01-01', '': '2026-01-01', 'L1-ACT-01': '2026-99-99' } });
  assert.equal(r.success, true);
  assert.equal(r.staged, 0);
  assert.equal(Object.keys(r.progress).length, 0);
  assert.equal(env.ss.sheets.get('紀錄冊待批').rows.length, 1, '冇有效項目就唔應有待批列');
});

test('後端 bookSync／bookAward：成員無權（需要可勾選的領袖）', () => {
  const { env } = leaderEnv();
  const m = env.call({ action: 'login', login_id: SID, password: 'Member!1234' });
  assert.equal(m.success, true);
  for (const action of ['bookRoster', 'bookSync', 'bookAward']) {
    const r = env.call({ action, token: m.token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' }, awards: [{ scoutId: SID, badgeId: 'L1', date: '2026-04-01' }] });
    assert.equal(r.success, false, action + ' 應拒絕成員：' + JSON.stringify(r));
    assert.match(r.error, /權限不足/);
  }
});

test('後端 bookAward：一次過頒發多成員多獎章，重複唔會寫第二次', () => {
  const { env, token } = leaderEnv();
  const awards = [
    { scoutId: SID, badgeId: 'L1', date: '2026-04-01' },
    { scoutId: SID, badgeId: 'L2', date: '2026-05-01' },
    { scoutId: SID2, badgeId: 'L1', date: '2026-04-02' },
    { scoutId: SID, badgeId: 'X9', date: '2026-04-01' }, // 壞獎章
    { scoutId: SID, badgeId: 'L3', date: '01/04/2026' }  // 壞日期
  ];
  const r1 = env.call({ action: 'bookAward', token, awards });
  assert.equal(r1.success, true, JSON.stringify(r1));
  assert.equal(r1.written, 3);
  assert.equal(r1.skipped, 2);
  const r2 = env.call({ action: 'bookAward', token, awards });
  assert.equal(r2.written, 0, '重複頒發唔可以再寫一次');
  assert.equal(r2.skipped, 5);
  const sheet = env.ss.sheets.get('紀錄冊頒發');
  assert.equal(sheet.rows.length, 4, '表頭 + 3 筆');
});

test('後端 bookPull：只回自己（token 身分），冇個資；bookRoster 給領袖零個資一覽', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
  env.call({ action: 'bookConfirm', token, scoutId: SID });
  env.call({ action: 'bookAward', token, awards: [{ scoutId: SID, badgeId: 'L1', date: '2026-04-01' }] });

  const m = env.call({ action: 'login', login_id: SID, password: 'Member!1234' });
  assert.equal(m.success, true);
  const pull = env.call({ action: 'bookPull', token: m.token });
  assert.equal(pull.success, true, JSON.stringify(pull));
  assert.equal(pull.scoutId, SID);
  assert.deepEqual(pull.awards, { L1: '2026-04-01' });
  // 核簽（成員交上嚟、領袖已簽）本身就是成員的完成紀錄；正式「進度追蹤」有紀錄時以它為準
  assert.equal(pull.progress['L1-ACT-01'], '2026-03-01');
  assert.ok(pull.signoffs.some(x => x.id === 'L1-ACT-01'), '但核簽本身要回給成員（貼回 ROVERBOOK）');
  // BOOK 側只可以「無條件相信」verifiedInBadge（全部由領袖行為產生）
  assert.equal(pull.verified, true);
  assert.equal(pull.verifiedInBadge['L1-ACT-01'], '2026-03-01');
  assert.ok(pull.signoffs.length >= 1);
  // 唔可以含任何個資
  const json = JSON.stringify(pull);
  for (const v of ['taiman@example.org', '陳大文']) assert.ok(!json.includes(v), 'bookPull 不可回個資：' + v);

  const roster = env.call({ action: 'bookRoster', token });
  assert.equal(roster.success, true);
  // 領袖用正式「進度追蹤」寫一筆後，roster 就看得到
  env.call({ action: 'save', token, changes: [{ ymis: SID, itemId: 'L1-ACT-01', date: '2026-03-01' }] });
  const roster2 = env.call({ action: 'bookRoster', token });
  assert.deepEqual(roster2.members[SID], { 'L1-ACT-01': '2026-03-01' });
  assert.equal(roster.privacy.personalData, 'none');
  assert.ok(!JSON.stringify(roster).includes('陳大文'), 'bookRoster 不可含姓名');
});

test('後端：核簽日期只可以向後（唔會被舊日期蓋走）', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-06-01' } });
  env.call({ action: 'bookConfirm', token, scoutId: SID });
  // 成員改細日期再交（想「扮」舊日期）→ 唔會入待批，亦唔會蓋走核簽
  const s2 = env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
  assert.equal(s2.staged, 0);
  const sh = env.ss.sheets.get('紀錄冊核簽');
  const row = sh.rows.find(r => String(r[1]) === SID && String(r[2]) === 'L1-ACT-01');
  assert.ok(row, '應有核簽列');
  assert.equal(row[3], '2026-06-01', '較早的日期唔可以蓋走既有核簽');
});

test('後端：選單有「📖 ROVERBOOK 對接狀態」，且狀態只計數字、不含個資', () => {
  const { env } = leaderEnv();
  env.api.onOpen();
  const labels = env.menuItems.map(m => m.label).join('|');
  assert.match(labels, /ROVERBOOK 對接狀態/);
  env.call({ action: 'bookSync', token: env.call({ action: 'login', login_id: '1111111111', password: 'changeme' }).token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
  const text = env.api.menuBookStatus();
  assert.match(text, /紀錄冊核簽/);
  assert.ok(!text.includes('陳大文'), '狀態訊息不可含姓名');
});

// ---------- B2. 撤回／更正／打錯編號（2026-11-05 審計修正的回歸） ----------
test('撤回（BUG 修正）：領袖取消完成後，bookPull／bookRoster 都唔可以再由核簽補回', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
  env.call({ action: 'bookConfirm', token, scoutId: SID });
  assert.equal((env.call({ action: 'bookRoster', token }).members[SID])['L1-ACT-01'], '2026-03-01');
  // 領袖在「我的進度」取消完成
  env.call({ action: 'save', token, changes: [{ ymis: SID, itemId: 'L1-ACT-01', uncomplete: true }] });
  const m = env.call({ action: 'login', login_id: SID, password: 'Member!1234' });
  const pull = env.call({ action: 'bookPull', token: m.token });
  assert.equal(pull.progress['L1-ACT-01'], undefined, '撤回後唔可以仍然回報已完成（否則 BOOK 會重新採用）');
  assert.ok(!pull.signoffs.some(x => x.id === 'L1-ACT-01'), '撤回後唔可以再宣稱核簽已核實');
  assert.deepEqual(pull.verifiedInBadge, {});
  assert.deepEqual(pull.withdrawn, ['L1-ACT-01'], '要明確告知 BOOK 移除');
  assert.equal(env.call({ action: 'bookRoster', token }).members[SID], undefined);
});

test('撤回（BOOK 側）：applySignoff 會依 withdrawn 移除完成紀錄', () => {
  const r = Bridge.applySignoff(
    { progress: { 'L1-ACT-01': '2026-03-01', 'L1-UND-01': '2026-03-02' }, awards: {} },
    { verified: true, signoffs: [{ id: 'L1-UND-01', date: '2026-03-02', verified: true }], withdrawn: ['L1-ACT-01'] }
  );
  assert.equal(r.progress['L1-ACT-01'], undefined, '領袖撤回 → BOOK 要移除');
  assert.equal(r.progress['L1-UND-01'], '2026-03-02');
  assert.deepEqual(r.removed, ['L1-ACT-01']);
  assert.ok(r.notes.some(n => /撤回/.test(n.reason)));
});

test('打錯編號（BUG 修正）：不存在的 SCOUT ID 唔可以寫待批或頒發（整批拒絕，唔會半寫）', () => {
  const { env, token } = leaderEnv();
  const bad = '9999999999';
  const r1 = env.call({ action: 'bookSync', token, scoutId: bad, progress: { 'L1-ACT-01': '2026-03-01' } });
  assert.equal(r1.success, false);
  assert.equal(r1.unknownScoutId, bad);
  assert.equal(env.ss.sheets.get('紀錄冊待批').rows.length, 1, '唔可以留低幽靈待批');
  const r2 = env.call({ action: 'bookAward', token, awards: [
    { scoutId: SID, badgeId: 'L1', date: '2026-04-01' },
    { scoutId: bad, badgeId: 'L2', date: '2026-04-01' }
  ] });
  assert.equal(r2.success, false, '有未知成員 → 整批拒絕');
  assert.deepEqual(r2.unknownScoutId, [bad]);
  assert.equal(env.ss.sheets.get('紀錄冊頒發').rows.length, 1, '唔可以半寫（連第一位都唔寫）');
  // 已在「成員名單」的成員（未開戶）仍然可以收
  env.call({ action: 'addMember', token, ymis: '1234567899', name: '未開戶成員' });
  const r3 = env.call({ action: 'bookSync', token, scoutId: '1234567899', progress: { 'L1-ACT-01': '2026-03-01' } });
  assert.equal(r3.success, true, JSON.stringify(r3));
});

test('頒發更正／撤回（BUG 修正）：預設永不改，領袖明確 confirm 才改或刪', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'bookAward', token, awards: [{ scoutId: SID, badgeId: 'L2', date: '2026-04-01' }] });
  // 預設：唔可以改
  const r1 = env.call({ action: 'bookAward', token, awards: [{ scoutId: SID, badgeId: 'L2', date: '2026-05-01', correct: true }] });
  assert.equal(r1.corrected, 0, '冇 confirm 唔可以更正');
  assert.equal(env.call({ action: 'bookPull', token: env.call({ action: 'login', login_id: SID, password: 'Member!1234' }).token }).awards.L2, '2026-04-01');
  // 明確 confirm：可以更正錯日期
  const r2 = env.call({ action: 'bookAward', token, confirm: true, awards: [{ scoutId: SID, badgeId: 'L2', date: '2026-05-01', correct: true }] });
  assert.equal(r2.corrected, 1, JSON.stringify(r2));
  const award = env.ss.sheets.get('紀錄冊頒發').rows.find(x => x[0] === SID && x[1] === 'L2');
  assert.equal(award[2], '2026-05-01');
  assert.match(String(award[6]), /更正頒發日期（原 2026-04-01）/);
  // 撤回：需要 confirm
  const r3 = env.call({ action: 'bookAward', token, awards: [{ scoutId: SID, badgeId: 'L2', date: '2026-05-01', remove: true }] });
  assert.equal(r3.removed, 0);
  const r4 = env.call({ action: 'bookAward', token, confirm: true, awards: [{ scoutId: SID, badgeId: 'L2', date: '2026-05-01', remove: true }] });
  assert.equal(r4.removed, 1);
  assert.equal(env.ss.sheets.get('紀錄冊頒發').rows.length, 1, '只剩表頭');
});

test('bookConfirm 範圍（BUG 修正）：冇指明 pendingIds／scoutId 就唔准確認（要 all:true）', () => {
  const { env, token } = leaderEnv();
  env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
  env.call({ action: 'bookSync', token, scoutId: SID2, progress: { 'L1-ACT-01': '2026-03-02' } });
  const r = env.call({ action: 'bookConfirm', token });
  assert.equal(r.success, false, '唔可以無範圍就掃全團');
  assert.match(r.error, /pendingIds|scoutId|all/);
  assert.equal(env.ss.sheets.get('進度追蹤').rows.length, 1, '一項都唔可以寫入');
  const ok = env.call({ action: 'bookConfirm', token, all: true });
  assert.equal(ok.approved, 2, '明確 all:true 才一次過確認全部');
});

test('端到端往返：成員手機 → 待批 → 領袖 CONFIRM → 取回 → BOOK 採用（偽造／舊資料都擋住）', () => {
  const { env, token } = leaderEnv();
  // A. 成員手機：自己標記一項
  const book = { progress: { 'L1-ACT-01': '2026-03-05' }, awards: {} };
  const parsed = Bridge.fromRoverBook({
    member: { scoutId: SID, nameZh: '陳大文', phone: '91234567' },
    progress: book.progress
  });
  assert.deepEqual(Object.keys(parsed.claims), ['L1-ACT-01']);
  // B. 交上 BADGE → 只入待批
  const sync = env.call({ action: 'bookSync', token, scoutId: SID, progress: parsed.progress });
  assert.equal(sync.staged, 1);
  assert.equal(env.ss.sheets.get('進度追蹤').rows.length, 1);
  // C. 領袖 CONFIRM（指明範圍）
  assert.equal(env.call({ action: 'bookConfirm', token, scoutId: SID }).approved, 1);
  // D. 成員取回 → BOOK 採用（BOOK 無條件相信已核實）
  const m = env.call({ action: 'login', login_id: SID, password: 'Member!1234' });
  const pull = env.call({ action: 'bookPull', token: m.token });
  const merged = Bridge.applySignoff(book, pull);
  assert.equal(merged.progress['L1-ACT-01'], '2026-03-05');
  assert.equal(merged.applied, 0, '手機已有同一日 → kept（只加不減）');
  assert.equal(merged.kept, 1);
  // E. 成員偽造「領袖已簽」→ 仍然只入待批，唔會完成
  const fake = Bridge.fromRoverBook({
    member: { scoutId: SID },
    progress: { 'L1-UND-01': { date: '2026-06-01', verified: true, source: 'ROVERBADGE' } }
  });
  assert.equal(fake.verifiedCount, 1);
  env.call({ action: 'bookSync', token, scoutId: SID, progress: fake.progress, trusts: fake.trusts });
  const roster = env.call({ action: 'bookRoster', token });
  assert.equal(roster.members[SID]['L1-UND-01'], undefined, '未 CONFIRM 唔可以出現');
  assert.ok(roster.pending.some(x => x.itemId === 'L1-UND-01' && x.trust === 'leader-signed'),
    '前端送出的 trust 標記要保留：' + JSON.stringify(roster.pending));
  // F. 舊備份（較早日期）→ 唔入待批、唔會倒流
  const older = Bridge.fromRoverBook({ member: { scoutId: SID }, progress: { 'L1-ACT-01': '2026-01-01' } });
  const s2 = env.call({ action: 'bookSync', token, scoutId: SID, progress: older.progress });
  assert.equal(s2.staged, 0);
  assert.deepEqual(s2.older, [{ itemId: 'L1-ACT-01', date: '2026-01-01', existing: '2026-03-05' }]);
  assert.equal(env.call({ action: 'bookRoster', token }).members[SID]['L1-ACT-01'], '2026-03-05');
  // G. 領袖頒發 → 成員取回 → BOOK 採用；另一位成員見唔到
  env.call({ action: 'bookAward', token, awards: [{ scoutId: SID, badgeId: 'L1', date: '2026-04-01' }] });
  assert.deepEqual(Bridge.applySignoff(merged, env.call({ action: 'bookPull', token: m.token })).awards, { L1: '2026-04-01' });
  const m2 = env.call({ action: 'login', login_id: SID2, password: 'Member!1234' });
  const p2 = env.call({ action: 'bookPull', token: m2.token });
  assert.equal(p2.scoutId, SID2);
  assert.deepEqual(p2.progress, {});
  assert.deepEqual(p2.awards, {});
});

test('信任標記傳遞（BUG 修正）：bridge 的 trusts 要送得到 BADGE，唔會被壓成 member-claim', () => {
  const { env, token } = leaderEnv();
  const parsed = Bridge.fromRoverBook({
    member: { scoutId: SID },
    progress: {
      'L1-ACT-01': { date: '2026-03-01', verified: true, source: 'ROVERBADGE' }, // BOOK 聲稱領袖簽過
      'L1-UND-01': '2026-03-02'                                                    // 成員自己標記
    }
  });
  assert.deepEqual(parsed.trusts, { 'L1-ACT-01': 'leader-signed', 'L1-UND-01': 'member-claim' });
  // 前端必須把 trusts 一齊送出（progress 只有日期字串，唔會自帶信任資訊）
  assert.match(indexHtml, /trusts: parsed\.trusts/, '前端要送 trusts');
  const r = env.call({ action: 'bookSync', token, scoutId: SID, progress: parsed.progress, trusts: parsed.trusts });
  assert.equal(r.leaderSignedCount, 1);
  assert.equal(r.memberClaimCount, 1);
  const pend = env.call({ action: 'bookPending', token, scoutId: SID });
  const t = Object.fromEntries(pend.pending.map(x => [x.itemId, x.trust]));
  assert.equal(t['L1-ACT-01'], 'leader-signed');
  assert.equal(t['L1-UND-01'], 'member-claim');
  // 就算 trusts 缺失／亂填，都只影響顯示，一樣入待批、一樣要 CONFIRM
  const r2 = env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-UND-02': '2026-03-03' }, trusts: { 'L1-UND-02': 'whatever' } });
  assert.equal(r2.staged, 1);
  assert.equal(r2.memberClaimCount, 1);
  assert.deepEqual(r2.progress, {}, 'trust 標記唔可以令任何項目自動完成');
});

// ---------- C. 代理層／前端接線 ----------
test('前後端契約：前端每個 book* 呼叫都有後端處理，反之亦然（唔會靜靜哋 400／Unknown action）', () => {
  const calls = new Set([...indexHtml.matchAll(/apiRequest\('(book[A-Za-z]+)'/g)].map(m => m[1]));
  assert.ok(calls.size >= 4, '前端至少要有接收／確認／頒發／取回：' + [...calls].join(','));
  for (const a of calls) {
    assert.ok(new RegExp(`action ?=== ?'${a}'`).test(codeSrc), 'Code.gs 缺少 handler 路由：' + a);
    assert.ok(proxySrc.includes(`'${a}'`), 'api/proxy.js 白名單缺少：' + a);
  }
  // 後端有、但前端未用（例如 bookRoster 由舊路徑呼叫）都要在白名單
  for (const a of ['bookRoster', 'bookSync', 'bookConfirm', 'bookPending', 'bookAward', 'bookPull']) {
    assert.ok(new RegExp(`action ?=== ?'${a}'`).test(codeSrc), 'Code.gs 缺少：' + a);
    assert.ok(proxySrc.includes(`'${a}'`), 'proxy 缺少：' + a);
  }
  // 防止回退：bookSync 唔可以直接寫正式進度
  const sync = codeSrc.slice(codeSrc.indexOf('function handleBookSync'), codeSrc.indexOf('function handleBookConfirm'));
  assert.ok(!/bookWriteProgress_/.test(sync), 'bookSync 唔可以直接寫「進度追蹤」（必須經 bookConfirm）');
  assert.ok(!/writeBookSignoffs_/.test(sync), 'bookSync 唔可以直接寫核簽（必須經 bookConfirm）');
  assert.match(indexHtml, /function bookConfirmSelected\(/, '前端要有逐項確認');
  assert.match(indexHtml, /function bookConfirmAll\(/, '前端要有一次過確認');
  assert.match(indexHtml, /all: !!all/, '「全部確認」必須明確帶 all:true');
  assert.match(indexHtml, /bookAwardCorrect/, '頒發要有更正日期控制');
  assert.match(indexHtml, /bookAwardRemove/, '頒發要有撤回控制');
  assert.match(indexHtml, /function bookConfirmLeaderSigned\(/, '前端要可以只確認 BOOK 顯示已簽的');
  // BOOK 信任度要顯示在待批表格（領袖要分得出邊項係成員自己標記）
  assert.match(indexHtml, /BOOK 信任度/);
  assert.match(indexHtml, /leader-signed/);
  // GAS：待批一律 pending（唔可以因為 BOOK 聲稱 verified 就跳過）
  const stage = codeSrc.slice(codeSrc.indexOf('function stageBookPending_'), codeSrc.indexOf('function bookProgressOf_'));
  assert.ok(!/APPROVED/.test(stage), 'stageBookPending_ 唔可以直接批准（只可以寫 pending）');
});

test('proxy：四個 ROVERBOOK action 都在 TOKEN_ACTIONS（前端呼叫唔會被擋）', () => {
  const m = proxySrc.match(/const TOKEN_ACTIONS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m);
  for (const a of ['bookRoster', 'bookSync', 'bookAward', 'bookPull']) {
    assert.ok(m[1].includes(`'${a}'`), 'TOKEN_ACTIONS 缺少 ' + a);
    assert.ok(indexHtml.includes(`apiRequest('${a}'`), 'index.html 未接 ' + a);
  }
  // 上游 sig 直通亦要涵蓋（支部節點一次過統管）
  assert.ok(/LINK_SIG_READ_ACTIONS[\s\S]{0,400}'bookRoster'/.test(codeSrc));
  assert.ok(/LINK_SIG_WRITE_ACTIONS[\s\S]{0,900}'bookAward'/.test(codeSrc));
});

test('前端：載入 bridge 模組、有 ROVERBOOK 分頁、成員預設見唔到', () => {
  assert.ok(indexHtml.includes('<script src="assets/roverbook-bridge.js"></script>'));
  assert.ok(indexHtml.includes('id="btn-tab-book"'));
  assert.ok(indexHtml.includes('id="tab-book"'));
  assert.ok(indexHtml.includes("setNavTabVisible('book'"));
  assert.ok(fs.existsSync(new URL('../assets/roverbook-bridge.js', import.meta.url)));
  // 鐵律寫在 UI 上（唔靠使用者自律）
  assert.match(indexHtml, /個人資料.*留在成員自己部機|個資.*剝走/);
});

test('docs：對接文件說明三條鐵律與格式版本', () => {
  const doc = fs.readFileSync(new URL('../docs/ROVERBOOK_BRIDGE.md', import.meta.url), 'utf8');
  for (const k of ['roverbook/signoff@1', 'roverbadge.award.v1', 'roverbadge.progress.roverbook.v2', '個資', 'bookSync', 'bookAward', 'bookPull']) {
    assert.ok(doc.includes(k), '文件缺少 ' + k);
  }
  assert.match(doc, /唔會.*上傳|不會上傳|只留.*手機/);
});

test('工具：drop-in 生成物真係可以 import，且同核心規則一致（唔會走樣）', async () => {
  const script = new URL('../scripts/roverbook-dropin.mjs', import.meta.url);
  assert.ok(fs.existsSync(script));
  execFileSync(process.execPath, [fileURLToPath(script)], { cwd: repoRoot, stdio: 'pipe' });
  const gen = path.join(repoRoot, 'dist', 'roverbook', 'roverbadge-bridge.mjs');
  const fixturesPath = path.join(repoRoot, 'dist', 'roverbook', 'bridge-fixtures.json');
  assert.ok(fs.existsSync(gen) && fs.existsSync(fixturesPath));
  const mod = await import('file://' + gen);
  const B = mod.default;
  assert.equal(B.BRIDGE_VERSION, Bridge.BRIDGE_VERSION);
  // 同一個輸入，核心與 drop-in 要得出同一個輸出（跨 repo 唔會走樣）
  assert.deepEqual(B.fromRoverBook(memberBook()), Bridge.fromRoverBook(memberBook()));
  // fixtures 的 payload 部分唔可以含個資；個資值只准出現在 forbiddenValues（ROVERBOOK 端拿去做斷言）
  const fx = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const payloadOnly = JSON.stringify({ ...fx, forbiddenValues: undefined });
  for (const v of ['陳大文', '91234567', 'taiman@example.org', 'PHOTO', 'HOLDERSIG']) {
    assert.ok(!payloadOnly.includes(v), 'fixtures payload 不可含個資：' + v);
    assert.ok(fx.forbiddenValues.includes(v) || v === '陳大文', 'forbiddenValues 應列出要擋的值：' + v);
  }
  assert.ok(fs.readFileSync(path.join(repoRoot, 'dist', 'roverbook', 'PATCH.md'), 'utf8').includes('bookAward'));
});
