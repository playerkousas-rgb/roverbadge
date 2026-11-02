# 🔴 RoverBadge｜樂行童軍進度及行政平台

> RoverBadge 是為香港樂行童軍旅團設計的進度紀錄及領袖行政工具：領袖可在網頁完成日常管理、審批及報表列印，而資料仍由各旅團自己既有的 Google Sheet 與 Apps Script 保管。
>
> 基於 2026 年第 11 版《樂行童軍訓練綱要》 • 前端 v5.2 ＋ 後端 GS 5.2.3（2026-11-02）
>
> ⚠️ **非官方聲明**：本系統為獨立開發的非官方工具，並非香港童軍總會官方產品，與總會並無隸屬或贊助關係。
>
> COPYRIGHT 2026 Scout System

## 主要功能

- **進度追蹤**：會員章、樂行童軍獎章、貝登堡獎章（2026 修訂版綱要，見 `data/items.json`）；離線暫存 + 批量寫入；全團總覽（30 欄／50 人上限）＋ 考驗營批量剔；按項目檢視
- **審批中心（✅ 一個分頁，子切換）**：🏅 進度申請（成員申請 → 「待批完成」→ 領袖批准才寫入）、👤 用戶申請（登入頁「🆕 申請帳戶」→ `Applications` → 批准即開戶，顯示一次性臨時密碼）、📅 履歷申請（成員自行申報服務／活動／訓練班 → 「待批履歷」→ 批准才寫入「活動履歷」；已批紀錄可再申請修改，重批才生效）
- **用戶管理**：新增／編輯／停用／重設密碼（臨時密碼寄電郵或當面給，首次登入強制改密）、細緻權限 `allowed_badges`、私隱開關 `allow_member_view_others`（成員預設只看自己）、批量開戶（CSV／YMIS 自訂報表 PDF 瀏覽器內解密）
- **🔑 忘記密碼（GS 5.2.3 起）**：登入頁自助式——輸入 YMIS 或登記電郵 → 寄 8 位一次性重設碼 → 即場設新密碼；重設碼只存 SHA-256、15 分鐘有效、5 次錯誤鎖定、不洩漏帳戶是否存在。詳見 [docs/PASSWORD_RESET.md](docs/PASSWORD_RESET.md)
- **官方表格**：新制／舊制 PT/21、PT/22、PT/69 自動填寫，`.print-area` 雙面列印
- **其他獎章**併入進度頁底部；**考驗介紹**內建（每項 detail／assessment／tip／links）；**保護兒童**資源一鍵直達
- **中／英一鍵切換**：`🌐 English` 按鈕即時全站切換（記喺 `localStorage: roverbadge_lang`）；分享連結可用 `?lang=en`／`?lang=zh` 鎖定語言
- **🐛💬 回報 · 意見**：對接 [scout-admin](https://github.com/playerkousas-rgb/scout-admin) 統一回報（首頁／登入頁／登入後 header 三個入口），傳送狀態明確（傳送中 → 已確認／未能確認，防重複提交）
- **MOCK 測試**：`data/mock_members.json` + `data/mock_import.csv`（10 個 MOCK 成員），用戶管理→🧪 測試工具一鍵載入

## 架構（設計原則）

```
index.html              — 前端所有邏輯（單一 HTML，統一 apiRequest() → 同源 /api/proxy）
assets/                 — LOGO PNG 128/256 + favicon + 架構圖 WebP + forms.js／rover-scope.js／ymis-parse.js
data/                   — items.json（樂行綱要：32 項段章細項（+子細項 0 項），15 項其他獎章）／items_en.json／members_template.csv／mock_members.json／mock_import.csv
apps-script/Code.gs     — 各旅團 Google Sheet 後端（單一檔案；進度／獎章／審批／帳戶／履歷／忘記密碼）
api/                    — proxy.js（同源多旅團 GAS Proxy，SSRF 白名單＋逾時＋錯誤標準化）
                        troops.js（只回旅團 id+name，永不回 backend/apikey）
                        portal.js（主系統 Portal 免登入，伺服器端驗 Referer/Origin＋角色白名單）
                        super.js（中央帳號：Vercel 驗 SUPER_KEY → 封短效票 → GAS 回打驗票）
                        _registry.js／_super.js／_admin.js（下劃線開頭，只作內部 import，不做 endpoint）
scripts/build.mjs       — 建置：產生 .vercel/output（Build Output API；靜態白名單＋ functions bundle）
vercel.json             — 只含 version:2／framework:null／buildCommand／git.deploymentEnabled
tests/                  — 全套測試（真實 Code.gs harness + mock GAS + 真 proxy 端到端）
docs/                   —領袖／執委／成員教學、部署指南（部署時只有白名單文件上線）
i18n_dict.tsv           — 中英字典源（LANG_DICT 以此為準，手動同步 index.html）
```

**核心設計規則（改動前必讀）**：

1. **瀏覽器永不接觸 GAS URL／API Key**：全部請求經同源 `/api/proxy`；旅團登記唯一來源係 Vercel 環境變數 `TROOP_{ID}_NAME／_BACKEND／_APIKEY`（編號保留前導 0），repo 內唔好放 troops JSON／fallback／sync script。
2. **`/api/*` 一律唔好洩漏機密**：`/api/troops` 淨係 `{id:{name,en}}`；健康檢查唔好實打上游 echo 回應。
3. **vercel.json 只准官方頂層欄位**（`additionalProperties:false`），legacy `builds`／`routes`／`functions` 唔准返嚟（2026-08 全站 404 事故，見 `docs/VERCEL_API_404_POSTMORTEM.md`）；`.vercelignore` 唔准存在（Build Output 模式會剝走 `scripts/`，令 build 鏈壞掉）。部署由 `npm run build` 產生 `.vercel/output`。
4. **資料保全（硬性）**：任何 patch/初始化唔准刪除、覆寫、重設用戶資料（帳號、成員、進度、獎章、履歷、備註、設定、API Key）；`initializeSheets()` 淨係做向後兼容嘅**增補**（建表、補空白表頭、補缺失列）；密碼永遠只存 hash。
5. **中央帳號零痕跡**：帳號識別字只寫喺 `Code.gs` 一行常數；密碼只喺 Vercel 環境變數驗證，GAS／Sheet／前端／已部署文件永遠收唔到；Sheet 內唔留任何相關列（測試 `html-integrity`／`troop_link` 守住）。
6. **防卡死**：`switchTab` 有 `_switching` 鎖＋ try/catch＋緊急返回；ESC 關 modal；雙擊 header 回首頁；`loadTroops()` 淨係讀 `/api/troops`，冇硬編碼旅團／JSON fallback。
7. **i18n**：所有 UI 字串入 `i18n_dict.tsv`（中英）＋ `index.html` 內嵌 `LANG_DICT`；新增字串要兩處同步（`tests/residue-audit`／`html-integrity` 會盯）。
8. **圖片**：LOGO 用 PNG 128/256（唔好用大原圖）；架構圖係唯一 WebP 例外（lazy-loaded，有下載連結；建置測試確保 >100KB 防退化、見 `VERCEL_ENV_SETUP.md`）。

## 授權聲明（Licensing）

**版權所有 © SCOUT SYSTEM，保留所有權利（All rights reserved）。** 本 repo 未附開源授權（LICENSE）：程式碼、文件與圖片均**不構成開源**；任何人未經作者書面同意，不得複製、修改、分發或作商業用途（公開於 GitHub 只代表可瀏覽／fork，不代表可合法使用）。

刻意**不採用** MIT／CC-BY 等寬鬆授權：呢類授權會**畀第三方合法複製同再利用**之權利（包括商業用途），而本系統為非官方工具，作者不希望被任何機構（包括童軍總會）未經同意整體取用或易名發佈。如日後改變主意要開源，加返對應 LICENSE 檔即可，功能完全不受影響。

## 施工規則（AI Agent 必讀）

通用規則（S/F/A/W/V/G/VL/X/C 系列＋審核閘）嘅唯一真理在 [`playerkousas-rgb/readme`](https://github.com/playerkousas-rgb/readme)（`README.md`＋`PLAYBOOK.md`＋專案案例 `docs/19`＋有身份系統底線 `docs/31`）；本 repo嘅 Agent 入口見根目錄 [`AGENTS.md`](AGENTS.md)。

## 審核／發佈要求（改動後必做）

- 改 `apps-script/Code.gs` 後要更新 `GS_VERSION`／`GS_RELEASE_DATE`（必要時 `GS_INIT_REQUIRED=true`），並同步 `assets/gs-release.js`（`tests/release-version.test.mjs` 會對實）；寫 `CHANGE_LOG.md`。
- 發佈新版前跑 **`npm run check`**、**`npm run lint`**、**`npm test`**（全部要 0 失敗；`scripts/check.mjs` 會確保所有 `tests/*.test.mjs` 都已註冊喺 `scripts.test`）。
- 完整自檢清單見 [docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md](docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md) §5；發佈新版 GS 檢查清單見 [APP_ADMIN_WORKFLOW.md](APP_ADMIN_WORKFLOW.md)。
- 任何會刪除／改寫既有資料嘅改動，必須經用戶確認並寫入 CHANGE_LOG，**唔好藏喺 initializeSheets() 內**。

## 部署

- **Vercel**：Build Output 模式——`vercel.json` 指定 `buildCommand: npm run build`，建置時 `scripts/build.mjs` 產生 `.vercel/output`（靜態白名單 `index.html`／`assets`／`data`／`docs`／`apps-script` ＋ `api/*.func`）。部署完成嘅定義：`curl /api/troops` 有 JSON、`GET /api/proxy` 回 **405**（404 即 function 冇建好）。
- **旅團登記**：管理員喺 Vercel 加 `TROOP_0082_NAME`、`TROOP_0082_BACKEND`（必須係 `https://script.google.com/macros/s/.../exec` 白名單格式）、`TROOP_0082_APIKEY`，Redeploy 後開 `/api/troops` 確認。詳見 [VERCEL_ENV_SETUP.md](VERCEL_ENV_SETUP.md)。
- **新旅團開 Sheet**：下載 `apps-script/Code.gs` → 建 Sheet → 貼上 → 執行 `initializeSheets()` → 部署為網頁應用程式 → 喺 Google「部署 → 管理部署」視窗複製 `/exec` URL 連同 API Key 交給 APP 管理員。雙軌指南見 [docs/DEPLOY_GUIDE_V5_DUALTRACK.md](docs/DEPLOY_GUIDE_V5_DUALTRACK.md)（軌道 A 獨立用；軌道 B 接主系統 Portal 免登入）。
- **升級既有旅團**：覆蓋 `Code.gs` 後，喺 Apps Script「部署 → 管理部署作業 → 編輯 → **新版本** → 部署」（沿用原 `/exec` URL，唔好新建部署）；需要初始化時執行一次 `initializeSheets()`（可安全重跑，只做增補）。GS 公告／核對見首頁「📢 最新版本公告」。

## 開發與檢查

```bash
npm run check    # 語法檢查（含 index.html inline script 與 Code.gs）+ 結構守護（85 項）
npm run lint     # 無 TODO 殘留／行尾空格／可疑 log
npm test         # 全套：check + 單元 + 真實 Code.gs harness + mock GAS + 真 HTTP 端到端
npm run dev      # 本機預覽：mock 旅團 0082 + 開發伺服器（port 3000，綁 0.0.0.0）
npm run demo     # Demo server（同樣掛 /api/proxy、/api/troops、/api/super）
npm run build    # 產生 .vercel/output（本機驗證 Build Output）
npm run test:build   # 驗證建置產物
```

CI：`.github/workflows/ci.yml` 會在 push／PR 自動跑 `lint`＋`check`＋`test`（見 PLAYBOOK G8）。

`tests/run-e2e.mjs` 會起真實 dev server + mock GAS 旅團走完整 HTTP 流程（旅團清單、登入、讀寫、跨旅團隔離、忘記密碼重設碼流程）；改 Proxy／Registry／Code.gs API 層後，以佢作部署前最後一道門。

## 文件

- 旅團負責人／領袖：[docs/LEADER_GUIDE.md](docs/LEADER_GUIDE.md)｜執委：[docs/EXEC_GUIDE.md](docs/EXEC_GUIDE.md)｜成員：[docs/MEMBER_GUIDE.md](docs/MEMBER_GUIDE.md)
- 部署：[docs/DEPLOY_GUIDE_V5_DUALTRACK.md](docs/DEPLOY_GUIDE_V5_DUALTRACK.md)／[VERCEL_ENV_SETUP.md](VERCEL_ENV_SETUP.md)｜批量開戶：[docs/BULK_ONBOARD.md](docs/BULK_ONBOARD.md)／[docs/YMIS_EXPORT.md](docs/YMIS_EXPORT.md)｜忘記密碼：[docs/PASSWORD_RESET.md](docs/PASSWORD_RESET.md)｜主系統整合：[docs/MAIN_SYSTEM_INTEGRATION.md](docs/MAIN_SYSTEM_INTEGRATION.md)
- APP 管理員工作流程／發佈檢查清單：[APP_ADMIN_WORKFLOW.md](APP_ADMIN_WORKFLOW.md)｜歷史：[CHANGE_LOG.md](CHANGE_LOG.md)

## 姊妹系統

同一架構獨立部署：`vsbadge.vercel.app`（深資）／`scoutbadge.vercel.app`（童軍）／`cubbadge.vercel.app`（幼童軍）。複製模版見 [docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md](docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md)。

---
COPYRIGHT 2026 Scout System • 非官方工具，並非香港童軍總會官方產品
