# 批量開戶（Bulk Onboarding）

一次過為整團開立多名成員 / 帳號，不用逐個填表。

> ⚠️ 本文所有編號／姓名／電郵／旅團代號均為虛構示範資料（例如 `1234560101` / `陳大文` / `chan@example.org`），
> 不含任何真實成員資料。

## 四種開戶方式定位

| 方式 | 定位 | 說明 |
|---|---|---|
| ⓪ 領袖上載 YMIS 自訂報表 PDF（APP 內「📥 批量開戶」） | **批量開戶主路（最推薦）** | YMIS 匯出 → 上載（支援密碼解鎖）→ 預覽 → 一鍵開戶，見 [`YMIS_EXPORT.md`](YMIS_EXPORT.md) |
| ① 後端 Sheet 直接寫（本文件 Apps Script） | **進階／備用，日常不建議** | 特殊情況或無前端權限時使用 |
| ② 前端自行申請 → 領袖前端審批 | 個人開戶主路 | APP 內「🆕 申請成員帳戶」，領袖於「✅ 審批中心 → 用戶審批」批准 |
| ③ 領袖前端上傳批量範本（APP 內「📥 批量開戶」） | 批量開戶備路 | 下載範本 → 前端上傳 → APP 轉 JSON 寫入後端 |

> 設計原則：所有開戶盡量在前端完成。方法①僅作備用。

## 方法零：YMIS 自訂報表 PDF 直接匯入（最推薦）

```
YMIS 自訂報表（編號→中文姓名→電郵）──► 下載 PDF ──► APP 上載（可輸入密碼）──► 預覽/修正 ──► 批量開戶
```

1. 在 YMIS 匯出自訂報表，欄位**必須依序**為：**童軍成員編號 → 中文姓名 → 電郵地址**。
2. APP → 👥 用戶管理 → **📥 批量開戶** → 輸入 PDF 密碼（如有）→ **📄 上載 YMIS PDF 報表**。
3. 檢查預覽表（YMIS／姓名／電郵可即場修改，已存在的成員自動不勾）。
4. 設定預設小隊／支部、角色、初始密碼（留空＝只加入名單，不開登入帳號）。
5. 按 **🚀 確認批量開戶**。

PDF 解密在瀏覽器內以 `pdf.js` 完成，檔案與密碼都不會上傳伺服器。
讀不到時可改用「🔍 解析貼上的文字」，或先用 Chrome／Edge 列印為無密碼 PDF。
完整步驟、密碼處理與疑難排解見 [`YMIS_EXPORT.md`](YMIS_EXPORT.md)。

## 流程總覽（備用路）

```
下載範本 CSV ──► 填寫 ──► 轉為 JSON ──► 寫入旅團的 Sheet（Google Sheet）
```

「旅團的 Sheet」即你旅團後端（`apps-script/Code.gs`）所用的 Google Sheet。
**多旅團架構**：每個旅團有自己的後端 deployment 及 Sheet，資料完全隔離；
以下操作請針對「你旅團」的 Sheet / 後端網址 / API Key 執行。

成員帳號存放在名為 **`Users`** 的工作表，欄位結構與後端完全一致（13 欄）：

```
ymis, name, email, role, password_hash, branch, can_tick, auth_by,
auth_date, created_at, last_login, status, allowed_badges
```

角色 `role`：`member / exec_committee / branch_leader / group_leader / admin`。

## 方法二（APP 內 CSV）：在 APP 直接上傳 CSV

1. 登入 APP（領袖或以上）→ 進入「👥 用戶管理」。
2. 按 **📥 批量開戶** → **⬇️ 下載成員範本 CSV**（即 [`data/members_template.csv`](../data/members_template.csv)）。
3. 在試算表軟件打開，填寫每位成員的資料。
4. 回到對話框，按 **📤 上傳填好的 CSV**，系統會自動為每位成員開戶。
   - 有填 `password` → 開立可登入帳號（`addUser`，密碼以 SHA-256 雜湊儲存）。
   - 只填 `ymis` + `name` → 只加入成員（`addMember`，寫入「成員名單」，不可登入）。
5. 亦可把 JSON 陣列貼到文字框，按 **🚀 由 JSON 批量開戶**。

### 範本欄位（CSV）

| 欄位 | 說明 |
|---|---|
| ymis | 10 位數字（必填，作為帳號） |
| name | 姓名（必填） |
| email | 電郵（開帳號時建議填） |
| role | member / exec_committee / branch_leader / group_leader / admin |
| can_tick | true / false（可否勾選進度） |
| password | 有填則開立可登入帳號 |
| note | 備註（僅提醒用，不寫入 Users 工作表） |
| squad（選填） | 小隊／支部 |
| squad_role（選填） | member / 隊長 / 副隊長 |

## 方法三（備用）：Google Sheets + Apps Script

適合直接在 Google Sheets 操作，資料在試算表內轉 JSON 並直接寫入旅團的 Sheet。

1. 在 Google Sheets 新建試算表。
2. **檔案 > 匯入 > 上載 > 選取本機 CSV**，選 `data/members_template.csv`（或從 app 下載的同一份）。
3. 填寫資料。
4. **擴充套件 > Apps Script**，把 [`assets/batch-onboard/Code.gs`](../assets/batch-onboard/Code.gs) 的內容貼上並儲存。
5. 修改檔首 `CONFIG`：
   - `MAIN_SHEET_ID`：你旅團主資料表的 ID（直接寫入時需要，出現在網址 `/d/.../` 之間）。
   - `APIKEY`：你旅團的 API Key（用「推送後端」時需要）。
   - `BACKEND_URL`：你旅團後端的 doPost 部署網址（用「推送後端」時需要）。
   - `USERS_SHEET`：主資料表內成員工作表名稱，預設 `Users`。
6. 回到試算表，重新整理，出現 **批量開戶** 選單：
   - **✍️ 直接寫入主資料表**：直接 append 到你旅團 Sheet 的 `Users` 工作表（依 ymis 跳過重複）。
   - **📤 轉JSON並推送後端**：逐列 POST 到你旅團後端 `addMember` / `addUser`。
   - **📝 預覽JSON**：先檢查將轉出的 JSON。

### 全新 Sheet 也可以！（自動建表）

直接寫入支援**全新、完全空白的 Sheet**：

- 若 `Users` 工作表不存在 → 自動建立。
- 若 `Users` 工作表沒有 `ymis` 表頭（空白新表）→ 自動寫入標準 13 欄表頭。
- 有填 `password` 的成員會以 SHA-256 雜湊儲存密碼，開戶後即可登入（建議首次登入修改密碼）。
- 無密碼的成員只會寫入「成員名單」工作表，與後端 `addMember` 行為一致。

> 提示：若你想要這份 Sheet 完全由 app 使用（含進度追蹤、審批、操作紀錄等其他工作表），
> 請先執行 app 後端的 `initializeSheets()` 一次性建立所有工作表，再執行批量開戶。

## 注意

- YMIS 必須為 10 位數字，否則該列會被忽略（YMIS PDF 匯入可用「🔢 全部補零至10位」輔助）。
- 已存在的 YMIS 會被跳過（不覆蓋）。
- 直接寫入時密碼會以雜湊形式儲存，與 app 後端登入機制一致。
- 批量操作建議先以小量（2–3 筆）測試，確認無誤再全團匯入。

## 相關文件

- [`YMIS_EXPORT.md`](YMIS_EXPORT.md) — YMIS 匯出自訂報表逐步教學
- [`../assets/ymis-parse.js`](../assets/ymis-parse.js) — PDF／文字解析器（瀏覽器 + Node 通用）
- 單元測試：`node tests/ymis-parse.test.mjs`
