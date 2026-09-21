// Vercel Serverless Function - 旅團清單 API v4.0
// v4.0 變更：
//   - 旅團登記唯一來源是 Vercel 環境變數（TROOP_{ID}_NAME / _BACKEND / _APIKEY），
//     不再讀任何 JSON 檔案，也沒有前端 fallback
//   - 只回傳 {id: {name[, portal]}}；backend URL / apikey 任何情況都不對前端公開
//   - portal 欄位（可選）= Portal 接入設定（來源網址／允許角色／停用），非機密；
//     來源網址／角色參數檢查只是軟性檢查，不是身份驗證
// 旅團註冊流程：旅團提交 編號+名稱+URL+APIKEY 給管理員 → 管理員在 Vercel 加環境變數 → Redeploy

import { listPublicTroops, getPortalDefaults } from './_registry.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ success: false, error: '此 API 只接受 GET 請求' });
  }
  const troops = listPublicTroops();
  const portalDefaults = getPortalDefaults();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    troops,
    portalDefaults,
    _note: 'v4.0：旅團登記只來自 Vercel 環境變數；backend/apikey 不對前端公開，所有 GAS 存取請經同源 /api/proxy'
  });
}
