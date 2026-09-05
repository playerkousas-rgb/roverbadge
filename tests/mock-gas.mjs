// Mock GAS /exec 伺服器（測試專用）
// 模擬真實 GAS 行為：
//   - POST/GET /exec 一律 302 redirect 到 /usercontent/<rid>（模擬 script.google.com → script.googleusercontent.com）
//   - 路由 action 與 Code.gs 相同，回應 JSON
//   - 可用 /__control 切換故障模式：html-error / http500 / slow
//   - 獨立 in-memory store，方便驗證多旅團隔離
import http from 'http';

export function startMockGas({ port, name, users, apikey = '' }) {
  const state = {
    name,
    users: {},                    // ymis -> {ymis,name,email,role,pass,can_tick,status}
    tokens: {},                   // token -> ymis
    progress: {},                 // ymis -> {itemId:{date,confirmer}}
    otherBadges: {},              // ymis -> {badgeId:{name,date,cert}}
    requests: [],                 // {request_id,ymis,name,item_id,item_name,requested_date,evidence,status}
    applications: [],
    roster: {},                   // v8.8 成員名單（純名單成員，無登入帳號）：ymis -> {ymis,name,squad}
    sentEmails: [],               // v8.8 forgotPassword 寄出的郵件（測試觀測用）
    forgotThrottle: {},           // v8.8 自助找回密碼節流：ymis -> 上次請求時間
    logs: [],                      // v8.1 活動履歷
    config: { allow_member_view_others: 'false' },
    apikey,
    mode: 'normal',               // normal | html-error | http500 | slow
    slowMs: 0,
    lastExecPath: '',             // 觀測上游實際被打的 URL（SSRF 測試用）
    execCount: 0,
    received: []                  // 每次 /exec 的 {method, action}，用黎驗證 GET/POST 路由啱唔啱

  };
  for (const u of users) state.users[u.ymis] = { status: 'active', email: '', ...u };

  const pendingRedirects = new Map(); // rid -> payload

  // 系統管理帳號 (super_admin)：與真實後端 Code.gs v8.6 一致 —
  // 憑證只存在於 Code.gs（不存於 Sheet），任何名單／回應都不會出現
  const superAdminUser = () => 'sh' + 'eep';
  const superAdminPass = () => '07' + '28';
  const isSuperAdminId = (y) => String(y || '').trim().toLowerCase() === superAdminUser();
  // Users 表殘留列一律不顯示（角色為 super_admin，或 YMIS 與超管帳號相同）
  const isHiddenRow = (u) => u.role === 'super_admin' || isSuperAdminId(u.ymis);

  // 真實 Code.gs 嘅分工：doGet 只認 load / getLoginMode，其餘 action 只存在於 doPost。
  // 呢度必須照做 —— 否則「proxy 誤用 POST 打 load」呢類 bug 喺測試入面永遠唔會浮現
  // （scoutbadge 2026-08 就係咁：登入 OK、load 變 Unknown action、前端顯示「離線模式」）。
  const GET_ONLY_ACTIONS = new Set(['load', 'getLoginMode']);
  const VALID_ROLES = ['member', 'exec_committee', 'branch_leader', 'group_leader', 'admin'];
  const APPLY_ROLES = ['member', 'branch_leader'];
  const CAN_MANAGE_ROLES = {
    super_admin: ['admin', 'group_leader', 'branch_leader', 'exec_committee', 'member'],
    admin: ['group_leader', 'branch_leader', 'exec_committee', 'member'],
    group_leader: ['branch_leader', 'exec_committee', 'member'],
    branch_leader: ['exec_committee', 'member']
  };
  const managerOf = (tokenYmis, validKey) => {
    if (isSuperAdminId(tokenYmis)) return { ymis: superAdminUser(), role: 'super_admin' };
    if (tokenYmis && state.users[tokenYmis]) return state.users[tokenYmis];
    if (validKey) return { role: 'admin' };
    return null;
  };
  const canManageUser = (mgr, role) => mgr && (mgr.role === 'super_admin' || (CAN_MANAGE_ROLES[mgr.role] || []).includes(role));
  const findActiveGsl = (exclude) => Object.values(state.users).find(u => u.role === 'group_leader' && u.status !== 'inactive' && u.ymis !== exclude);
  // v8.8：與真實 Code.gs 一致的唯一性／名單 helpers
  const ROLE_LEVEL = { super_admin: 100, admin: 80, group_leader: 60, branch_leader: 40, exec_committee: 20, member: 0 };
  const normEmail = (e) => String(e || '').trim().toLowerCase();
  const emailTaken = (email, excludeYmis) => {
    const t = normEmail(email);
    if (!t) return null;
    return Object.values(state.users).find(u => u.ymis !== excludeYmis && normEmail(u.email) === t) || null;
  };
  // 合併名單（Users active ＋ 純名單 roster），與真實 getMembers() 一致
  const mergedMembers = () => {
    const out = [];
    const seen = new Set();
    for (const u of Object.values(state.users)) {
      if (u.status === 'inactive' || isHiddenRow(u)) continue;
      seen.add(u.ymis);
      out.push({ ymis: u.ymis, name: u.name, role: u.role, squad: u.squad || '' });
    }
    for (const r of Object.values(state.roster)) {
      if (seen.has(r.ymis) || isSuperAdminId(r.ymis)) continue;
      out.push({ ymis: r.ymis, name: r.name, squad: r.squad || '' });
    }
    return out;
  };
  const maskEmail = (email) => {
    const e = String(email || '').trim();
    const at = e.indexOf('@');
    if (at <= 0) return '***';
    const nm = e.substring(0, at), domain = e.substring(at);
    if (nm.length <= 2) return nm.charAt(0) + '*' + domain;
    return nm.charAt(0) + '***' + nm.charAt(nm.length - 1) + domain;
  };

  function routeAction(action, body) {
    const validKey = state.apikey && body.apikey === state.apikey;
    const tokenYmis = body.token && state.tokens[body.token] ? state.tokens[body.token] : null;
    switch (action) {
      case 'login': {
        // 系統管理帳號：憑證只存在於 Code.gs（與真實後端一致）
        if (isSuperAdminId(body.login_id) && String(body.password || '') === superAdminPass()) {
          const su = superAdminUser();
          const token = 'tok_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
          state.tokens[token] = su;
          return { success: true, token, user: { ymis: su, name: '系統管理員', role: 'super_admin', can_tick: true, email: '' } };
        }
        const loginKey = String(body.login_id || '').trim();
        const u = state.users[loginKey] || Object.values(state.users).find(x => x.email && normEmail(x.email) === normEmail(loginKey));
        if (!u || u.status === 'inactive') return { success: false, error: '找不到此帳號或帳號已停用' };
        if (u.pass !== String(body.password || '')) return { success: false, error: '密碼錯誤' };
        const token = 'tok_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        state.tokens[token] = u.ymis;
        return { success: true, token, user: { ymis: u.ymis, name: u.name, role: u.role, can_tick: u.can_tick, allowed_badges: '*' }, force_change_password: !!u.force_change_password };
      }
      case 'logout': {
        delete state.tokens[body.token];
        return { success: true };
      }
      case 'apply': {
        const role = body.requested_role || 'member';
        if (!APPLY_ROLES.includes(role)) return { success: false, error: '無效的申請角色' };
        // v8.8：YMIS／Email 全表唯一（含已停用）＋待批重複檢查（與真實 handleApply 一致）
        const aYmis = String(body.ymis || '').trim();
        const aEmail = String(body.email || '').trim();
        if (role === 'member' && !/^\d{10}$/.test(aYmis)) return { success: false, error: '成員需 10位 YMIS' };
        if (role !== 'member' && !aEmail) return { success: false, error: '領袖申請必須填寫聯絡電郵' };
        if (aEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(aEmail)) return { success: false, error: 'Email 格式不正確' };
        if (isSuperAdminId(aYmis) || isSuperAdminId(aEmail)) return { success: false, error: '此帳號已被保留，請使用其他帳號' };
        const effYmis = role === 'member' ? aYmis : '';
        if (effYmis && state.users[effYmis]) {
          const ex = state.users[effYmis];
          return { success: false, error: ex.status === 'inactive' ? '此 YMIS 已有帳號紀錄（已停用），請聯絡領袖恢復帳號，不需重新申請' : '此 YMIS 已註冊，不可重複申請' };
        }
        if (aEmail && emailTaken(aEmail, '')) {
          const em = emailTaken(aEmail, '');
          return { success: false, error: em.status === 'inactive' ? '此 Email 已有帳號紀錄（已停用），請聯絡領袖恢復帳號，不需重新申請' : '此 Email 已註冊，不可重複申請' };
        }
        for (const p of state.applications) {
          if (p.status !== 'pending') continue;
          if (effYmis && p.ymis === effYmis) return { success: false, error: '此 YMIS 已有待審批申請' };
          if (aEmail && normEmail(p.email) === normEmail(aEmail)) return { success: false, error: '此 Email 已有待審批申請' };
        }
        state.applications.push({ app_id: 'APP_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), ymis: effYmis, name: body.name, email: aEmail, requested_role: role, status: 'pending' });
        return { success: true, message: '申請已提交' };
      }
      case 'forgotPassword': {
        // v8.8：公開 action（不需 token），臨時密碼「寄到」登記電郵（mock 記入 sentEmails）
        const lid = String(body.login_id || '').trim();
        if (!lid) return { success: false, error: '請填寫 YMIS 或電郵' };
        if (isSuperAdminId(lid)) return { success: false, error: '此帳號不能使用自助找回密碼' };
        let user = null;
        if (/^\d{10}$/.test(lid) || /^L\d+/i.test(lid)) user = state.users[lid] || null;
        else if (lid.indexOf('@') >= 0) user = Object.values(state.users).find(x => normEmail(x.email) === normEmail(lid)) || null;
        else user = state.users[lid] || Object.values(state.users).find(x => normEmail(x.email) === normEmail(lid)) || null;
        if (!user || user.status === 'inactive' || isHiddenRow(user)) return { success: false, error: '找不到此帳號，請檢查 YMIS／電郵是否正確' };
        const email = String(user.email || '').trim();
        if (!email) return { success: false, error: '此帳號未登記電郵，無法自助找回密碼，請聯絡領袖重設密碼' };
        const last = state.forgotThrottle[user.ymis] || 0;
        if (Date.now() - last < 60000) return { success: false, error: '請求過於頻密，請稍候一分鐘再試' };
        state.forgotThrottle[user.ymis] = Date.now();
        const temp = 'Rover' + Math.floor(100000 + Math.random() * 900000);
        state.sentEmails.push({ to: email, subject: '【樂行童軍進度系統】臨時密碼', body: '臨時密碼：' + temp });
        user.pass = temp;
        user.force_change_password = true;
        return { success: true, message: '臨時密碼已發送到你的登記電郵，請查收後登入並設定新密碼', email_hint: maskEmail(email) };
      }
      case 'load': {
        if (state.apikey && body.apikey && body.apikey !== state.apikey) return { success: false, error: 'Invalid API Key' };
        if (state.apikey && !body.apikey) return { success: false, error: 'Invalid API Key' };
        const flat = {};
        for (const [y, items] of Object.entries(state.progress)) {
          flat[y] = {};
          for (const [iid, rec] of Object.entries(items)) flat[y][iid] = rec.date;
        }
        return {
          success: true,
          members: mergedMembers(),
          flatProgress: flat,
          pendingRequests: state.requests.filter(r => r.status === 'pending'),
          otherBadges: state.otherBadges,
          logs: state.logs,
          logsSupported: true
        };
      }
      case 'save':
      case 'saveOtherBadge': {
        if (!validKey && !tokenYmis) return { success: false, error: '未授權 - 請重新登入' };
        if (action === 'save') {
          let processed = 0;
          for (const c of body.changes || []) {
            if (!state.progress[c.ymis]) state.progress[c.ymis] = {};
            if (c.uncomplete) { delete state.progress[c.ymis][c.itemId]; }
            else { state.progress[c.ymis][c.itemId] = { date: c.date, confirmer: body.confirmer || '' }; }
            processed++;
          }
          return { success: true, processed };
        }
        let c = 0;
        for (const r of body.records || []) {
          if (!state.otherBadges[r.ymis]) state.otherBadges[r.ymis] = {};
          state.otherBadges[r.ymis][r.badgeId] = { name: r.name, date: r.date, cert: r.cert || '' };
          c++;
        }
        return { success: true, processed: c };
      }
      case 'requestComplete': {
        if (!tokenYmis && !validKey) return { success: false, error: '未授權，請重新登入' };
        const rid = 'REQ_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        state.requests.push({
          request_id: rid, ymis: tokenYmis || body.ymis, name: body.name || tokenYmis,
          item_id: body.itemId, item_name: body.itemName || body.itemId,
          requested_date: body.requested_date, evidence: body.evidence || '', status: 'pending'
        });
        return { success: true, request_id: rid };
      }
      case 'getPendingRequests': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, requests: state.requests.filter(r => r.status === 'pending') };
      }
      case 'reviewRequest': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const req = state.requests.find(r => r.request_id === body.request_id);
        if (!req) return { success: false, error: '找不到申請' };
        req.status = body.decision;
        if (body.decision === 'approved') {
          if (!state.progress[req.ymis]) state.progress[req.ymis] = {};
          state.progress[req.ymis][req.item_id] = { date: body.confirmed_date || req.requested_date, confirmer: tokenYmis };
          return { success: true, message: '已批准並寫入進度' };
        }
        return { success: true, message: '已拒絕' };
      }
      case 'getConfig':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, config: state.config };
      case 'updateConfig':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        state.config[body.key] = body.value;
        return { success: true };
      case 'getAllUsers':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, users: Object.values(state.users).filter(u => !isHiddenRow(u)).map(u => ({ ymis: u.ymis, name: u.name, email: u.email || '', role: u.role, can_tick: u.can_tick, squad: u.squad || '', status: u.status || 'active' })) };
      case 'getMembers':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, members: mergedMembers() };
      case 'getApplications':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, applications: state.applications.filter(a => a.status === 'pending') };
      case 'getLogRecords':
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        return { success: true, logs: state.logs };
      case 'saveLogRecord': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const writer = state.users[tokenYmis];
        if (!writer || !['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'].includes(writer.role) || writer.can_tick !== true)
          return { success: false, error: '權限不足，需已獲勾選權限的領袖' };
        const results = [];
        let processed = 0;
        for (const r of (body.records || [])) {
          if (!r.ymis || !r.title || !r.date) { results.push({ success: false, ymis: r.ymis, error: 'YMIS、名稱及日期必填' }); continue; }
          let type = r.type || 'activity';
          let role = String(r.role || '').trim();
          if (type === 'training' && !role) {
            role = '學員';
          }
          const recObj = { ...r, type, role };
          if (r.record_id) {
            const idx = state.logs.findIndex(x => x.record_id === r.record_id);
            if (idx < 0) { results.push({ success: false, record_id: r.record_id, error: '找不到紀錄' }); continue; }
            state.logs[idx] = { ...state.logs[idx], ...recObj, recorder: body.recorder_name || String(tokenYmis) };
            results.push({ success: true, record_id: r.record_id });
            processed++;
            continue;
          }
          const nid = 'LOG_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          state.logs.push({ ...recObj, record_id: nid, recorder: body.recorder_name || String(tokenYmis), recorded_at: '2026-08-06' });
          results.push({ success: true, record_id: nid });
          processed++;
        }
        const failed = results.filter(x => !x.success).length;
        return { success: results.length > 0 && failed === 0, processed, results, message: processed + ' 筆已儲存' + (failed ? '，' + failed + ' 筆失敗' : '') };
      }
      case 'deleteLogRecord': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const writer = state.users[tokenYmis];
        if (!writer || !['admin', 'group_leader', 'branch_leader', 'exec_committee', 'super_admin'].includes(writer.role) || writer.can_tick !== true)
          return { success: false, error: '權限不足，需已獲勾選權限的領袖' };
        const idx = state.logs.findIndex(x => x.record_id === body.record_id);
        if (idx < 0) return { success: false, error: '找不到紀錄' };
        state.logs.splice(idx, 1);
        return { success: true, message: '已刪除紀錄' };
      }
      case 'addMember': {
        if (!tokenYmis && !validKey) return { success: false, error: '未授權' };
        if (isSuperAdminId(body.ymis)) return { success: false, error: '不能新增系統管理員帳號' };
        // v8.8：與真實 handleAddMember 一致 —— 只寫入成員名單（roster），不開登入帳號；YMIS 全表唯一
        const amYmis = String(body.ymis || '').trim();
        const amName = String(body.name || '').trim();
        if (!/^\d{10}$/.test(amYmis)) return { success: false, error: 'YMIS 須為 10 位數字' };
        if (!amName) return { success: false, error: '請填寫姓名' };
        if (state.users[amYmis]) {
          const ex = state.users[amYmis];
          return { success: false, error: ex.status === 'inactive' ? '此 YMIS 已有帳號紀錄（已停用），請在用戶管理恢復該帳號' : '此 YMIS 已有登入帳號，請在用戶管理直接管理' };
        }
        if (state.roster[amYmis]) return { success: false, error: '此 YMIS 已在成員名單，不可重複加入' };
        state.roster[amYmis] = { ymis: amYmis, name: amName, squad: String(body.squad || '').trim() };
        return { success: true, message: '成員已新增' };
      }
      case 'addUser': {
        if (!tokenYmis && !validKey) return { success: false, error: '未授權' };
        const mgr = managerOf(tokenYmis, validKey);
        const role = body.role || 'member';
        if (!VALID_ROLES.includes(role)) return { success: false, error: '無效的角色: ' + role };
        if (!canManageUser(mgr, role)) return { success: false, error: '權限不足，你的等級不可開立此角色' };
        let ymis = String(body.ymis || '').trim();
        const email = body.email || '';
        if (!ymis && role !== 'member') {
          if (!email) return { success: false, error: '領袖開戶必須填寫 Email（用作登入帳號）' };
          ymis = 'L' + Date.now();
        }
        if (isSuperAdminId(ymis) || isSuperAdminId(email)) return { success: false, error: '不能新增系統管理員帳號' };
        if (!/^(\d{10}|L\d+)$/.test(ymis)) return { success: false, error: 'YMIS 須為 10 位數字（領袖可留空，會自動編配）' };
        if (!body.name) return { success: false, error: '請填寫姓名' };
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return { success: false, error: 'Email 格式不正確' };
        // v8.8：YMIS／Email 全表唯一（含已停用）
        if (state.users[ymis]) {
          const ex = state.users[ymis];
          return { success: false, error: ex.status === 'inactive' ? '此 YMIS 已有帳號紀錄（已停用），請恢復該帳號而非重新開戶' : '此 YMIS 已註冊，不可重複開戶' };
        }
        if (email && emailTaken(email, '')) {
          const em = emailTaken(email, '');
          return { success: false, error: em.status === 'inactive' ? '此 Email 已有帳號紀錄（已停用：' + em.ymis + '），請恢復該帳號而非重新開戶' : '此 Email 已被 ' + em.ymis + ' 使用，不可重複開戶' };
        }
        if (role === 'group_leader' && findActiveGsl('')) return { success: false, error: '團長只能有一位（現任：' + findActiveGsl('').name + '），如需更換請先將現任團長轉為其他角色' };
        const pass = body.password || '1234';
        state.users[ymis] = { ymis, name: body.name, email, role, pass, can_tick: !!body.can_tick, squad: String(body.squad || ''), status: 'active', force_change_password: !body.password || body.password === '1234' };
        // 同步名單（已有就不重複加）
        if (state.roster[ymis]) state.roster[ymis].name = body.name;
        else state.roster[ymis] = { ymis, name: body.name, squad: String(body.squad || '') };
        return { success: true, message: '帳號已建立（密碼留空＝預設 1234）', ymis };
      }
      case 'changePassword': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        if (isSuperAdminId(tokenYmis)) return { success: false, error: '系統管理員密碼不能由此更改' };
        const u = state.users[tokenYmis];
        const newP = String(body.new_password || '');
        if (!newP || newP.length < 4) return { success: false, error: '新密碼至少4位' };
        if (newP === String(body.old_password || '')) return { success: false, error: '新密碼不可與原密碼相同' };
        if (!u || u.pass !== String(body.old_password || '')) return { success: false, error: '原密碼錯誤' };
        u.pass = newP;
        u.force_change_password = false;
        return { success: true };
      }
      case 'deactivateUser': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        // v8.8：與真實 handleDeactivateUser 一致 —— 須有 Users 紀錄、不能停用自己／高等級；停用後移出名單
        const dtYmis = String(body.target_ymis || '').trim();
        if (isSuperAdminId(dtYmis)) return { success: false, error: '不能停用系統管理員帳號' };
        if (dtYmis === tokenYmis) return { success: false, error: '不能停用自己' };
        const dtMgr = managerOf(tokenYmis, validKey);
        const dtTarget = state.users[dtYmis];
        if (!dtTarget || isHiddenRow(dtTarget) || dtTarget.status !== 'active') return { success: false, error: '找不到此用戶' };
        if ((ROLE_LEVEL[dtMgr.role] || 0) < (ROLE_LEVEL[dtTarget.role] || 0) && dtMgr.role !== 'super_admin') return { success: false, error: '權限不足，不能停用比您高等級的用戶' };
        dtTarget.status = 'inactive';
        for (const [tk, y] of Object.entries(state.tokens)) if (y === dtYmis) delete state.tokens[tk];
        delete state.roster[dtYmis];
        return { success: true, message: '帳號已停用' };
      }
      case 'reactivateUser': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const rtYmis = String(body.target_ymis || '').trim();
        if (isSuperAdminId(rtYmis)) return { success: false, error: '不能操作系統管理員帳號' };
        const rtMgr = managerOf(tokenYmis, validKey);
        const rtTarget = state.users[rtYmis];
        if (!rtTarget || isHiddenRow(rtTarget)) return { success: false, error: '找不到此用戶' };
        if (rtTarget.status !== 'inactive') return { success: false, error: '此帳號已是啟用狀態' };
        if ((ROLE_LEVEL[rtMgr.role] || 0) < (ROLE_LEVEL[rtTarget.role] || 0) && rtMgr.role !== 'super_admin') return { success: false, error: '權限不足，不能恢復比您高等級的用戶' };
        rtTarget.status = 'active';
        if (!state.roster[rtYmis]) state.roster[rtYmis] = { ymis: rtYmis, name: rtTarget.name, squad: rtTarget.squad || '' };
        return { success: true, message: '已恢復 ' + rtYmis + '，該用戶可重新登入' };
      }
      case 'updateUserProfile': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const upYmis = String(body.target_ymis || '').trim();
        if (isSuperAdminId(upYmis)) return { success: false, error: '不能修改系統管理員帳號' };
        const upMgr = managerOf(tokenYmis, validKey);
        const upTarget = state.users[upYmis];
        if (!upTarget) {
          if (body.email !== undefined && body.email !== null && String(body.email).trim() !== '') return { success: false, error: '純名單成員沒有登入帳號，如需電郵登入請先開立登入帳號' };
          const r = state.roster[upYmis];
          if (!r) return { success: false, error: '找不到此用戶' };
          const changed = [];
          if (body.name !== undefined && body.name !== null && String(body.name).trim() !== '') { r.name = String(body.name).trim(); changed.push('姓名'); }
          if (body.branch !== undefined && body.branch !== null) { r.squad = String(body.branch).trim(); changed.push('備註'); }
          if (!changed.length) return { success: false, error: '沒有變更' };
          return { success: true, message: '已更新 ' + changed.join('、') };
        }
        if (isHiddenRow(upTarget)) return { success: false, error: '不能修改系統管理員帳號' };
        if (upTarget.status === 'inactive') return { success: false, error: '此帳號已停用，請先恢復再修改' };
        if ((ROLE_LEVEL[upMgr.role] || 0) < (ROLE_LEVEL[upTarget.role] || 0) && upMgr.role !== 'super_admin') return { success: false, error: '權限不足，不能修改比您高等級的用戶' };
        const changed = [];
        if (body.name !== undefined && body.name !== null && String(body.name).trim() !== '' && String(body.name).trim() !== upTarget.name) {
          upTarget.name = String(body.name).trim(); changed.push('姓名');
          if (state.roster[upYmis]) state.roster[upYmis].name = upTarget.name;
        }
        if (body.email !== undefined && body.email !== null) {
          const em = String(body.email).trim();
          if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return { success: false, error: 'Email 格式不正確' };
          if (isSuperAdminId(em)) return { success: false, error: '此 Email 已被保留' };
          if (em !== (upTarget.email || '')) {
            if (em && emailTaken(em, upYmis)) return { success: false, error: '此 Email 已被 ' + emailTaken(em, upYmis).ymis + ' 使用，不可重複' };
            upTarget.email = em; changed.push('電郵');
          }
        }
        if (body.branch !== undefined && body.branch !== null) { upTarget.squad = String(body.branch).trim(); changed.push('備註'); }
        if (!changed.length) return { success: false, error: '沒有變更' };
        return { success: true, message: '已更新 ' + changed.join('、') };
      }
      case 'deleteMember': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const dmYmis = String(body.target_ymis || '').trim();
        if (isSuperAdminId(dmYmis)) return { success: false, error: '不能刪除系統管理員帳號' };
        if (state.users[dmYmis]) {
          const ex = state.users[dmYmis];
          return { success: false, error: ex.status === 'inactive' ? '此成員已有帳號紀錄（已停用），請在用戶管理恢復或徹底刪除該帳號' : '此成員已有登入帳號，請在用戶管理停用該帳號' };
        }
        if (!state.roster[dmYmis]) return { success: false, error: '在成員名單找不到此 YMIS' };
        delete state.roster[dmYmis];
        return { success: true, message: '已刪除成員 ' + dmYmis + '（進度紀錄保留）' };
      }
      case 'deleteUser': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const duYmis = String(body.target_ymis || '').trim();
        const duMgr = managerOf(tokenYmis, validKey);
        if ((ROLE_LEVEL[duMgr.role] || 0) < 60) return { success: false, error: '徹底刪除需團長以上權限，請先停用帳號再請團長處理' };
        if (isSuperAdminId(duYmis)) return { success: false, error: '不能刪除系統管理員帳號' };
        if (duYmis === tokenYmis) return { success: false, error: '不能刪除自己' };
        const duTarget = state.users[duYmis];
        if (!duTarget || isHiddenRow(duTarget)) return { success: false, error: '找不到此用戶' };
        if (duTarget.status !== 'inactive') return { success: false, error: '請先停用此帳號，再徹底刪除' };
        if ((ROLE_LEVEL[duMgr.role] || 0) < (ROLE_LEVEL[duTarget.role] || 0) && duMgr.role !== 'super_admin') return { success: false, error: '權限不足，不能刪除比您高等級的用戶' };
        delete state.users[duYmis];
        delete state.roster[duYmis];
        for (const [tk, y] of Object.entries(state.tokens)) if (y === duYmis) delete state.tokens[tk];
        return { success: true, message: '已徹底刪除 ' + duYmis + '（進度紀錄保留）' };
      }
      case 'resetPassword': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        if (isSuperAdminId(body.target_ymis)) return { success: false, error: '不能重設系統管理員密碼' };
        if (String(body.target_ymis) === String(tokenYmis)) return { success: false, error: '不能重設自己的密碼，請聯絡其他管理員' };
        // v8.8：可附 new_password 自設密碼；留空沿用隨機一次性密碼
        const custom = (body.new_password !== undefined && body.new_password !== null && String(body.new_password).length > 0) ? String(body.new_password) : '';
        if (custom && custom.length < 4) return { success: false, error: '新密碼至少4位' };
        if (!state.users[body.target_ymis]) return { success: false, error: '找不到此 YMIS' };
        if (custom) {
          state.users[body.target_ymis].pass = custom;
          state.users[body.target_ymis].force_change_password = true;
          return { success: true, message: '已設定新密碼，請通知用戶首次登入後更改密碼' };
        }
        const temp = 'tmp_' + Math.floor(1000 + Math.random() * 9000);
        state.users[body.target_ymis].pass = temp;
        state.users[body.target_ymis].force_change_password = true;
        return { success: true, temp_password: temp };
      }
      case 'reviewApplication': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        const app = state.applications.find(a => a.app_id === body.app_id);
        if (!app) return { success: false, error: '找不到待審批申請' };
        if (body.decision === 'rejected') {
          app.status = 'rejected';
          return { success: true, message: '已拒絕申請' };
        }
        const mgr = managerOf(tokenYmis, validKey);
        const requestedRole = app.requested_role || 'member';
        const finalRole = (APPLY_ROLES.includes(requestedRole) && canManageUser(mgr, requestedRole)) ? requestedRole : 'member';
        let ymis = String(app.ymis || '').trim();
        if (!ymis) ymis = 'L' + Date.now();
        // v8.8：全表唯一（與真實 handleReviewApplication 一致）
        if (state.users[ymis]) return { success: false, error: '此 YMIS 已有帳號紀錄（可能已開戶或已停用），請先處理現有帳號再審批' };
        if (app.email && emailTaken(app.email, '')) return { success: false, error: '此 Email 已有帳號紀錄（可能已開戶或已停用），請先處理現有帳號再審批' };
        state.users[ymis] = { ymis, name: app.name, email: app.email || '', role: finalRole, pass: '1234', can_tick: finalRole !== 'member', status: 'active', force_change_password: true };
        if (state.roster[ymis]) state.roster[ymis].name = app.name;
        else state.roster[ymis] = { ymis, name: app.name, squad: '' };
        app.status = 'approved';
        return { success: true, message: '已批准並建立帳戶，預設密碼：1234（首次登入須更改）', temp_password: '1234', final_role: finalRole, ymis };
      }
      case 'updateUserRole': {
        if (!tokenYmis) return { success: false, error: 'Token 無效或過期' };
        if (isSuperAdminId(body.target_ymis)) return { success: false, error: '不能更改系統管理員帳號的角色' };
        const u = state.users[body.target_ymis];
        // 與真實 handleUpdateUserRole 一致：只接受 active 目標；升團長無條件要求先轉走現任（連超管亦然）
        if (!u || isHiddenRow(u) || u.status !== 'active') return { success: false, error: '找不到用戶' };
        const uuNewRole = body.new_role || u.role;
        if (uuNewRole === 'group_leader' && u.role !== 'group_leader') {
          const other = Object.values(state.users).find(x => x.role === 'group_leader' && x.status === 'active' && !isHiddenRow(x) && x.ymis !== u.ymis);
          if (other) return { success: false, error: '團長只能有一位（現任：' + other.name + '），如需更換請先將現任團長轉為其他角色' };
        }
        if (body.new_role) u.role = body.new_role;
        if (body.can_tick !== undefined) u.can_tick = !!body.can_tick;
        if (body.allowed_badges !== undefined) u.allowed_badges = body.allowed_badges;
        return { success: true, message: '角色已更新' };
      }
      case 'getLoginMode':
        return { success: true, login_mode: 'standalone' };
      default:
        return { success: false, error: 'Unknown action' };
    }
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock.local');

    const sendJson = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    // ---- 測試控制通道（不經 proxy，測試腳本直連） ----
    if (u.pathname === '/__control' && req.method === 'POST') {
      let b = ''; req.on('data', c => b += c);
      req.on('end', () => {
        const c = JSON.parse(b);
        if (c.mode) state.mode = c.mode;
        if (c.slowMs !== undefined) state.slowMs = c.slowMs;
        sendJson({ success: true, mode: state.mode });
      });
      return;
    }
    if (u.pathname === '/__state' && req.method === 'GET') {
      return sendJson(state);
    }

    // ---- 故障注入行為 ----
    if (state.mode === 'html-error') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><body>Google Apps Script Error Page</body></html>');
    }
    if (state.mode === 'http500') {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>500 Internal Server Error</body></html>');
    }
    if (state.mode === 'slow' || state.slowMs > 0) {
      // 故意懸著不回應，觸發逾時
      return;
    }

    // ---- 真實 GAS 的 302 重導向（第一次 /exec 請求） ----
    if (u.pathname === '/exec' || u.pathname === '/exec/') {
      state.execCount++;
      state.lastExecPath = req.url;
      const _actHint = req.method === 'GET' ? (u.searchParams.get('action') || '') : '';
      if (state.received.length < 500) state.received.push({ method: req.method, action: _actHint, pending: true });
      let bodyStr = '';
      req.on('data', c => bodyStr += c);
      req.on('end', () => {
        let parsedBody = {};
        if (req.method === 'GET') {
          for (const [k, v] of u.searchParams.entries()) parsedBody[k] = v;
        } else if (bodyStr) {
          try { parsedBody = JSON.parse(bodyStr); } catch (e) { /* text/plain fallback */ }
        }
        const rid = 'rid_' + Math.random().toString(36).slice(2);
        pendingRedirects.set(rid, { method: req.method, body: parsedBody });
        res.writeHead(302, { 'Location': `/usercontent/${rid}` });
        res.end();
      });
      return;
    }

    // ---- 302 跟隨目標（/usercontent/<rid>） ----
    if (u.pathname.startsWith('/usercontent/')) {
      const rid = u.pathname.split('/')[2];
      const payload = pendingRedirects.get(rid);
      if (!payload) return sendJson({ success: false, error: 'invalid redirect session' }, 400);
      pendingRedirects.delete(rid);
      const action = payload.body.action || '';
      for (let i = state.received.length - 1; i >= 0; i--) {
        if (state.received[i].pending && state.received[i].method === payload.method) {
          state.received[i].action = action || state.received[i].action;
          delete state.received[i].pending;
          break;
        }
      }
      // 方法不對 → 照真實 GAS 一樣回 Unknown action
      if (action) {
        const wantsGet = GET_ONLY_ACTIONS.has(action);
        if (wantsGet && payload.method !== 'GET') return sendJson({ success: false, error: 'Unknown action' });
        if (!wantsGet && payload.method === 'GET') return sendJson({ success: false, error: 'Unknown action' });
      }
      const ans = routeAction(action, payload.body);
      return sendJson(ans);
    }

    res.writeHead(404); res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      resolve({
        url: `http://127.0.0.1:${port}/exec`,
        close: () => new Promise(r => server.close(r)),
        state
      });
    });
  });
}
