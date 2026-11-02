# 忘記密碼（電郵一次性重設碼）— 使用與部署說明

> 適用版本：前端 v5.2 ＋ **GS 5.2.3（2026-11-02）**。舊版 GS（未支援 `requestPasswordReset`／`confirmPasswordReset`）會收到 `Unknown action`，前端會顯示「此旅團後端尚未支援忘記密碼功能，請聯絡領袖在『用戶管理』重設密碼」。

## 這是什麼

成員／領袖忘記密碼時，**毋須聯絡任何人**：在登入頁（兩個登入分頁底部都有「🔑 忘記密碼」）輸入 **YMIS 或登記電郵** → 系統寄一組 **8 位一次性重設碼**到登記電郵 → 在同一個視窗輸入重設碼並設定新密碼 → 即時生效，所有舊登入 session 一併失效。

與舊有功能並存：v8.8 起的「臨時密碼寄電郵」流程（`forgotPassword` action）**仍然可用**（會寄臨時密碼到登記電郵），但由 2026-11-02 起為符合防枚舉要求（readme repo A17），無論帳戶是否存在、有冇登記電郵，API 都回同一個中性成功訊息，唔再回 `email_hint`／「找不到此帳號」；實際只會向已登記電郵寄信。前端已全面改用上面嘅重設碼流程。

## 使用流程（用戶）

1. 登入頁 → 點「🔑 忘記密碼」→ 輸入 YMIS 或登記電郵 → 「📧 發送重設碼」
2. 收電郵，輸入 **8 位重設碼**（不分大小寫，可貼上 `ABCD-1234` 格式）＋ 新密碼（至少 4 位，輸入兩次）→ 「💾 設定新密碼」
3. 成功後自動帶回登入頁，用新密碼登入

提示訊息不會洩漏「這個帳戶存唔存在」：未登記電郵、已停用、甚至不存在的電郵，回應都一樣。

## 安全設計（重點）

- **重設碼只存 SHA-256 雜湊**：新增「密碼重設」工作表（`reset_id, ymis, email, code_hash, created_ms, expires_ms, attempts, status, used_at`），永不儲存明文重設碼；操作紀錄亦只寫中性記錄（`system / password_reset_by_email`），不含重設碼或密碼。
- **一次性 + 時效**：重設碼 **15 分鐘**有效，最多 **5 次**錯誤嘗試後鎖定（`locked`）；成功使用後即作廢（`used`）；新申請會作廢舊碼（`superseded`），同一帳戶任何時間只會有一組有效碼；過期自動標記 `expired`；帳戶其後被停用或改了電郵，確認時會作廢（`void`）並拒絕。
- **限速**：同一電郵 30 分鐘內最多申請 3 次；全團每小時最多 30 次；寫入前有 `LockService` 鎖（8 秒）防止並發重複發碼。舊碼保留 24 小時後自動清理，不影響登入。
- **不洩漏帳戶**：所有「找不到／無電郵／已停用／不合資格」的情況回應完全一致（仍會寫一行 `no_account` 記錄方便限速，但不寄信、不洩漏）；super_admin 帳號一律不能自助重設。
- **電郵注入防護**：電郵欄位拒絕以 `= + - @` 開頭（Google Sheets 公式注入）。
- **成功後撤銷所有 session**：重設成功會刪除該用戶所有 Tokens（舊裝置要重新登入），新密碼**不會**觸發強制改密。
- **Proxy 層**：`requestPasswordReset`／`confirmPasswordReset` 是登入前公開 action（不需 token），但 `api/proxy.js` 會主動剷走請求內的 `token / ymis / target_ymis / role / password_hash / code_hash / user / apikey / sig / sig_ts / sig_nonce`，API Key 只在 server 端補上，前端永遠唔會接觸到。
- **合資格帳戶**：任何「已啟用、非 super_admin、已登記電郵且已設密碼」的帳戶（包括普通成員）都可用。

## 旅團部署／升級步驟

1. 前端：Vercel 重新部署（v5.2，毋須改版本號）。
2. 各旅團 Apps Script：貼上新 `Code.gs`（GS 5.2.3，2026-11-02）→ 在**既有部署**上選「新版本」→ 部署（沿用原網址）。
3. **重新授權電郵範圍**（重要）：新版本用 `MailApp.sendEmail` 寄重設碼；部署後第一次執行會彈出授權視窗，必須批准 `https://www.googleapis.com/auth/gmail.send`（script 外寄信）。舊部署只授權過 Sheets 權限的話，發信會失敗。
4. `initializeSheets()` 會一併建立「密碼重設」工作表；**舊 Sheet 毋須重跑初始化**——第一次有人申請重設碼時會自動補建，既有資料完全不受影響（資料保全規則不變）。
5. （建議）在 Apps Script 編輯器執行一次 `testPasswordResetMail()`：會寄一封測試信去執行者（你自己）的 Gmail，成功後自動清走「發信故障」旗標；冇執行者電郵就會拋錯，提示先登入 Google 帳號再執行。

## 發信失敗怎麼辦（delivery=unavailable）

如果 GAS 未重新授權 `gmail.send`，寄信會失敗；此時兩個 action 仍回 `{success:true, delivery:'unavailable'}`，前端顯示「本旅團電郵發信暫未啟用，請聯絡領袖在『用戶管理』重設密碼」。這個旗標是**全團共通**的，不會洩漏邊個帳號有效；重新授權後再發一次成功就會自動清旗標。管理員亦可手動執行 `testPasswordResetMail()` 測試及清旗標。

## 相關檔案

- `apps-script/Code.gs`：`handleRequestPasswordReset`／`handleConfirmPasswordReset`／`testPasswordResetMail`、`getPasswordResetSheet`（即用即補建）、`密碼重設` 工作表
- `api/proxy.js`：兩個 action 列入 `PUBLIC_ACTIONS`，並剷走身份欄位
- `index.html`：兩步式「忘記密碼」modal（`fpwStep1` 發碼 → `fpwStep2` 輸碼設新密碼），兩個登入分頁底部都有入口
- `tests/password-reset.test.mjs`：18 項測試（完整流程、YMIS 申請、不洩漏、鎖定／過期／作廢、限速、注入防護、session 撤銷＋操作紀錄、發信失敗旗標、舊 Sheet 自動補建、閂口模式、proxy 剷字段、真 proxy→mock GAS 端到端）
