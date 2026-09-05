// ===== 批量開戶 Apps Script（直接寫入旅團主資料表版本）=====
// 適用：你已有一份旅團「主資料表」（即 RoverBadge 後端 apps-script/Code.gs 所用的 Google Sheet），
//       想把成員一次過寫入其中的 Users 工作表。
//
// 用法：
//   1. 在 Google Sheets 新建試算表，選單「檔案 > 匯入 > 上載 > 選取本機 CSV」匯入 data/members_template.csv
//      （或從 APP 的「📥 批量開戶」下載同一份 CSV 再匯入）
//   2. 擴充套件 > Apps Script，貼上本檔，儲存
//   3. 回到試算表，重新整理，出現「批量開戶」選單
//   4. 填好資料後：
//      -「✍️ 直接寫入主資料表」：最快，不需後端，直接 append 到旅團主資料表（支援全新空白 Sheet）
//      -「📤 轉JSON並推送後端」：逐列經你旅團的後端 addMember / addUser
//
// 欄位：ymis,name,email,role,can_tick,password,note（可加選填欄 squad / squad_role）
//   ymis      ：10 位數字（必填，作為帳號）
//   name      ：姓名（必填）
//   email     ：電郵（開立可登入帳號時建議填）
//   role      ：member / exec_committee / branch_leader / group_leader / admin
//   can_tick  ：true / false（可否勾選進度）
//   password  ：留空＝預設密碼 1234；有填＝用自訂密碼（直接寫入會以 SHA-256 雜湊儲存，與後端完全一致）
//   note      ：備註（Users 工作表無此欄，僅作填寫提醒）
//   squad     ：小隊／支部（選填； roverbadge 後端會存到 Users 的 branch 欄）
//   squad_role：member / 隊長 / 副隊長（選填）
//
// 直接寫入的工作表結構會與後端 Users 工作表完全相同（13 欄）：
//   ymis,name,email,role,password_hash,branch,can_tick,auth_by,auth_date,
//   created_at,last_login,status,allowed_badges
//
// ⚠️ 多旅團架構：每個旅團有自己的後端（GAS deployment）。推送後端時
//    BACKEND_URL / APIKEY 請填「你旅團」的 /exec 網址及 API Key（與 APP 登入所屬旅團相同）。

var CONFIG = {
  BACKEND_URL: 'https://script.google.com/macros/s/你的部署ID/exec', // 你旅團後端的 doPost 網址（用推送後端時需要）
  APIKEY: '你的TROOP_APIKEY',          // 你旅團的 API Key（與 APP 管理員設定相同）
  MAIN_SHEET_ID: '你的主資料表ID',     // 直接寫入主資料表時使用（旅團主資料表）
  USERS_SHEET: 'Users'                // 主資料表內存放成員的工作表名稱（需與後端相同：Users）
};

// Users 工作表標準欄位（與後端 initializeSheets 完全一致，13 欄）
var USERS_HEADER = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('批量開戶')
    .addItem('✍️ 直接寫入主資料表', 'writeToMainSheet')
    .addItem('📤 轉JSON並推送後端', 'pushToBackend')
    .addItem('📝 預覽JSON', 'previewJson')
    .addToUi();
}

// 與後端相同的 SHA-256 雜湊（確保直接寫入的密碼可以登入）
function hashPassword(p) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function readRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    headers.forEach(function (h, idx) { obj[h] = data[i][idx]; });
    if (obj.ymis) rows.push(obj);
  }
  return rows;
}

function toJson(rows) {
  return rows.map(function (r) {
    return {
      ymis: String(r.ymis).trim(),
      name: String(r.name || '').trim(),
      email: String(r.email || '').trim(),
      squad: String(r.squad || '').trim(),
      squad_role: String(r.squad_role || 'member').trim(),
      role: String(r.role || 'member').trim(),
      can_tick: ['true', '1', 'yes', 'y'].indexOf(String(r.can_tick || '').trim().toLowerCase()) >= 0,
      password: String(r.password || '').trim() || '1234'  // 留空＝預設密碼 1234
    };
  });
}

function previewJson() {
  var json = toJson(readRows());
  SpreadsheetApp.getUi().alert('將轉換 ' + json.length + ' 筆：\n\n' + JSON.stringify(json, null, 2).slice(0, 4000));
}

// 方法 A：透過你旅團後端寫入（一律 addUser 開立可登入帳號，與 APP 完全一致）
function pushToBackend() {
  var json = toJson(readRows());
  if (!json.length) { SpreadsheetApp.getUi().alert('沒有資料'); return; }
  var ok = 0, fail = 0, fails = [];
  json.forEach(function (m) {
    var payload = {
      action: 'addUser',
      apikey: CONFIG.APIKEY,
      ymis: m.ymis,
      name: m.name,
      email: m.email,
      squad: m.squad,
      squad_role: m.squad_role,
      role: m.role,
      can_tick: m.can_tick,
      password: m.password
    };
    try {
      var res = UrlFetchApp.fetch(CONFIG.BACKEND_URL, {
        method: 'post',
        contentType: 'text/plain',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var d = JSON.parse(res.getContentText());
      if (d.success) ok++; else { fail++; fails.push(m.ymis + ': ' + (d.error || '失敗')); }
    } catch (e) { fail++; fails.push(m.ymis + ': ' + e.message); }
  });
  SpreadsheetApp.getUi().alert('推送完成：成功 ' + ok + ' 筆，失敗 ' + fail + ' 筆' + (fails.length ? '\n\n' + fails.join('\n') : ''));
}

// 確保主資料表存在 Users 工作表；若為全新/空白工作表則自動建立標準表頭
function ensureUsersSheet(ss) {
  var sh = ss.getSheetByName(CONFIG.USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.USERS_SHEET);
  }
  var needsHeader = true;
  if (sh.getLastRow() >= 1 && sh.getLastColumn() >= 1) {
    var firstRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    if (firstRow.indexOf('ymis') >= 0) needsHeader = false;
  }
  if (needsHeader) {
    sh.clearContents();
    sh.getRange(1, 1, 1, USERS_HEADER.length).setValues([USERS_HEADER]);
    sh.getRange(1, 1, 1, USERS_HEADER.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return { sh: sh, needsHeader: needsHeader };
}

// 允許的角色（與後端 handleAddUser 一致）
function defaultAllowedBadges(role) {
  if (role === 'member') return '';
  if (role === 'exec_committee') return 'L1,活動段章,OTHER';
  return '*';
}

// 方法 B：直接寫入主資料表（不需後端，以主資料表權限寫入）
// 支援「全新 Sheet」：自動建立 Users 工作表 + 標準表頭；密碼以 SHA-256 雜湊儲存，開戶即可登入。
function writeToMainSheet() {
  var json = toJson(readRows());
  if (!json.length) { SpreadsheetApp.getUi().alert('沒有資料'); return; }
  var ss = SpreadsheetApp.openById(CONFIG.MAIN_SHEET_ID);
  var info = ensureUsersSheet(ss);
  var sh = info.sh;

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var ymisCol = headers.indexOf('ymis');
  if (ymisCol < 0) { SpreadsheetApp.getUi().alert('主資料表找不到 ymis 欄位'); return; }

  var lastRow = sh.getLastRow();
  var existing = lastRow > 1
    ? sh.getRange(2, ymisCol + 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); })
    : [];
  // v8.8：Email 亦全表唯一（含已停用）—— 讀出現有 Email（小寫化比對）
  var emailCol = headers.indexOf('email');
  var existingEmails = (lastRow > 1 && emailCol >= 0)
    ? sh.getRange(2, emailCol + 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).trim().toLowerCase(); })
    : [];

  // 讀取成員名單已有的 YMIS，避免重複寫入
  var mSheet = null, mExisting = {};
  try {
    mSheet = ss.getSheetByName('成員名單');
    if (mSheet && mSheet.getLastRow() > 1) {
      var mData = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 1).getValues();
      mData.forEach(function (r) { mExisting[String(r[0]).trim()] = true; });
    }
  } catch (e) { mSheet = null; }

  var validRoles = ['member', 'exec_committee', 'branch_leader', 'group_leader', 'admin'];
  var nowStr = Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss');
  var added = 0, dup = 0, dupEmail = 0, skipped = 0;
  json.forEach(function (m) {
    if (!/^\d{10}$/.test(m.ymis)) { skipped++; return; } // 防呆：YMIS 須 10 位數字
    if (validRoles.indexOf(m.role) < 0) m.role = 'member';
    // 與後端行為一致：一律 addUser 開立可登入帳號（密碼留空＝預設 1234），並同步寫入成員名單
    if (existing.indexOf(m.ymis) >= 0) { dup++; return; }
    var emKey = String(m.email || '').trim().toLowerCase(); // v8.8：Email 亦全表唯一
    if (emKey && existingEmails.indexOf(emKey) >= 0) { dup++; dupEmail++; return; }
    var row = new Array(headers.length).fill('');
    function set(name, val) { var c = headers.indexOf(name); if (c >= 0) row[c] = (val === undefined ? '' : val); }
    set('ymis', m.ymis);
    set('name', m.name);
    set('email', m.email);
    set('role', m.role);
    set('password_hash', hashPassword(m.password));
    set('branch', m.squad);            // 後端 convention：branch 欄存 squad
    set('can_tick', m.can_tick ? 'TRUE' : 'FALSE');
    set('auth_by', 'bulk_onboard');
    set('auth_date', nowStr);
    set('created_at', nowStr);
    set('status', 'active');
    set('allowed_badges', defaultAllowedBadges(m.role));
    sh.appendRow(row);
    existing.push(m.ymis);
    if (emKey) existingEmails.push(emKey);
    added++;
    // 同步寫入成員名單（與後端 addUser 行為一致：ymis,姓名,加入日期,支部,聯絡,備註）
    if (mSheet && !mExisting[m.ymis]) {
      mSheet.appendRow([m.ymis, m.name, new Date(), '', '', m.squad]);
      mExisting[m.ymis] = true;
    }
  });
  SpreadsheetApp.getUi().alert('寫入主資料表完成：新增 ' + added + ' 筆，略過重複 ' + dup + ' 筆' + (dupEmail ? '（其中 Email 重複 ' + dupEmail + ' 筆）' : '') + (skipped ? '，跳過無效 ' + skipped + ' 筆' : '') + (info.needsHeader ? '（已自動建立 Users 表頭）' : ''));
}
