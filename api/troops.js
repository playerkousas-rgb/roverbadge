// Vercel Serverless Function - 旅團清單 API v4.0
// v4.0 變更：
//   - 旅團登記唯一來源是 Vercel 環境變數（TROOP_{ID}_NAME / _BACKEND / _APIKEY，
//     另有可選 TROOP_{ID}_EN 英文名稱），不再讀任何 JSON 檔案，也沒有前端 fallback
//   - 只回傳 {id: {name, en}}；backend URL / apikey / Portal 設定
//     任何情況都不對前端公開（與姊妹系統 vsbadge 同結構；
//     Portal 免登入改由同源 /api/portal 在伺服器端驗證，見 docs/PORTAL_INTEGRATION.md）
// 旅團註冊流程：旅團提交 編號+名稱+URL+APIKEY 給管理員 → 管理員在 Vercel 加環境變數 → Redeploy

import { listPublicTroops } from './_registry.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ success: false, error: '此 API 只接受 GET 請求' });
  }
  const troops = listPublicTroops();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    troops,
    _note: 'v4.0：旅團登記只來自 Vercel 環境變數；backend/apikey/Portal 設定不對前端公開，所有 GAS 存取請經同源 /api/proxy，Portal 免登入請經同源 /api/portal 驗證'
  });
}
