// Vercel 同源部署診斷端點 — GET /api/health
//
// 存在原因：Vercel 顯示「綠燈」只代表靜態檔部署成功，不代表 /api/* function 有被建立。
// 2026-08 那次全站登入失效，就是靜態站正常、所有 function 404，前端只看到
// 「伺服器回應格式異常 (HTTP 404)」，完全看不出是部署問題。
//
// 部署完成後只要開這個 URL 就能確認四件事：
//   1) Function 真的存在（回應是 JSON 而非 Vercel 的 HTML 404 頁）
//   2) 旅團 Registry（TROOP_* 環境變數）解析到有效旅團（registry.source / troops[].backendTrusted）
//   3) 執行環境（Node 版本、region）
//   4) 中央登入鏈路（SUPER_KEY）Vercel 側自測（super.selfTest：簽票→驗票→綁定→session）
// 本端點刻意不回傳 apikey、GAS 完整 URL、任何帳號資料。

import { getRegistryDiagnostics, listTroopHealth, getRegistry } from './_registry.js';
import {
  superConfigured, issueSuperTicket, verifySuperTicket,
  wrapSessionToken, unwrapSessionToken, SESSION_PREFIX
} from './_super.js';

// Function 設定（maxDuration / includeFiles）統一喺 vercel.json 管理

function send(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Roverbadge-Api', 'ok');
  return res.status(status).json(obj);
}

// ---- 中央登入（SUPER_KEY）鏈路自測 ----
// 只測 Vercel 側一半：簽票 → 驗票（正／錯 backend）→ session 包裝／解包。
// 不接觸任何 GAS、Sheet、真實帳號；回應只含 ok/fail 步驟名，永不含密碼／票據／key。
// 目的：登入失敗時可以先分清「Vercel 側壞咗」定「旅團 GAS 側壞咗」。
function superChainSelfTest() {
  if (!superConfigured()) return { configured: false, selfTest: 'skipped_not_configured' };
  const reg = getRegistry();
  const troop = Object.entries(reg).find(([, t]) => t.backend && t.backendTrusted);
  if (!troop) return { configured: true, selfTest: 'skipped_no_trusted_troop' };
  const [id, t] = troop;
  const ticket = issueSuperTicket({ loginId: 'selftest', troopId: id, backend: t.backend });
  if (!ticket) return { configured: true, selfTest: 'fail:issue', checkedTroop: id };
  const ok = verifySuperTicket(ticket, t.backend);
  if (!ok || ok.id !== 'selftest') return { configured: true, selfTest: 'fail:verify', checkedTroop: id };
  const crossed = verifySuperTicket(ticket, 'https://script.google.com/macros/s/SOMEOTHERTROOP/exec');
  if (crossed) return { configured: true, selfTest: 'fail:backend_binding', checkedTroop: id };
  const forged = verifySuperTicket(ticket.slice(0, -2) + 'xx', t.backend);
  if (forged) return { configured: true, selfTest: 'fail:tamper_check', checkedTroop: id };
  const wrapped = wrapSessionToken(id, 'selftest-token');
  if (!wrapped || !wrapped.startsWith(SESSION_PREFIX)) return { configured: true, selfTest: 'fail:wrap', checkedTroop: id };
  if (unwrapSessionToken('other', wrapped) !== null) return { configured: true, selfTest: 'fail:session_binding', checkedTroop: id };
  if (unwrapSessionToken(id, wrapped) !== 'selftest-token') return { configured: true, selfTest: 'fail:unwrap', checkedTroop: id };
  return { configured: true, selfTest: 'ok', checkedTroop: id };
}

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, { success: false, error: '此 API 只接受 GET 請求' });
  }
  const diag = getRegistryDiagnostics();
  const troops = listTroopHealth();
  const trusted = troops.filter(t => t.backendTrusted);
  const configured = trusted.length > 0;
  return send(res, configured ? 200 : 503, {
    success: configured,
    service: 'roverbadge-api',
    api: 'v4.0',
    time: new Date().toISOString(),
    runtime: {
      node: process.version,
      vercel: process.env.VERCEL === '1',
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || null
    },
    registry: {
      source: diag.source,
      troopsFound: diag.troopsFound,
      cwd: process.cwd(),
      envBackendTroops: diag.envBackendTroops,
      portalDefaultOriginSet: diag.portalDefaultOriginSet,
      portalDefaultRolesSet: diag.portalDefaultRolesSet
    },
    super: superChainSelfTest(),
    troops: trusted.map(t => ({ id: t.id, name: t.name, backendHost: t.backendHost, apikeyConfigured: t.apikeyConfigured })),
    ...(configured ? {} : {
      error: '旅團 Registry 解析不到任何有效後端，/api/proxy 將回 404。請檢查 Vercel 環境變數 TROOP_{ID}_BACKEND / TROOP_{ID}_APIKEY 是否已設定，並重新部署。'
    })
  });
}
