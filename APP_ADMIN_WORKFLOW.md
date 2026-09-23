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
            +--> 提交 URL + APIKEY --> [APP ADMIN] --> Vercel 加 TROOP_{ID}_NAME/_BACKEND/_APIKEY --> Redeploy
[旅團 B] --/
```

**旅團需提交：**
- 旅團編號 (如 0082)
- 名稱 (第 82 旅)
- Backend URL (/exec)
- API KEY (rover_xxxx)

**管理員做（v4.0 起純環境變數，唔使改 repo 任何檔案）：**
1. Vercel Dashboard 加 3 個環境變數：`TROOP_0082_NAME=第 82 旅`、
   `TROOP_0082_BACKEND=https://script.google.com/macros/s/.../exec`、`TROOP_0082_APIKEY=rover_xxxx`
   （編號保留前導 0；backend/apikey 唔會出瀏覽器）
2. Redeploy，然後開 `https://<app>.vercel.app/api/troops` 確認 JSON 有 `troops` 旅團清單
   （**唔好以 Vercel 綠燈為準**；綠燈只代表靜態檔上咗，`/api/*` 可以成整列 404）
3. 再開 `/api/troops` 確認新旅團 id+name 出現

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

## 中央管理帳號（super_admin）- v8.9：密碼只喺 Vercel 驗證

**規格：帳號識別字只寫喺 `Code.gs` 一行（`const SUPER_ADMIN_ID = ...`）；密碼由 Vercel 環境變數 `SUPER_KEY` 驗證，GAS／Sheet 永遠收唔到密碼或 hash。**

| 位置 | 會唔會出現密碼／帳號 |
| --- | --- |
| `Code.gs` | 只有一行帳號識別字宣告；冇任何密碼 |
| Vercel `SUPER_KEY` | ✅ 密碼唯一存放處（≥4 字元字串，前導 0 保留） |
| Google Sheet（Users 表） | ❌ 冇這列；舊版殘留 super_admin 列會被忽略 |
| Google Sheet（Tokens 表） | ❌ session 以中性代號 `__sys__` 儲存，唔會出現帳號 |
| `initializeSheets()` 完成小視窗 | ❌ 只顯示 Sheets / API Key / URL / 本旅團管理員 |
| 用戶管理 / 成員名單 / load | ❌ 任何角色都睇唔到 |
| 任何 API 回應 / 錯誤訊息 / log | ❌ 只有一般用語；密碼、token、apikey 一律唔會落 log |

**登入鏈路（vsbadge 同構：GAS 只回打固定受信端點 `/api/super` 驗票）：**

1. 前端將帳號+密碼 POST 去 `/api/proxy`（同普通登入一樣）
2. proxy 喺 Vercel 側用 `SUPER_KEY` 做完整比對（timing-safe）；通過先簽發 **60 秒 AES-256-GCM 加密票據**
   （`rbs1.` 前綴；payload 綁定旅團 id＋backend＋apikey）
3. proxy 轉發 `action=login`（附 `super_ticket`，**唔再附密碼**——密碼永遠唔出現在 GAS）
4. GAS 回打固定受信端點 `SUPER_VERIFY_URL`（`/api/super`）驗票（受信核對＋一次性防重放）→ 先發 token
   （帶 `rbs-super-v1-` 標記）—— 唯一回打就係呢個固定端點
5. 瀏覽器攞到嘅係加密包裝、旅團綁定嘅 session（`rbs1.` 前綴），跨旅團無效

**要点：**

- `SUPER_KEY` 未設／空／少於 4 字元 → 中央登入停用，一般旅團登入不受影響；冇預設密碼、冇旁路
- 舊版 GAS 直接密碼入口已移除（新版）：就算直接打 GAS `login`，系統管理員帳號都會被拒；
  有效 `super_ticket`＋apikey 先會過（唔做回傳＝唔收密碼登入）
- 舊版 GAS（未升級）一律唔通：proxy 唔再附密碼（vsbadge 同構；系統未流出，唔做舊版兼容），升級新版 Code.gs 即可
- 4 字元係明確選擇嘅政策：離線暴力破解風險仍然存在；登入限速（每旅團每 IP 60 秒 10 次）只能減慢線上嘗試
- 姊妹 APP 各自設同一個 `SUPER_KEY` 即可用同一組憑證；跨 APP SSO 未實作
- 防護保留：不能停用／重設密碼／更改角色／以此帳號開戶
- 進度紀錄嘅「確認者」欄寫嘅係顯示名稱（`系統管理員`），唔係帳號

**如要換密碼：** 只改 Vercel `SUPER_KEY` → Redeploy → 完成（唔使碰 GAS／Sheet；舊加密 session 會失效，重新登入即可）。

## 檢查

- 0082R 已移除：scoutbadge 之前有殘留，已清
- vsbadge 文字殘留：roverbadge/cubbadge/scoutbadge 之前寫 vsbadge 管理員，已改為各自 app 管理員
- fallback URL 已更新為最新 https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec

COPYRIGHT 2026 Scout System
