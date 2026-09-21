// 中央登入票據驗證服務 — POST /api/verify-super-ticket
//
// 用途：旅團 GAS 收到 proxy 轉發的 superTicketLogin 後，向這個「固定於 Code.gs 常量／
// Script Properties 的可信端點」驗票（驗證服務網址不由登入請求指定）。
//
// 輸入：{ ticket, backend }   backend = GAS 自報的 ScriptApp URL
// 輸出：{ valid: true, login_id } 或 { valid: false }
//   - 只認由本 APP 簽發（AES-256-GCM）、未過期、且綁定同一旅團後端的票據
//   - 永不回傳密碼／API Key；log 只記錄結果，不記錄票據內容
//
// GET：只回服務名稱，供 GAS 端 testCentralVerify() 做「不讀寫 Sheet」的授權／連線測試。

import { superConfigured, verifySuperTicket } from './_super.js';

function send(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(obj);
}

function safeLog(fields) {
  try { console.log(JSON.stringify({ svc: 'roverbadge-verify', ...fields })); } catch (e) { /* ignore */ }
}

// Vercel 會預先解析 JSON body（req.body）；本機／vercel dev 用 raw stream 時自行讀取
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) return null; // 驗票請求很小；過大直接拒絕
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    // 連線測試用：不含任何機密，也不透露設定狀態細節
    return send(res, 200, { success: true, service: 'roverbadge-super-verify' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    return send(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  const body = await readBody(req);
  if (!body || typeof body !== 'object') return send(res, 400, { valid: false });

  const ticket = typeof body.ticket === 'string' ? body.ticket : '';
  const backend = typeof body.backend === 'string' ? body.backend : '';

  if (!superConfigured()) {
    safeLog({ result: 'not_configured' });
    return send(res, 200, { valid: false });
  }
  const payload = verifySuperTicket(ticket, backend);
  if (!payload) {
    safeLog({ result: 'invalid_ticket', ticketPresent: !!ticket, backendPresent: !!backend });
    return send(res, 200, { valid: false });
  }
  safeLog({ result: 'valid', troopId: payload.t });
  return send(res, 200, { valid: true, login_id: String(payload.id || '') });
}
