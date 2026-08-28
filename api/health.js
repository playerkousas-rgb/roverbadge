// Vercel 同源部署診斷端點 — GET /api/health
//
// 存在原因：Vercel 顯示「綠燈」只代表靜態檔部署成功，不代表 /api/* function 有被建立。
// 2026-08 那次全站登入失效，就是靜態站正常、所有 function 404，前端只看到
// 「伺服器回應格式異常 (HTTP 404)」，完全看不出是部署問題。
//
// 部署完成後只要開這個 URL 就能確認三件事：
//   1) Function 真的存在（回應是 JSON 而非 Vercel 的 HTML 404 頁）
//   2) 旅團 Registry 解析到有效旅團（registry.source / troops[].backendTrusted）
//   3) 執行環境（Node 版本、region、includeFiles 是否生效）
// 本端點刻意不回傳 apikey、GAS 完整 URL、任何帳號資料。

import { getRegistryDiagnostics, listTroopHealth } from './_registry.js';

// Function 設定（maxDuration / includeFiles）統一喺 vercel.json 管理

function send(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Roverbadge-Api', 'ok');
  return res.status(status).json(obj);
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
    api: 'v3.1',
    time: new Date().toISOString(),
    runtime: {
      node: process.version,
      vercel: process.env.VERCEL === '1',
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || null
    },
    registry: {
      source: diag.source,
      includeFilesWorking: /^file:/.test(diag.source),
      fileTroopsFound: diag.fileTroopsFound,
      staticTroopsFound: diag.staticTroopsFound,
      cwd: diag.cwd,
      envBackendTroops: diag.envBackendTroops
    },
    troops: trusted.map(t => ({ id: t.id, name: t.name, backendHost: t.backendHost, apikeyConfigured: t.apikeyConfigured })),
    ...(configured ? {} : {
      error: '旅團 Registry 解析不到任何有效後端，/api/proxy 將回 404。請檢查 data/troops.json 是否已同步、Vercel 是否重新部署。'
    })
  });
}
