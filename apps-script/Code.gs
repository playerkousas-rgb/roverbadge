// ============================================================
// 樂行童軍進度追蹤系統 - Apps Script 後端 v8.8 - 全功能版 (樂行童軍支部 Rover Scout)
// 完全兼容舊版 + 新增待批申請、批量寫入優化、日誌
// v8.3 新增：
//   - 批量開戶／申請審批的預設密碼改為 1234（DEFAULT_PASS）
//   - 更改密碼最短長度由 6 位放寬至 4 位
// v8.7 新增：團長全團只可一位（addUser／updateUserRole 強制執行；審批只可開出 member／branch_leader）
//   ＋領袖免 YMIS（用電郵登入，留空自動編配內部 L 編號）＋開戶權限收緊（只可開立自己可管理的角色）
//   - 公開申請只接受 member／branch_leader（管委／團長／管理員須由現任管理層在「用戶管理」開立）
//   - Sheet 人手改寫的 GSL／admin 申請一律退回 member；領袖申請忽略 YMIS
//   - reviewApplication 開戶預設密碼 1234，首次登入強制更改；回應加 final_role + temp_password；舊有 YMIS 領袖帳號不變
// v8.8 新增（用戶管理完整生命週期）：
//   - YMIS／Email 全表唯一（含已停用帳號）：apply／addUser／reviewApplication／addMember 劃一檢查，
//     不可重複開戶；停用帳號佔用的 YMIS／Email 須「恢復帳號」而非重新開戶
//   - 用戶管理可見全部人：getAllUsers 回傳 active＋inactive（含 status 欄）；無登入帳號的純名單成員
//     由 getMembers 差集顯示，前端可開立登入帳號／改名／刪除名單
//   - 領袖可自設成員密碼：resetPassword 接受可選 new_password（≥4位，首次登入須更改）；留空沿用隨機一次性密碼
//   - 自助找回密碼：公開 action forgotPassword（YMIS／電郵 → 臨時密碼寄到登記電郵；未登記電郵者請聯絡領袖）
//   - 新 action：reactivateUser（恢復停用）／updateUserProfile（改姓名／電郵／備註，電郵唯一）／
//     deleteMember（刪純名單成員）／deleteUser（徹底刪除已停用帳號，需團長以上，進度保留）
// v8.6 修改：系統管理帳號（super_admin）「只存在於 Code.gs」，其他地方完全唔提：
//   - 帳號／密碼只寫喺本檔（getSuperAdminUser / getSuperAdminPass），唔使設定、裝完即用
//   - Google Sheet 完全冇蹤跡：Users 表唔會有這列，initializeSheets() 亦會清走舊版殘留列
//   - initializeSheets() 完成提示只顯示 API Key / URL / 本旅團管理員，唔會出現超管任何資訊
//   - 用戶管理 getAllUsers／成員名單 getMembers／任何 API 回應／錯誤訊息都不會出現超管帳號或密碼
//   - 本 repo 文件亦刻意不記錄憑證
//   - 防護保留：系統管理帳號不能被停用／重設密碼／更改角色／自行改密碼
// v8.1 新增：活動履歷（服務紀錄／活動紀錄／訓練班紀錄）
//   - 新工作表「活動履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//   - 新 action：getLogRecords / saveLogRecord（支援批量 records[]）/ deleteLogRecord
//   - handleLoad 回應新增 logs + logsSupported
// v8.2 新增：活動履歷「成員自行申報 → 領袖審批」
//   - 新工作表「待批履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//   - 新 action：getPendingLogRequests / submitLogRequest / reviewLogRequest
//   - 成員可申報自己的活動履歷（新申報或申請修改已批紀錄），領袖批准後寫入「活動履歷」
//   - 修改類批准後更新原有紀錄（record_id 不變）；其他（進度/其他獎章）批准後成員不能自行修改
// ============================================================

const ADMIN_YMIS = '1111111111';
const ADMIN_NAME = '管理員';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'changeme';
// 批量開戶／申請審批的預設密碼
const DEFAULT_PASS = '1234';
// 系統管理帳號 (super_admin)：憑證只寫在 Code.gs 內（見下方 getSuperAdminUser / getSuperAdminPass）
// 不存於 Google Sheet、不在 initializeSheets() 提示／用戶名單／成員名單／API 回應中出現
const SUPER_ADMIN_NAME = '系統管理員';
// Tokens 表內代表超管的中性代號（避免超管帳號出現在 Sheet 任何一欄）
const SUPER_ADMIN_TOKEN_MARK = '__sys__';

// v8.1：活動履歷
const LOG_SHEET_NAME = '活動履歷';
const LOG_HEADERS = ['record_id','type','ymis','name','date','title','role','hours','cert_no','detail','recorder','recorded_at','updated_at'];
const LOG_TYPES = ['service','activity','training'];

// v8.2：活動履歷 - 成員自行申報 → 領袖審批
//  - 新工作表「待批履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//  - 新 action：getPendingLogRequests / submitLogRequest / reviewLogRequest
//  - 成員可申報自己的活動履歷；批准後寫入「活動履歷」；批准後成員仍可申請修改（重新待批）
const LOG_PENDING_SHEET_NAME = '待批履歷';
const LOG_PENDING_HEADERS = ['request_id','record_id','type','ymis','name','date','title','role','hours','cert_no','detail','status','requested_at','submitted_by','reviewed_by','reviewed_at','review_note','submission_type'];
function safeSheetText(v,maxLen){
  let text=String(v||'').trim().substring(0,maxLen||200);
  if(/^['=+\-@\t\r]/.test(text)) text="'"+text;
  return text;
}

// ===== 工具 =====
function getSheet() { return SpreadsheetApp.getActiveSpreadsheet(); }
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');
  if (!apiKey) {
    apiKey = 'rover_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', apiKey);
  }
  return apiKey;
}
function showApiKey() {
  const apiKey = getApiKey();
  const ui = SpreadsheetApp.getUi();
  if (ui) ui.alert('API Key', '你的 API Key：\n\n' + apiKey, ui.ButtonSet.OK);
  Logger.log('API Key: ' + apiKey);
  return apiKey;
}

// ===== 系統管理帳號 (super_admin) =====
// 設計原則（v8.6）：超管「只存在於本檔 Code.gs」
//   - 帳號／密碼只寫在這裡的常量，不存於 Google Sheet（Users 表不會有這列）
//   - initializeSheets() 的完成提示不會顯示，任何 alert / prompt 都不會出現
//   - 用戶管理 getAllUsers／成員名單 getMembers／任何 API 回應都不會出現
//   - 本 repo 的文件亦刻意不記錄憑證
//   - 防護保留：不能被停用／重設密碼／更改角色／自行改密碼
// 注意：Code.gs 是部署指南頁的公開下載檔，拿到此檔的人讀得到這兩行常量；
//       以下用字串拼接只是避免明文凭證被搜尋到，並不是加密保護。
function getSuperAdminUser() { return 'sh' + 'eep'; }
function getSuperAdminPass() { return '07' + '28'; }
function isSuperAdminId(id) {
  return String(id || '').trim().toLowerCase() === getSuperAdminUser();
}
// 供部署者核對超管是否有效（只回布林，永不回傳帳號／密碼）
function checkSuperAdmin() {
  const ok = String(getSuperAdminPass() || '').length >= 4;
  Logger.log('系統管理帳號可用：' + ok);
  return { success: true, enabled: ok };
}

function hashPassword(p) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function(b){return ('0' + (b & 0xFF).toString(16)).slice(-2);}).join('');
}
function generateToken(){ return Utilities.getUuid().replace(/-/g,'') + Date.now().toString(36); }
function now(){ return Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss'); }
function formatDate(d){ if(!d) return ''; if(d instanceof Date) return Utilities.formatDate(d,'Asia/Hong_Kong','yyyy-MM-dd'); return d.toString().split(' ')[0]; }
function jsonResponse(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

const ROLE_HIERARCHY = { 'super_admin':100,'admin':80,'group_leader':60,'branch_leader':40,'exec_committee':20,'member':0 };
const CAN_TICK_ROLES = ['admin','group_leader','branch_leader','exec_committee','super_admin'];
const CAN_MANAGE_ROLES = { 
  'super_admin': ['admin','group_leader','branch_leader','exec_committee','member'],
  'admin': ['group_leader','branch_leader','exec_committee','member'], 
  'group_leader': ['branch_leader','exec_committee','member'], 
  'branch_leader': ['exec_committee','member'] 
};
function canUserTick(r){ return CAN_TICK_ROLES.indexOf(r)>=0; }
function getRoleLevel(r){ return ROLE_HIERARCHY[r]||0; }
function canManageRole(m,t){ return (CAN_MANAGE_ROLES[m]||[]).indexOf(t)>=0; }
function canManageUser(manager,targetRole){ return manager && (manager.role==='super_admin' || canManageRole(manager.role,targetRole)); }
// v8.7：領袖免 YMIS（用電郵登入）—— 為領袖帳戶自動編配內部唯一 L 編號（只做 Users 表鍵值，不會向領袖展示為 YMIS）
function generateLeaderId(){
  for(let i=0;i<20;i++){
    const id='L'+Date.now().toString().substring(7)+Math.floor(Math.random()*90+10);
    if(!getUser(id)) return id;
  }
  return 'L'+Date.now().toString()+Math.floor(Math.random()*900+100);
}
// v8.7：團長全團只可有一位 —— 取現任在職團長（可排除指定 YMIS；換人流程：先將現任轉為其他角色，再升新人）
function findActiveGroupLeader(excludeYmis){
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return null;
  const data=uSheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0] && String(data[i][0])!==String(excludeYmis||'') && data[i][3] && String(data[i][3])==='group_leader' && data[i][11] && String(data[i][11])==='active'){
      return {ymis:String(data[i][0]), name:data[i][1]?String(data[i][1]):''};
    }
  }
  return null;
}
// 公開申請只接受 member／branch_leader（管委／團長／管理員須由現任管理層直接開立）
const VALID_ROLES = ['member','exec_committee','branch_leader','group_leader','admin'];
const APPLY_ROLES = ['member','branch_leader'];
const FORCE_CHANGE_COL = 14;
function ensureForceChangeCol(uSheet){
  if(!uSheet) return;
  if(uSheet.getLastColumn()<FORCE_CHANGE_COL || !String(uSheet.getRange(1,FORCE_CHANGE_COL).getValue()||'').trim()){
    uSheet.getRange(1,FORCE_CHANGE_COL).setValue('force_change_password');
  }
}
function isForceChangeValue(v){ return v===true || String(v).toUpperCase()==='TRUE'; }
// ===== v8.8：YMIS／Email 全表唯一（含已停用帳號）=====
// 設計：停用帳號仍佔用其 YMIS／Email（保留歷史進度與審批軌跡），不可用同一 YMIS／Email 另開新帳號；
//       如需重用，領袖應在「用戶管理」恢復該帳號（reactivateUser）而非重新開戶。
function normalizeEmail_(email){ return String(email||'').trim().toLowerCase(); }
function isValidEmail_(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||'').trim()); }
// 在 Users 表找 YMIS（不分 active／inactive；超管不存表，另由 isSuperAdminId 把關）
function findUserRowAnyStatus_(ymis){
  const key=String(ymis||'').trim();
  if(!key) return null;
  const sh=getSheet().getSheetByName('Users');
  if(!sh) return null;
  const data=sh.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]||'').trim()===key){
      return {row:i+1, ymis:key, name:data[i][1]?String(data[i][1]):'', email:data[i][2]?String(data[i][2]).trim():'', role:data[i][3]?String(data[i][3]):'member', status:String(data[i][11]||'').trim()||'active'};
    }
  }
  return null;
}
function ymisTakenAnyStatus_(ymis){ return !!findUserRowAnyStatus_(ymis); }
// Email 是否已被佔用（不分 active／inactive；excludeYmis 用於「修改自己電郵」時排除自己）
function emailTakenAnyStatus_(email, excludeYmis){
  const target=normalizeEmail_(email);
  if(!target) return null;
  const sh=getSheet().getSheetByName('Users');
  if(!sh) return null;
  const data=sh.getDataRange().getValues();
  const ex=String(excludeYmis||'').trim();
  for(let i=1;i<data.length;i++){
    const rowY=String(data[i][0]||'').trim();
    if(!rowY) continue;
    if(ex && rowY===ex) continue;
    if(normalizeEmail_(data[i][2])===target){
      return {row:i+1, ymis:rowY, name:data[i][1]?String(data[i][1]):'', status:String(data[i][11]||'').trim()||'active'};
    }
  }
  return null;
}
function memberNameRowExists_(ymis){
  const key=String(ymis||'').trim();
  if(!key) return null;
  const mSheet=getSheet().getSheetByName('成員名單');
  if(!mSheet) return null;
  const data=mSheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]||'').trim()===key) return {row:i+1, name:data[i][1]?String(data[i][1]):''};
  }
  return null;
}
function maskEmail_(email){
  const e=String(email||'').trim();
  const at=e.indexOf('@');
  if(at<=0) return '***';
  const nm=e.substring(0,at), domain=e.substring(at);
  if(nm.length<=2) return nm.charAt(0)+'*'+domain;
  return nm.charAt(0)+'***'+nm.charAt(nm.length-1)+domain;
}

// ===== 初始化 =====
function initializeSheets() {
  const ss = getSheet();
  let pSheet = ss.getSheetByName('進度追蹤');
  if(!pSheet){
    pSheet = ss.insertSheet('進度追蹤');
    pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);
    pSheet.getRange(1,1,1,6).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    pSheet.setFrozenRows(1);
  } else {
    // ensure 6 columns header
    if(pSheet.getLastColumn()<6){
      pSheet.getRange(1,5).setValue('確認者'); pSheet.getRange(1,6).setValue('備註');
    }
  }
  let mSheet = ss.getSheetByName('成員名單');
  if(!mSheet){
    mSheet = ss.insertSheet('成員名單');
    mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡']);
    mSheet.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    mSheet.setFrozenRows(1);
  }
  let uSheet = ss.getSheetByName('Users');
  if(!uSheet){
    uSheet = ss.insertSheet('Users');
    uSheet.appendRow(['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','force_change_password']);
    uSheet.getRange(1,1,1,14).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    uSheet.setFrozenRows(1);
    uSheet.getRange(2,1).setValue(ADMIN_YMIS);
    uSheet.getRange(2,2).setValue(ADMIN_NAME);
    uSheet.getRange(2,3).setValue(ADMIN_EMAIL);
    uSheet.getRange(2,4).setValue('admin');
    uSheet.getRange(2,5).setValue(hashPassword(ADMIN_PASS));
    uSheet.getRange(2,6).setValue('b4');
    uSheet.getRange(2,7).setValue(true);
    uSheet.getRange(2,8).setValue('system');
    uSheet.getRange(2,9).setValue(now());
    uSheet.getRange(2,10).setValue(now());
    uSheet.getRange(2,12).setValue('active');
    uSheet.getRange(2,13).setValue('*'); // 管理員默認全部
    uSheet.getRange(2,14).setValue(true);
  } else {
    // 確保第13欄存在
    if(uSheet.getLastColumn()<13){
      uSheet.getRange(1,13).setValue('allowed_badges');
    }
    ensureForceChangeCol(uSheet);
  }
  let aSheet = ss.getSheetByName('Applications');
  if(!aSheet){
    aSheet = ss.insertSheet('Applications');
    aSheet.appendRow(['app_id','ymis','name','email','role','branch','status','applied_at','reviewed_by','reviewed_at','note']);
    aSheet.getRange(1,1,1,11).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    aSheet.setFrozenRows(1);
  }
  let tSheet = ss.getSheetByName('Tokens');
  if(!tSheet){
    tSheet = ss.insertSheet('Tokens');
    tSheet.appendRow(['token','ymis','created_at','expires_at']);
    tSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    tSheet.setFrozenRows(1);
  }
  let cSheet = ss.getSheetByName('SystemConfig');
  if(!cSheet){
    cSheet = ss.insertSheet('SystemConfig');
    cSheet.appendRow(['key','value','updated_at','updated_by']);
    cSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    cSheet.setFrozenRows(1);
    cSheet.appendRow(['login_mode','standalone',now(),'system']);
    cSheet.appendRow(['admin_email',ADMIN_EMAIL,now(),'system']);
  }
  // 新增：待批完成表
  let prSheet = ss.getSheetByName('待批完成');
  if(!prSheet){
    prSheet = ss.insertSheet('待批完成');
    prSheet.appendRow(['request_id','ymis','name','item_id','item_name','requested_date','evidence','status','created_at','reviewed_by','reviewed_at','review_note','confirmed_date']);
    prSheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    prSheet.setFrozenRows(1);
  }
  // 其他獎章紀錄表
  let oSheet = ss.getSheetByName('其他獎章');
  if(!oSheet){
    oSheet = ss.insertSheet('其他獎章');
    oSheet.appendRow(['YMIS','獎章 ID','獎章名稱','完成日期','證書編號','備註','更新時間']);
    oSheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    oSheet.setFrozenRows(1);
  }
  // 前端管理操作審計
  let auditSheet = ss.getSheetByName('操作紀錄');
  if(!auditSheet){
    auditSheet = ss.insertSheet('操作紀錄');
    auditSheet.appendRow(['時間','操作者','操作','對象','詳情']);
    auditSheet.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    auditSheet.setFrozenRows(1);
  }
  // v8.1：活動履歷（服務／活動／訓練班紀錄，統一用 type 欄位區分）
  let lSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if(!lSheet){
    lSheet = ss.insertSheet(LOG_SHEET_NAME);
    lSheet.appendRow(LOG_HEADERS);
    lSheet.getRange(1,1,1,LOG_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lSheet.setFrozenRows(1);
  }
  // v8.2：待批履歷（成員申報 → 領袖審批）
  let lpSheet = ss.getSheetByName(LOG_PENDING_SHEET_NAME);
  if(!lpSheet){
    lpSheet = ss.insertSheet(LOG_PENDING_SHEET_NAME);
    lpSheet.appendRow(LOG_PENDING_HEADERS);
    lpSheet.getRange(1,1,1,LOG_PENDING_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lpSheet.setFrozenRows(1);
  }
  // 確保系統設定有 allow_member_view_others
  let cfgSheet = ss.getSheetByName('SystemConfig');
  if(cfgSheet){
    const cfgData=cfgSheet.getDataRange().getValues();
    let hasAllow=false;
    for(let i=1;i<cfgData.length;i++){ if(cfgData[i][0]==='allow_member_view_others'){ hasAllow=true; break; } }
    if(!hasAllow){
      cfgSheet.appendRow(['allow_member_view_others','false',now(),'system']);
    }
  }

  const apiKey = getApiKey();
  let scriptUrl=''; try{ scriptUrl=ScriptApp.getService().getUrl(); }catch(e){ scriptUrl='請部署為網頁應用程式後查看';}
  // 清除 Users 表殘留的 super_admin 列（系統管理帳號只存在於 Code.gs，Sheet 唔應該有這列）
  try{ removeSuperAdminRows(); }catch(e){}
  try{
    const ui=SpreadsheetApp.getUi();
    if(ui){
      // 提示內容刻意不包含任何系統管理帳號（super_admin）資訊：
      // 只顯示本旅團自己的 API Key、URL 與旅團管理員帳號（超管只在 Code.gs 內，唔會喺呢度曝光）
      ui.alert('✅ v4.0 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章\n\n🔑 API Key:\n'+apiKey+'\n\n👤 旅團管理員 YMIS: '+ADMIN_YMIS+' 初始密碼: '+ADMIN_PASS+'（請立即登入後更改）\n\n🌐 URL:\n'+scriptUrl);
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

// 系統管理帳號 (super_admin)：憑證只存在於 Code.gs，不存於 Users 表
// removeSuperAdminRows()：清除 Users 表內殘留的系統管理帳號列（舊版 ensureSuperAdmin 寫入的），
// - initializeSheets() 會自動執行
// - 可單獨在 Apps Script 編輯器執行，只刪 super_admin 列，不影響其他資料
function removeSuperAdminRows(){
  const ss=getSheet();
  const uSheet=ss.getSheetByName('Users');
  if(!uSheet) return {success:true,removed:0,message:'Users 工作表不存在，無需清理'};
  if(uSheet.getLastColumn()<13){
    uSheet.getRange(1,13).setValue('allowed_badges');
  }
  const data=uSheet.getDataRange().getValues();
  const su=getSuperAdminUser();
  let removed=0;
  for(let i=data.length-1;i>=1;i--){
    const y=String(data[i][0]||'').trim().toLowerCase();
    const role=String(data[i][3]||'').trim().toLowerCase();
    // 舊版殘留列：角色為 super_admin，或 YMIS 與目前設定的系統管理帳號相同
    if(role==='super_admin' || (su && y===su)){
      uSheet.deleteRow(i+1);
      removed++;
    }
  }
  return {success:true,removed:removed,message:'已從 Users 表移除 '+removed+' 列系統管理帳號殘留列（系統管理帳號只存在於 Code.gs，不存於 Users 表）'};
}

// ===== 用戶查詢 =====
function getUser(ymis){
  // 系統管理帳號 (super_admin) 免 Users 表，直接返回最高權限（只存在於 Code.gs）
  if(isSuperAdminId(ymis)){
    return {ymis:getSuperAdminUser(),name:SUPER_ADMIN_NAME,email:'',role:'super_admin',can_tick:true,branch:'',squad:'',squad_role:'member',allowed_badges:'*',status:'active'};
  }
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  const hasAllowedCol = sheet.getLastColumn()>=13;
  const key=String(ymis||'').trim();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]||'').trim()===key && String(data[i][11]||'').trim()==='active'){
      return {
        ymis:data[i][0].toString(),
        name:data[i][1]?data[i][1].toString():'',
        email:data[i][2]?data[i][2].toString():'',
        role:data[i][3]?data[i][3].toString():'member',
        can_tick:data[i][6]===true||data[i][6]==='TRUE',
        branch:data[i][5]?data[i][5].toString():'',
        // v5.0: squad/squad_role 暫存於 branch 欄 (欄 6)，向後兼容
        squad:data[i][5]?data[i][5].toString():'',
        squad_role:'member',
        allowed_badges: hasAllowedCol ? (data[i][12]?data[i][12].toString():'') : '',
        status:'active',
        force_change_password: data[i].length>=FORCE_CHANGE_COL && isForceChangeValue(data[i][FORCE_CHANGE_COL-1])
      };
    }
  }
  return null;
}
function getUserByEmail(email){
  if(!email) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues(); const target=String(email||'').trim().toLowerCase();
  if(!target) return null;
  const hasAllowed = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){
    if(String(data[i][2]||'').trim().toLowerCase()===target && String(data[i][11]||'').trim()==='active'){
      return {ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',email:data[i][2].toString(),role:data[i][3]?data[i][3].toString():'member',can_tick:data[i][6]===true||data[i][6]==='TRUE',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : '',squad:data[i][5]?data[i][5].toString():'',squad_role:'member'};
    }
  }
  return null;
}
function getAllUsers(){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return [];
  const users=[]; const data=sheet.getDataRange().getValues();
  const hasAllowed = sheet.getLastColumn()>=13;
  // 系統管理帳號不存於 Users 表；若 Sheet 有殘留的 super_admin 列亦一律略過
  // v8.8：回傳 active＋inactive（前端分「啟用中／已停用」顯示，停用帳號可恢復或徹底刪除）
  for(let i=1;i<data.length;i++){
    const y=String(data[i][0]||'').trim();
    if(!y) continue;
    const role=data[i][3]?data[i][3].toString():'member';
    if(role==='super_admin' || isSuperAdminId(y)) continue;
    const status=String(data[i][11]||'').trim()||'active';
    users.push({ymis:y,name:data[i][1]?data[i][1].toString():'',email:data[i][2]?data[i][2].toString():'',role:role,can_tick:data[i][6]===true||data[i][6]==='TRUE',branch:data[i][5]?data[i][5].toString():'',squad:data[i][5]?data[i][5].toString():'',squad_role:'member',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : '',status:status});
  }
  return users;
}

// Token
function validateToken(token){
  if(!token) return null;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0]===token){
      if(new Date()>new Date(data[i][3])){ sheet.deleteRow(i+1); return null; }
      const y=data[i][1].toString();
      // 超管 token 列在 Sheet 內以中性代號儲存，讀出時還原（Sheet 唔會出現超管帳號）
      // 向後兼容：舊版直接寫了帳號的列，經 isSuperAdminId() 一樣還原
      return (y===SUPER_ADMIN_TOKEN_MARK || isSuperAdminId(y)) ? getSuperAdminUser() : y;
    }
  }
  return null;
}
function createToken(ymis){
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  // 超管登入時，Tokens 表只寫中性代號，令整份 Sheet 都搵唔到超管帳號
  sheet.appendRow([token,isSuperAdminId(ymis)?SUPER_ADMIN_TOKEN_MARK:ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
  return token;
}
function destroyToken(token){
  if(!token) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===token){ sheet.deleteRow(i+1); return; } }
}

// ===== API =====
function doGet(e){
  const action=e.parameter.action;
  if(action==='load'){
    // v4: allow load without apikey for backwards compatibility (troops.json may not have apikey), but if apikey provided, must validate
    const reqKey=e.parameter.apikey;
    if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
    return handleLoad();
  }
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone'});
  return jsonResponse({success:false,error:'Unknown action'});
}
function doPost(e){
  try{
    const body=JSON.parse(e.postData.contents);
    const action=body.action;
    if(action==='login') return handleLogin(body.login_id,body.password);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role||'member',body.branch);
    // v8.8：自助找回密碼（公開，不需 token；臨時密碼寄到登記電郵）
    if(action==='forgotPassword') return handleForgotPassword(body.login_id);

    // save & addMember 需要 apikey (v4 向下兼容：若無 apikey 但有有效 token 也允許)
    if(action==='save' || action==='addMember' || action==='addUser' || action==='saveOtherBadge'){
      const reqKey=body.apikey;
      if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
      // 若無 apikey，嘗試 token 驗證作為後備
      if(!reqKey && body.token){
        const tk=validateToken(body.token);
        if(!tk && action!=='addMember') return jsonResponse({success:false,error:'未授權 - 需 API Key 或有效 Token'});
      }
      if(action==='save') return handleSave(body.changes, body.confirmer||'');
      if(action==='addMember'){
        // v5.0: 需領袖權限 (group_leader 或以上)
        const my=body.token?validateToken(body.token):null;
        const mgr=my?getUser(my):null;
        if(!mgr && body.apikey && body.apikey===getApiKey()) mgr={role:'admin'};
        if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以新增成員'});
        return handleAddMember(body.ymis, body.name, body.squad||'', body.squad_role||'member');
      }
      if(action==='addUser'){
        // v5.0: 領袖可在前端開立可登入帳號
        const my=body.token?validateToken(body.token):null;
        const mgr=my?getUser(my):null;
        if(!mgr && body.apikey && body.apikey===getApiKey()) mgr={role:'admin'};
        if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以開新帳號'});
        return handleAddUser(body,mgr);
      }
      if(action==='saveOtherBadge') return handleSaveOtherBadge(body.records, body.apikey);
    }
    // member request - needs token but also allow apikey for member self
    if(action==='requestComplete'){
      // allow token or apikey
      let ymis=null; if(body.token){ ymis=validateToken(body.token); } 
      if(!ymis && body.apikey && body.apikey===getApiKey()){ ymis=body.ymis; } // standalone mode
      if(!ymis) return jsonResponse({success:false,error:'未授權'});
      return handleRequestComplete(body, ymis);
    }

    // 以下需要 token 驗證及高權限
    const ymis=validateToken(body.token);
    if(!ymis) return jsonResponse({success:false,error:'Token 無效或過期'});
    const user=getUser(ymis);
    if(!user) return jsonResponse({success:false,error:'找不到用戶'});

    if(action==='getAllUsers') {
      // 任何已登入用戶都可查看名單，方便領袖管理；成員僅查看自己旅團成員
      let list=getAllUsers();
      // 隱藏系統管理帳號：任何角色（包括 super_admin 自己）一律過濾
      list=list.filter(function(u){ return u.role!=='super_admin' && !isSuperAdminId(u.ymis); });
      return jsonResponse({success:true,users:list});
    }
    if(action==='getMembers'){ return jsonResponse({success:true,members:getMembers()}); }
    if(action==='getPendingRequests'){ if(getRoleLevel(user.role)<0) return jsonResponse({success:false,error:'權限不足'}); return handleGetPendingRequests(); }
    if(action==='reviewRequest'){ if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'}); return handleReviewRequest(body.request_id, body.decision, body.review_note, ymis, body.confirmed_date); }
    if(action==='getOtherBadges'){ return handleGetOtherBadges(body.target_ymis||ymis); }
    if(action==='getApplications'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，需團長/支部領袖'}); return handleGetApplications(); }
    if(action==='reviewApplication'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReviewApplication(body.app_id,body.decision,body.review_note,user); }
    if(action==='getConfig'){
      // 任何已登入用戶都可讀取公開設定
      return handleGetConfig();
    }
    // v8.1：活動履歷（服務／活動／訓練班紀錄）。讀取任何登入者可；寫入／刪除需已獲勾選權限的領袖（同進度寫入）。
    if(action==='getLogRecords') return handleGetLogRecords();
    if(action==='saveLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleSaveLogRecord(body.records||(body.record?[body.record]:[]), ymis, body.recorder_name||'');
    }
    if(action==='deleteLogRecord'){
      if(!canUserTick(user.role) || user.can_tick!==true) return jsonResponse({success:false,error:'權限不足，需已獲勾選權限的領袖'});
      return handleDeleteLogRecord(body.record_id, ymis);
    }
    // v8.2：活動履歷 - 成員自行申報 → 領袖審批。任何登入成員可申報／查看自己的申請；審批需領袖。
    if(action==='getPendingLogRequests') return handleGetPendingLogRequests(user);
    if(action==='submitLogRequest') return handleSubmitLogRequest(body, ymis, user);
    if(action==='reviewLogRequest'){
      if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'});
      return handleReviewLogRequest(body.request_id, body.decision, ymis, body.review_note);
    }

    // 以下為高權限
    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password);
    // v5.0: 重設密碼 (領袖專用, 需 40+ 權限)；v8.8 可附 new_password 自設密碼（留空＝隨機一次性密碼）
    if(action==='resetPassword'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleResetPassword(body.target_ymis,ymis,body.new_password); }
    // v5.0: 停用帳號 (領袖專用, 需 40+ 權限, 且不能停用自己/超管)
    if(action==='deactivateUser'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleDeactivateUser(body,user,ymis); }
    // v8.8：恢復停用帳號 (領袖專用, 需 40+ 權限)
    if(action==='reactivateUser'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReactivateUser(body,user,ymis); }
    // v8.8：修改帳號資料——姓名／電郵／備註；純名單成員則改名單 (領袖專用, 需 40+ 權限)
    if(action==='updateUserProfile'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleUpdateUserProfile(body,user,ymis); }
    // v8.8：刪除純名單成員（無登入帳號者；領袖專用, 需 40+ 權限）
    if(action==='deleteMember'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleDeleteMember(body,user,ymis); }
    // v8.8：徹底刪除已停用帳號（需團長以上；先停用再刪除；進度保留）
    if(action==='deleteUser'){ if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'徹底刪除需團長以上權限，請先停用帳號再請團長處理'}); return handleDeleteUser(body,user,ymis); }
    if(action==='updateUserRole'){
      // 允許團長/支部領袖/管理員更新角色 + 細緻權限
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role,body.can_tick,ymis, body.allowed_badges);
    }
    if(action==='updatePermissions'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role||null,body.can_tick,ymis, body.allowed_badges);
    }
    if(action==='updateConfig'){
      // allow_member_view_others 可由團長以上設定，其他設定需管理員
      const key=body.key;
      if(key==='allow_member_view_others'){
        if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'需團長以上權限'});
      }else{
        if(getRoleLevel(user.role)<80) return jsonResponse({success:false,error:'需管理員權限'});
      }
      return handleUpdateConfig(body.key,body.value,ymis);
    }
    return jsonResponse({success:false,error:'Unknown action'});
  }catch(err){ return jsonResponse({success:false,error:err.toString()}); }
}

// ===== 邏輯 =====
function handleLogin(loginId,password){
  if(!loginId||!password) return jsonResponse({success:false,error:'請填寫帳號和密碼'});
  // 系統管理帳號 (super_admin)：憑證只存在於 Code.gs，不存於 Users 表（Sheet 完全冇蹤跡）
  if(isSuperAdminId(loginId) && String(password||'')===getSuperAdminPass()){
    const su=getSuperAdminUser();
    return jsonResponse({success:true,token:createToken(su),user:{ymis:su,name:SUPER_ADMIN_NAME,role:'super_admin',can_tick:true,email:''},force_change_password:false});
  }
  let user=(/^\d{10}$/.test(loginId)||/^L\d+/.test(loginId))? getUser(loginId): getUserByEmail(loginId);
  if(!user){
    // try both
    user=getUser(loginId)||getUserByEmail(loginId);
  }
  if(!user) return jsonResponse({success:false,error:'找不到此帳號'});
  const hash=hashPassword(password);
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][11].toString()==='active' && data[i][4].toString()===hash){
      const rowY=data[i][0].toString(); const rowE=data[i][2].toString().toLowerCase();
      if(rowY===user.ymis || rowE===user.email.toLowerCase() || rowY===loginId){
        const token=createToken(user.ymis);
        sheet.getRange(i+1,11).setValue(now());
        const forceChange=data[i].length>=FORCE_CHANGE_COL && isForceChangeValue(data[i][FORCE_CHANGE_COL-1]);
        return jsonResponse({success:true,token:token,user:user,force_change_password:forceChange});
      }
    }
  }
  return jsonResponse({success:false,error:'密碼錯誤'});
}
function handleChangePassword(ymis,oldP,newP){
  // 錯誤訊息刻意不含任何帳號／密碼資訊（舊版曾在此回「密碼固定為 0728」，已移除）
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'系統管理員密碼不能由此更改'});
  if(!newP || newP.toString().length<4) return jsonResponse({success:false,error:'新密碼至少4位'});
  if(String(newP)===String(oldP||'')) return jsonResponse({success:false,error:'新密碼不可與原密碼相同'});
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===ymis && data[i][11].toString()==='active'){
      if(data[i][4].toString()===hashPassword(oldP)){
        sheet.getRange(i+1,5).setValue(hashPassword(newP));
        ensureForceChangeCol(sheet);
        sheet.getRange(i+1,FORCE_CHANGE_COL).setValue(false);
        return jsonResponse({success:true});
      }
    }
  }
  return jsonResponse({success:false,error:'原密碼錯誤'});
}
function handleApply(ymis,name,email,role,branch){
  // v8.7：成員／領袖都可自行申請；角色嚴格驗證，只限 member / branch_leader。
  // 領袖免 YMIS（用電郵登入），領袖申請一律忽略 YMIS。管委／團長／管理員不可由此申請。
  ymis=String(ymis||'').trim(); name=safeSheetText(name,100);
  email=String(email||'').trim().substring(0,160); branch=safeSheetText(branch,100);
  role=String(role||'member').trim()||'member';
  if(APPLY_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效的申請角色'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  if(role==='member'){
    if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'成員需 10位 YMIS'});
  }else{
    ymis='';
    if(!email) return jsonResponse({success:false,error:'領袖申請必須填寫聯絡電郵'});
  }
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
  if(isSuperAdminId(ymis) || isSuperAdminId(email)) return jsonResponse({success:false,error:'此帳號已被保留，請使用其他帳號'});
  // v8.8：YMIS／Email 全表唯一（含已停用帳號，不可重複申請）
  if(ymis && ymisTakenAnyStatus_(ymis)){
    const ex=findUserRowAnyStatus_(ymis);
    return jsonResponse({success:false,error:(ex && ex.status!=='active')?'此 YMIS 已有帳號紀錄（已停用），請聯絡領袖恢復帳號，不需重新申請':'此 YMIS 已註冊，不可重複申請'});
  }
  if(email && emailTakenAnyStatus_(email,'')){
    const em=emailTakenAnyStatus_(email,'');
    return jsonResponse({success:false,error:(em && em.status!=='active')?'此 Email 已有帳號紀錄（已停用），請聯絡領袖恢復帳號，不需重新申請':'此 Email 已註冊，不可重複申請'});
  }
  const sheet=getSheet().getSheetByName('Applications');
  if(!sheet) return jsonResponse({success:false,error:'Applications 工作表不存在，請先執行 initializeSheets()'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][6])==='pending'){
      if(ymis && String(data[i][1])===ymis) return jsonResponse({success:false,error:'此 YMIS 已有待審批申請'});
      if(email && String(data[i][3]).toLowerCase()===email.toLowerCase()) return jsonResponse({success:false,error:'此 Email 已有待審批申請'});
    }
  }
  sheet.appendRow(['APP_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),ymis,name,email,role,branch||'','pending',now(),'','','']);
  return jsonResponse({success:true,message:'申請已提交'});
}
function handleGetApplications(){
  const sheet=getSheet().getSheetByName('Applications'); const apps=[]; const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][6].toString()==='pending'){ apps.push({app_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),email:data[i][3].toString(),requested_role:data[i][4].toString(),branch:data[i][5].toString(),applied_at:data[i][7]?formatDate(data[i][7]):''}); } }
  return jsonResponse({success:true,applications:apps});
}
function handleReviewApplication(appId,decision,note,manager,tempPassword){
  // v8.7：審批只可開出 member／branch_leader（即使有人手改 Sheet 寫入 group_leader／admin／exec_committee 亦會退回 member）
  // 按申請角色開戶；審批者權限不足時退回 member。領袖免 YMIS —— 批准時一律自動編配內部 L 編號。
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決定'});
  const sheet=getSheet().getSheetByName('Applications');
  if(!sheet) return jsonResponse({success:false,error:'找不到 Applications 工作表'});
  const data=sheet.getDataRange().getValues();
  let rowIndex=-1, appData=null;
  for(let i=1;i<data.length;i++){ if(String(data[i][0])===String(appId)){ rowIndex=i+1; appData=data[i]; break; } }
  if(!appData || String(appData[6])!=='pending') return jsonResponse({success:false,error:'找不到待審批申請'});
  const reviewerYmis=(manager && manager.ymis)?String(manager.ymis):String(manager||'');
  if(decision==='rejected'){
    sheet.getRange(rowIndex,7).setValue('rejected');
    sheet.getRange(rowIndex,9).setValue(reviewerYmis);
    sheet.getRange(rowIndex,10).setValue(now());
    sheet.getRange(rowIndex,11).setValue(note||'');
    writeAudit(reviewerYmis,'reject_application',String(appData[1]),String(appId));
    return jsonResponse({success:true,message:'已拒絕申請'});
  }
  const requestedRole=String(appData[4]||'member');
  const finalRole=(APPLY_ROLES.indexOf(requestedRole)>=0 && canManageUser(manager,requestedRole))?requestedRole:'member';
  let ymis=String(appData[1]||'').trim();
  const appName=String(appData[2]||'');
  const appEmail=String(appData[3]||'').trim();
  const branchVal=safeSheetText(appData[5],100);
  // 即使因審批者權限不足而退回 member 也一樣編配 L 編號，否則該申請會永遠卡在待批無法批准；一律用 Email 登入
  if(!ymis){ ymis=generateLeaderId(); }
  if(isSuperAdminId(ymis) || isSuperAdminId(appEmail)) return jsonResponse({success:false,error:'此帳號已被保留，不能開戶'});
  // v8.8：全表唯一（含已停用）—— 批准前再驗一次，防止待批期間已被開戶
  if(ymisTakenAnyStatus_(ymis)) return jsonResponse({success:false,error:'此 YMIS 已有帳號紀錄（可能已開戶或已停用），請先處理現有帳號再審批'});
  if(appEmail && emailTakenAnyStatus_(appEmail,'')) return jsonResponse({success:false,error:'此 Email 已有帳號紀錄（可能已開戶或已停用），請先處理現有帳號再審批'});
  const password=DEFAULT_PASS;
  const isLeaderFinal=(finalRole!=='member');
  const allowedBadges = finalRole==='member' ? '' : (finalRole==='exec_committee' ? 'L1,活動段章,OTHER' : '*');
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success:false,error:'找不到 Users 工作表'});
  ensureForceChangeCol(uSheet);
  const nowStr=now();
  uSheet.appendRow([ymis,appName,appEmail,finalRole,hashPassword(password),branchVal,isLeaderFinal,reviewerYmis,nowStr,nowStr,'','active',allowedBadges,true]);
  // v8.8：名單已有此 YMIS（純名單成員升級為登入帳號）就不重複加列，只更新姓名
  const mSheet=getSheet().getSheetByName('成員名單');
  if(mSheet){
    const mRow=memberNameRowExists_(ymis);
    if(mRow) mSheet.getRange(mRow.row,2).setValue(appName);
    else mSheet.appendRow([ymis,appName,new Date(),branchVal,appEmail]);
  }
  sheet.getRange(rowIndex,7).setValue('approved');
  sheet.getRange(rowIndex,9).setValue(reviewerYmis);
  sheet.getRange(rowIndex,10).setValue(nowStr);
  sheet.getRange(rowIndex,11).setValue(note||'');
  writeAudit(reviewerYmis,'approve_application',ymis,String(appId)+' → '+finalRole);
  return jsonResponse({success:true,message:'已批准並建立帳戶，預設密碼：'+password+'（首次登入須更改）',temp_password:password,final_role:finalRole,ymis:ymis});
}
function handleUpdateUserRole(targetYmis,newRole,canTick,managerYmis, allowedBadges){
  const manager=getUser(managerYmis);
  if(!manager) return jsonResponse({success:false,error:'找不到管理員'});
  if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能更改系統管理員帳號的角色'});
  // super_admin 可以改任何人，admin 可以改團長/支部領袖/執委/成員，團長可改支部領袖/執委/成員，支部領袖可改執委/成員
  if(manager.role!=='super_admin' && !canManageRole(manager.role,newRole) && manager.role!=='admin') return jsonResponse({success:false,error:'權限不足，你的等級不可設定此角色'});
  // v8.7：團長全團只可有一位（換人流程：先將現任轉為其他角色，再升新人）
  if(newRole==='group_leader'){
    const cur=findActiveGroupLeader(targetYmis);
    if(cur) return jsonResponse({success:false,error:'團長只能有一位（現任：'+cur.name+' '+cur.ymis+'），如需更換請先將現任團長轉為其他角色'});
  }
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===targetYmis && data[i][11].toString()==='active'){
      sheet.getRange(i+1,4).setValue(newRole);
      sheet.getRange(i+1,7).setValue(canTick);
      sheet.getRange(i+1,8).setValue(managerYmis);
      sheet.getRange(i+1,9).setValue(now());
      // 處理細緻權限：若提供 allowedBadges，寫入第13欄
      if(sheet.getLastColumn()>=13){
        if(allowedBadges!==undefined && allowedBadges!==null){
          sheet.getRange(i+1,13).setValue(allowedBadges);
        } else {
          // 默認：領袖全部 (*)，成員無，執委默認 L1, L3-ACT, OTHER部分
          if(!data[i][12]){
            let def='*';
            if(newRole==='member') def='';
            else if(newRole==='exec_committee') def='L1,L3-ACT,OTHER';
            else def='*';
            sheet.getRange(i+1,13).setValue(def);
          }
        }
      }
      return jsonResponse({success:true});
    }
  }
  return jsonResponse({success:false,error:'找不到用戶'});
}
function handleUpdateConfig(key,value,ymis){
  const sheet=getSheet().getSheetByName('SystemConfig'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===key){ sheet.getRange(i+1,2).setValue(value); sheet.getRange(i+1,3).setValue(now()); sheet.getRange(i+1,4).setValue(ymis); return jsonResponse({success:true}); } }
  sheet.appendRow([key,value,now(),ymis]); return jsonResponse({success:true});
}
function handleGetConfig(){
  const sheet=getSheet().getSheetByName('SystemConfig');
  const cfg={};
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(data[i][0]) cfg[data[i][0].toString()]=data[i][1]?data[i][1].toString():'';
    }
  }
  // 默認值
  if(!cfg['allow_member_view_others']) cfg['allow_member_view_others']='false';
  return jsonResponse({success:true,config:cfg});
}
function getMembers(){
  const mSheet=getSheet().getSheetByName('成員名單'); const members=[];
  if(mSheet){ const data=mSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0]) members.push({ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',squad:data[i][5]?data[i][5].toString():''}); } }
  const uSheet=getSheet().getSheetByName('Users'); if(uSheet){ const data=uSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][11].toString()==='active' && data[i][0]){ const y=data[i][0].toString(); const role=data[i][3]?data[i][3].toString():'member'; if(role==='super_admin' || isSuperAdminId(y)) continue; if(!members.some(m=>m.ymis===y)){ members.push({ymis:y,name:data[i][1].toString(),squad:data[i][5]?data[i][5].toString():''}); } } } }
  return members;
}
function handleLoad(){
  const ss=getSheet();
  const pSheet=ss.getSheetByName('進度追蹤'); const progress={};
  if(pSheet){ const data=pSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const ymis=data[i][0].toString(); if(!ymis) continue; if(!progress[ymis]) progress[ymis]={}; progress[ymis][data[i][1].toString()]={date:data[i][2]?formatDate(data[i][2]):'',confirmer:data[i][4]?data[i][4].toString():''}; } }
  // 簡化版：同時提供 flat
  const flat={}; for(const y in progress){ flat[y]={}; for(const k in progress[y]){ flat[y][k]=progress[y][k].date; } }
  const members=getMembers();
  // pending requests
  const prSheet=ss.getSheetByName('待批完成'); const pending=[];
  if(prSheet){ const data=prSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ pending.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  // other badges
  const oSheet=ss.getSheetByName('其他獎章'); const other={};
  if(oSheet){ const data=oSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const y=data[i][0].toString(); if(!y) continue; if(!other[y]) other[y]={}; other[y][data[i][1].toString()]={name:data[i][2]?data[i][2].toString():'',date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}; } }
  // v8.1：活動履歷（logsSupported 讓前端分辨後端是否已升級）
  const lSheet=ss.getSheetByName(LOG_SHEET_NAME);
  return jsonResponse({success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other,logs:getLogRecordsList(),logsSupported:!!lSheet});
}
function handleSave(changes, confirmer){
  const sheet=getSheet().getSheetByName('進度追蹤'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  let processed=0;
  changes.forEach(function(c){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){
      if(data[i][0].toString()===c.ymis && data[i][1].toString()===c.itemId){
        if(c.uncomplete){ sheet.deleteRow(i+1); } else { sheet.getRange(i+1,3).setValue(c.date); sheet.getRange(i+1,4).setValue(new Date()); sheet.getRange(i+1,5).setValue(confirmer||c.confirmer||''); sheet.getRange(i+1,6).setValue(c.note||''); }
        found=true; processed++; break;
      }
    }
    if(!found && !c.uncomplete){
      sheet.appendRow([c.ymis,c.itemId,c.date,new Date(),confirmer||c.confirmer||'',c.note||'']);
      processed++;
    }
  });
  return jsonResponse({success:true,processed:processed});
}
function handleAddMember(ymis,name,squad,squadRole){
  ymis=String(ymis||'').trim(); name=safeSheetText(name,100); squad=safeSheetText(squad,100);
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'不能新增系統管理員帳號'});
  if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  // v8.8：YMIS 全表唯一 —— 已有登入帳號（含停用）或已在名單都不可重複加入
  const uRow=findUserRowAnyStatus_(ymis);
  if(uRow) return jsonResponse({success:false,error:(uRow.status!=='active')?'此 YMIS 已有帳號紀錄（已停用），請在用戶管理恢復該帳號':'此 YMIS 已有登入帳號，請在用戶管理直接管理'});
  if(memberNameRowExists_(ymis)) return jsonResponse({success:false,error:'此 YMIS 已在成員名單，不可重複加入'});
  let sheet=getSheet().getSheetByName('成員名單');
  if(!sheet){ sheet=getSheet().insertSheet('成員名單'); sheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','備註']); }
  // 確保有 6 欄 header
  if(sheet.getLastColumn()<6){
    sheet.getRange(1,6).setValue('備註');
  }
  sheet.appendRow([ymis,name,new Date(),'','',squad||'']);
  return jsonResponse({success:true});
}
// 待批完成
function handleRequestComplete(body, requesterYmis){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const reqId='REQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  const user=getUser(requesterYmis)||{name:body.name||requesterYmis};
  sheet.appendRow([reqId,requesterYmis,user.name||body.name,body.itemId,body.itemName||body.itemId,body.requested_date||formatDate(new Date()),body.evidence||'','pending',now(),'','','', '']);
  return jsonResponse({success:true,request_id:reqId});
}
function handleGetPendingRequests(){
  const sheet=getSheet().getSheetByName('待批完成'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ list.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  return jsonResponse({success:true,requests:list});
}
function handleReviewRequest(reqId,decision,note,reviewer,confirmed_date){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const data=sheet.getDataRange().getValues(); let row=null;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===reqId){ row=data[i]; sheet.getRange(i+1,8).setValue(decision); sheet.getRange(i+1,10).setValue(reviewer); sheet.getRange(i+1,11).setValue(now()); sheet.getRange(i+1,12).setValue(note||''); sheet.getRange(i+1,13).setValue(confirmed_date||formatDate(new Date())); break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  if(decision==='approved'){
    const pSheet=getSheet().getSheetByName('進度追蹤');
    pSheet.appendRow([row[1],row[3],confirmed_date||row[5],new Date(),reviewer, '由申請轉入：'+(note||'')]);
    return jsonResponse({success:true,message:'已批准並寫入進度'});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleGetOtherBadges(ymis){
  const sheet=getSheet().getSheetByName('其他獎章'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0].toString()===ymis){ list.push({id:data[i][1].toString(),name:data[i][2].toString(),date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}); } } }
  return jsonResponse({success:true,other:list});
}
function handleSaveOtherBadge(records){
  const sheet=getSheet().getSheetByName('其他獎章'); if(!sheet) return jsonResponse({success:false,error:'Sheet missing'});
  let c=0;
  records.forEach(function(r){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){ if(data[i][0].toString()===r.ymis && data[i][1].toString()===r.badgeId){ sheet.getRange(i+1,3).setValue(r.date); sheet.getRange(i+1,4).setValue(r.cert||''); sheet.getRange(i+1,5).setValue(r.note||''); sheet.getRange(i+1,6).setValue(new Date()); found=true; c++; break; } }
    if(!found){ sheet.appendRow([r.ymis,r.badgeId,r.name||r.badgeId,r.date,r.cert||'',r.note||'',new Date()]); c++; }
  });
  return jsonResponse({success:true,processed:c});
}

// ================== v5.0 全前端控制 (向後兼容) ==================
// 寫入操作紀錄 (若無 audit 表則自動建)
function writeAudit(actor,action,target,detail){
  try{
    const ss=getSheet();
    let sh=ss.getSheetByName('操作紀錄');
    if(!sh){ sh=ss.insertSheet('操作紀錄'); sh.appendRow(['時間','操作者','操作','對象','詳情']); sh.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF'); sh.setFrozenRows(1); }
    // 超管做嘅操作只記顯示名稱，唔記帳號（整份 Sheet 都搵唔到超管帳號）
    const who=isSuperAdminId(actor)?SUPER_ADMIN_NAME:(actor||'');
    sh.appendRow([now(),who,action||'',target||'',detail||'']);
  }catch(e){ console.warn('writeAudit failed',e); }
}
// 重設密碼 - 生成一次性臨時密碼；v8.8：領袖可附 new_password 自設密碼（≥4位，首次登入須更改）
function handleResetPassword(targetYmis,managerYmis,newPassword){
  try{
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    if(!targetYmis) return jsonResponse({success:false,error:'請提供目標 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能重設系統管理員密碼'});
    if(String(targetYmis)===String(managerYmis)) return jsonResponse({success:false,error:'不能重設自己的密碼，請聯絡其他管理員'});
    const custom=(newPassword!==undefined && newPassword!==null && String(newPassword).length>0) ? String(newPassword) : '';
    if(custom && custom.length<4) return jsonResponse({success:false,error:'新密碼至少4位'});
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(targetYmis)){
        if(custom){
          sh.getRange(i+1,5).setValue(hashPassword(custom));
          ensureForceChangeCol(sh);
          sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
          writeAudit(managerYmis,'set_password',targetYmis,'領袖自設密碼（首次登入須更改）');
          return jsonResponse({success:true,message:'已設定新密碼，請通知用戶首次登入後更改密碼'});
        }
        const temp='Rover'+Math.floor(100000+Math.random()*900000);
        sh.getRange(i+1,5).setValue(hashPassword(temp));
        ensureForceChangeCol(sh);
        sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
        writeAudit(managerYmis,'reset_password',targetYmis,'重設為一次性密碼: '+temp);
        return jsonResponse({success:true,temp_password:temp,message:'已重設，請通知用戶首次登入後更改密碼'});
      }
    }
    return jsonResponse({success:false,error:'找不到此 YMIS'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// v8.8：自助找回密碼（公開 action，不需 token）
// 有登記 Email → 產生臨時密碼並電郵寄出；冇 Email → 請聯絡領袖（領袖可在用戶管理自設密碼）
function handleForgotPassword(loginId){
  try{
    loginId=String(loginId||'').trim();
    if(!loginId) return jsonResponse({success:false,error:'請填寫 YMIS 或電郵'});
    if(isSuperAdminId(loginId)) return jsonResponse({success:false,error:'此帳號不能使用自助找回密碼'});
    let user=null;
    if(/^\d{10}$/.test(loginId) || /^L\d+/i.test(loginId)) user=getUser(loginId);
    else if(loginId.indexOf('@')>=0) user=getUserByEmail(loginId);
    else user=getUser(loginId)||getUserByEmail(loginId);
    if(!user) return jsonResponse({success:false,error:'找不到此帳號，請檢查 YMIS／電郵是否正確'});
    const email=String(user.email||'').trim();
    if(!email) return jsonResponse({success:false,error:'此帳號未登記電郵，無法自助找回密碼，請聯絡領袖重設密碼'});
    // 輕量節流：同一帳號 60 秒內只可請求一次（防濫發電郵）
    try{
      const props=PropertiesService.getScriptProperties();
      const key='FORGOT_'+user.ymis;
      const last=parseInt(props.getProperty(key)||'0',10)||0;
      if(Date.now()-last<60000) return jsonResponse({success:false,error:'請求過於頻密，請稍候一分鐘再試'});
      props.setProperty(key,String(Date.now()));
    }catch(e){}
    const temp='Rover'+Math.floor(100000+Math.random()*900000);
    const subject='【樂行童軍進度系統】臨時密碼';
    const bodyText='你好 '+user.name+'：\n\n你於樂行童軍進度追蹤系統申請了自助找回密碼。\n臨時密碼：'+temp+'\n\n請盡快登入，系統會要求你設定新密碼（至少4位）。\n如非本人操作，請聯絡你的旅團領袖。\n\n— 樂行童軍進度追蹤系統';
    // 先寄信、後改密碼：寄信失敗則密碼不變，用戶仍可用舊密碼
    try{
      MailApp.sendEmail(email,subject,bodyText);
    }catch(e){
      return jsonResponse({success:false,error:'郵件發送失敗，請聯絡領袖重設密碼'});
    }
    const sh=getSheet().getSheetByName('Users');
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(user.ymis) && String(data[i][11])==='active'){
        sh.getRange(i+1,5).setValue(hashPassword(temp));
        ensureForceChangeCol(sh);
        sh.getRange(i+1,FORCE_CHANGE_COL).setValue(true);
        break;
      }
    }
    try{ writeAudit(user.ymis,'forgot_password',user.ymis,'自助找回密碼（電郵已寄出）'); }catch(e){}
    return jsonResponse({success:true,message:'臨時密碼已發送到你的登記電郵，請查收後登入並設定新密碼',email_hint:maskEmail_(email)});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 開立可登入帳號
function handleAddUser(body,mgr){
  try{
    let ymis=(body.ymis||'').toString().trim();
    const name=(body.name||'').toString().trim();
    const email=(body.email||'').toString().trim();
    const role=(body.role||'member').toString().trim();
    const password=(body.password||'').toString();
    const squad=(body.squad||'').toString().trim();
    const canTick=body.can_tick===true||body.can_tick==='true'||body.can_tick==='TRUE';
    if(VALID_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效的角色: '+role});
    if(!canManageUser(mgr,role)) return jsonResponse({success:false,error:'權限不足，你的等級不可開立此角色'});
    // 領袖免 YMIS（用電郵登入）—— 留空且有 Email 即自動編配內部 L 編號
    if(!ymis && role!=='member'){
      if(!email) return jsonResponse({success:false,error:'領袖開戶必須填寫 Email（用作登入帳號）'});
      ymis=generateLeaderId();
    }
    if(!/^(\d{10}|L\d+)$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字（領袖可留空，會自動編配）'});
    if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
    if(email && !isValidEmail_(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
    if(isSuperAdminId(ymis) || isSuperAdminId(email)) return jsonResponse({success:false,error:'不能新增系統管理員帳號'});
    // v8.8：YMIS／Email 全表唯一（含已停用帳號，不可重複開戶）
    if(ymisTakenAnyStatus_(ymis)){
      const ex=findUserRowAnyStatus_(ymis);
      return jsonResponse({success:false,error:(ex && ex.status!=='active')?'此 YMIS 已有帳號紀錄（已停用），請恢復該帳號而非重新開戶':'此 YMIS 已註冊，不可重複開戶'});
    }
    if(email){
      const em=emailTakenAnyStatus_(email,'');
      if(em) return jsonResponse({success:false,error:(em.status!=='active')?'此 Email 已有帳號紀錄（已停用：'+em.ymis+'），請恢復該帳號而非重新開戶':'此 Email 已被 '+em.ymis+' 使用，不可重複開戶'});
    }
    if(role==='group_leader'){
      const cur=findActiveGroupLeader('');
      if(cur) return jsonResponse({success:false,error:'團長只能有一位（現任：'+cur.name+' '+cur.ymis+'），如需更換請先將現任團長轉為其他角色'});
    }
    const uSheet=getSheet().getSheetByName('Users');
    if(!uSheet) return jsonResponse({success:false,error:'Users 工作表不存在'});
    ensureForceChangeCol(uSheet);
    const nowStr=now();
    const usedDefault=!password || password===DEFAULT_PASS;
    const pwdHash = hashPassword(password||DEFAULT_PASS);
    const allowedBadges = role==='member' ? '' : (role==='exec_committee' ? 'L1,活動段章,OTHER' : '*');
    uSheet.appendRow([
      ymis,
      name,
      email,
      role,
      pwdHash,
      squad,
      canTick,
      (mgr&&mgr.ymis)||'bulk_onboard',
      nowStr,
      nowStr,
      '',
      'active',
      allowedBadges,
      usedDefault
    ]);
    let mSheet=getSheet().getSheetByName('成員名單');
    if(!mSheet){
      mSheet=getSheet().insertSheet('成員名單');
      mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','備註']);
    }
    // v8.8：名單已有此 YMIS（純名單成員升級為登入帳號）就不重複加列，只更新姓名
    const mRow=memberNameRowExists_(ymis);
    if(mRow) mSheet.getRange(mRow.row,2).setValue(name);
    else mSheet.appendRow([ymis, name, new Date(), '', '', squad]);
    writeAudit((mgr&&mgr.ymis)||'','add_user',ymis,'前端開立帳號 role='+role);
    return jsonResponse({success:true,message:'帳號已建立'+(usedDefault?'（預設密碼：'+DEFAULT_PASS+'，首次登入須更改）':'（已設密碼）'),ymis:ymis});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 停用帳號 - 設 status=inactive，清除 tokens，保留資料
function handleDeactivateUser(body,manager,managerYmis){
  try{
    const targetYmis=(body.target_ymis||'').toString().trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能停用系統管理員帳號'});
    if(targetYmis===managerYmis) return jsonResponse({success:false,error:'不能停用自己'});
    const target=getUser(targetYmis);
    if(!target) return jsonResponse({success:false,error:'找不到此用戶'});
    // 權限檢查：不能停用比自己高等級的用戶
    if(getRoleLevel(manager.role)<getRoleLevel(target.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能停用比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(targetYmis) && data[i][11]==='active'){
        sh.getRange(i+1,12).setValue('inactive');
        // 清除此用戶的 tokens
        try{
          const tSheet=getSheet().getSheetByName('Tokens');
          if(tSheet){
            const td=tSheet.getDataRange().getValues();
            for(let j=td.length-1;j>=1;j--){
              if(td[j][1] && String(td[j][1])===String(targetYmis)) tSheet.deleteRow(j+1);
            }
          }
        }catch(e){ console.warn('clear tokens failed',e); }
        // 從成員名單移除 (但保留歷史)
        try{
          const mSheet=getSheet().getSheetByName('成員名單');
          if(mSheet){
            const md=mSheet.getDataRange().getValues();
            for(let k=md.length-1;k>=1;k--){
              if(md[k][0] && String(md[k][0])===String(targetYmis)) mSheet.deleteRow(k+1);
            }
          }
        }catch(e){ console.warn('clear member list failed',e); }
        writeAudit(managerYmis,'deactivate_user',targetYmis,'停用帳號');
        return jsonResponse({success:true,message:'已停用 '+targetYmis+'，token 已清除'});
      }
    }
    return jsonResponse({success:false,error:'找不到活躍用戶'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// v8.8：恢復已停用帳號（停用時佔用的 YMIS／Email 保留，重用請恢復而非重開）
function handleReactivateUser(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能操作系統管理員帳號'});
    const row=findUserRowAnyStatus_(targetYmis);
    if(!row) return jsonResponse({success:false,error:'找不到此用戶'});
    if(row.role==='super_admin') return jsonResponse({success:false,error:'不能操作系統管理員帳號'});
    if(row.status==='active') return jsonResponse({success:false,error:'此帳號已是啟用狀態'});
    if(getRoleLevel(manager.role)<getRoleLevel(row.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能恢復比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    sh.getRange(row.row,12).setValue('active');
    // 恢復後同步補回成員名單（停用時曾被移除）
    try{
      if(!memberNameRowExists_(targetYmis)){
        let mSheet=getSheet().getSheetByName('成員名單');
        if(!mSheet){ mSheet=getSheet().insertSheet('成員名單'); mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','備註']); }
        mSheet.appendRow([targetYmis,row.name,new Date(),'','', '']);
      }
    }catch(e){}
    writeAudit(managerYmis,'reactivate_user',targetYmis,'恢復已停用帳號');
    return jsonResponse({success:true,message:'已恢復 '+targetYmis+'，該用戶可重新登入'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// v8.8：修改帳號資料（姓名／電郵／備註；電郵全表唯一）
// 目標無登入帳號但在成員名單 → 改名單（姓名／備註），方便管理純名單成員
function handleUpdateUserProfile(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能修改系統管理員帳號'});
    const row=findUserRowAnyStatus_(targetYmis);
    // 純名單成員（無登入帳號）：改名單
    if(!row){
      if(body.email!==undefined && body.email!==null && String(body.email).trim()!=='') return jsonResponse({success:false,error:'純名單成員沒有登入帳號，如需電郵登入請先開立登入帳號'});
      const mRow=memberNameRowExists_(targetYmis);
      if(!mRow) return jsonResponse({success:false,error:'找不到此用戶'});
      const mSheet=getSheet().getSheetByName('成員名單');
      const changed=[];
      if(body.name!==undefined && body.name!==null && String(body.name).trim()!==''){
        const nm=safeSheetText(body.name,60);
        if(!nm) return jsonResponse({success:false,error:'姓名不可為空'});
        mSheet.getRange(mRow.row,2).setValue(nm);
        changed.push('姓名');
      }
      if(body.branch!==undefined && body.branch!==null){
        if(mSheet.getLastColumn()<6) mSheet.getRange(1,6).setValue('備註');
        mSheet.getRange(mRow.row,6).setValue(safeSheetText(body.branch,100));
        changed.push('備註');
      }
      if(changed.length===0) return jsonResponse({success:false,error:'沒有變更'});
      writeAudit(managerYmis,'update_member',targetYmis,'修改純名單成員：'+changed.join('、'));
      return jsonResponse({success:true,message:'已更新 '+changed.join('、')});
    }
    if(row.role==='super_admin') return jsonResponse({success:false,error:'不能修改系統管理員帳號'});
    if(row.status!=='active') return jsonResponse({success:false,error:'此帳號已停用，請先恢復再修改'});
    if(getRoleLevel(manager.role)<getRoleLevel(row.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能修改比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    const changed=[];
    if(body.name!==undefined && body.name!==null && String(body.name).trim()!==''){
      const nm=safeSheetText(body.name,100);
      if(!nm) return jsonResponse({success:false,error:'姓名不可為空'});
      if(nm!==row.name){
        sh.getRange(row.row,2).setValue(nm);
        changed.push('姓名');
        try{
          const mRow2=memberNameRowExists_(targetYmis);
          if(mRow2) getSheet().getSheetByName('成員名單').getRange(mRow2.row,2).setValue(nm);
        }catch(e){}
      }
    }
    if(body.email!==undefined && body.email!==null){
      const em=String(body.email).trim();
      if(em && !isValidEmail_(em)) return jsonResponse({success:false,error:'Email 格式不正確'});
      if(isSuperAdminId(em)) return jsonResponse({success:false,error:'此 Email 已被保留'});
      if(em!==row.email){
        if(em){
          const taken=emailTakenAnyStatus_(em,targetYmis);
          if(taken) return jsonResponse({success:false,error:'此 Email 已被 '+taken.ymis+' 使用，不可重複'});
        }
        sh.getRange(row.row,3).setValue(em);
        changed.push('電郵');
      }
    }
    if(body.branch!==undefined && body.branch!==null){
      sh.getRange(row.row,6).setValue(safeSheetText(body.branch,100));
      changed.push('備註');
    }
    if(changed.length===0) return jsonResponse({success:false,error:'沒有變更'});
    writeAudit(managerYmis,'update_profile',targetYmis,'修改：'+changed.join('、'));
    return jsonResponse({success:true,message:'已更新 '+changed.join('、')});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// v8.8：刪除純名單成員（無登入帳號者；有帳號一律走停用／徹底刪除流程；進度紀錄保留）
function handleDeleteMember(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能刪除系統管理員帳號'});
    const uRow=findUserRowAnyStatus_(targetYmis);
    if(uRow) return jsonResponse({success:false,error:(uRow.status==='active')?'此成員已有登入帳號，請在用戶管理停用該帳號':'此成員已有帳號紀錄（已停用），請在用戶管理恢復或徹底刪除該帳號'});
    const mRow=memberNameRowExists_(targetYmis);
    if(!mRow) return jsonResponse({success:false,error:'在成員名單找不到此 YMIS'});
    const mSheet=getSheet().getSheetByName('成員名單');
    mSheet.deleteRow(mRow.row);
    writeAudit(managerYmis,'delete_member',targetYmis,'刪除純名單成員（進度紀錄保留）');
    return jsonResponse({success:true,message:'已刪除成員 '+targetYmis+'（進度紀錄保留）'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// v8.8：徹底刪除已停用帳號（需團長以上；必須先停用；進度紀錄保留，釋放 YMIS／Email）
function handleDeleteUser(body,manager,managerYmis){
  try{
    const targetYmis=String(body.target_ymis||'').trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'不能刪除系統管理員帳號'});
    if(String(targetYmis)===String(managerYmis)) return jsonResponse({success:false,error:'不能刪除自己'});
    const row=findUserRowAnyStatus_(targetYmis);
    if(!row) return jsonResponse({success:false,error:'找不到此用戶'});
    if(row.role==='super_admin') return jsonResponse({success:false,error:'不能刪除系統管理員帳號'});
    if(row.status==='active') return jsonResponse({success:false,error:'請先停用此帳號，再徹底刪除'});
    if(getRoleLevel(manager.role)<getRoleLevel(row.role) && manager.role!=='super_admin') return jsonResponse({success:false,error:'權限不足，不能刪除比您高等級的用戶'});
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    sh.deleteRow(row.row);
    try{
      const tSheet=getSheet().getSheetByName('Tokens');
      if(tSheet){
        const td=tSheet.getDataRange().getValues();
        for(let j=td.length-1;j>=1;j--){
          if(td[j][1] && String(td[j][1])===String(targetYmis)) tSheet.deleteRow(j+1);
        }
      }
    }catch(e){}
    writeAudit(managerYmis,'delete_user',targetYmis,'徹底刪除已停用帳號（進度紀錄保留）');
    return jsonResponse({success:true,message:'已徹底刪除 '+targetYmis+'（進度紀錄保留）'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}

// ===== v8.1：活動履歷（服務／活動／訓練班紀錄） =====
function getLogRecordsList(){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME); const logs=[];
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0]) continue;
      logs.push({
        record_id:String(data[i][0]), type:String(data[i][1]||'activity'),
        ymis:String(data[i][2]||''), name:String(data[i][3]||''),
        date:data[i][4]?formatDate(data[i][4]):'', title:String(data[i][5]||''),
        role:String(data[i][6]||''), hours:String(data[i][7]||''),
        cert_no:String(data[i][8]||''), detail:String(data[i][9]||''),
        recorder:String(data[i][10]||''),
        recorded_at:data[i][11]?String(data[i][11]):''
      });
    }
  }
  return logs;
}
function handleGetLogRecords(){
  // 未升級/未初始化時明確報錯，讓前端顯示升級提示
  if(!getSheet().getSheetByName(LOG_SHEET_NAME)) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  return jsonResponse({success:true,logs:getLogRecordsList()});
}
function sanitizeLogRecord(r){
  r=r||{};
  let type = LOG_TYPES.indexOf(r.type)>=0 ? r.type : 'activity';
  let role = safeSheetText(r.role,60);
  if(type==='training' && !role){
    role='學員';
  }
  return {
    type: type,
    ymis: String(r.ymis||'').trim().substring(0,20),
    name: safeSheetText(r.name,60),
    date: String(r.date||'').substring(0,20),
    title: safeSheetText(r.title,120),
    role: role,
    hours: String(r.hours==null?'':r.hours).substring(0,20),
    cert_no: safeSheetText(r.cert_no,60),
    detail: safeSheetText(r.detail,500)
  };
}
function handleSaveLogRecord(records, recorderYmis, recorderName){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  if(!Array.isArray(records)||records.length===0) return jsonResponse({success:false,error:'沒有可儲存的紀錄'});
  if(records.length>200) return jsonResponse({success:false,error:'一次最多 200 筆，請分批'});
  const results=[]; let processed=0;
  records.forEach(function(r){
    const rec=sanitizeLogRecord(r);
    if(!rec.ymis||!rec.title||!rec.date){ results.push({success:false,ymis:rec.ymis,title:rec.title,error:'YMIS、名稱及日期必填'}); return; }
    const rid=String((r&&r.record_id)||'');
    if(rid){
      // 更新既有紀錄（record_id 不變）
      const data=sheet.getDataRange().getValues();
      for(let i=1;i<data.length;i++){
        if(String(data[i][0])===rid){
          sheet.getRange(i+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,sheet.getRange(i+1,11).getValue()||recorderName||recorderYmis,String(data[i][11]||''),now()]]);
          results.push({success:true,record_id:rid}); processed++;
          writeAudit(recorderYmis,'update_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
          return;
        }
      }
      results.push({success:false,record_id:rid,error:'找不到紀錄'}); return;
    }
    const newId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    sheet.appendRow([newId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorderName||recorderYmis,now(),'']);
    results.push({success:true,record_id:newId}); processed++;
    writeAudit(recorderYmis,'add_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
  });
  const failed=results.filter(function(x){return !x.success;}).length;
  return jsonResponse({success:(results.length>0&&failed===0),processed:processed,results:results,message:processed+' 筆已儲存'+(failed?'，'+failed+' 筆失敗':'')});
}
function handleDeleteLogRecord(recordId, recorderYmis){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  recordId=String(recordId||'');
  if(!recordId) return jsonResponse({success:false,error:'缺少 record_id'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0])===recordId){
      const label=String(data[i][1]||'')+': '+String(data[i][5]||'')+' '+String(data[i][4]||'');
      const target=String(data[i][2]||'');
      sheet.deleteRow(i+1);
      writeAudit(recorderYmis,'delete_log',target,label);
      return jsonResponse({success:true,message:'已刪除紀錄'});
    }
  }
  return jsonResponse({success:false,error:'找不到紀錄'});
}

// ===== v8.2：活動履歷 - 成員自行申報 → 領袖審批 =====
function getPendingLogRequestsList(viewYmis, isLeader){
  const sheet=getSheet().getSheetByName(LOG_PENDING_SHEET_NAME); const list=[];
  if(!sheet) return list;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(!data[i][0]) continue;
    if(!isLeader && String(data[i][3])!==String(viewYmis)) continue; // 成員只看到自己的申請
    list.push({
      request_id:String(data[i][0]),
      record_id:String(data[i][1]||''),
      type:String(data[i][2]||'activity'),
      ymis:String(data[i][3]||''),
      name:String(data[i][4]||''),
      date:data[i][5]?formatDate(data[i][5]):'',
      title:String(data[i][6]||''),
      role:String(data[i][7]||''),
      hours:String(data[i][8]||''),
      cert_no:String(data[i][9]||''),
      detail:String(data[i][10]||''),
      status:String(data[i][11]||'pending'),
      requested_at:data[i][12]?String(data[i][12]):'',
      submitted_by:String(data[i][13]||''),
      reviewed_by:String(data[i][14]||''),
      reviewed_at:data[i][15]?String(data[i][15]):'',
      review_note:String(data[i][16]||''),
      submission_type:String(data[i][17]||'new')
    });
  }
  return list;
}
function handleGetPendingLogRequests(user){
  if(!getSheet().getSheetByName(LOG_PENDING_SHEET_NAME)) return jsonResponse({success:false,error:'「'+LOG_PENDING_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const isLeader=canUserTick(user.role);
  return jsonResponse({success:true,requests:getPendingLogRequestsList(user.ymis, isLeader),canApprove:isLeader});
}
function handleSubmitLogRequest(body, requesterYmis, user){
  const sheet=getSheet().getSheetByName(LOG_PENDING_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_PENDING_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  let rows=[];
  if(body.record_id){
    // 修改既有（已批）紀錄：重新待批
    const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
    if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在'});
    let found=false, origYmis='';
    const ld=lSheet.getDataRange().getValues();
    for(let i=1;i<ld.length;i++){ if(String(ld[i][0])===String(body.record_id)){ found=true; origYmis=String(ld[i][2]||''); break; } }
    if(!found) return jsonResponse({success:false,error:'找不到原有紀錄'});
    if(String(origYmis)!==String(requesterYmis)) return jsonResponse({success:false,error:'只能申請修改自己的紀錄'});
    // 防止重複待批修改
    const pd=sheet.getDataRange().getValues();
    for(let i=1;i<pd.length;i++){ if(String(pd[i][1])===String(body.record_id) && String(pd[i][11])==='pending') return jsonResponse({success:false,error:'此紀錄已有待批的修改申請'});
    }
    const d=body.data||{};
    const rec=sanitizeLogRecord({...d, ymis:origYmis});
    rows.push({record_id:String(body.record_id),type:rec.type,ymis:rec.ymis,name:user.name||'',date:rec.date,title:rec.title,role:rec.role,hours:rec.hours,cert_no:rec.cert_no,detail:rec.detail,submission_type:'edit'});
  }else{
    // 新增申報
    const records=Array.isArray(body.records)?body.records:[];
    if(records.length===0) return jsonResponse({success:false,error:'沒有可申報的紀錄'});
    if(records.length>20) return jsonResponse({success:false,error:'一次最多 20 筆，請分批'});
    records.forEach(function(r){
      const rec=sanitizeLogRecord(r);
      rows.push({record_id:'',type:rec.type,ymis:rec.ymis,name:user.name||'',date:rec.date,title:rec.title,role:rec.role,hours:rec.hours,cert_no:rec.cert_no,detail:rec.detail,submission_type:'new'});
    });
  }
  // 驗證只能申報自己的紀錄
  const selfCheck=rows.filter(function(r){ return String(r.ymis)!==String(requesterYmis); });
  if(selfCheck.length>0) return jsonResponse({success:false,error:'只能申報自己的活動履歷'});
  const validCheck=rows.filter(function(r){ return !r.ymis||!r.title||!r.date; });
  if(validCheck.length>0) return jsonResponse({success:false,error:'YMIS、名稱及日期必填'});
  const results=[]; let processed=0;
  rows.forEach(function(r){
    const rid='LOGRQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    sheet.appendRow([rid,r.record_id,r.type,r.ymis,r.name,r.date,r.title,r.role,r.hours,r.cert_no,r.detail,'pending',now(),requesterYmis,'','','',r.submission_type]);
    results.push({success:true,request_id:rid}); processed++;
    writeAudit(requesterYmis,'submit_log_request',r.ymis,(r.submission_type==='edit'?'修改':'申報')+': '+r.type+' '+r.title+' '+r.date);
  });
  return jsonResponse({success:true,processed:processed,results:results,message:processed+' 筆已送交審批'});
}
function handleReviewLogRequest(reqId, decision, reviewer, note){
  const sheet=getSheet().getSheetByName(LOG_PENDING_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_PENDING_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const data=sheet.getDataRange().getValues(); let row=null, rowIndex=null;
  for(let i=1;i<data.length;i++){ if(String(data[i][0])===String(reqId)){ row=data[i]; rowIndex=i+1; break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  if(String(row[11])!=='pending') return jsonResponse({success:false,error:'此申請已處理'});
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決策'});
  // 更新狀態
  sheet.getRange(rowIndex,12).setValue(decision);
  sheet.getRange(rowIndex,15).setValue(reviewer);
  sheet.getRange(rowIndex,16).setValue(now());
  sheet.getRange(rowIndex,17).setValue(note||'');
  if(decision==='rejected'){
    writeAudit(reviewer,'review_log_request',row[3]||'','拒絕: '+row[6]+' '+row[5]);
    return jsonResponse({success:true,message:'已拒絕申請'});
  }
  // approved：寫入 活動履歷
  const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在'});
  const rec={
    type:String(row[2]||'activity'),
    ymis:String(row[3]||''),
    name:String(row[4]||''),
    date:String(row[5]||''),
    title:String(row[6]||''),
    role:String(row[7]||''),
    hours:String(row[8]||''),
    cert_no:String(row[9]||''),
    detail:String(row[10]||'')
  };
  const submissionType=String(row[17]||'new');
  const submittedBy=String(row[13]||reviewer);
  let newRecordId='';
  if(submissionType==='edit' && String(row[1]||'')){
    // 更新原有紀錄（record_id 不變）
    const oldId=String(row[1]);
    const ld=lSheet.getDataRange().getValues();
    let updated=false;
    for(let i=1;i<ld.length;i++){
      if(String(ld[i][0])===oldId){
        lSheet.getRange(i+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,submittedBy,String(ld[i][11]||''),now()]]);
        updated=true; newRecordId=oldId; break;
      }
    }
    if(!updated) return jsonResponse({success:false,error:'原有紀錄不存在，請先聯絡領袖處理'});
  }else{
    newRecordId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    lSheet.appendRow([newRecordId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,submittedBy,now(),'']);
  }
  // 將 record_id 回填到待批表
  sheet.getRange(rowIndex,2).setValue(newRecordId);
  writeAudit(reviewer,'approve_log_request',rec.ymis,rec.type+': '+rec.title+' '+rec.date+' -> '+newRecordId);
  return jsonResponse({success:true,message:'已批准並寫入活動履歷',record_id:newRecordId});
}
