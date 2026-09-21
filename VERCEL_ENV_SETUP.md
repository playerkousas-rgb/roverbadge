# Vercel 環境變數設定指南 v8.0 - 純環境變數登記（v4.0 定版）

> ## ⚠️ 睺住呢段先部署（2026-08 全站登入失效嘅教訓）
>
> 1. **`vercel.json` 永遠唔准用 legacy `builds` / `routes`**（會令 Vercel 唔建立任何 `/api/*` function，
>    靜態站照樣綠燈）。而家嘅寫法係零配置（`cleanUrls`/`trailingSlash` + `maxDuration`），詳細見
>    [`docs/VERCEL_API_404_POSTMORTEM.md`](docs/VERCEL_API_404_POSTMORTEM.md)。
> 2. **旅團登記一律靠環境變數**：`TROOP_{ID}_NAME` / `TROOP_{ID}_BACKEND` / `TROOP_{ID}_APIKEY`。
>    v4.0 起已冇 `troops.json` / `data/troops.json` / `api/_troops_static.js` / `npm run sync:troops` —— 唔會再出現「改咗 JSON 忘記同步」呢類事故。
> 3. 部署完成嘅定義唔係綠燈，而係呢條 line 有 JSON：
>    `curl -s https://roverbadge.vercel.app/api/health` → 期望 `"success":true`。
> 4. **千祈唔好喺 `package.json` 加 `build` script** —— Vercel 會自動將佢當 Build Command 執行；
>    而家 Registry 純環境變數、冇任何 build 產物，加咗 build script 只會多一個失败點。

---

## 一句答案：管理員 = 同一個 APP ADMIN (單一 Vercel APP 管晒所有旅團)

- `vsbadge` (深資) 係一個獨立 Vercel APP，管理所有用深資系統嘅旅團
- `roverbadge` (樂行) 係另一個獨立 APP，藍色 #0D47A1，LOGO 不同
- `scoutbadge` (童軍) 綠色 #2E7D32，獨立
- `cubbadge` (幼童軍) 黃色 #FFC107，獨立
- 每個 APP 各自一套 Vercel 環境變數，但**同一個 APP 入面所有旅團都指向同一個 APP ADMIN** (就係維護該 Vercel 專案嘅人)

**即係：**
- 第 82 旅想加入 roverbadge → 將 URL+APIKEY 交 `roverbadge 管理員`
- 第 15 旅都想加入 → 同樣交 `roverbadge 管理員`
- 管理員只需喺 Vercel 加 3 個環境變數 + Redeploy，唔使每個旅團開一個 Vercel，亦唔使改任何檔案

---

## 流程

**旅團負責人做 (3步)：**
1. 去 Google Sheet 建新試算表
2. 擴充功能 → Apps Script → 貼上 `apps-script/Code.gs` → 儲存
3. 執行 `initializeSheets` → 授權 → 會彈 API Key + URL
   - `showApiKey()` 隨時可再睇 KEY
   - URL 係部署為網頁應用程式後 `/exec` 結尾嗰條

**旅團提交俾管理員 (2樣嘢)：**
```
旅團編號：0082（保留前導 0）
旅團名稱：第 82 旅
Backend URL：https://script.google.com/macros/s/.../exec
API KEY：rover_xxxxxxxxxxxxxx (執行 showApiKey 取得)
```

**管理員做（只喺 Vercel Dashboard 加環境變數，唔使改 repo 任何檔案）：**

Vercel Dashboard → 你的 Project → Settings → Environment Variables → Add

| Name | Value | Env |
|------|-------|-----|
| `TROOP_0082_NAME` | `第 82 旅` | Production, Preview, Development 全勾 |
| `TROOP_0082_BACKEND` | `https://script.google.com/macros/s/.../exec` | 同上 |
| `TROOP_0082_APIKEY` | `rover_xxxx` | 同上 |

**注意命名：**
- `TROOP_` + `旅團編號` + `_NAME` / `_BACKEND` / `_APIKEY`
- **編號保留前導 0**：0082 就係 `TROOP_0082_*`，唔係 `TROOP_82_*`（前端顯示、proxy 路由全部用返原本編號字串）
- 旅團編號只出現喺**變數名**入面；唔需要任何 JSON、ID 欄位或者檔案

**然後 Build + Redeploy + 驗證**
```bash
npm test          # 本機回歸（mock GAS + serverless registry + proxy 登入鏈路）
git push          # 如 repo 有改動；加環境變數後喺 Vercel 撳 Redeploy 即生效
```

**部署完一定要驗證：**
```bash
curl -s https://roverbadge.vercel.app/api/health | head -c 400   # 期望 "success":true
curl -s https://roverbadge.vercel.app/api/troops  | head -c 200   # 期望 troops 入面有新旅團 id，而且只有 id+name
curl -s -o /dev/null -w '%{http_code}\n' https://roverbadge.vercel.app/api/proxy  # 期望 405（404 = function 冇建好）
```
該旅團即刻喺首頁 `troopGrid` 見到。前端由頭到尾**淨係攞到 id + name**；backend 同 apikey 只喺 serverless proxy 內使用，唔會落到瀏覽器。

---

## 可選：主系統 Portal 對接（Dashboard 卡片入口）

如旅團由主系統 Dashboard 卡片帶入（`?from=portal&u=0082&src=主系統網址`），**必須**設：

| Name | 用途 |
|------|------|
| `PORTAL_DEFAULT_ORIGIN` | 主系統來源 origin（例：`https://main.example.org`，填帶 path 嘅 URL 會自動正規化）；**唔設 = 所有旅團都唔開放 portal（fail closed）** |
| `PORTAL_DEFAULT_ROLES` | 逗號分隔嘅允許角色（例：`member,group_leader`）；唔設就只放行 `exec_committee` |
| `TROOP_0082_PORTALORIGIN` | 某旅團專用來源 origin（覆寫預設） |
| `TROOP_0082_PORTALROLES` | 某旅團專用允許角色（覆寫預設） |
| `TROOP_0082_PORTALDISABLED` | 設 `1`/`true` 可停用該旅團嘅 portal 入口（唔影響正常登入） |

**驗證流程（伺服器端，同 vsbadge 結構一致）**：前端 `handlePortalParams()` 唔再自己判斷，一律打同源 `GET /api/portal?u=&role=&src=`；伺服器檢查：(1) 旅團已登記＋backend 可信；(2) 旅團有 portalOrigin 且未停用；(3) 瀏覽器 Referer/Origin 同 `src` 參數對得上登記 origin（兩者至少要有一個，curl／直接打 URL 會被擋）；(4) 角色同時喺旅團白名單同系統已知角色內（`member` 亦可經 portal 進入，寫入照樣由旅團 GAS 驗權）。**驗證唔通過一律留喺錯誤頁**（顯示原因＋`reason` 錯誤代碼），唔會 fallback 免登入／普通登入。Portal 設定只留喺伺服器端，`/api/troops` 只回 id+name+en。

本機試 portal 流程可用 `ROVERBADGE_PORTAL_TEST=1` 放寬來源檢查（**Vercel 上必定失效**，雙重保護唔會喺生產環境開洞；角色照驗）。驗證部署：

```bash
curl -s 'https://roverbadge.vercel.app/api/portal?u=0082&role=member&src=https://main.example.org'  # 期望 {"ok":true,...}
curl -s 'https://roverbadge.vercel.app/api/portal?u=0082&role=member'  # 期望 no_origin（無來源 fail closed）
```

---

## 中央管理帳號（SUPER_KEY）

v8.9 起，系統管理員密碼改由 **Vercel 環境變數 `SUPER_KEY`** 驗證，只喺 Vercel 側比對；**任何密碼／hash 都唔會送到 GAS、Sheet、URL、前端或 log**。

| Name | 用途 |
|------|------|
| `SUPER_KEY` | 中央管理密碼（**字串**，最少 4 字元；前導 0 保留，唔會截斷／補位） |
| `SUPER_SESSION_SECRET` | 可選：session／票據加密鹽（唔設就用 `SUPER_KEY` 派生） |
| `CENTRAL_VERIFY_URL` | 可選：覆寫 GAS 驗票用嘅中央驗證 URL（預設指向本部署嘅 `/api/verify-super-ticket`，屬受信配置，唔接受由請求帶入） |

**登入鏈路（同 vsbadge 模式一致）：**
1. 前端 → `/api/proxy`（action=login）
2. proxy 喺 Vercel 側用 `SUPER_KEY` 完整比對（timing-safe）→ 通過先簽發**短效加密票據**（綁定旅團 + backend，預設 60 秒）
3. GAS 收到 `superTicketLogin` → 向**固定受信 URL**（`getCentralVerifyUrl()`，唔係請求帶入）驗票 → 先發 token
4. 瀏覽器攞到嘅係**加密包裝、旅團綁定**嘅 session（`rbs1.` 前綴），跨旅團用唔到

**政策：**
- `SUPER_KEY` 未設／空／少於 4 字元 → 中央登入整條功能停用（一般旅團登入完全不受影響）；冇預設密碼、冇旁路
- 4 字元密碼係你明確選擇咗嘅政策：**離線暴力破解風險仍然實際存在**；proxy 有每旅團每 IP 60 秒 10 次嘅登入限速，但限速**只能減慢**線上嘗試，唔可以消除短密碼本身嘅弱點
- 姊妹 APP（vsbadge/scoutbadge/cubbadge）各自部署時設**同一個** `SUPER_KEY` 即可用同一組憑證登入各 APP；呢個密碼**永遠唔會**寫入 GAS／Sheet，各旅團自己嘅帳號完全不受影響。跨 APP SSO（一次登入通行所有 APP）未實作
- 本文件刻意不記錄任何憑證

---

## 為何 backend URL 放環境變數都安全？

- Google Apps Script `/exec` URL 本身公開，但**無 KEY 無 Token 取唔到資料**：
  - `Code.gs` 第一層：`if(reqKey && reqKey!==getApiKey()) return Invalid API Key` → 防爬虫隨機掃
  - 第二層：人類需登入 → `Tokens` 表檢查；無 token 就 `Token 無效`
- v4.0 起 `/api/troops` **只回 id + name**，backend／apikey 完全唔出瀏覽器（舊版 `/api/troops` 會直接回 backend，已收緊）
- `apikey` 放 Vercel 環境變數，唔進 GitHub，避免 GitHub 公開掃描

---

## GS 自動生成 API KEY（3 處）

**Code.gs 已有：**
- `getApiKey()`：若無就 `rover_` + uuid（存 `PropertiesService`）
- `showApiKey()`：隨時查看
- `initializeSheets()`：初始化完彈出 KEY + URL

- 第一次執行 `initializeSheets` 自動生成 `rover_` + 24 位 uuid
- 之後任何地方 `getApiKey()` 都取同一個，除非手動清 `Script Properties`
- `showApiKey()` 可隨時再睇

---

## api/_registry.js（/api/troops 背後）v4.0 點運作

**v2.0 遺留問題（歷史紀錄）：** `fs` 讀 `data/troops.json`。Vercel Node function 跑喺 `/var/task`，
冇被 bundle 嘅檔案唔存在 → registry 變空 `{}` → `/api/proxy` 對任何旅團回
`404 找不到此旅團` → **全站登入失敗**（2026-08 事故嘅真正原因，見 `docs/VERCEL_API_404_POSTMORTEM.md`）。
v3.1 曾用 `_troops_static.js` 保底；**v4.0 起直接斬斷成條檔案路徑**——Registry 唯一來源係環境變數，唔會再讀到舊 JSON（就算 repo 仲有殘留檔案都會被忽略）。

規則：
1. 掃描 `TROOP_{ID}_NAME` / `TROOP_{ID}_BACKEND` / `TROOP_{ID}_APIKEY`；`{ID}` 原樣保留（前導 0 唔會變）
2. backend 必須通過 `isTrustedExecUrl()`（HTTPS `script.google.com/macros/s/.../exec`）先算有效旅團
3. `/api/troops` 只回 `{id, name}`；backend／apikey 只喺 proxy 內用
4. 除錯：`GET /api/health` 會回 `registry.source`（`env-only`）同旅團數

---

## 檢查清單 (管理員)

- [x] GS Code.gs 有 getApiKey 自動生成 + showApiKey + initializeSheets 回傳
- [x] 旅團登記：純 `TROOP_{ID}_NAME/_BACKEND/_APIKEY` 環境變數（無 JSON、無同步步驟、無 build 產物）
- [x] 前端只攞 id + name；backend／apikey 唔出瀏覽器
- [x] 中央管理帳號：`SUPER_KEY`（≥4 字元字串）只喺 Vercel 驗證；GAS 舊密碼入口已移除；密碼／hash 唔落 GAS／Sheet／log
- [x] Sheet 冇中央帳號蹤跡：Users 表冇這列（舊版殘留列會被忽略），Tokens 表以中性代號 `__sys__` 儲存 session
- [x] 用戶管理／成員名單任何角色都睇唔到系統管理員；API 回應／錯誤訊息只有一般用語
- [x] 防護保留：不能停用／重設密碼／改角色／以此帳號開戶
- [x] 驗證：`node tests/code-gs.test.mjs`（真正載入執行 Code.gs）、`node tests/proxy-login.test.mjs`（SUPER_KEY 政策 + 加密 session）、`node tests/run-e2e.mjs`（雙旅團完整鏈路）
- [x] 中央登入自測：`GET /api/health` 的 `super.selfTest`（簽票→驗票→後端綁定→session 全鏈路自檢；見「疑難排解」一節）
- [x] 每個支部獨立 APP，同一 APP 內所有旅團指向同一個 APP ADMIN

---

## 倉庫瘦身與圖片原則（部署大小控制）

**原則（v4.0 起生效，`.vercelignore` 按此執行）：**

1. **排除前必須全文搜尋引用**：`grep -rn "<檔名>" index.html docs/ api/`，連**動態引用、下載連結、
   fallback 路徑**都要查（例：`docs/BULK_ONBOARD.md` 用相對連結指去 `data/members_template.csv`，
   所以該 CSV 必須隨部署上線，雖然 index.html 本身冇直接 fetch 佢）。
2. **前端實際連結到的檔案一律保留部署**：`apps-script/Code.gs`（部署指南下載）、`assets/*`
   （LOGO/解析器/批量開戶腳本）、`data/items*.json`、`data/members_template.csv`、
   `data/mock_members.json`、五份前端有連結嘅 `docs/*.md`。
3. **只排除開發產物**：`.git`、`node_modules`、`tests/`、log、tmp、備份、i18n 工具
   （`i18n_dict.tsv`、`build_i18n.py`）同純管理文件。`tests/vercel-config.test.mjs` 會守住
   「被引用嘅檔案冇被 `.vercelignore` 排除」呢條底線。
4. **圖片**：LOGO 用 PNG（128px ≈20KB、256px ≈64KB）+ SVG fallback，唔使再壓。
   AVIF/WebP 暫不採用：瀏覽器相容性要求 PNG fallback 照樣要隨部署上線，轉換後**總位元組
   （AVIF + PNG fallback）反而多咗**，而且會引入透明度／畫質回歸風險 —— 冇實際节省就唔做。
5. **依賴極簡**：`dependencies` 為空；建構／測試工具只入 `devDependencies`（如有）。
   `vercel.json` 冇 `buildCommand`，`package.json` 冇 `build` script。
6. **內部模組唔做成 endpoint**：`api/_registry.js`、`api/_super.js` 以下劃線開頭，
   只被其他 handler `import`，唔會直接回應請求（`tests/serverless-registry.test.mjs` 有守）。

**誠實聲明**：`.vercelignore` 只影響**新部署**上傳嘅檔案。刪除檔案唔會清除 Git 歷史、
舊部署或 Vercel 已產生嘅歷史 build 用量；舊部署喺 Vercel 保留期間仍然可用、仍然佔佢哋
當時嘅大小。要慳历史用量只可以喺 Vercel 側手動移除舊 deployment。

---

## 疑難排解：中央管理帳號（sheep）登入失敗

密碼只喺 Vercel 比對，登入要行完整條鏈路（Vercel 簽票 → GAS 回打中央端點驗票 → GAS 發 token）。
**任何一環錯，都只會見到下面兩句一般用語**（刻意唔透露邊一環壞，防探測）；真正原因要靠自己分步排查。

**第一步：開 `https://<你嘅部署網域>/api/health`，睇 `super` 欄。**

| `super.selfTest` | 意義 |
|---|---|
| `skipped_not_configured` | `SUPER_KEY` 未設／少於 4 字元 → 中央登入整條停用（Vercel 側問題） |
| `skipped_no_trusted_troop` | 冇任何有效 `TROOP_{ID}_BACKEND`（Vercel 側問題） |
| `fail:*` | 簽票／驗票／綁定／session 自測失敗 → Vercel 側問題（多數係改咗 `SUPER_KEY`／`SUPER_SESSION_SECRET` 未 Redeploy） |
| `ok` | **Vercel 側全部正常** → 問題一定喺旅團 GAS 側，睇下表 |

**第二步（`selfTest: ok` 仍登入失敗）：對照前端見到嘅字句。**

**A. 「登入失敗：旅團後端尚未支援此登入方式或暫時無法使用，請聯絡管理員」**
＝ GAS 對 `superTicketLogin` 回咗 HTTP 4xx/5xx 或 HTML（proxy log 會見 `super_login_upstream_bad`）。
按可能性排：
1. **Code.gs 已貼新版但冇重新部署**：Apps Script 改 code 唔會自動生效，必須
   「部署 → 管理部署作業 → ✏️ 編輯 → 版本：新版本 → 部署」。
2. **未做 UrlFetchApp 授權**（v8.9 新增咗對外連線）：喺 Apps Script 編輯器揀 `testCentralVerify`
   函數按「執行」，完成授權（授權頁會要求「連接外部服務」），再重新部署新版本。
   - v8.9.1 起 `testCentralVerify` 會先 log **實際使用嘅端點 URL**，連線失敗時附埋**真正例外訊息**：
     - `You do not have permission to call UrlFetchApp` ＝ 授權未完成（做上面嘅授權步驟）
     - `DNS`／`Invalid URL`／`Address unavailable` 等 ＝ 檢查「專案設定 → 指令碼屬性」嘅
       `CENTRAL_VERIFY_URL`：冇需要就刪咗佢用返預設；自己填嘅話注意**全形字元（：。／）係 DNS 殺手**，
       成條 URL 必須全半形。另：log 到 `HTTP 404/500` 唔算連線失敗，代表 URL 指錯地方（path 多咗／少咗）。
   - 編輯器彈「An unknown error has occurred, please try again later」多數係 Google 側暫時性錯誤／
     工作階段過期：重新整理編輯器頁面（F5）再跑一次就得，同 Code.gs 內容無關。
3. **網頁應用程式存取權唔係「任何人」**：變咗「任何 Google 帳戶」嘅話，proxy 收到嘅係
   Google 登入頁 HTML，所有 action（唔只登入）都會失敗。
4. `TROOP_{ID}_BACKEND` 指向咗舊／已刪除嘅部署 URL → `GET /api/health` 睇 `troops[].backendHost`
   對唔對，錯就改 env + Redeploy。

**B. 「帳號或密碼錯誤」（用系統管理員帳號登入時）**
＝ GAS 收到 `superTicketLogin` 並回咗 JSON，但驗票唔通過（proxy log 會見 `super_login_denied`）：
1. **GAS 驗票端點指錯地方**：`Code.gs` 內置預設係 `https://roverbadge.vercel.app/api/verify-super-ticket`；
   **如果你嘅 Vercel 部署唔係呢個網域**（例如自己 fork 出去嘅 project），必須喺該旅團 Apps Script
   「專案設定 → 指令碼屬性」加 `CENTRAL_VERIFY_URL = https://<你嘅部署網域>/api/verify-super-ticket`。
2. **票據後端綁定不符**：票據綁定咗 `TROOP_{ID}_BACKEND` 嘅 URL，GAS 自報
   `ScriptApp.getService().getUrl()` 必須完全一致。如果 GAS 重新部署時揀咗「新建部署」
   （新 /exec URL），要同步更新 env 變數並 Redeploy。
3. **兩邊 `SUPER_KEY`（或 `SUPER_SESSION_SECRET`）唔一致**：每個 Vercel project（roverbadge /
   vsbadge / scoutbadge…）用同一組密碼就要設同一個值。
4. **密碼真係錯**：SUPER_KEY 比對失敗會跌返入一般旅團登入，保留帳號一律回同一句「帳號或密碼錯誤」
   （刻意設計，唔透露帳號存在）——確認 Caps Lock／前導零／複製貼上無多了空白。

**一般成員（10 位 YMIS／L 編號／電郵）登入唔經中央票據**，見「帳號或密碼錯誤」多數係
GAS `handleLogin` 嘅一般錯誤，與 SUPER_KEY 無關。

---

## 常見問答

**Q: 為何要加 TROOP_0082_APIKEY？唔加得唔得？**
A: proxy 會注入 apikey 做第一層防爬虫。唔加嘅話人類靠登入仍然防到，但建議加。

**Q: 每個旅團都要提交 URL + API KEY？**
A: 係，URL 係 Sheet 部署出嚟每個旅團唔同，KEY 都係每個 Sheet 獨立生成。管理員收集後加 3 個環境變數就得。

**Q: 管理員指向同一個 APP ADMIN？**
A: 係。roverbadge 這個 Vercel Project 就是所有樂行旅團的 APP ADMIN。各支部分開，但各自管自己支部內所有旅團。

**Q: GS 自動生成 API KEY 會唔會重複？**
A: `Utilities.getUuid()` 幾乎不會重複，24 hex chars 足夠。

**Q: 換咗 SUPER_KEY 之後？**
A: Vercel 改環境變數 → Redeploy → 即時生效；已經發出嘅加密 session 會因為 salt 改變而失效（需要重新登入），唔使碰 GAS 或 Sheet。

---

COPYRIGHT 2026 Scout System - Vercel Env v8.0（純環境變數 Registry + SUPER_KEY 中央帳號）
