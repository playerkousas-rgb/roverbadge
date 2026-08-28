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
2. **`npm run sync:troops`**（重新產生 `api/_troops_static.js`；漏咗呢步 = function 讀唔到旅團 = 該旅團登入死，
   `npm test` 會 fail 住提醒你）
3. Vercel 加1個環境變數 `TROOP_0082_APIKEY=rover_xxxx` (防爬虫，不進 GitHub)
4. Redeploy，然後開 `https://<app>.vercel.app/api/health` 確認 `"success":true`
   （**唔好以 Vercel 綠燈為準**；綠燈只代表靜態檔上咗，`/api/*` 可以成整列 404）

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

## 超管（super_admin）- v8.6：只存在於 Code.gs

**規格：超管實際存在、裝完即用；除咗 Code.gs 本身，任何地方都不提佢。**

| 位置 | 會唔會出現超管 |
| --- | --- |
| `Code.gs`（`getSuperAdminUser()` / `getSuperAdminPass()`） | ✅ 唯一存在的地方 |
| Google Sheet（Users 表） | ❌ 冇這列；`initializeSheets()` 會自動清走舊版殘留列 |
| Google Sheet（Tokens 表） | ❌ 超管 session 以中性代號 `__sys__` 儲存，唔會出現帳號 |
| `initializeSheets()` 完成小視窗 | ❌ 只顯示 Sheets / API Key / URL / 本旅團管理員 |
| 用戶管理 / 成員名單 / load | ❌ 任何角色（包括超管本人）都睇唔到 |
| 任何 API 回應 / 錯誤訊息 | ❌ 不會回傳帳號或密碼（舊版錯誤訊息曾直接寫出密碼，已移除） |
| 本 repo 文件 | ❌ 刻意不記錄憑證 |

**要点：**

- 憑證只寫喺 `Code.gs` 頂部嘅兩個函式，用字串拼接避免明文凭證被搜尋到（**注意：這不是加密** —— `Code.gs` 是部署指南頁嘅公開下載檔，拿到檔案嘅人讀得到）
- 唔使任何設定：新旅團貼上 `Code.gs` → 執行 `initializeSheets()` → 部署，超管即刻可用
- `checkSuperAdmin()` 只回 `{enabled:true/false}`，供你核對，永不回傳憑證
- `removeSuperAdminRows()` 可單獨執行，清走 Users 表殘留嘅 super_admin 列
- 防護保留：不能停用／重設密碼／更改角色／自行更改密碼／以此帳號開戶
- 進度紀錄嘅「確認者」欄寫嘅係顯示名稱（`系統管理員`），唔係帳號

**如要換憑證：** 改 `Code.gs` 內 `getSuperAdminUser()` / `getSuperAdminPass()` 兩行，然後逐團重新貼上並重新部署。

## 檢查

- 0082R 已移除：scoutbadge 之前有殘留，已清
- vsbadge 文字殘留：roverbadge/cubbadge/scoutbadge 之前寫 vsbadge 管理員，已改為各自 app 管理員
- fallback URL 已更新為最新 https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec

COPYRIGHT 2026 Scout System
