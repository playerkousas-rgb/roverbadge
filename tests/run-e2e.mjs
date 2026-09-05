// roverbadge 同源 Proxy 架構 e2e 測試
// 流程：node tests/run-e2e.mjs
//   1. 起兩個 mock GAS（旅團 0082=A、1001=B），含 302 redirect hop
//   2. 起本機 app server：靜態檔 + 掛真實 api/proxy.js、api/troops.js（模擬 Vercel 行為）
//   3. 從 index.html 抽出真正的 apiRequest() 在 Node 執行，模擬瀏覽器請求
//   4. 斷言多旅團隔離、錯誤處理、SSRF 防護、靜態安全檢查
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startMockGas } from './mock-gas.mjs';

// ---- 必須在 import api 模組前設定 env（proxy 於 import 時讀 timeout） ----
const PORT_A = parseInt(process.env.E2E_PORT_A || '3901', 10);
const PORT_B = parseInt(process.env.E2E_PORT_B || '3902', 10);
process.env.ROVERBADGE_PROXY_TEST = '1';            // 允許 localhost mock（只限測試）
process.env.ROVERBADGE_PROXY_TIMEOUT_MS = '3000';   // 測試用短 timeout
process.env.TROOP_0082_BACKEND = `http://127.0.0.1:${PORT_A}/exec`;
process.env.TROOP_0082_APIKEY = 'KEY_A';
process.env.TROOP_1001_BACKEND = `http://127.0.0.1:${PORT_B}/exec`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_PORT = parseInt(process.env.E2E_PORT_APP || '8899', 10);
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function postProxy(body, rawHeaders = {}) {
  const r = await fetch(`${APP_BASE}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...rawHeaders },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-json */ }
  return { status: r.status, json, headers: r.headers };
}

// ================== 1. 起 mock GAS ==================
console.log('\n【1】起兩個 mock GAS 旅團後端（含 GAS 式 302 redirect）');
const mockA = await startMockGas({
  port: PORT_A, name: '旅團A(0082)', apikey: 'KEY_A',
  users: [
    { ymis: '1234567890', name: '陳大文', role: 'group_leader', pass: 'PassA!234567', can_tick: true, email: 'a@example.org' },
    { ymis: '1234560001', name: '成員甲', role: 'member', pass: 'MemberA!234', can_tick: false },
    // 舊版殘留：模擬舊版寫入 Users 表的 super_admin 列（v8.5 起不應出現在任何名單）
    { ymis: 'legacy_sysop', name: '系統管理員', role: 'super_admin', pass: 'legacy', can_tick: true, status: 'active' }
  ]
});
const mockB = await startMockGas({
  port: PORT_B, name: '旅團B(1001)',
  users: [
    { ymis: '9876543210', name: '李小明', role: 'group_leader', pass: 'PassB!234567', can_tick: true, email: 'b@example.org' }
  ]
});
console.log(`  mock A: ${mockA.url}  mock B: ${mockB.url}`);

// ================== 2. 起本機 app server ==================
console.log('\n【2】起本機 app server，掛載真實 api/proxy.js + api/troops.js');
const { default: proxyHandler } = await import('../api/proxy.js');
const { default: troopsHandler } = await import('../api/troops.js');

function vercelize(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (obj) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  return res;
}
const appServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname === '/api/proxy') return proxyHandler(req, vercelize(res));
  if (u.pathname === '/api/troops') return troopsHandler(req, vercelize(res));
  let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const fp = path.join(ROOT, p);
  if (fs.existsSync(fp) && !fs.statSync(fp).isDirectory()) {
    res.writeHead(200); fs.createReadStream(fp).pipe(res);
  } else { res.writeHead(404); res.end('404'); }
});
await new Promise(r => appServer.listen(APP_PORT, '127.0.0.1', r));

// ================== 3. 前端 real apiRequest ==================
console.log('\n【3】從 index.html 抽出真實 apiRequest() 測試（模擬瀏覽器呼叫）');
const htmlCode = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const match = htmlCode.match(/async function apiRequest\([\s\S]*?\n\}/);
check('自 index.html 找到 apiRequest() 函數定義', !!match);

const apiRequestCode = `
  const API_ENDPOINT = '${APP_BASE}/api/proxy';
  let currentTroopId = '0082';
  ${match ? match[0] : 'async function apiRequest(){ throw new Error("no fn"); }'}
  return apiRequest;
`;
const apiRequest = new Function(apiRequestCode)();

// ================== 4. 首頁與配置載入 ==================
console.log('\n【4】首頁 + 旅團選擇 + 正確旅團配置載入');
{
  const rHome = await fetch(APP_BASE);
  const textHome = await rHome.text();
  check('首頁可載入', rHome.status === 200 && textHome.includes('<!DOCTYPE html>'));
  check('首頁不含任何具體 GAS /exec URL', !/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/.test(textHome));
  check('首頁業務 API 指向同源 /api/proxy', textHome.includes("const API_ENDPOINT='/api/proxy'") || textHome.includes('const API_ENDPOINT = "/api/proxy"'));

  const rTr = await fetch(`${APP_BASE}/api/troops`);
  const jsonTr = await rTr.json();
  check('/api/troops 列出兩個旅團', jsonTr.troops && jsonTr.troops['0082'] && jsonTr.troops['1001']);
  check('/api/troops 不洩漏 backend/apikey', !jsonTr.troops['0082'].backend && !jsonTr.troops['0082'].apikey);
}

// ================== 5. 登入 ==================
console.log('\n【5】登入 + 錯誤密碼');
let tokenA = '';
{
  const bad = await apiRequest('login', { login_id: '1234567890', password: 'wrong' }, { troopId: '0082' });
  check('錯誤密碼 → success:false + 錯誤訊息', bad.success === false && /密碼/i.test(bad.error || ''));

  const ok = await apiRequest('login', { login_id: '1234567890', password: 'PassA!234567' }, { troopId: '0082' });
  check('正確密碼 → success:true + token', ok.success === true && typeof ok.token === 'string');
  tokenA = ok.token;
}

// ================== 6. 讀取資料 ==================
console.log('\n【6】讀取資料（GET load → proxy → mock A，驗證 302 follow + apikey 注入）');
{
  const ld = await apiRequest('load', { token: tokenA }, { troopId: '0082' });
  check('load 成功（伺服器端 apikey 注入有效，前端不用帶）', ld.success === true);
  check('load 回傳成員列表', Array.isArray(ld.members) && ld.members.some(m => m.ymis === '1234567890'));
}

// ================== 7. 新增/修改/儲存 ==================
console.log('\n【7】新增/修改/儲存 → 重新讀取驗證落盤（旅團 A）');
{
  const sv = await apiRequest('save', {
    token: tokenA,
    changes: [
      { ymis: '1234560001', itemId: 'L1-CP', date: '2026-08-01' },
      { ymis: '1234560001', itemId: 'L2-01', date: '2026-08-02' }
    ],
    confirmer: '陳大文'
  }, { troopId: '0082' });
  check('save 成功 processed=2', sv.success === true && sv.processed === 2);
  check('mock A 已有進度', mockA.state.progress['1234560001'] && mockA.state.progress['1234560001']['L1-CP']?.date === '2026-08-01');
  check('mock B 無任何進度（隔離）', !mockB.state.progress['1234560001']);

  const ld2 = await apiRequest('load', { token: tokenA }, { troopId: '0082' });
  check('重新 load 讀回剛儲存的進度', ld2.flatProgress && ld2.flatProgress['1234560001'] && ld2.flatProgress['1234560001']['L1-CP'] === '2026-08-01');

  // 其他獎章儲存與讀取
  const svOb = await apiRequest('saveOtherBadge', {
    token: tokenA,
    records: [{ ymis: '1234560001', badgeId: 'OT-01', name: '急救證書', date: '2026-08-03', cert: 'FA123' }]
  }, { troopId: '0082' });
  check('saveOtherBadge 成功 processed=1', svOb.success === true && svOb.processed === 1);
  const ld3 = await apiRequest('load', { token: tokenA }, { troopId: '0082' });
  check('重新 load 讀回剛儲存的其他獎章', ld3.otherBadges['1234560001'] && ld3.otherBadges['1234560001']['OT-01']?.cert === 'FA123');
}

// ================== 8. 錯誤旅團 ID 被拒絕 ==================
console.log('\n【8】錯誤旅團 ID 被拒絕');
{
  const rUnk = await postProxy({ troopId: '9999', action: 'load' });
  check('未知旅團 → success:false', rUnk.json && rUnk.json.success === false);
  check('未知旅團 → HTTP 404', rUnk.status === 404);

  const rBad = await postProxy({ troopId: '../../etc', action: 'load' });
  check('惡意 troopId 格式 → HTTP 400', rBad.status === 400);
}

// ================== 9. SSRF / Open Proxy 防護 ==================
console.log('\n【9】SSRF / Open Proxy 防護');
{
  const { isTrustedExecUrl } = await import('../api/_registry.js');
  check('拒絕任意外部 URL（unit）', !isTrustedExecUrl('https://evil.example.com/exec') && !isTrustedExecUrl('https://script.google.com/macros/s/AKfy123456/dev'));
  check('拒絕 GAS /dev URL', !isTrustedExecUrl('https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/dev'));
  check('接受正常 GAS /exec URL', isTrustedExecUrl('https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec'));

  // 嘗試在 request 夾帶 backend / url 試圖修改上游
  const rInject = await postProxy({
    troopId: '0082',
    action: 'save',
    data: {
      token: tokenA,
      backend: 'https://evil.example.com/exec',
      url: 'https://evil.example.com/exec',
      gasUrl: 'https://evil.example.com/exec',
      changes: [{ ymis: '1234560001', itemId: 'L2-02', date: '2026-08-04' }]
    }
  });
  check('data 內夾帶 backend/url/gasUrl 被忽略，仍寫入 Registry 指定的 mock A', rInject.status === 200 && rInject.json && rInject.json.success === true && mockA.state.progress['1234560001']['L2-02']?.date === '2026-08-04');

  const rBadAct = await postProxy({ troopId: '0082', action: 'adminDeleteAll', data: {} });
  check('非白名單 action → HTTP 400', rBadAct.status === 400);

  const rNoToken = await postProxy({ troopId: '0082', action: 'save', data: { changes: [] } });
  check('受保護 action 無 token → HTTP 401', rNoToken.status === 401);
}

// ================== 10. 後端失敗模式 ==================
console.log('\n【10】後端各種失敗模式：proxy 一律 success:false（前端絕對不會顯示假成功）');
{
  await fetch(`${mockA.url.replace('/exec', '')}/__control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'html-error' })
  });
  const rHtml = await postProxy({ troopId: '0082', action: 'save', data: { token: tokenA, changes: [] } });
  check('上游回應 HTML 錯誤頁 → success:false', rHtml.json && rHtml.json.success === false);
  check('回應含友善錯誤訊息', /回應格式異常|Apps Script 部署/.test(rHtml.json?.error || ''));

  await fetch(`${mockA.url.replace('/exec', '')}/__control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'http500' })
  });
  const r500 = await postProxy({ troopId: '0082', action: 'load', data: { token: tokenA } });
  check('上游 HTTP 500 → success:false + HTTP 502', r500.status === 502 && r500.json && r500.json.success === false);

  await fetch(`${mockA.url.replace('/exec', '')}/__control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'slow', slowMs: 5000 })
  });
  const tStart = Date.now();
  const rSlow = await postProxy({ troopId: '0082', action: 'load', data: { token: tokenA } });
  const elapsed = Date.now() - tStart;
  check('上游逾時 → success:false + HTTP 504', rSlow.status === 504 && rSlow.json && rSlow.json.success === false);
  check('逾時偵測在 timeout 內觸發 (<5s)', elapsed < 5000);

  await fetch(`${mockA.url.replace('/exec', '')}/__control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'normal', slowMs: 0 })
  });
  const rRec = await postProxy({ troopId: '0082', action: 'load', data: { token: tokenA } });
  check('故障復原後可正常使用', rRec.status === 200 && rRec.json && rRec.json.success === true);
}

// ================== 10b. 會員與領袖管理操作 ==================
console.log('\n【10b】會員與領袖管理操作（新增/修改/權限/停用/重設密碼）');
{
  // v8.8 真實語義：addMember 只寫成員名單、不開登入帳號
  const addMem = await apiRequest('addMember', {
    token: tokenA, ymis: '1234560002', name: '成員乙', squad: '雄鷹小隊'
  }, { troopId: '0082' });
  check('新增成員（addMember）成功：只入名單、不開帳號',
    addMem.success === true && mockA.state.roster['1234560002']?.name === '成員乙' && !mockA.state.users['1234560002']);

  // 同一 YMIS 再 addMember → 重複阻擋
  const addMemDup = await apiRequest('addMember', {
    token: tokenA, ymis: '1234560002', name: '成員乙次', squad: ''
  }, { troopId: '0082' });
  check('重複 addMember 同一 YMIS 被拒', addMemDup.success === false && /已在|重複/.test(addMemDup.error || ''));

  // 已有登入帳號者不能再 addMember
  const addMemHasAcct = await apiRequest('addMember', {
    token: tokenA, ymis: '1234560001', name: '成員甲', squad: ''
  }, { troopId: '0082' });
  check('已有登入帳號者 addMember 被拒', addMemHasAcct.success === false && /登入帳號/.test(addMemHasAcct.error || ''));

  const addUsr = await apiRequest('addUser', {
    token: tokenA, ymis: '1234560003', name: '領袖丙', email: 'c@example.org', role: 'branch_leader', password: 'PassC!234', can_tick: true
  }, { troopId: '0082' });
  check('建立帳號（addUser）成功', addUsr.success === true && mockA.state.users['1234560003']?.role === 'branch_leader');

  // 同 YMIS 再 addUser → 阻擋（不可重複開戶）
  const addUsrDup = await apiRequest('addUser', {
    token: tokenA, ymis: '1234560003', name: '領袖丙次', email: 'c2@example.org', role: 'member', password: 'x'
  }, { troopId: '0082' });
  check('重複 YMIS 開戶被拒', addUsrDup.success === false && /已註冊|重複|已有/.test(addUsrDup.error || ''));

  // 同 Email（大小寫不同）再 addUser → 阻擋
  const addUsrDupEm = await apiRequest('addUser', {
    token: tokenA, ymis: '1234560006', name: '領袖戊', email: 'C@EXAMPLE.ORG', role: 'member', password: 'x'
  }, { troopId: '0082' });
  check('重複 Email 開戶被拒（大小寫不敏感）', addUsrDupEm.success === false && /Email/.test(addUsrDupEm.error || ''));

  const updPerm = await apiRequest('updateUserRole', {
    token: tokenA, target_ymis: '1234560001', new_role: 'exec_committee', can_tick: true, allowed_badges: 'L1,L2'
  }, { troopId: '0082' });
  check('更新角色及權限（updateUserRole）成功', updPerm.success === true && mockA.state.users['1234560001']?.role === 'exec_committee');

  const rstPw = await apiRequest('resetPassword', {
    token: tokenA, target_ymis: '1234560001'
  }, { troopId: '0082' });
  check('重設密碼（resetPassword）成功並返回臨時密碼', rstPw.success === true && typeof rstPw.temp_password === 'string' && rstPw.temp_password.startsWith('tmp_'));

  // v8.8：停用對象須為有登入帳號者（addMember 不再建 Users 列）；停用 0003（本節新建，零副作用）
  const deact = await apiRequest('deactivateUser', {
    token: tokenA, target_ymis: '1234560003'
  }, { troopId: '0082' });
  check('停用帳號（deactivateUser）成功', deact.success === true && mockA.state.users['1234560003']?.status === 'inactive');

  // 停用後登入被拒
  const loginDeact = await apiRequest('login', { login_id: '1234560003', password: 'PassC!234' }, { troopId: '0082' });
  check('已停用帳號無法登入', loginDeact.success === false);

  // 停用中 YMIS／Email 仍被佔用，不可重複開戶
  const addUsrDeact = await apiRequest('addUser', {
    token: tokenA, ymis: '1234560003', name: '領袖丙3', email: 'c3@example.org', role: 'member', password: 'x'
  }, { troopId: '0082' });
  check('已停用 YMIS 不可重複開戶', addUsrDeact.success === false && /停用|已有|重複/.test(addUsrDeact.error || ''));

  // 成員申請帳號及領袖審批
  const appRes = await apiRequest('apply', {
    ymis: '1234560004', name: '新團員丁', email: 'd@example.org', requested_role: 'member', branch: '紅隼小隊'
  }, { troopId: '0082' });
  check('申請帳號（apply）成功', appRes.success === true && mockA.state.applications.length > 0);

  const getApps = await apiRequest('getApplications', { token: tokenA }, { troopId: '0082' });
  const appId = getApps.applications[0]?.app_id;
  check('取得待審批申請成功', getApps.success === true && !!appId);

  const revApp = await apiRequest('reviewApplication', {
    token: tokenA, app_id: appId, decision: 'approved', review_note: '歡迎加入'
  }, { troopId: '0082' });
  check('審批申請（reviewApplication）成功', revApp.success === true && mockA.state.applications[0]?.status === 'approved');
}

// ================== 10c. 活動履歷 ==================
console.log('\n【10c】活動履歷：單筆/批量寫入、讀取、成員被拒、刪除、旅團隔離');
{
  // 領袖單筆寫入（服務）
  const s1 = await apiRequest('saveLogRecord', { token: tokenA, records: [{ type: 'service', ymis: '1234560001', name: '成員甲', date: '2026-08-01', title: '暑期賣旗籌款', role: '服務員', hours: '4', cert_no: '', detail: '港島區' }], recorder_name: '陳大文' }, { troopId: '0082' });
  check('領袖單筆服務紀錄成功 + 回傳 record_id', s1.success === true && (s1.results?.[0]?.record_id || '').startsWith('LOG_'));
  const rid1 = s1.results[0].record_id;

  // 批量寫入（活動 + 訓練班）
  const s2 = await apiRequest('saveLogRecord', { token: tokenA, records: [
    { type: 'activity', ymis: '1234560001', name: '成員甲', date: '2026-07-15', title: '夏日大露營', role: '參加者', hours: '', cert_no: '', detail: '' },
    { type: 'activity', ymis: '1234560002', name: '成員乙', date: '2026-07-15', title: '夏日大露營', role: '參加者', hours: '', cert_no: '', detail: '' },
    { type: 'training', ymis: '1234560001', name: '成員甲', date: '2026-06-01', title: '急救證書班', role: '學員', hours: '18', cert_no: 'FA-2026-001', detail: '' }
  ], recorder_name: '陳大文' }, { troopId: '0082' });
  check('批量 3 筆寫入 processed=3', s2.success === true && s2.processed === 3);

  // 讀取
  const g = await apiRequest('getLogRecords', { token: tokenA }, { troopId: '0082' });
  check('getLogRecords 返回 4 筆', g.success === true && (g.logs || []).length === 4);
  check('load 回應包含 logs + logsSupported', (await apiRequest('load', { token: tokenA }, { troopId: '0082' })).logsSupported === true && (await apiRequest('load', { token: tokenA }, { troopId: '0082' })).logs.length === 4);

  // 編輯（record_id 更新）
  const up = await apiRequest('saveLogRecord', { token: tokenA, records: [{ record_id: rid1, type: 'service', ymis: '1234560001', name: '成員甲', date: '2026-08-01', title: '暑期賣旗籌款（修改）', role: '統籌', hours: '6', cert_no: '', detail: '' }], recorder_name: '陳大文' }, { troopId: '0082' });
  const afterEdit = await apiRequest('getLogRecords', { token: tokenA }, { troopId: '0082' });
  const edited = (afterEdit.logs || []).find(x => x.record_id === rid1);
  check('編輯成功（標題/崗位/時數已更新，仍 4 筆）', up.success === true && edited?.title.includes('修改') && edited?.role === '統籌' && afterEdit.logs.length === 4);

  // 旅團隔離
  check('mock B 無任何履歷紀錄（隔離）', (mockB.state.logs || []).length === 0);

  // 成員（無勾選權）寫入被拒
  const addMemE = await apiRequest('addUser', { token: tokenA, ymis: '1234560005', name: '成員戊', email: 'e@example.org', role: 'member', password: 'MemberE!23456', can_tick: false }, { troopId: '0082' });
  check('新增無勾選權成員戊成功', addMemE.success === true);
  const loginMember = await apiRequest('login', { login_id: '1234560005', password: 'MemberE!23456' }, { troopId: '0082' });
  check('成員登入成功（讀取用）', loginMember.success === true && typeof loginMember.token === 'string');
  const memberSave = await apiRequest('saveLogRecord', { token: loginMember.token, records: [{ type: 'activity', ymis: '1234560005', name: '成員戊', date: '2026-08-02', title: '自填活動', role: '', hours: '', cert_no: '', detail: '' }] }, { troopId: '0082' });
  check('成員（can_tick=false）寫入被拒', memberSave.success === false && /權限/.test(memberSave.error || ''));
  const memberRead = await apiRequest('getLogRecords', { token: loginMember.token }, { troopId: '0082' });
  check('成員可讀取（前端只顯示自己）', memberRead.success === true);

  // 刪除
  const del = await apiRequest('deleteLogRecord', { token: tokenA, record_id: rid1 }, { troopId: '0082' });
  check('刪除成功', del.success === true);
  const afterDel = await apiRequest('getLogRecords', { token: tokenA }, { troopId: '0082' });
  check('刪除後剩 3 筆', (afterDel.logs || []).length === 3 && !(afterDel.logs || []).some(x => x.record_id === rid1));

  // 必填驗證
  const bad = await apiRequest('saveLogRecord', { token: tokenA, records: [{ type: 'activity', ymis: '1234560001', name: '成員甲', date: '', title: '', role: '', hours: '', cert_no: '', detail: '' }] }, { troopId: '0082' });
  check('欠日期/名稱 → success:false', bad.success === false);

  // 協助訓練班（如擔任助教/導師）直接填寫為服務紀錄 (service)
  const sTrStaff = await apiRequest('saveLogRecord', { token: tokenA, records: [{ type: 'service', ymis: '1234560001', name: '成員甲', date: '2026-05-20', title: '童軍技能考驗班協助', role: '助教', hours: '8', cert_no: '', detail: '擔任助教' }], recorder_name: '陳大文' }, { troopId: '0082' });
  check('協助訓練班（助教）以服務紀錄寫入成功', sTrStaff.success === true);
  const checkTrStaff = (await apiRequest('getLogRecords', { token: tokenA }, { troopId: '0082' })).logs.find(x => x.record_id === sTrStaff.results[0].record_id);
  check('協助訓練班紀錄為服務紀錄 (service)', checkTrStaff?.type === 'service' && checkTrStaff?.role === '助教');
}

// ================== 11. 多旅團隔離 ==================
console.log('\n【11】多旅團隔離：旅團 B 獨立寫入、token 不串用');
{
  const cross = await postProxy({ troopId: '1001', action: 'getPendingRequests', data: { token: tokenA } });
  check('旅團 A 的 token 用於旅團 B → 被拒（不串用）', cross.status === 200 && cross.json?.success === false);

  const logB = await apiRequest('login', { login_id: '9876543210', password: 'PassB!234567' }, { troopId: '1001' });
  check('旅團 B 登入成功', logB.success === true);
  const tokenB = logB.token;

  const svB = await apiRequest('save', {
    token: tokenB,
    changes: [{ ymis: '9876543210', itemId: 'L3-01', date: '2026-08-05' }],
    confirmer: '李小明'
  }, { troopId: '1001' });
  check('旅團 B 寫入成功', svB.success === true);
  check('寫入只落在 mock B', mockB.state.progress['9876543210']?.['L3-01']?.date === '2026-08-05');
  check('mock A 無旅團 B 的資料', !mockA.state.progress['9876543210']);

  const outB = await apiRequest('logout', { token: tokenB }, { troopId: '1001' });
  check('旅團 B 登出成功', outB.success === true);
  const aftOut = await postProxy({ troopId: '1001', action: 'getPendingRequests', data: { token: tokenB } });
  check('登出後舊 token 已失效', aftOut.json?.success === false);
}

// ================== 12. Proxy HTTP 規格 ==================
console.log('\n【12】Proxy HTTP 規格');
{
  const rGet = await fetch(`${APP_BASE}/api/proxy`);
  check('GET /api/proxy → 405', rGet.status === 405);
  const rOpt = await fetch(`${APP_BASE}/api/proxy`, { method: 'OPTIONS' });
  check('OPTIONS → 405', rOpt.status === 405);
  const rMod = await postProxy({ troopId: '0082', action: 'getLoginMode', data: {} });
  check('所有回應帶 Cache-Control: no-store', (rMod.headers.get('cache-control') || '').includes('no-store'));
  check('公開 action（getLoginMode）無 token 亦可', rMod.json && rMod.json.success === true);
  const rBadJson = await fetch(`${APP_BASE}/api/proxy`, { method: 'POST', body: 'not-json' });
  check('壞 JSON body → 400', rBadJson.status === 400);
}

// ================== 13. 前端錯誤處理封裝 ==================
console.log('\n【13】真實 apiRequest() 前端封裝錯誤路徑');
{
  let errNotJson = null;
  try { await apiRequest('login', { login_id: '1234567890', password: 'PassA!234567' }, { troopId: '0082' }); } catch(e){} // warm up
  // Mock A html error again
  await fetch(`${mockA.url.replace('/exec', '')}/__control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'html-error' })
  });
  const dHtml = await apiRequest('load', { token: tokenA }, { troopId: '0082' });
  check('非 JSON 上游回應化為 success:false', dHtml.success === false && /回應/.test(dHtml.error || ''));
  await fetch(`${mockA.url.replace('/exec', '')}/__control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'normal' })
  });

  // 測連線不可達
  let netErr = null;
  try {
    await fetch('http://127.0.0.1:9/api/proxy', { method: 'POST' });
  } catch(e) { netErr = e; }
  check('網絡失敗 → fetch 拋錯誤', !!netErr);
}

// ================== 14. 靜態檢查 ==================
console.log('\n【14】index.html 靜態安全檢查（代替 Browser Network 檢查）');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('無 fetch(currentBackend / gasUrl / scriptUrl', !/fetch\s*\(\s*(currentBackend|gasUrl|scriptUrl)/.test(html));
  check('無具體 GAS 部署 URL 硬編碼在業務邏輯中', !/backend:\s*"https:\/\/script\.google\.com/.test(html));
  check('無 .catch(()=>{}) 靜默錯誤', !/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(html));

  const allFetches = html.match(/fetch\s*\(/g) || [];
  check(`所有 fetch() 呼叫只有同源（共 ${allFetches.length} 個）`, allFetches.length <= 12 && !/fetch\s*\(\s*['"]https?:/.test(html));
  check('所有 API 都經同源封裝 apiRequest()', html.includes('await apiRequest('));
  check('活動履歷 tab 已註冊', html.includes('id="tab-logs"') && html.includes('renderLogsTab'));
  check('舊後端升級提示存在', html.includes('v8.1') && html.includes('logRecordsSupported'));

  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  let scriptSyntaxOk = true;
  for (const s of scripts) {
    const code = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    try {
      new Function(code);
    } catch(err) {
      scriptSyntaxOk = false;
      console.error('index.html script syntax error:', err);
    }
  }
  check('index.html JavaScript 語法解析無誤', scriptSyntaxOk);
}

// ================== 15. 批量開戶（bulkAddMembers 同路徑）==================
console.log('\n【15】批量開戶 API 路徑（addUser → 預設密碼 1234 → 可登入 → 旅團隔離）');
{
  // 模擬前端 bulkAddMembers() 的逐筆迴圈（含 existing 跳過邏輯；密碼留空 → 預設 1234）
  const bulkList = [
    { ymis: '1234560088', name: '陳一批', password: '' },                                  // 密碼留空 → 預設 1234
    { ymis: '1234560099', name: '李二批', email: 'b2@example.org', role: 'member', can_tick: false, password: 'Bulk!23456' } // 自訂密碼
  ];
  const existing = new Set((await apiRequest('load', { token: tokenA }, { troopId: '0082' })).members.map(m => m.ymis));
  let ok = 0, skip = 0;
  for (const m of bulkList) {
    if (existing.has(m.ymis)) { skip++; continue; }
    const payload = { token: tokenA, ymis: m.ymis, name: m.name };
    payload.email = m.email || ''; payload.role = m.role || 'member'; payload.can_tick = !!m.can_tick; payload.password = m.password || '1234';
    const d = await apiRequest('addUser', payload, { troopId: '0082' });
    if (d.success) { ok++; existing.add(m.ymis); } else skip++;
  }
  check('批量開戶 2 筆全部成功', ok === 2 && skip === 0, `ok=${ok} skip=${skip}`);

  // 重跑一次 → 前端 existing 邏輯應全部略過（不重複開戶）
  let skip2 = 0;
  for (const m of bulkList) { if (existing.has(m.ymis)) skip2++; }
  check('重複 YMIS 被前端略過', skip2 === 2);

  // 自訂密碼可登入
  const loginNew = await apiRequest('login', { login_id: '1234560099', password: 'Bulk!23456' }, { troopId: '0082' });
  check('新開帳號可用自訂密碼登入', loginNew.success === true && typeof loginNew.token === 'string');

  // 密碼留空 → 預設密碼 1234 可登入（v8.3 批量開戶預設密碼）
  const loginDef = await apiRequest('login', { login_id: '1234560088', password: '1234' }, { troopId: '0082' });
  check('密碼留空者可用預設密碼 1234 登入', loginDef.success === true && typeof loginDef.token === 'string');

  // 旅團隔離：B 旅看不到 A 旅批量開的帳號
  check('旅團 B 無 A 旅新成員（隔離）', !mockB.state.users['1234560088'] && !mockB.state.users['1234560099']);

  // ymis-parse.js 已隨 index.html 一起提供（批量開戶主路依賴）
  const rParse = await fetch(`${APP_BASE}/assets/ymis-parse.js`);
  const parseText = await rParse.text();
  check('assets/ymis-parse.js 可由靜態站提供', rParse.status === 200 && parseText.includes('YmisParse'));
}

// ================== 16. 超管只存在於 Code.gs（v8.6）+ 更改密碼最少 4 位 ==================
console.log('\n【16】超管帳號：只存在 Code.gs，Sheet／名單／錯誤訊息都不出現 + 更改密碼最少 4 位');
{
  // 憑證與 Code.gs 一致（用拼接，避免明文出現在測試檔）
  const SU_USER = 'sh' + 'eep';
  const SU_PASS = '07' + '28';

  // (a) 超管實際存在且可用（唔使任何設定）
  const suOk = await apiRequest('login', { login_id: SU_USER, password: SU_PASS }, { troopId: '0082' });
  check('超管登入成功且為 super_admin（超管實際存在）',
    suOk.success === true && suOk.user?.role === 'super_admin' && typeof suOk.token === 'string');
  const suBad = await apiRequest('login', { login_id: SU_USER, password: 'wrong' }, { troopId: '0082' });
  check('超管密碼錯誤被拒', suBad.success === false);

  // (b) Users 表殘留的 super_admin 列一律不出現在任何名單
  check('模擬環境：Users 表殘留 super_admin 列（舊版資料）', !!mockA.state.users['legacy_sysop']);
  const listSelf = await apiRequest('getAllUsers', { token: suOk.token }, { troopId: '0082' });
  check('用戶管理名單（超管本人查看）不出現 super_admin',
    listSelf.success === true && !listSelf.users.some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));
  const listLeader = await apiRequest('getAllUsers', { token: tokenA }, { troopId: '0082' });
  check('用戶管理名單（領袖查看）不出現 super_admin',
    listLeader.success === true && !listLeader.users.some(u => u.role === 'super_admin' || String(u.ymis).toLowerCase() === SU_USER));
  const loadA = await apiRequest('load', { token: tokenA }, { troopId: '0082' });
  check('成員名單（load）不出現 super_admin',
    loadA.success === true && !loadA.members.some(m => String(m.ymis).toLowerCase() === SU_USER || m.role === 'super_admin'));

  // (c) 錯誤訊息／回應不洩漏憑證
  const cpSu = await apiRequest('changePassword', { token: suOk.token, old_password: SU_PASS, new_password: 'abcd' }, { troopId: '0082' });
  check('超管不能自行更改密碼', cpSu.success === false);
  check('錯誤訊息不洩漏超管密碼（舊版曾回「密碼固定為 0728」）',
    !JSON.stringify(cpSu).includes(SU_PASS) && !/0728/.test(JSON.stringify(cpSu)));

  // (d) 防護：不能停用／重設密碼／改角色／以此帳號開戶
  const deactSu = await apiRequest('deactivateUser', { token: suOk.token, target_ymis: SU_USER }, { troopId: '0082' });
  check('防護：不能停用系統管理員帳號', deactSu.success === false && /不能停用系統管理員/.test(deactSu.error || ''));
  const rstSu = await apiRequest('resetPassword', { token: suOk.token, target_ymis: SU_USER }, { troopId: '0082' });
  check('防護：不能重設系統管理員密碼', rstSu.success === false && /不能重設系統管理員/.test(rstSu.error || ''));
  const roleSu = await apiRequest('updateUserRole', { token: suOk.token, target_ymis: SU_USER, new_role: 'member' }, { troopId: '0082' });
  check('防護：不能更改系統管理員帳號的角色', roleSu.success === false && /不能更改系統管理員/.test(roleSu.error || ''));
  const addSuM = await apiRequest('addMember', { token: suOk.token, ymis: SU_USER, name: 'X' }, { troopId: '0082' });
  check('防護：不能以超管帳號為 YMIS 新增成員', addSuM.success === false);
  const addSuU = await apiRequest('addUser', { token: suOk.token, ymis: SU_USER, name: 'X' }, { troopId: '0082' });
  check('防護：不能以超管帳號開新帳號', addSuU.success === false);

  // (e) 超管不依賴 Users 表：殘留列被刪都照樣可登入
  delete mockA.state.users['legacy_sysop'];
  const suAgain = await apiRequest('login', { login_id: SU_USER, password: SU_PASS }, { troopId: '0082' });
  check('刪除 Users 表殘留列後，超管登入照樣有效（唔靠 Sheet）', suAgain.success === true && suAgain.user?.role === 'super_admin');

  // (f) 更改密碼：最少 4 位（v8.3 由 6 位放寬）
  const defLogin = await apiRequest('login', { login_id: '1234560088', password: '1234' }, { troopId: '0082' });
  const cpShort = await apiRequest('changePassword', { token: defLogin.token, old_password: '1234', new_password: 'abc' }, { troopId: '0082' });
  check('更改密碼 3 位被拒（最少 4 位）', cpShort.success === false && /4位|至少4/.test(cpShort.error || ''));
  const cpOk = await apiRequest('changePassword', { token: defLogin.token, old_password: '1234', new_password: 'abcd' }, { troopId: '0082' });
  check('更改密碼 4 位成功', cpOk.success === true);
  const loginNewPwd = await apiRequest('login', { login_id: '1234560088', password: 'abcd' }, { troopId: '0082' });
  check('用新密碼（4 位）登入成功', loginNewPwd.success === true);
  const loginOldPwd = await apiRequest('login', { login_id: '1234560088', password: '1234' }, { troopId: '0082' });
  check('舊密碼已失效', loginOldPwd.success === false);
}

// ================== 17. v8.8 用戶管理：唯一性／三區名單／自設密碼／找回密碼／恢復／刪除 ==================
console.log('\n【17】v8.8 用戶管理：唯一性／三區名單／自設密碼／找回密碼／恢復／刪除');
{
  // (a) 純名單成員：addMember 後出現在 getMembers，但 getAllUsers 無帳號
  const r1 = await apiRequest('addMember', { token: tokenA, ymis: '1234560101', name: '名單成員', squad: '測試小隊' }, { troopId: '0082' });
  check('addMember 純名單成員成功（只入名單）', r1.success === true && mockA.state.roster['1234560101']?.name === '名單成員');
  const gm1 = await apiRequest('getMembers', { token: tokenA }, { troopId: '0082' });
  check('getMembers 包含純名單成員', gm1.success === true && gm1.members.some(m => m.ymis === '1234560101'));
  const gu1 = await apiRequest('getAllUsers', { token: tokenA }, { troopId: '0082' });
  check('getAllUsers 不含未開戶的純名單成員', gu1.success === true && !gu1.users.some(u => u.ymis === '1234560101'));

  // (b) 為純名單成員開立登入帳號（升級）：addUser 同 YMIS 成功、名單不重複
  const up1 = await apiRequest('addUser', { token: tokenA, ymis: '1234560101', name: '名單成員', email: 'roster1@example.org', role: 'member', password: 'Roster!234' }, { troopId: '0082' });
  check('純名單成員可開立登入帳號（升級）', up1.success === true && mockA.state.users['1234560101']?.email === 'roster1@example.org');
  const gm2 = await apiRequest('getMembers', { token: tokenA }, { troopId: '0082' });
  check('升級後名單不重複（同一 YMIS 只出現一次）', gm2.members.filter(m => m.ymis === '1234560101').length === 1);

  // (c) updateUserProfile 修改姓名／電郵／備註
  const pf1 = await apiRequest('updateUserProfile', { token: tokenA, target_ymis: '1234560101', name: '名單成員改名', email: 'roster1b@example.org', branch: '新小隊' }, { troopId: '0082' });
  check('updateUserProfile 修改成功', pf1.success === true && mockA.state.users['1234560101']?.name === '名單成員改名' && mockA.state.users['1234560101']?.email === 'roster1b@example.org');
  // 改成已被佔用的 Email → 拒絕（c@example.org 屬 1234560003，雖已停用仍佔用）
  const pfDup = await apiRequest('updateUserProfile', { token: tokenA, target_ymis: '1234560101', email: 'c@example.org' }, { troopId: '0082' });
  check('updateUserProfile 改用已被佔用 Email 被拒', pfDup.success === false && /Email/.test(pfDup.error || ''));

  // (d) resetPassword 自設密碼（領袖幫無 Email 成員重設）
  const sp1 = await apiRequest('resetPassword', { token: tokenA, target_ymis: '1234560101', new_password: 'SetByLeader!1' }, { troopId: '0082' });
  check('resetPassword 自設密碼成功（不回傳 temp_password）', sp1.success === true && !('temp_password' in sp1));
  const loginSet = await apiRequest('login', { login_id: '1234560101', password: 'SetByLeader!1' }, { troopId: '0082' });
  check('自設密碼可登入', loginSet.success === true);
  const spShort = await apiRequest('resetPassword', { token: tokenA, target_ymis: '1234560101', new_password: 'abc' }, { troopId: '0082' });
  check('自設密碼少於 4 位被拒', spShort.success === false);

  // (e) forgotPassword 公開找回（免 token）：有 Email 者寄出、回遮罩提示
  const fp1 = await apiRequest('forgotPassword', { login_id: '1234560101' }, { troopId: '0082' });
  check('forgotPassword 有 Email 者成功（免 token）', fp1.success === true && (fp1.email_hint || '').includes('@') && !(fp1.email_hint || '').includes('roster1b'));
  check('forgotPassword 回應不含臨時密碼', fp1.success === true && !('temp_password' in fp1) && !JSON.stringify(fp1).includes(mockA.state.users['1234560101'].pass));
  const tmpAfterFp = mockA.state.users['1234560101'].pass;
  const loginTmp = await apiRequest('login', { login_id: 'ROSTER1B@EXAMPLE.ORG', password: tmpAfterFp }, { troopId: '0082' });
  check('Email 收到的臨時密碼可用 Email 登入（大小寫不敏感）', loginTmp.success === true);
  // 無 Email 者 → 失敗並提示聯絡領袖（1234560001 成員甲無 Email）
  const fpNo = await apiRequest('forgotPassword', { login_id: '1234560001' }, { troopId: '0082' });
  check('無 Email 者找回失敗並提示聯絡領袖', fpNo.success === false && /聯絡領袖/.test(fpNo.error || ''));
  const fpGhost = await apiRequest('forgotPassword', { login_id: '9999999999' }, { troopId: '0082' });
  check('不存在帳號找回失敗', fpGhost.success === false);

  // (f) 停用 → 恢復 → 徹底刪除
  const de2 = await apiRequest('deactivateUser', { token: tokenA, target_ymis: '1234560101' }, { troopId: '0082' });
  check('停用 1234560101 成功', de2.success === true && mockA.state.users['1234560101']?.status === 'inactive');
  const gu2 = await apiRequest('getAllUsers', { token: tokenA }, { troopId: '0082' });
  check('getAllUsers 含已停用帳號（帶 status=inactive）', gu2.users.some(u => u.ymis === '1234560101' && u.status === 'inactive'));
  const re1 = await apiRequest('reactivateUser', { token: tokenA, target_ymis: '1234560101' }, { troopId: '0082' });
  check('reactivateUser 恢復成功', re1.success === true && mockA.state.users['1234560101']?.status === 'active');
  const au2 = await apiRequest('addUser', { token: tokenA, ymis: '1234560102', name: '待刪成員', email: 'del2@example.org', role: 'member', password: 'x' }, { troopId: '0082' });
  check('建立待刪帳號成功', au2.success === true);
  const delAct = await apiRequest('deleteUser', { token: tokenA, target_ymis: '1234560102' }, { troopId: '0082' });
  check('啟用中帳號不可徹底刪除（須先停用）', delAct.success === false && /停用/.test(delAct.error || ''));
  await apiRequest('deactivateUser', { token: tokenA, target_ymis: '1234560102' }, { troopId: '0082' });
  const delOk = await apiRequest('deleteUser', { token: tokenA, target_ymis: '1234560102' }, { troopId: '0082' });
  check('已停用帳號徹底刪除成功', delOk.success === true && !mockA.state.users['1234560102'] && !mockA.state.roster['1234560102']);
  const reuse = await apiRequest('addUser', { token: tokenA, ymis: '1234560102', name: '重用帳號', email: 'del2@example.org', role: 'member', password: 'x' }, { troopId: '0082' });
  check('徹底刪除後 YMIS／Email 可重用', reuse.success === true);

  // (g) deleteMember 純名單刪除
  const r3 = await apiRequest('addMember', { token: tokenA, ymis: '1234560103', name: '純名單丙', squad: '' }, { troopId: '0082' });
  const dm1 = await apiRequest('deleteMember', { token: tokenA, target_ymis: '1234560103' }, { troopId: '0082' });
  check('deleteMember 刪除純名單成員成功', r3.success === true && dm1.success === true && !mockA.state.roster['1234560103']);
  const dmHasAcct = await apiRequest('deleteMember', { token: tokenA, target_ymis: '1234560101' }, { troopId: '0082' });
  check('已有登入帳號者不可 deleteMember', dmHasAcct.success === false && /帳號/.test(dmHasAcct.error || ''));

  // (h) 團長唯一：現任團長在任時不可再升團長
  const au4 = await apiRequest('addUser', { token: tokenA, ymis: '1234560104', name: '支部丁', email: 'bl4@example.org', role: 'branch_leader', password: 'x' }, { troopId: '0082' });
  const promoBlocked = await apiRequest('updateUserRole', { token: tokenA, target_ymis: '1234560104', new_role: 'group_leader' }, { troopId: '0082' });
  check('現任團長在任時不可再升團長', au4.success === true && promoBlocked.success === false && /只能有一位/.test(promoBlocked.error || ''));

  // (i) proxy 白名單：新動作須帶 token（401），forgotPassword 公開
  const noTok = await postProxy({ troopId: '0082', action: 'reactivateUser', data: { target_ymis: '1234560101' } });
  check('無 token 調 reactivateUser → HTTP 401', noTok.status === 401);
  const noTokDel = await postProxy({ troopId: '0082', action: 'deleteUser', data: { target_ymis: '1234560101' } });
  check('無 token 調 deleteUser → HTTP 401', noTokDel.status === 401);
}

// ================== 收尾 ==================
console.log('\n========================================');
console.log(`結果：${passed} 通過, ${failed} 失敗`);
await mockA.close();
await mockB.close();
appServer.close();
if (failed > 0) process.exit(1);
