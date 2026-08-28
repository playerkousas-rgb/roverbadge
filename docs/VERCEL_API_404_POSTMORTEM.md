# 事故報告：`/api/*` 全部 404 → 全站無人登入得到（2026-08-28）

> 一句講晒：**唔係帳號問題**。`sheep`、`1111111111`、任何成員帳號都一樣入唔到，
> 因為 Vercel 根本冇建立起任何一個 Serverless Function，前端打到嘅係 Vercel 嘅
> **HTML** 404 頁，`res.json()` 自然 explode，訊息變成「伺服器回應格式異常 (HTTP 404)」。
> Vercel 顯示綠燈只代表靜態檔部署成功。

---

## 1. 實測證據

`scoutbadge.vercel.app`（童軍 app）與 `roverbadge.vercel.app`（本 repo）都係同一個樣：

| URL | 結果 |
| --- | --- |
| `/` | ✅ 200，頁面正常（v5.2 / v5.0） |
| `/data/troops.json` | ✅ 200 JSON（靜態檔） |
| `/apps-script/Code.gs` | ✅ 200（靜態檔） |
| `/api/troops` | ❌ Vercel 原生 `404: NOT_FOUND`（`Code: NOT_FOUND`） |
| `/api/proxy` | ❌ Vercel 原生 `404: NOT_FOUND` |
| 旅團 GAS `/exec` 上游 | ✅ `{"success":true,"login_mode":"standalone"}` → **後端本身冇事** |

驗證方法（任何支部 app 都適用）：

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://<app>.vercel.app/api/health
# 期望：200 application/json
# 而家：404 text/html  ← 即係 function 冇被建立
```

## 2. 四條根因（缺一都未 fix 完）

### 根因 A — `vercel.json` 用咗被淘汰嘅 legacy `builds` + `routes`

```jsonc
// 舊寫法（會出事）
{ "version": 2,
  "builds": [ { "src": "api/**", "use": "@vercel/node" }, ... ],
  "routes": [ { "src": "/api/(.*)", "dest": "/api/$1" }, ... ] }
```

Vercel 文件明確：`builds` 屬 Legacy；**一旦定義 `builds`，Project 嘅 Build & Development Settings
會被忽略**，而 `functions` 與 `builds` **互斥**、唔可以同時用。呢種半 legacy 配置下，`api/` 嘅
內建 function 偵測唔會運作，輸出亦唔會落到 `/api/proxy`、`/api/troops` 呢啲路徑 → 靜態站照樣上線，
function 一個都冇。呢個就係 404 嘅直接原因。

### 根因 B — Serverless function 入面 `fs` 讀唔到 `data/troops.json`（**最容易被漏掉**）

`api/_registry.js` 靠 `fs.readFileSync(path.join(process.cwd(), 'data', 'troops.json'))` 攞旅團名單。
但 Vercel Node function 跑喺 `/var/task`，**只有被 bundle 嘅檔案先存在**；`data/troops.json`
冇被 import、亦未宣告 `includeFiles`，所以 function 讀唔到 → `getRegistry()` 回空物件：

- `/api/troops` → `{}`（旅團名單空白）
- `/api/proxy` → 任何 `troopId` 都 `404 找不到此旅團`
- **所以：就算你净係刪咗 `builds`/`routes` 就重新部署，登入照樣失敗**，只是錯誤訊息由
  「格式異常 (404)」變做「找不到此旅團」。呢條先係真正嘅坑。

（本 repo 已用 `node scripts/sync-troops.mjs` 產生 `api/_troops_static.js` 作為 bundle 內保底來源，
再用 `functions.includeFiles` 補返 `data/*.json`，兩條路各自獨立都得。）

### 根因 C — 測試睇唔到，因為測試自己用 env 注入咗 backend

`tests/run-e2e.mjs` 一直 `TROOP_0082_BACKEND=...`（根因 B 就俾 env 遮咗），所以
「本地測試全通過」與「正式環境死咗」可以同時成立。**經過 env 注入嘅測試唔能證明 troops.json 讀到。**
現新增 `tests/serverless-registry.test.mjs` + `tests/proxy-login.test.mjs`：專門喺
「冇 `data/` 目錄嘅空 `/var/task`」度跑真正嘅 `api/*.js`。

### 根因 D（我哋自己 introduce 嘅部署失敗，2026-08-28）— 真正兇手係 `package.json` 嘅 `build` script

改完 `vercel.json` 之後，Vercel **連續 5 次 Preview 都 `Error`**，而我哋冇 Vercel token 睇唔到 log。
用 `gh api /repos/…/commits/<sha>/status` 讀 Vercel 寫返嘅 commit status 做 1-bit oracle，逐個變數
拆走（每次都係一次真實部署）：

| 輪次 | 配置狀態 | Vercel status |
| --- | --- | --- |
| 1 | vercel.json 有 `_comment`（註解）+ `buildCommand` + `functions` + `headers`，package 有 `engines`/`build` | ❌ failure |
| 2 | 刪 `_comment`（保留 `buildCommand`） | ❌ failure |
| 3 | 刪 `buildCommand` + `engines` + `maxDuration`（保留 `functions.includeFiles`/`headers`/`build`） | ❌ failure |
| 4 | 刪 `functions`（淨低 `headers` + `build`） | ❌ failure |
| 5 | **刪晒 vercel.json + 刪 `build` script** | ✅ **success** |
| 6 | 加返 `build` script（冇 vercel.json） | ❌ **failure** ← _single variable_ |
| 7（最終）| 還原 vercel.json（`functions.includeFiles` + `headers`），**冇** `build` script | ✅ success（見下） |

**結論：`package.json` 有 `scripts.build` 就係致命點。** Vercel 對「有 build script 嘅專案」會拿佢做
Build Command，於是每次部署都執行 `node scripts/sync-troops.mjs`，而呢個腳本要喺 build 環境把
`api/_troops_static.js` **寫返入來源目錄** → Vercel build container 唔容許 → 非零出口 → 成次部署
`Error`（同 config 寫法無關）。第 6 輪只加返一個 `build` script、其他全部唔變，就由 success 變返
failure，係最乾淨嘅證據。

規則（四個支部 app 都適用）：

- **`package.json` 唔准有 `build` script**；需要產生嘅檔案（例如 `api/_troops_static.js`）
  **一律 commit 入 Git**，本機用 `npm run sync:troops` 產生、`npm test` 用 `--check` 盯住唔好漂移
- `vercel.json` 只准官方欄位：`additionalProperties:false` 嘅 root schema 會 reject 自訂 key
  （`_comment`）同 Project Settings 欄位（`buildCommand`/`installCommand`/`devCommand`/
  `outputDirectory`/`framework`）——呢啲要喺 Dashboard 改
- Function 設定（`maxDuration`／`includeFiles`）只喺 `vercel.json` 的 `functions` 寫一次，
  唔好再喺 `api/*.js` 出 `export const config`（兩邊重複會互相覆蓋）
- 呢啲規則全部有測試守：`tests/vercel-config.test.mjs`【6】+ `tests/serverless-registry.test.mjs`
  （已用 `_comment`、`buildCommand`、`build` script 三份負面測試確認會 fail）
- **冇 Vercel token 時點樣驗證部署**：`git push` 後
  `gh api repos/<owner>/<repo>/commits/<sha>/status --jq '.statuses[]|{state,description,target_url}'`
  （description 會俾 `npx vercel inspect dpl_xxx --logs` 呢條 command 同 deployment id；
  有 token 就先见到真正 log）

## 3. 本次修正

| 檔案 | 改動 |
| --- | --- |
| `vercel.json` | 改成零配置：刪除 `builds`/`routes`/`version`，只留 `functions`（`includeFiles` + `maxDuration`）、`headers`、`buildCommand` |
| `api/_registry.js` | Registry 來源改成 **env → `data/troops.json`（多候选根目錄）→ bundle 內靜態保底**；加 `getRegistryDiagnostics()` |
| `api/_troops_static.js` | 新增（自動產生，`npm run sync:troops`；**千祈唔好命名做 `build`**，見根因 D）：把 `data/troops.json` 編譯入 bundle；**不含 apikey** |
| `scripts/sync-troops.mjs` | 產生上面個檔（`npm run sync:troops`，**唔好叫 build**）；`--check` 供 CI 防漂移 |
| `api/health.js` | 新增 `GET /api/health`：回 JSON 講明 function 有冇部署、registry 用咗邊個來源、有效旅團幾多個（永不回 GAS URL / apikey） |
| `package.json` | `engines.node >= 18`；`build` = sync troops；`test` 串埋兩個新測試 |
| `index.html` | `apiRequest()` 回應非 JSON 時自動查 `/api/health` → 提示「後端 API 未部署」；`selectTroop()` 喺登入頁预先顯示部署診斷；兩個新字串已入 `i18n_dict.tsv` + `LANG_DICT` |
| `tests/serverless-registry.test.mjs`、`tests/proxy-login.test.mjs` | 新增（33 + 29 項斷言） |
| `.gitignore` | 加 `.vercel/`、`.tmp-lambda/` |

## 3.5 同類問題覆查：`load` 嘅 GET/POST 路由（scoutbadge 出現「離線模式」嗰個）

scoutbadge 嗰邊第二擊：登入成功，但一入主畫面就彈「⚠️ 離線模式：顯示快取資料」。佢哋嘅成因係
**前端一律 POST → `/api/proxy` → GAS `doPost`，但 `load` 只寫喺 `doGet`** → 後端回
`Unknown action` → 前端 fall back 去 localStorage 快取。

**roverbadge 無呢個問題**（已逐層核對）：

| 層 | 事實 |
| --- | --- |
| `apps-script/Code.gs` | `doGet` 只處理 `load` + `getLoginMode`；其餘 action 全喺 `doPost`，末尾 `return jsonResponse({success:false,error:'Unknown action'})` |
| `api/proxy.js` | `const GET_ACTIONS = new Set(['load','getLoginMode'])` → 呢兩個 action **由 proxy 轉成 GET** 打去 GAS，其餘用 POST。前端永遠只 POST 俾 proxy，唔使知道分工 |
| 前端 `index.html` | `apiRequest('load',{token})` → proxy → GAS `doGet` ✓ |

但測試原先**抓唔到呢類 bug**：`tests/mock-gas.mjs` 得 `routeAction(action)`，GET/POST 都照做，
所以就算有人把 `load` 由 `GET_ACTIONS` 移除，100 項 e2e 都會全綠。已修：

- mock 加入 `GET_ONLY_ACTIONS`（`load`/`getLoginMode`）**照 Code.gs 一樣 enforce HTTP 方法**，
  方法唔啱就回 `Unknown action`；又加咗 `state.received[]`（每次 `/exec` 的 method+action）
- `tests/proxy-login.test.mjs`【9】斷言：`load`/`getLoginMode` 必須係 GET、`login`/`save` 必須係 POST，
  並附兩個「對照組」（直接 POST `load` 俾 GAS 一定 `Unknown action`），證明個守門唔係空轉
- 已做負面測試：把 `load` 由 `GET_ACTIONS` 移除 → 5 項即刻 fail（含 `Unknown action` 原文），還原後全綠

**順手修咗「離線模式」本身嘅誤導性**（呢個 message 喺兩個 app 都讲錯自己）：
載入失敗而家會話明「係雲端載入失敗、唔係你斷網」、顯示快取幾舊（1 分鐘前／N 小時前／未載入過）、
附上後端回嘅原因，並提供「🔄 重新載入」按鈕（`setStaleBanner()`，成功載入後自動清除）。
重要：原因只用 `textContent` 放入橫幅，唔经 `innerHTML`（後端字串唔可以變 HTML）。
判讀口訣：**登入成功 + 一入面就「離線模式」→ 唔係網絡，係 action 嘅 HTTP 方法／後端版本唔匹配。**

## 4. 部署後點驗證（1 分鐘）

```bash
# 1) function 有冇建造成？
curl -s https://roverbadge.vercel.app/api/health
#    期望 "success":true，"registry":{"source":"file:data/troops.json"（或 static:...）},"troops":[{"id":"0082"...}]

# 2) 旅團名單
curl -s https://roverbadge.vercel.app/api/troops
#    期望 {"troops":{"0082":{"name":"第 82 旅 (樂行)"}},...}  ← 必須有 0082，而且唔可以有 backend/apikey

# 3) proxy 活住（GET 應該係 405 唔係 404）
curl -s -o /dev/null -w '%{http_code}\n' https://roverbadge.vercel.app/api/proxy   # 期望 405

# 4) 登入（sheep 係 Code.gs 內嘅 super_admin，密碼見 getSuperAdminPass()）
curl -s -X POST https://roverbadge.vercel.app/api/proxy -H 'Content-Type: application/json' \
  -d '{"troopId":"0082","action":"login","data":{"login_id":"sheep","password":"0728"}}'
#    期望 {"success":true,"token":"...","user":{"role":"super_admin"}}
#    → 呢步入面咗，成員/領袖登入就一定得（同一條鏈路）

# 本機重跑全部測試
npm ci || npm i
npm test
```

## 5. 新常規（防止再次發生）

1. **`vercel.json` 永遠唔准出現 `builds`、`routes`、`version`。** 需要改函式設定就用 `functions`；
   需要路徑覆寫就用 `rewrites`/`redirects`。`tests/serverless-registry.test.mjs` 會 fail 掉違規嘅 PR。
2. **改咗 `data/troops.json` / `troops.json` 一定要 `npm run sync:troops`** 再 commit（`api/_troops_static.js`；
   唔好用 `build` 做名 —— Vercel 會自動執行 `build` script 然後炸，見根因 D）
   要同步；`npm test` 會 check）。或者索性只靠 `TROOP_{ID}_BACKEND` 環境變數（env 優先於檔案）。
3. **部署完成 = 開 `/api/health`**，唔好睇綠燈。`includeFilesWorking:false` 表示 Vercel 冇把
   `data/*.json` 放進 lambda（此時會用 bundle 保底，仍然可用）。
4. 新旅團接入後自檢順序：`/api/troops` 有無呢個 id → `/api/health` 個 `source` → 先講帳號密碼問題。
5. **其餘三個支部 app（`scoutbadge` / `cubbadge` / `vsbadge`）係獨立 repo、獨立 Vercel Project，
   要各自 apply 同一份改動**（本次只改 `roverbadge`）；照上面第 4 節逐個 `curl /api/health` 就知有事冇事。
   已覆查過嘅結果見第 6 節。`docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md` 已改寫成正確規則
   （舊版嗰段「`vercel.json` 必須開放 assets/docs/data/apps-script/api」正係本事故嘅源頭，照住做會再生返 legacy builds）。

## 6. 其他支部 app 覆查（2026-08-28，同日稍後）

`scoutbadge` 已由該 repo 嘅 agent 將 `vercel.json` 改成 `{"version": 2}` 零配置並重新部署，
`/api/troops`、`/api/proxy`、`/api/health` 都已經回 JSON（`GET /api/proxy` → `{"success":false,
"error":"Missing required parameter: action"}`，即 function 已上線）。但佢嘅修法留低三個問題，
**其他支部 agent 請跟返本 repo 嘅做法，唔好抄 scoutbadge**：

1. **`/api/health` 大量洩漏**：公開 GET 就回 `fullBackend`（完整 GAS `/exec` URL）、`hasApikey`、
   **`spreadsheetId` 同 `docs.google.com/spreadsheets/<id>/edit` 連結**，仲會即時打一次 GAS
   `diagnose`/`health` 並將 Sheet 名稱、各表 row/col、Users 數、Tokens 數原樣 echo。
   即等於將「童軍成員資料表」嘅入口＋結構交畀任何匿名訪客，亦變相免認證鏡像後端。
   → 健康檢查只准回布林值／host／來源（見本 repo `api/health.js`），並加 `Cache-Control: no-store`。
2. **`/api/troops` 回傳 `backend`**：v3.0 之後 frontend 唔應該再見到 GAS URL；佢而家兩份都回
   （仲多咗 `_debug`）。應該只回 `{id:{name}}`。
3. **登入仍然會失敗，但原因唔同咗**：佢嘅 `health` 自己講咗 —— Users 表只有 1 行（預設 admin）、
   `成員名單 rows:1`、`membersCount:0`、`progressCount:0`。即嗰個 GAS 連嘅係**空/被重置/連錯嘅
   Spreadsheet**。呢種情況下 `/api/*` 修好都只係由「404」變做「找不到此帳號」，
   要管理員喺 Sheet 那边 `initializeSheets()` + 確認部署 URL 指向正確嘅試算表先算搞掂。

（另：`cubbadge` / `vsbadge` 未覆查；照第 5 節規則逐個 `curl /api/health` 即可判斷。）

## 7. 順記（本次冇改，留待管理員決定）


- `i18n_dict.tsv`（840 keys）與 `index.html` 內 `LANG_DICT`（846 keys）有 6 條字串唔同步：
  即管唔會壞嘢，但下一次有人跑 `build_i18n.py` 就會覆蓋咗嗰 6 條人工修訂。建議找個時間
  以 `index.html` 為准回寫 TSV。
- 前端 `selectTroop()` 會喺 `/api/troops` 失敗時 fallback 讀 `data/troops.json`，所以
  「旅團清單见到、但登入死咗」係呢次事故嘅典型外觀；如果想更嚴，可以將 fallback 只用於
  顯示、並將登入按鈕 disable 直至 `/api/health` 確認 OK。

COPYRIGHT 2026 Scout System
