# 旅系統對齊 — 進度系統版（roverbadge）

> 版本號只保留在此 MD。`apps-script/Code.gs` 與 `assets/batch-onboard/Code.gs` 內所有 `// vX.X` 版本註解已全數清除（`tests/troop_link.test.mjs` 第 10 項守護）。

**版號：v9.0 — 旅系統對齊版（2026-09-22；2026-09-23 補完接入步驟表與支部 SHEET 成對說明）；對齊基準：vsbadge `operations/TROOP_LINK_UPGRADE.md`**

---

## 0. 定位：同一份 Code.gs，三層節點（旅 > 團（支部） > 進度）

roverbadge 同 vsbadge **完全一致**：同一份 `Code.gs` 部署喺每一層節點（旅／團（支部）／進度），
層與層之間係上游／下游關係，**上游控下游寫**（旅控團、團控進度）：

```
        旅 GAS ──── sig ────▶ 團（支部）GAS ──── sig ────▶ 進度 GAS
          │                        │                          │
   登記下游 B + D            登記下游 B + D            ALLOW_LOCAL_LOGIN
   DOWNSTREAM_<id>_URL      DOWNSTREAM_<id>_URL        （直接入口掣）
   DOWNSTREAM_<id>_KEY      DOWNSTREAM_<id>_KEY
```

- 上游喺**自己** Sheet 嘅 Script Properties 登記下游嘅 B＋D：

```
DOWNSTREAM_<id>_URL = <下游節點 /exec URL>
DOWNSTREAM_<id>_KEY = <下游節點 API_KEY>
```

（有地域有鎖匙先入到；掛錯對方一測 sig／一睇結構就會發現會改返。）

- **每團補一張「支部 SHEET」，與現有「進度 SHEET」成對**：「支部 SHEET」係**成張全新 Google Sheet
  部署**（新 Sheet → 貼同一份 `Code.gs` → `initializeSheets()` → 部署 → 抄 B/D）——
  支部 SHEET 係上游節點、進度 SHEET 係下游節點，一對一配對。
- 程式層面**冇「支部」工作表（tab）、冇支部登記表**：呢個「支部 SHEET」係部署單位，唔係工作表。
  v9 舊方案嘅 `BRANCH_SHEET_NAME='支部'`、`handleGetBranches/handleSaveBranch/handleDeleteBranch`、
  前端「支部管理」卡片係另一回事（舊支部工作表方案），已全數移除；
  `initializeSheets()` 不再建支部工作表、不再預設寫入 `ALLOW_LOCAL_LOGIN`。
  （`成員名單` 表嘅「支部」欄係既有 schema 嘅小隊標籤，保留唔改。）

---

## 1. 變數 ABCD — 一律唔寫入任何工作表

| 代號 | 變數名 | 值 | 產生者 | 填寫 | 備註 |
|---|---|---|---|---|---|
| **A** | `SUPER_KEY` | 中央管理密碼 | Vercel env `SUPER_KEY` | **隱藏**，與旅系統無關 | 是次不改動、不顯示；中央管理帳號登入（`login` + `super_ticket` 本地驗簽，零回傳）與旅系統閘門脫鉤，直接入口關閉後仍可用 |
| **B** | 本節點 `/exec` URL | `https://script.google.com/macros/s/.../exec` | **GS 產生**（`ScriptApp.getService().getUrl()`，部署後生效） | 選單「🔑 顯示 BACKEND／APIKEY（交 ADMIN）」 | 交上游／ADMIN 登記 |
| **C** | NAME | 節點顯示名稱 | **自行填寫** | 交 ADMIN 時一併提供 | 例如 `第 82 旅（進度）` |
| **D** | APIKEY（SHEET KEY） | `rover_` + uuid24 | **GS 產生**（`getApiKey()`，initializeSheets 彈窗） | 選單「🔑 顯示 BACKEND／APIKEY（交 ADMIN）」 | 存本節點 Script Properties `API_KEY` |

一次過流程：Sheet 選單 **🔗 旅系統 → 🔑 顯示 BACKEND／APIKEY（交 ADMIN）** →
收件匣（前端 `submitRegistration` → `/api/proxy` → 固定中央收件端點）→ ADMIN 入 Vercel env。

**禁令：**
- ❌ ABCD 一律唔寫入任何工作表（登記資料只存 Script Properties）
- ❌ 唔改 A（`SUPER_KEY` 由 Vercel 側控，GS 內不含、不收、不比對）
- ❌ 唔設 callback；下游永不回打上游（所有 sig 流向只有 上游 → 下游）

**換 D（撤銷舊 key）**：本節點 Script Properties 刪除 `API_KEY` → 執行 `showApiKey()` 生成新 key →
重新交 ADMIN 改 env，並喺上游重新登記下游。

---

## 2. 上下游接入（步驟）

> **接入完全自願**：唔登記下游、或者登記咗但唔閂口，現有旅團一切照舊（`ALLOW_LOCAL_LOGIN` 未設定＝開啟，行為零變化，`tests/troop_link.test.mjs` 測試 1 守呢條）。

| 步驟 | 做乜 | 邊度做 |
|---|---|---|
| 1 | 部署 GS，抄 B 的 URL，生成 D | 每層 Sheet → Apps Script → 部署（執行身分「我」、存取權「任何人」）→ 選單「🔗 旅系統 → 🔑 顯示 BACKEND／APIKEY（交 ADMIN）」 |
| 2 | 填 C，連 B/D 經收件匣交 ADMIN | 首頁「📋 新旅團部署」表單（旅團編號／名稱／Apps Script URL／API Key）→ `submitRegistration` → `/api/proxy` → 固定中央收件端點 |
| 3 | 每團補一張支部 SHEET，與現有進度 SHEET 成對 | 新 Sheet → 貼同一份 `Code.gs` → `initializeSheets()` → 部署 → 抄 B/D |
| 4 | 上游控下游寫：掣在上游（旅控團、團控進度） | 上游選單「➕ 登記下游（URL + SHEET KEY）」→「📡 測試下游連線（sig）」；「🚪 下游直接入口」經 sig 打下游 `setLocalLogin`，旗 `ALLOW_LOCAL_LOGIN` 寫在下游 Script Properties，閂後只收 sig |
| 5 | 搬舊數（第 6 節） | 舊進度「📤 匯出 JSON（含 hash）」→ 新支部「📥 匯入 JSON」，逐個 `upsertUser` 直插 hash（保留舊密碼） |
| 6 | 匯完核對無誤後閂下游直接入口 | 上游選單「🚪 下游直接入口 → 🔒 閂口（只收 sig）」（閂口前有確認彈窗，提醒先完成匯入及連線測試） |
| 7 | 之後開戶一律在上游 | 上游選單「👤 為下游開戶（揀團）」，經 sig 落下游寫 |

- 每層升級都要：Apps Script → 用新 `Code.gs` 全檔覆蓋 → 部署 → **管理部署 → ✏️ 編輯 → 版本選「新版本」**（`/exec` URL 唔變，Registry 唔使改）。
- **只有全新嘅支部 SHEET 先執行 `initializeSheets()`**；現有進度 SHEET 唔好重跑（唔改 schema、唔清資料）。
- 上游 Script Properties：`DOWNSTREAM_<id>_URL`、`DOWNSTREAM_<id>_KEY`、`DOWNSTREAM_<id>_NAME`、`DOWNSTREAM_<id>_AT`。<id> 由你改（例：`progress`、`branch-a`），只可用英文／數字／底線／連字號，最長 32 字元。旅對住幾個團就登記幾條。
- 下游 Script Properties：`ALLOW_LOCAL_LOGIN`（未設定＝開啟，現有旅團零影響）。

---

## 3. sig — GAS→GAS 直連（HMAC-SHA256，唔經 Vercel proxy，不設回調）

舊方案 `isSigValid = (sig === apikey || sig === hashPassword(apikey))` 已廢除；
`SIG_ACTIONS/WRITE_SIG_ACTIONS/__upstream__` 虛擬用戶亦已移除。

**數學（上游用下游 D 簽署；下游用本機 D 驗證）：**

```
sigKey    = hex( HMAC-SHA256( message = 'roverbadge-troop-sig-v1', key = D ) )
canonical = action + "\n" + ts(毫秒) + "\n" + nonce + "\n" + hex( SHA-256(rawBody) )
sig       = hex( HMAC-SHA256( canonical, sigKey ) )
```

- **雙通道**：query `?sig=&sts=&snonce=`（digest 綁完整原始 body）＋ body `{sig,sig_ts,sig_nonce}`
  （digest 綁去掉三個 sig 欄位後嘅 body）。上游一次送齊兩種；GAS 302 轉址丟失其一種，另一種照樣過關。
- **防重放**：nonce（8–64 位英數 `- _`）經 CacheService 存 10 分鐘、一次性；
  一次請求同時帶兩組 sig 時，**兩組 nonce 一律消耗**，否則重放可以用另一組再入一次。
- **窗口**：±5 分鐘；**體積**：原始 body ≤ 900KB；**格式**：sig 必須 64 位 hex；
  **比較**：先各自 SHA-256 再比對（常數時間）；**方法**：POST only；
  **URL 白名單**：下游 URL 必須係 `https://script.google.com/macros/s/.../exec`。
- **路由**：`doPost` 先驗 sig → 過關即入 `handleSignedRequest()`（白名單路由）；
  `doGet` 唔收 sig（load/getLoginMode 受直接入口掣管）。
- **不設回調**：只有上游主動打下游；下游永遠唔會回打上游，亦冇任何 callback endpoint。

**sig action 白名單（對 roverbadge action set 對齊）：**

- READ：`load, getLoginMode, getLinkState, getMembers, getConfig, getAllUsers, getOtherBadges, getPendingRequests, getApplications, getLogRecords, getPendingLogRequests`
- WRITE：`save, saveOtherBadge, requestComplete, reviewRequest, addMember, addUser, upsertUser, importUsers, resetPassword, deactivateUser, reactivateUser, updateUserProfile, deleteMember, deleteUser, updateUserRole, updatePermissions, saveLogRecord, deleteLogRecord, reviewLogRequest, reviewApplication, setLocalLogin`
- **永不收 sig**：`login, apply, logout, changePassword, forgotPassword, submitLogRequest, updateConfig` 等本地憑證／自我操作 —— 帶有效 sig 都會回「上游簽名請求不接受此操作」。

寫入類請求一律經 `writeAudit('upstream', 'link_signed_<action>', 操作者, …)` 留審計軌跡；
操作者標籤（`on_behalf`）只留安全字元（`[0-9A-Za-z_.@-]`），防止經 auth_by／操作紀錄變成工作表算式。

---

## 4. 直接入口掣 — `ALLOW_LOCAL_LOGIN`（fail closed）

| 掣值 | 行為 |
|---|---|
| **未設定**（預設） | **開啟** — 現有旅團零影響；`initializeSheets()` 唔會自動寫值 |
| `1`／`true`／`yes`／`on`／`open`（大小寫／前後空白不敏感） | 開啟 |
| **其餘任何值**（`false`／`0`／`no`／`off` 或串錯字） | **閂口（fail closed）** |

**閂口後（只收 sig）嘅行為對照：**

| 請求 | 未設定／`true` | `=false`（閂口） |
|---|---|---|
| 前端直接 `login`／`apply`／`forgotPassword` | 照舊 | **拒**，回 `{success:false, upstream_only:true, error:"…只接受上游簽名（sig）請求…"}` |
| `GET ?action=load`／`getLoginMode` | 照舊 | **拒**（同一訊息） |
| apikey 直寫（`save` 等） | 照舊（兼容） | **拒**（apikey 唔再等於授權） |
| 用戶 token 操作 | 照舊 | **拒** |
| 上游 `sig` 請求 | **接受** | **接受** |
| `login` + `super_ticket`（A 中央管理帳號，本地驗簽） | **接受** | **接受**（與旅系統閘門脫鉤） |

- 掣值只存**本節點** Script Properties `ALLOW_LOCAL_LOGIN`；
  寫入途徑：Sheet 選單「🚪 本機直接入口」、前端卡（`setAllowLocalLogin`，團長以上）、上游 sig（`setLocalLogin`）。
- 前端「🔐 上下游控管」卡片同步顯示狀態（`getAllowLocalLogin` 同時回 `allow`／`allow_local_login`，向後兼容）。
- 上游仍可以 sig 讀寫下游（包括用 `setLocalLogin` 再開返）；閂口係可逆。

---

## 5. 開戶 — 上游「為下游開戶（揀團）」，兩邊同一 password_hash

**閂口後新戶在上游揀團開戶，經 sig 落下游寫。**

Sheet 選單 **👤 為下游開戶（揀團）**（或程式 `createAccountForDownstream(id, user, manager)`）：

1. 上游本地開戶（`addUser_`：角色權限檢查、YMIS/Email 唯一性、領袖自動編 L 號照舊）
2. 讀回該帳戶（含 `password_hash`）
3. 經 sig 打下游 `upsertUser`（帶同一 hash、`force_change_password:true`）
4. 任一步失敗會明言「上游已開戶，但下游寫入失敗」（重推用 `upsertUser`，冪等）

`upsertUser` 語義（下游接收端）：
- 新帳戶**必須帶** `password_hash`（64 位 hex）；**明文 `password` 一律被拒**
- 既有帳戶（同 YMIS，或同 Email 認回同一身份）→ **更新**；冇帶 hash → **保留原密碼**（冪等，可重複匯入）
- 冇帶 `branch` 唔洗改既有小隊；保留帳號（`SUPER_ADMIN_ID`）絕不可操作
- `importUsers` 亦可經 sig 批量（`users[]`／`json` 字串／`drive_file_id`）

---

## 6. 吐 JSON（搬舊數）

**場景：舊進度有數，新支部空。**

1. **舊進度按「匯出 JSON（含 hash）」**：Sheet 選單 **📤 匯出 JSON（含 hash）**
   - `exportUsersJson()` 將 `{format:'roverbadge-users-export', schema:1, exported_at, node, count, users[]}`
     寫成 **Drive 私人檔**（`Access.PRIVATE`＋`Permission.NONE`，與 Spreadsheet 同資料夾），彈窗給連結＋檔案 ID
   - 「操作紀錄」只記**筆數＋檔案 ID**；hash 絕不落地任何工作表
   - Drive 寫入失敗時，完整 JSON 寫入「檢視 → 執行紀錄（Logger）」作後備
   - **proxy 後備通道保留**：`exportUsers` action 照舊回 JSON（權限：領袖以上），前端「搬舊數」卡片用；
     前端下載時包成同一 `roverbadge-users-export` 格式，同 Drive 檔互換
2. **新支部按「匯入」，逐個 `upsertUser` 直插 hash（保留舊密碼）**：Sheet 選單 **📥 匯入 JSON（upsertUser 直插 hash）**（貼 Drive 連結／檔案 ID）
   - 或前端卡片「📤 匯入 JSON」（接受 `{users:[...]}` 新格式或純陣列舊格式，逐筆 `upsertUser`）
   - 守衛：明文密碼拒、假 hash 拒、新帳戶冇 hash 拒、缺 YMIS 拒、壞 JSON 拒、一次 ≤ 2000 筆
   - `force_change_password` 跟隨匯出值（搬舊數唔會逼人即時改密碼）；**冪等**：重匯唔會開重複列
   - 完成後彈窗顯示「新增 X、更新 Y、失敗 Z」及首 8 筆失敗原因
3. **匯完可閂下游直接入口**：核對筆數 → 上游「🚪 下游直接入口 → 🔒 閂口（只收 sig）」
4. **匯入後刪除 Drive 匯出檔**（含 hash，唔好用共享資料夾或電郵明文傳送）

---

## 7. 是次唔做（明確範圍）

- ❌ **不在 SHEET 寫 ABCD**（有 `tests/troop_link.test.mjs` 測試 5 守）
- ❌ **唔改 A 本身**（`SUPER_KEY` 只在 Vercel：GS 內不含、不收、不比對任何密碼）。
  ［補充：中央管理登入鏈路已另行升級為**零回傳簽名票據**設計 —— Vercel 驗密碼 →
  HMAC 簽票（by 共享鎖匙 D）→ GAS 本地驗簽；`api/verify-super-ticket.js` 已移除，
  GAS 完全唔會回打 Vercel；舊版 GAS（GS 硬寫密碼）兼容路徑保留。］
- ❌ **唔設回調**（冇 callback endpoint、下游唔會回打上游；**登入都唔做回傳** ——
  只驗 VERCEL 密碼（super）／SHEET 內密碼（members））
- ❌ **唔改 `api/`**：sig 係 GAS→GAS 直連，唔經 Vercel proxy（proxy 舊 action 白名單原樣；
  `exportUsers`／`getAllowLocalLogin`／`setAllowLocalLogin` 作前端卡片後備通道保留；
  超管路徑只涉票據簽／驗數學，action 白名單不變）
- ❌ **唔改工作表 schema**；唔對既有部署重跑 `initializeSheets()`（只補缺、唔覆寫、唔自動設掣）

---

## 8. 清理

- ✅ 移除全部 `// vX.X` 版本註解（`apps-script/Code.gs`、`assets/batch-onboard/Code.gs`；
  `initializeSheets()` 彈窗已無版號字樣，改為「✅ 初始化完成！」＋🔗 旅系統選單提示）
- ✅ 移除（v9 舊支部工作表方案）：`BRANCH_SHEET_NAME/BRANCH_HEADERS/getBranchesList`、
  `handleGetBranches/handleSaveBranch/handleDeleteBranch`、`getAllowLocalLogin(舊)/setAllowLocalLogin(舊)/isSigValid/requireSigOrLocal`、
  `SIG_ACTIONS/WRITE_SIG_ACTIONS/__upstream__`
- ✅ 新增：旅系統接駁段（sig 數學／登記下游／`callDownstream`／開戶／匯出匯入／`handleSignedRequest`）、
  `onOpen` 選單「🔗 旅系統」、`doGet/doPost` 新路由（sig 優先 → 中央登入 → 直接入口掣 → 本地路由）
- ✅ `npm run check && npm run lint && npm test && npm run test:link && npm run build && npm run test:build` 全綠（見第 11 項）

---

## 9. 前端選擇（二選一，本倉庫選：**同步卡片**）

vsbadge 係「零改動前端（選單版）」；roverbadge 已有管理介面，是次選**卡片同步**：

- 「🏕️ 支部管理」卡片（呼叫已移除嘅 branch action）→ 改「🔗 旅系統接駁」資訊卡
  （講明接駁經 Sheet 選單「🔗 旅系統」、sig 唔經 proxy、新節點接入流程）
- 「🔐 上下游控管：ALLOW_LOCAL_LOGIN」卡片保留並同步新語義（未設定＝開啟、fail closed、`upstream_only`）
- 「🔄 搬舊數」卡片保留：proxy `exportUsers` 後備匯出（包成新格式）＋ 匯入（兼容 `{users:[...]}`/陣列）
- 移除死代碼：`refreshBranches/openBranchModal/saveBranchFront/deleteBranchFront`

---

## 10. 檔案對照

| 檔案 | 改動 |
|---|---|
| `apps-script/Code.gs` | 旅系統接駁段＋選單＋新 doGet/doPost 路由；移除支部工作表／舊 sig；`addUser_` 純函數＋`handleAddUser` 包裝；upsert/匯出改新語義 |
| `assets/batch-onboard/Code.gs` | 移除版本註解（文字保留） |
| `index.html` | 卡片同步（見第 9 項）；移除 branch 死代碼 |
| `tests/troop_link.test.mjs` | **新增**：10 項守護（in-memory GAS 雙節點＋假網路＋假 Drive，載入真實 Code.gs） |
| `scripts/build.mjs` | **新增**：部署產物包裝器（靜態檔＝.vercelignore 之後＋5 個 function bundle，零依賴）。產物寫入本地 `.vercel-build/`（gitignored）做驗證；**Vercel 部署維持傳統模式**（vercel.json + .vercelignore），唔用 Build Output API（原因見 `docs/VERCEL_API_404_POSTMORTEM.md` 第 8 節） |
| `tests/build.test.mjs` | **新增**：產物底線（機密／開發檔唔上線、5 function 可運行、公開 Code.gs 無版號） |
| `package.json` | 新增 `test:link`／`build`／`test:build`（`build` 行 2026-09-23 補回——vercel-config【5】【6】守護要求）；`test` 鏈納入兩個新測試 |
| `.vercelignore` | 新增 `docs/TROOP_UPGRADE_2026.md`（本 MD 係操作機密文檔，唔上線） |
| `api/` | **零改動** |

**`tests/troop_link.test.mjs` 10 項**（守上面 1–7）：
1. 直接入口掣：未設定時現有旅團行為完全不變
2. 閂口後：直接登入／申請／GET load／apikey save／token save 全部被拒，只收 sig
3. 上游登記下游 SHEET KEY 後，sig 請求可讀可寫下游
4. sig 防護：錯誤 key、竄改 body、過期時間戳、重放 nonce、白名單外 action 全部被拒
5. ABCD 四項登記資料只存 Script Properties，絕不寫入任何工作表
6. 開戶：上游揀團開戶，經 sig 落下游寫（兩邊同一 password_hash）
7. 搬舊數：匯出含 hash（Drive 私人檔）→ 匯入逐個 upsertUser 直插 hash（保留舊密碼）
8. 上游以 sig 批量匯入下游（importUsers）與讀取用戶清單（回應唔會洩漏 hash）
9. 上游傳來的標籤不可變成工作表算式（auth_by／操作紀錄）
10. GS 程式內不留版號註解（版號只留 MD）

---

## 11. 驗證

```bash
npm run check && npm run lint && npm test && npm run test:link && npm run build && npm run test:build
# 部署後快檢
curl -s https://roverbadge.vercel.app/api/health | jq
curl -s https://roverbadge.vercel.app/api/troops | jq
```

> 本地測試唔能代替正式 GAS 部署驗收：`sig` 經真實 302 轉址、Drive 權限、Script Properties 配額、`onOpen` 選單授權，都要喺測試旅團真機跑一次先算數。

---

COPYRIGHT 2026 Scout System — v9.0 旅系統對齊版（進度系統節點：HMAC sig／fail-closed 直接入口掣／Drive 匯出匯入／ABCD 收件匣／支部 SHEET 成對）
