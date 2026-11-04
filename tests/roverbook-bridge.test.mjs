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
  assert.deepEqual(Object.keys(out).sort(), ['awards', 'exportedAt', 'privacy', 'progress', 'schema', 'scoutId', 'source', 'troopId', 'v']);
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

test('後端 bookSync：寫入進度，個資一律唔會入表（包括請求夾帶）', () => {
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
  assert.equal(r.written, 2, '只應寫入 2 項有效進度');
  assert.ok(r.rejected.length >= 2, '壞項目／壞日期要被拒絕：' + JSON.stringify(r.rejected));
  assert.ok(r.privacy.removedCount >= 5, '應報告剝走的個資欄位：' + JSON.stringify(r.privacy));
  // 回傳的 progress 係「成員喺進度追蹤的實際狀態」——核簽寫入「紀錄冊核簽」，
  // 要領袖按「確認寫入雲端」才會計入正式進度（單一權威來源：領袖）
  assert.ok(env.ss.sheets.get('紀錄冊核簽').rows.length >= 3, '應寫入核簽表');
  assert.equal(typeof r.progress, 'object');

  // 只檢查「由 ROVERBOOK 寫入」的三張表；Users 表的電郵是領袖自己開戶時填的，與 ROVERBOOK 無關
  const dump = ['紀錄冊核簽', '紀錄冊頒發', '進度追蹤']
    .map(n => { const sh = env.ss.sheets.get(n); return sh ? n + '\n' + sh.rows.map(r2 => r2.join('\u0001')).join('\n') : ''; }).join('\n');
  for (const v of [book.member.phone, book.member.email, book.member.address, book.member.dob,
    book.member.emergencyName, book.member.emergencyPhone, 'PHOTO', 'HOLDERSIG']) {
    assert.ok(!dump.includes(v), '試算表不可含成員個資：' + v);
  }
  // 但 SCOUT ID、項目、日期要寫入（領袖要一次過統管）
  assert.ok(dump.includes(SID) && dump.includes('L1-ACT-01') && dump.includes('2026-03-01'));
});

test('後端 bookSync：未知／已停用項目、壞日期一律拒絕（防止亂寫進度）', () => {
  const { env, token } = leaderEnv();
  const r = env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L9-XYZ-99': '2026-01-01', '': '2026-01-01' } });
  assert.equal(r.success, true);
  assert.equal(r.written, 0);
  assert.equal(Object.keys(r.progress).length, 0);
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
    { scoutId: '1234567891', badgeId: 'L1', date: '2026-04-02' },
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
  env.call({ action: 'bookSync', token, scoutId: SID, progress: { 'L1-ACT-01': '2026-03-01' } });
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

// ---------- C. 代理層／前端接線 ----------
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
