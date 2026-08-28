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

## 2. 三條根因（缺一都未 fix 完）

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

## 3. 本次修正

| 檔案 | 改動 |
| --- | --- |
| `vercel.json` | 改成零配置：刪除 `builds`/`routes`/`version`，只留 `functions`（`includeFiles` + `maxDuration`）、`headers`、`buildCommand` |
| `api/_registry.js` | Registry 來源改成 **env → `data/troops.json`（多候选根目錄）→ bundle 內靜態保底**；加 `getRegistryDiagnostics()` |
| `api/_troops_static.js` | 新增（自動產生，`npm run build`）：把 `data/troops.json` 編譯入 bundle；**不含 apikey** |
| `scripts/sync-troops.mjs` | 產生上面個檔；`--check` 模式供 CI 防漂移 |
| `api/health.js` | 新增 `GET /api/health`：回 JSON 講明 function 有冇部署、registry 用咗邊個來源、有效旅團幾多個（永不回 GAS URL / apikey） |
| `package.json` | `engines.node >= 18`；`build` = sync troops；`test` 串埋兩個新測試 |
| `index.html` | `apiRequest()` 回應非 JSON 時自動查 `/api/health` → 提示「後端 API 未部署」；`selectTroop()` 喺登入頁预先顯示部署診斷；兩個新字串已入 `i18n_dict.tsv` + `LANG_DICT` |
| `tests/serverless-registry.test.mjs`、`tests/proxy-login.test.mjs` | 新增（33 + 29 項斷言） |
| `.gitignore` | 加 `.vercel/`、`.tmp-lambda/` |

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
2. **改咗 `data/troops.json` / `troops.json` 一定要 `npm run build`** 再 commit（`api/_troops_static.js`
   要同步；`npm test` 會 check）。或者索性只靠 `TROOP_{ID}_BACKEND` 環境變數（env 優先於檔案）。
3. **部署完成 = 開 `/api/health`**，唔好睇綠燈。`includeFilesWorking:false` 表示 Vercel 冇把
   `data/*.json` 放進 lambda（此時會用 bundle 保底，仍然可用）。
4. 新旅團接入後自檢順序：`/api/troops` 有無呢個 id → `/api/health` 個 `source` → 先講帳號密碼問題。
5. **其餘三個支部 app（`scoutbadge` / `cubbadge` / `vsbadge`）係獨立 repo、獨立 Vercel Project，
   要各自 apply 同一份改動**（本次只改 `roverbadge`）。佢哋嘅 `vercel.json` 大概率同樣有 legacy
   `builds`，`/api/*` 一樣係 404 —— 照上面第 4 節逐個 curl 一次就知。

## 6. 順記（本次冇改，留待管理員決定）

- `i18n_dict.tsv`（840 keys）與 `index.html` 內 `LANG_DICT`（846 keys）有 6 條字串唔同步：
  即管唔會壞嘢，但下一次有人跑 `build_i18n.py` 就會覆蓋咗嗰 6 條人工修訂。建議找個時間
  以 `index.html` 為准回寫 TSV。
- 前端 `selectTroop()` 會喺 `/api/troops` 失敗時 fallback 讀 `data/troops.json`，所以
  「旅團清單见到、但登入死咗」係呢次事故嘅典型外觀；如果想更嚴，可以將 fallback 只用於
  顯示、並將登入按鈕 disable 直至 `/api/health` 確認 OK。

COPYRIGHT 2026 Scout System
