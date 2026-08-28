# APP ADMIN 工作流程 - 同一個 APP 管晒所有旅團

## 你問：管理員是指向同1個APP ADMIN的對吧？

**答：係！**

- 每個支部是**獨立APP**：
  - `vsbadge.vercel.app` → 深資童軍 #8B0000
  - `roverbadge.vercel.app` → 樂行童軍 #0D47A1
  - `scoutbadge.vercel.app` → 童軍 #2E7D32
  - `cubbadge.vercel.app` → 幼童軍 #FFC107

- 每個 APP **各自**有一個 APP ADMIN (維護該 Vercel Project 的人，擁有 `系統管理員` super_admin)
  - 例如 vsbadge 的 APP ADMIN 管晒所有用 vsbadge 的旅團 (0082, 0015, 0233...)
  - 唔係每個旅團開一個 Vercel，係共用同一個

## 旅團加入流程 (你講的正確)

```
[旅團 A] --\
            +--> 提交 URL + APIKEY --> [vsbadge APP ADMIN] --> 改 troops.json + 加 TROOP_XXX_APIKEY --> Redeploy
[旅團 B] --/
```

**旅團需提交：**
- 旅團編號 (如 0082)
- 名稱 (第 82 旅)
- Backend URL (/exec)
- API KEY (rover_xxxx)

**管理員做：**
1. 編輯 `data/troops.json` + `troops.json` (公開)
2. Vercel 加1個環境變數 `TROOP_0082_APIKEY=rover_xxxx` (防爬虫，不進 GitHub)
3. Redeploy

## 為何咁設計？

- **URL 不用功能變數**：backend 公開無妨，靠 `token` + `role` 防人類
- **API KEY 防爬虫**：放環境變數，避免 GitHub 被掃到，`api/troops.js` 合併後前端先拿到
- **人類靠登入防**：即使拿到 backend+apikey，無 token 都讀唔到進度
- **同一個 APP ADMIN**：方便集中維護，一個 Vercel Project 管幾十個旅團

## GS 自動生成 API KEY 已加入

`apps-script/Code.gs`:

- `getApiKey()`：若無就 `rover_` + uuid
- `showApiKey()`：隨時查看
- `initializeSheets()`：初始化完彈出 KEY + URL

## 超管（super_admin）- v8.5 起：程式碼零憑證

**舊做法（v8.4 及以前）已廢除：** 帳號密碼寫死在 `Code.gs`（並由 `initializeSheets()` 彈框顯示）。
問題：`Code.gs` 是部署指南頁上的公開下載檔，任何人都能下載看到；而每個旅團執行 `initializeSheets()` 時彈框還會直接把帳號密碼顯示給該旅團的部署者。

**現行做法：**

- `Code.gs` 內 **沒有任何** 超管帳號或密碼（只有 Script Properties 的鍵名）
- `initializeSheets()` 完成提示只顯示：Sheets 清單、API Key、URL、**本旅團**管理員帳號 — 不會提及系統管理帳號
- 憑證只存於該 Apps Script 專案的 `Script Properties`（`SUPER_ADMIN_USER` + `SUPER_ADMIN_PASS_HASH`，密碼只存 SHA-256 雜湊）
- 由部署者本人執行 `setSuperAdmin()` 設定（三次 prompt：帳號 / 密碼 / 確認密碼；密碼不回顯、不寫入任何工作表）
- `clearSuperAdmin()` 停用；`getSuperAdminStatus()` 只回 `{enabled:true/false}`，永不回傳憑證
- 未執行 `setSuperAdmin()` ＝ 該旅團 **沒有** 超管帳號，不存在預設後門
- 用戶管理／成員名單任何角色（包括 super_admin 自己）都睇唔到 super_admin 列；`removeSuperAdminRows()` 自動清除 Users 表殘留列
- 防護保留：不能停用／重設密碼／更改角色／自行更改密碼

**⚠️ 舊版憑證已作廢：** 任何仍在使用 v8.4 及以前 `Code.gs` 的旅團 Sheet，其寫死後門仍然生效 — 請盡快把新版 `Code.gs` 貼到各旅團的 Apps Script 並重新部署，然後按需執行 `setSuperAdmin()`（每個旅團用不同密碼）。

## 檢查

- 0082R 已移除：scoutbadge 之前有殘留，已清
- vsbadge 文字殘留：roverbadge/cubbadge/scoutbadge 之前寫 vsbadge 管理員，已改為各自 app 管理員
- fallback URL 已更新為最新 https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec

COPYRIGHT 2026 Scout System
