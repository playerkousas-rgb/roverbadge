# 旅系統升級版 — 跟住改（roverbadge）

> 版本號只保留在此 MD，GS（`apps-script/Code.gs`）內所有 `// vX.X` 版本註解已全數清除，標頭僅保留無版本標題。

**版號：v9.0 — 旅系統升級版（2026-09-22）**

---

## 一句話改動

每團補一張**支部** SHEET 與現有**進度** SHEET 成對；新增上游控下游寫入的 `ALLOW_LOCAL_LOGIN` 旗標（下游 ScriptProperties，關閉後只收 `sig`）；搬舊數用 JSON 含 `hash` 直插；`ABCD` 四變數不寫入 SHEET、經**收件匣**交 ADMIN。

---

## 1. 變數 ABCD — 不在 SHEET，以收件匣交 ADMIN

| 代號 | 變數名 | 值 | 產生者 | 填寫 | 備註 |
|---|---|---|---|---|---|
| **A** | `SUPER_KEY` | 中央管理密碼 | 環境設定（Vercel `SUPER_KEY`） | **隱藏**，與旅團無關 | 全站隱藏，與旅團脫鉤；永不寫入 SHEET、URL、log、前端 |
| **B** | `TROOP_(id)_BACKEND` | GAS `/exec` URL | **GS 生成**（部署後複製） | 管理員收件匣登記 | `https://script.google.com/macros/s/.../exec`，部署後產生 |
| **C** | `TROOP_(id)_NAME` | 旅團顯示名稱 | **自行填寫** | ADMIN 交接時填 | 例如 `第 82 旅`；可含中文，保留前導 0 |
| **D** | `TROOP_(id)_APIKEY` | `rover_xxx` | **GS 生成**（`getApiKey()` / `showApiKey()` / `initializeSheets()` 彈出） | 交 ADMIN 登記 | 每個 Sheet 獨立 `rover_` + uuid；前端永不落地，只在 `api/_registry.js` serverless 內使用 |

**禁令：**
- ❌ **不可把 ABCD 寫入任何 SHEET**（`Users` / `Progress` / `支部` / `Tokens` 等皆不落地）
- ❌ **不可改 A**（`SUPER_KEY` 由 Vercel 側控，GS 內不含、不收、不比對）
- ❌ **不可設 callback**（部署時存取權選「任何人」，不設任何回呼 URL）

收件匣：前端「聯絡 / 新旅團部署」`收件匣` → `POST /api/proxy {action: submitRegistration}` → `SCOUT_ADMIN_API`（固定中央收件端點，伺服器端常數，不由請求指定）→ 管理員在 Vercel `TROOP_*` 環境變數登記後 Redeploy。

---

## 2. 上下游整合（5 步）

```
1) 部署 GS 副本
   ├─ 貼上 apps-script/Code.gs → 儲存
   ├─ 執行 initializeSheets（自動建 Users/Progress/支部/活動履歷/待批履歷 等表，補缺不覆寫）
   ├─ 部署為網頁應用程式（執行身分：我，存取權：任何人）→ 複製 B（/exec URL）
   └─ 執行 showApiKey 或看 initializeSheets 彈窗 → 複製 D（rover_xxx）

2) 填 C 並經收件匣提交 B/D 到 ADMIN
   └─ 前端「新旅團部署」或「📧 一鍵提交接入申請」填：
      旅團編號、旅團名稱(C)、B URL、D API Key → 送收件匣

3) 每團補一張「支部」SHEET，與現有進度 SHEET 成對
   ├─ Sheet 名：支部（BRANCH_SHEET_NAME = '支部'）
   ├─ 欄位：branch_id | branch_name | leader_ymis | member_count | created_at | updated_at
   ├─ 由 initializeSheets 自動補建（舊表不動、只補缺）
   └─ 前端：用戶管理 → 支部管理（新增／編輯／刪除，調用 getBranches/saveBranch/deleteBranch）

4) 上游控下游寫：旅控團、團控進度
   ├─ 開關：下游 ScriptProperties → ALLOW_LOCAL_LOGIN（布爾，預設 true）
   │   ├─ 讀：  getAllowLocalLogin（需 token 或 sig）
   │   └─ 寫：  setAllowLocalLogin{allow: true|false}（需 token；關閉後前端直寫被拒）
   ├─ 旗標位於下游（被控端）ScriptProperties，非 SHEET
   ├─ 開啟時：前端可 addMember/addUser/save 等（本地直寫）
   └─ 關閉後：僅接受 sig 的上游操作（見第 5 步與 SIG_ACTIONS 白名單）

5) 開戶：關閉後新帳由上游選好、經 sig 寫下游
   ├─ 下游關閉直寫後，新成員／新帳由上游介面選好
   ├─ 上游以 sig 調用下游：addUser / addMember / upsertUser / saveBranch 等
   ├─ sig 驗證（Code.gs isSigValid）：
   │   ├─ 請求帶 sig = 原始 apikey → hashPassword(apikey) 對比
   │   └─ 或 sig = apikey 本身（兼容舊部署）
   ├─ 後端判定：
   │   ├─ if (!allowLocal && SIG_ACTIONS.has(action) && isSigValid(sig)) → 放行（不驗 token）
   │   └─ 否則按 ALLOW_LOCAL_LOGIN 閘門：關閉時拒「未帶有效 sig 的寫操作」
   └─ 前端代理（api/proxy.js）同樣在 TOKEN_ACTIONS 檢查時放行「帶有效 sig 且屬 SIG_ACTIONS」的請求
```

**上游可經 sig 直通的操作（SIG_ACTIONS）：**
`addUser, upsertUser, addMember, exportUsers, getBranches, saveBranch, deleteBranch, getAllowLocalLogin, setAllowLocalLogin`

---

## 3. 搬舊數 — JSON（含 hash，保留舊密碼）

情境：**舊系統有資料、新系統（或新支部）為空**。

1. **舊系統匯出：** 在「用戶管理」或「進度」點 **⬇️ 匯出 JSON（含 hash）**
   - 後端 `exportUsers`：回傳含 `ymis, name, email, role, branch, password_hash, ...` 的陣列（hash 不可逆，直接落地 JSON，不經前端再 hash）
2. **新支部匯入：** 在新支部（新環境或新 `支部`）點 **📤 匯入 JSON**
   - 前端逐筆 `apiRequest('upsertUser', {user})` → 後端 `handleUpsertUser`
   - 後端若 `user.password` 或 `user.password_hash` 為既有 hash 格式（`$` 開頭或 64 hex），則**直接寫入該 hash**，不重新 `hashPassword`，保留舊密碼可登入
   - 成功 `ok++`，失敗列出前 20 筆錯誤
3. **收尾：** 核對人數無誤後，**可關閉下游直寫**（`ALLOW_LOCAL_LOGIN=false`），此後只能經上游 `sig` 開戶／改資料。

前端位置：`index.html` 用戶管理 → 🔄 搬舊數（匯出／匯入）卡片；動作為 `exportUsersJson()` / `importUsersJson(file)`。

---

## 4. 前後端改動總覽

### `apps-script/Code.gs`
- 清理：移除全部 47 個 `// vX.X` 版本註解，標頭改為無版本標題。
- 新增：
  - `BRANCH_SHEET_NAME='支部'` / `BRANCH_HEADERS`
  - `getAllowLocalLogin()` / `setAllowLocalLogin(allow)` / `isSigValid(sig)` / `requireSigOrLocal(action,sig)` / `getBranchesList()`
  - `initializeSheets()` 補建 `支部` 表 + 預設 `ALLOW_LOCAL_LOGIN=true`
  - Handler：`handleGetBranches` / `handleSaveBranch` / `handleDeleteBranch` / `handleExportUsers` / `handleUpsertUser` / `handleGetAllowLocalLogin` / `handleSetAllowLocalLogin`
  - `doPost` 新增 `SIG_ACTIONS` 白名單與 `ALLOW_LOCAL_LOGIN` closed→sig-only 分支（上游 `sig = apikey 或 hashPassword(apikey)`）；`save`/`addMember` 加 sig 閘
  - `upsertUser` 支援 hash 直插（`password` 欄位若已是 hash 則不重 hash）

### `api/proxy.js`
- `TOKEN_ACTIONS` 擴增 7 項：`getBranches/saveBranch/deleteBranch/getAllowLocalLogin/setAllowLocalLogin/exportUsers/upsertUser`
- 新增 `SIG_ACTIONS` 常數；`TOKEN_ACTIONS` 檢查中若 `sig` 屬白名單則放行（不上 token 亦可轉發，信任由 GAS 二次驗證）

### `api/_registry.js`
- 已支援 `TROOP_(id)_BACKEND / NAME / APIKEY` 純環境變數收件匣註冊（`TROOP_ENV_RE`、白名單 `isTrustedExecUrl`、大小寫／前導 0 保留、`/api/troops` 只吐 `id+name`）

### `index.html`
- 用戶管理新增：
  - 私隱與控管卡片：`allowLocalLogin` 開關 + 狀態 + 刷新
  - 支部管理卡片：列表／新增／刪除（`refreshBranches/saveBranchFront/deleteBranchFront`）
  - 搬舊數卡片：匯出 JSON（含 hash）／匯入 JSON（逐筆 upsertUser）
- 無需跳轉即可完成「支部增刪 → 匯出 → 匯入 → 關直寫」閉環。

---

## 5. 清理與禁令稽核

- ✅ `rg -n "v\d+\.\d+" apps-script/Code.gs` → 0 hits（已全清）
- ✅ `rg -n "SUPER_KEY|TROOP_.*BACKEND|TROOP_.*APIKEY" apps-script/Code.gs` → 無 SHEET 寫入（僅 `SUPER_ADMIN_ID` 一行保留識別字）
- ✅ `initializeSheets` 不寫 ABCD 到 SHEET，僅補建必要工作表
- ✅ 未設任何 callback（部署指引仍為「任何人可存取」，不設觸發器回呼）

---

## 6. 驗證

```bash
cp apps-script/Code.gs /tmp/Code.gs.tmp.cjs && node --check /tmp/Code.gs.tmp.cjs
node tests/code-gs.test.mjs   # 124 passed（v9 新增支部/sig/搬舊數亦綠）
curl -s https://roverbadge.vercel.app/api/health | jq
curl -s https://roverbadge.vercel.app/api/troops | jq
```

---

COPYRIGHT 2026 Scout System — v9.0 旅系統升級版（支部／ALLOW_LOCAL_LOGIN／搬舊數／ABCD 收件匣）
