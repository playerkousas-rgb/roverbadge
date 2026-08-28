# Vercel 環境變數設定指南 v7.1 FINAL - 按你最終要求定版

> ## ⚠️ 睺住呢段先部署（2026-08 全站登入失效嘅教訓）
>
> 1. **`vercel.json` 永遠唔准用 legacy `builds` / `routes`**（會令 Vercel 唔建立任何 `/api/*` function，
>    靜態站照樣綠燈）。而家嘅寫法係零配置 + `functions.includeFiles`，詳細見
>    [`docs/VERCEL_API_404_POSTMORTEM.md`](docs/VERCEL_API_404_POSTMORTEM.md)。
> 2. **Serverless function 入面 `fs` 讀唔到 `data/troops.json`**（除非 `includeFiles` 生效）。
>    所以 Registry 有第三條保底路徑：`api/_troops_static.js`（由 `npm run sync:troops` 產生、必定被 bundle）。
>    **改咗 troops.json 就記得 `npm run sync:troops` 再 commit。**
> 3. 部署完成嘅定義唔係綠燈，而係呢條 line 有 JSON：
>    `curl -s https://roverbadge.vercel.app/api/health` → 期望 `"success":true`。
> 4. 淨係用 env 注入 backend 嘅測試（`TROOP_0082_BACKEND=...`）**唔能**證明 troops.json 讀到；
>    `npm test` 而家會喺「冇 `data/` 目錄嘅模擬 `/var/task`」度跑真正 handler。

> 你的要求原文：

> 1. URL 不用功能變數, API KEY 是防爬虫的, 人類靠登入就可以防 請寫入MD
> 2. 要加 TROOP_0082_APIKEY 只是每個旅團只需要提交URL 及API KEY 給管理員,而管理員也只要改TROOPS JSON 及加1個功能變數就能完成,管理員是指向同1個APP ADMIN 的對吧
> 3. GS 有加入自動生成API KEY 對吧

---

## 一句答案：係，你講啱晒

### 1. 管理員 = 同一個 APP ADMIN (單一 Vercel APP 管晒所有旅團)

- `vsbadge` (深資) 係一個獨立 Vercel APP，管理所有用深資系統嘅旅團
- `roverbadge` (樂行) 係另一個獨立 APP，藍色 #0D47A1，LOGO 不同
- `scoutbadge` (童軍) 綠色 #2E7D32，獨立
- `cubbadge` (幼童軍) 黃色 #FFC107，獨立
- 每個 APP 各自有一套 `troops.json` + Vercel 環境變數，但**同一個 APP 入面所有旅團都指向同一個 APP ADMIN** (就係維護 vsbadge / roverbadge 果個 Vercel 專案嘅人)

**即係：**
- 第 82 旅想加入 vsbadge → 將 URL+APIKEY 交 `vsbadge 管理員`
- 第 15 旅都想加入 vsbadge → 同樣交 `vsbadge 管理員`
- 管理員只需做 2 步 (見下)，唔使每個旅團開一個 Vercel

### 2. 流程 (你講嘅正確流程)

**旅團負責人做 (3步)：**
1. 去 Google Sheet 建新試算表
2. 擴充功能 → Apps Script → 貼上 `apps-script/Code.gs` → 儲存
3. 執行 `initializeSheets` → 授權 → 會彈 API Key + URL
   - `showApiKey()` 隨時可再睇 KEY
   - URL 係部署為網頁應用程式後 `/exec` 結尾嗰條

**旅團提交俾管理員 (2樣嘢)：**
```
旅團編號：0082
旅團名稱：第 82 旅
Backend URL：https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec
API KEY：rover_xxxxxxxxxxxxxx (執行 showApiKey 取得)
```

**管理員做 (只改2個地方，1分鐘完成)：**

**Step A - 改 TROOPS JSON (公開，URL可公開)**
編輯 `data/troops.json` + `troops.json` (兩個同步)，加一行：

```json
{
  "troops": {
    "0082": {
      "name": "第 82 旅",
      "backend": "https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec"
    },
    "0015": {
      "name": "第 15 旅",
      "backend": "https://script.google.com/macros/s/.../exec"
    }
  }
}
```

**Step B - 加1個功能變數 (防爬虫，不進 GitHub)**
Vercel Dashboard → 你的 Project (vsbadge) → Settings → Environment Variables → Add

| Name | Value | Env |
|------|-------|-----|
| `TROOP_0082_APIKEY` | `rover_xxxx` | Production, Preview, Development 全勾 |
| `TROOP_0015_APIKEY` | `rover_yyyy` | 同上 |

**注意命名：**
- `TROOP_` + `旅團編號` + `_APIKEY`
- 編號保留前導0，例如 0082 就係 `TROOP_0082_APIKEY`，唔係 `TROOP_82_APIKEY` (但程式有兼容，寫 0082 最穩陣)
- 若想兼容舊版 `TROOP_0082_BACKEND` (將 URL 都放環境變數)，程式亦支援向後兼容，但按你要求 URL 唔使放功能變數，放 `troops.json` 公開就得

**Step C - Build + Redeploy + 驗證**
```bash
npm run sync:troops     # 把 data/troops.json 編譯入 api/_troops_static.js（serverless 保底來源）
npm test          # 包含「模擬 /var/task（冇 data/）」嘅 function 測試
git add -A && git commit -m "troops: add 0082" && git push
```
Push 後 Vercel 會自動重新部署（零配置，冇 Build Command）。**千祈唔好喺 `package.json` 加 `build` script** —— Vercel 會自動將佢當 Build Command 執行，而本專案嘅 `api/_troops_static.js` 係「commit 入 Git」嘅產物，build 階段喺 Vercel 寫唔返入來源目錄 → 成次部署 `Error`（2026-08-28 用 6 次部署實測對照出嚟）。所以同步靜態保底要用 `npm run sync:troops`（本機／CI 執行），再用 `npm test` 盯住冇漂移。

**部署完一定要驗證：**
```bash
curl -s https://roverbadge.vercel.app/api/health | head -c 400   # 期望 "success":true
curl -s https://roverbadge.vercel.app/api/troops  | head -c 200   # 期望 troops 入面有新旅團 id
curl -s -o /dev/null -w '%{http_code}\n' https://roverbadge.vercel.app/api/proxy  # 期望 405（404 = function 冇建好）
```
該旅團即刻喺首頁 `troopGrid` 見到。

---

## 為何 URL 不用功能變數？

- Google Apps Script `/exec` URL 本身公開，但**無 KEY 無 Token 取唔到資料**：
  - `Code.gs` 第一層：`if(reqKey && reqKey!==getApiKey()) return Invalid API Key` → 若前端有送 apikey，會檢查；防爬虫隨機掃
  - 第二層：人類需登入 → `Tokens` 表檢查，YMIS+密碼 或 Email+密碼，無 token 就 `Token 無效`
  - 即使爬虫拿到 backend URL + apikey (透過 /api/troops  endpoint)，無有效 token 仍讀唔到 `getAllUsers` / `getProgress` 等
- 所以 `backend` 放 `troops.json` 公開係安全、簡單、速度快
- `apikey` 放 Vercel 環境變數，唔進 GitHub，避免 GitHub 公開掃描

---

## GS 有無自動生成 API KEY？ 有，3處

**Code.gs v4.8 已加入：**

```javascript
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');
  if (!apiKey) {
    apiKey = 'vs_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', apiKey);
  }
  return apiKey;
}
function showApiKey() {
  const apiKey = getApiKey();
  SpreadsheetApp.getUi().alert('API Key', '你的 API Key：\n\n' + apiKey, ...)
  Logger.log('API Key: ' + apiKey);
  return apiKey;
}
function initializeSheets() {
  ...
  const apiKey = getApiKey();
  let scriptUrl=''; try{ scriptUrl=ScriptApp.getService().getUrl(); }catch(e){}
  ui.alert('✅ v4.0 初始化完成！\n\n🔑 API Key:\n'+apiKey+'\n\n🌐 URL:\n'+scriptUrl);
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}
```

- 第一次執行 `initializeSheets` 自動生成 `rover_` + 24位 uuid，存 `PropertiesService`
- 之後任何地方 `getApiKey()` 都取同一個，除非手動清 `Script Properties`
- `showApiKey()` 可隨時再睇

---

## api/_registry.js（/api/troops 背後）v3.1 點運作

**v2.0 遺留問題：** `fs` 讀 `data/troops.json`。Vercel Node function 跑喺 `/var/task`，
冇被 bundle 嘅檔案唔存在 → 讀唔到 → registry 變空 `{}` → `/api/proxy` 對任何旅團回
`404 找不到此旅團` → **全站登入失敗**（2026-08 事故嘅真正原因，見 `docs/VERCEL_API_404_POSTMORTEM.md`）。

**v3.1 已修復 — 三條來源，順序由上而下：**
1. `TROOP_{ID}_BACKEND` / `TROOP_{ID}_APIKEY` 環境變數（最高優先，永远有效）
2. `data/troops.json` + `troops.json` 磁碟檔案 — 需要 `vercel.json` 嘅
   `functions["api/*.js"].includeFiles`（已設 `"{data/*.json,troops.json}"`）先會喺 function 內存在；
   `_registry.js` 會試 `cwd`、`__dirname/..`、`__dirname/../..`、`ROVERBADGE_PROJECT_ROOT`
3. `api/_troops_static.js`（`npm run sync:troops` 產生、被 `import` → 一定喺 bundle 內）— **保底**，
   就算 includeFiles 失效都仍然揾到旅團；呢檔唔含 apikey

合併規則不變：backend = env > file > static；apikey = env > file；
只有 `backend` 通過 `isTrustedExecUrl()`（HTTPS `script.google.com/macros/s/.../exec`）先算有效旅團。
前端 `loadTroops()` 亦會 fetch `/api/troops` + `data/troops.json` 再合併（雙保險）。
除錯：`GET /api/health` 會回 `registry.source`（`file:...` 或 `static:...`）同 `includeFilesWorking`。

```javascript
// 節錄
const backend = backendEnv || fileEntry.backend || '';
const apikey = apikeyEnv || fileEntry.apikey || '';
if (backend) troops[id] = { name, backend, apikey };
```

所以你而家只設 `TROOP_0082_APIKEY`，backend 用 `troops.json` 公開，完全 Work。

---

## 檢查清單 (管理員)

- [x] GS Code.gs 有 getApiKey 自動生成 + showApiKey + initializeSheets 回傳
- [x] 超管（v8.6）：**只存在於 `Code.gs`**（`getSuperAdminUser()` / `getSuperAdminPass()`），裝完即用、唔使任何設定；本文件刻意不記錄憑證
- [x] Sheet 完全冇蹤跡：Users 表冇這列（`removeSuperAdminRows()` 自動清走舊版殘留列），Tokens 表以中性代號 `__sys__` 儲存超管 session
- [x] `initializeSheets()` 小視窗只顯示 Sheets 清單 / API Key / URL / 本旅團管理員帳號，唔會出現超管任何資訊
- [x] 用戶管理／成員名單任何角色（包括超管本人）都睇唔到；任何 API 回應／錯誤訊息都不含超管帳號或密碼（舊版錯誤訊息曾直接寫出密碼，已移除）
- [x] 防護保留：不能停用／重設密碼／改角色／自行改密碼／以此帳號開戶
- [x] 驗證：`node tests/code-gs.test.mjs` 會真正載入執行 `apps-script/Code.gs`（GAS API 模擬），掃描全部工作表所有儲存格確認冇超管蹤跡
- ⚠️ **注意：** `Code.gs` 是部署指南頁嘅公開下載檔（`/apps-script/Code.gs`），能取得該檔嘅人都讀得到憑證；要換就改嗰兩行再逐團重新部署
- [x] URL https://script.google.com/macros/s/AKfycbw81wLR5NZtRk4m1ptSAoFBueoqwIZ5hcM_apHJa2xMmlVfUvZsS8R45nTIKTOIuBB2KQ/exec 已更新到所有 `troops.json` + `index.html fallbackTroops`
- [x] 全面排查 vsbadge 內容：scoutbadge 曾有 0082R 已移除，roverbadge/cubbadge/scoutbadge 內 `vsbadge 管理員` 文字已改為各自 app 管理員，session key 已修正 `scoutbadge_session_v1` / `cubbadge_session_v1` / `roverbadge_session_v1` / `vsbadge_session_v4`
- [x] Vercel 功能變數名稱：`TROOP_0082_APIKEY` (推薦) ，向後兼容 `TROOP_0082_BACKEND` (可選)
- [x] 每個支部獨立 APP，同一 APP 內所有旅團指向同一個 APP ADMIN

---

## 常見問答

**Q: 為何要加 TROOP_0082_APIKEY？唔加得唔得？**
A: 唔加都得，人類靠登入已可防。加咗多一層防爬虫，爬虫無 KEY 直情 `Invalid API Key`。建議加。

**Q: 每個旅團都要提交 URL + API KEY？**
A: 係，URL 係 Sheet 部署出嚟每個旅團唔同，KEY 都係每個 Sheet 獨立生成。管理員收集後做上面 2 步。

**Q: 管理員指向同一個 APP ADMIN？**
A: 係。vsbadge 這個 Vercel Project 就是所有深資旅團的 APP ADMIN，roverbadge 同理。各自分開，但各自管自己支部內所有旅團。

**Q: GS 自動生成 API KEY 會唔會重複？**
A: `Utilities.getUuid()` 幾乎不會重複，24 hex chars 足夠。

---

COPYRIGHT 2026 Scout System - Vercel Env v7.1 FINAL（+ serverless Registry 保底、/api/health 自檢）
