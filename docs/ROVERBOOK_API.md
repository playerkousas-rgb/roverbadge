# ROVERBOOK 用戶端 API（`/api/roverbook`）

> ROVERBOOK 已合併到 `main`，佢只會經**呢一個 endpoint** 同 ROVERBADGE 溝通。
> 呢個 endpoint 刻意同本系統前端用的 `/api/proxy` **完全分開**：一個只懂四件事的細介面，
> 比喺 proxy 加 client 判斷更難出錯（唔會有一條漏寫 `403` 的路）。

預設對接：`https://roverbadge.vercel.app`

---

## 1. 對外契約

### 1.1 旅團清單

```http
GET /api/roverbook?action=troops
```

```json
{
  "success": true,
  "troops": { "0082": { "name": "第82旅", "en": "82nd Rover Scout Group" } },
  "privacy": { "personalData": "none" }
}
```

- 只有 `id` ＋ `name`（＋可選 `en`）。
- **永不**回 `backend`／`apikey`／Portal 設定；`Cache-Control: public, max-age=300`。

### 1.2 動作（POST）

```http
POST /api/roverbook
Content-Type: application/json

{ "action": "login", "troopId": "0082", "data": { "login_id": "81420", "password": "…" } }
```

| action | 用途 | 回應（全部零個資） |
| --- | --- | --- |
| `login` | 成員登入 | `{ success, token, scoutId, ymis, force_change_password }` — **姓名／電郵／角色一律剝走** |
| `logout` | 登出 | `{ success }` |
| `load` | 讀全團進度（BOOK 伺服器端自行過濾自己） | `{ success, members[], progress, otherBadges, pendingRequests, schemes }` |
| `requestComplete` | 申請完成一項 | `{ success, status: 'pending', request_id }` — **一定係 pending**，領袖在 ROVERBADGE CONFIRM 才計入進度 |

### 1.3 被拒絕的動作

| 情況 | 狀態碼 | 例子 |
| --- | --- | --- |
| 已知寫入／管理類 action | **403 Forbidden** | `save`、`saveOtherBadge`、`reviewRequest`、`reviewApplication`、`addUser`、`upsertUser`、`exportUsers`、`resetPassword`、`updateConfig`、`bookSync`、`bookConfirm`、`bookAward`、`apply`、`forgotPassword`… |
| 完全未知的 action | 400 | `action: "whatever"` |
| 缺 token（`load`／`requestComplete`／`logout`） | 401 | — |
| 輸入格式錯（缺密碼、壞項目代號） | 400 | — |
| 找不到旅團 | 404 | — |
| payload > 200 KB | 413 | — |
| 上游逾時 | 504 | — |

> `403` 同 `400` 分開，係為咗令 ROVERBOOK 端一睇就知「呢個動作被制度禁止」而唔係「打錯字」。

---

## 2. 零個資料

`api/roverbook.js` 用**白名單**輸出，再過一道 `stripNever()`：

- 永遠不會出現：`name`、`nameZh`、`nameEn`、`email`、`phone`、`address`、`dob`、`photo`、
  `signature`、`holderSignature`、`png`、`ink`、`emergencyName`、`emergencyPhone`、
  `group`、`crew`、`district`、`password`、`password_hash`、`apikey`、`token`（除 login 回傳自己嗰個）…
- `load` 的 `progress` 只留 `{ itemId: { date, confirmer? } }`；`confirmer` 係**領袖姓名**（唔係成員個資）。
- `otherBadges` 只留 `{ date }`（連 `cert` 都唔回——證書編號有機會含個人資料）。
- `pendingRequests` 只留 `request_id`／`scoutId`／`item_id`／`requested_date`／`status`；
  **證據（`evidence`，可能係相片）永遠唔回**。
- 測試 `tests/roverbook-api.test.mjs` 會逐個欄位斷言，並用真 HTTP server 驗 403 白名單。

---

## 3. SCOUT ID ：十位數前導零正規化

規格：`81420 ⇄ 0000081420` 係同一個人。

| 輸入 | 正規化 |
| --- | --- |
| `81420` | `0000081420` |
| ` 81420 ` | `0000081420` |
| `0000081420` | `0000081420` |
| `L12345`（領袖內部編號） | `L12345`（原樣） |
| 空／null | `''` |

- Vercel 端：`api/roverbook.js` `scoutNorm()`。
- GAS 端：`apps-script/Code.gs` `scoutNorm_()` / `scoutAliases_()` / `scoutMatches_()`（同一套）。
- **只影響比對，唔改寫任何既有 Sheet 資料**；但新寫入的紀錄（新帳號、待批、核簽、頒發、進度）一律存正規化值，
  所以唔會出現「一人兩份」。
- `load` 回傳的 `progress`／`otherBadges` key 亦係正規化值 → BOOK 過濾自己嗰個 key 就直接對得上。

> 為何要同時接受兩種寫法：成員在 ROVERBOOK 輸入的多數是 `81420` 這種短寫法（YMIS 後 5 位），
> 而 Google Sheet 內的 Users 表可能存 `0000081420`。兩邊都要通，否則「明明同一個人卻話搵唔到」。

---

## 4. 同 ROVERBADGE 內部（`/api/proxy`）的分工

| | `/api/proxy`（本系統前端） | `/api/roverbook`（ROVERBOOK） |
| --- | --- | --- |
| 身份 | 領袖＋成員（完整功能） | 成員（只有 4 個 action） |
| 寫入 | `save`／`reviewRequest`／`bookConfirm`… 全部可用 | **一律 403** |
| 個資 | 本系統自己的資料（姓名、電郵…） | **零個資**，連姓名都剝走 |
| 進度權威 | 領袖 CONFIRM = 完成 | 只能 `requestComplete` → pending |

ROVERBOOK 端**唔會**、亦**唔可以**用 `/api/proxy`：即使佢攞到一個有效 token，
`/api/proxy` 會檢查角色（`save` 需要勾選權限），而 `bookConfirm` 這類 action 更只有領袖可用。
`/api/roverbook` 係額外一道更窄的門。

---

## 5. 部署

1. Vercel 部署本版（`scripts/build.mjs` 會打包第五個 function `api/roverbook.func`，只依賴 `_registry`）。
2. `GET https://roverbadge.vercel.app/api/roverbook?action=troops` 應回 `{ success: true, troops: {...} }`。
3. `POST` 一個 `save` 應回 **403**（唔係 400／200）—— 這是白名單生效的證據。
4. Apps Script 貼上本版 `Code.gs` → 部署新版本（SCOUT ID 正規化喺 GAS 端生效）。

## 6. ROVERBOOK 端用法

```js
const base = 'https://roverbadge.vercel.app';
// 1. 旅團
const { troops } = await (await fetch(`${base}/api/roverbook?action=troops`)).json();
// 2. 登入（只回 token＋scoutId）
const login = await (await fetch(`${base}/api/roverbook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'login', troopId: '0082', data: { login_id: '81420', password } })
})).json();
// 3. 讀（自己過濾自己：進度 key 係正規化 SCOUT ID）
const all = await (await fetch(`${base}/api/roverbook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'load', troopId: '0082', data: { token: login.token } })
})).json();
const mine = all.progress[login.scoutId] || {};
// 4. 申請完成（只會變 pending）
await fetch(`${base}/api/roverbook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'requestComplete', troopId: '0082', data: { token: login.token, item_id: 'L1-ACT-01' } })
});
```

## 6.5 與 ROVERBOOK 現行程式碼的相容性（2026-11-05 對照實碼）

ROVERBOOK 現時**唔係**打 `/api/roverbook`，而係打 `<origin>/api/proxy`：

| ROVERBOOK 端 | 實際請求 | BADGE 端承接 |
| --- | --- | --- |
| `login` | `proxy('login', { login_id, password })`，讀 `up.user.ymis` | `handleLogin`（`login_id` 已接受 SCOUT ID／未補零） |
| `load` | `proxy('load', { token })`，之後在 `members[]` 內以 `scoutId \|\| ymis \|\| memberNo` 搵本人 | `handleLoad` — **每個 member 自帶 `progress`／`flatProgress`／`badges`／`otherBadges`／`pendingRequests`** |
| `submitPending` | 逐項 `proxy('requestComplete', { token, itemId, date })` | `handleRequestComplete` — 一律 `status:'pending'`，並回 `id`／`date` 供 BOOK 記錄 |
| `save` / `saveOtherBadge` / `reviewRequest` | BOOK 自己 403，唔會打上嚟 | BADGE 一樣擋（成員 token 寫唔入） |

關鍵三點（缺一 BOOK 就顯示空白或重複送交）：

1. **`members[]` 每個人都要帶自己嗰份 `progress`**（`{itemId: 'YYYY-MM-DD'}`）。
2. **所有 SCOUT ID 一律 10 位補零**（`81420` → `0000081420`）——BOOK 用 `padStart(10,'0')` 比對。
3. **`pendingRequests` 只放未批項目**（`[{itemId,date,status:'pending'}]`），批完就消失，否則 BOOK 會重複送交。

`tests/roverbook-api.test.mjs` 內 `roverbookFilterPersonalConfirmedLoad()` 係逐行照抄 BOOK 的過濾邏輯，用來鎖住呢個契約。

## 7. 相關測試

| 檔案 | 覆蓋 |
| --- | --- |
| `tests/roverbook-api.test.mjs` | 白名單／403／400／401／404／413、零個資（逐欄位）、`scoutNorm`、`requestComplete` 一律 pending、真 HTTP、build 打包、GAS 端同一套正規化 |
| `tests/roverbook-bridge.test.mjs` | 橋接邏輯、CONFIRM 閘、只加不減、雙向信任、撤回、頒發更正 |
| `tests/proxy-actions.test.mjs` | 本系統前端每個 `apiRequest` 都在 proxy 白名單 |
