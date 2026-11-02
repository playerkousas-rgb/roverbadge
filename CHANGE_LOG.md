# CHANGE_LOG

## 2026-11-02（續 2） — 重設密碼授權收緊＋重設後狀態清理（前端仍 v5.2；GS 5.2.3 → **5.2.4**，無新增工作表／欄位、不需重跑 initializeSheets）

- **重設密碼授權（前端後台階級一致）**：`handleResetPassword` 原本只驗「呼叫者係領袖（角色等級 ≥40）」，未驗目標角色，與 `deactivateUser`／`reactivateUser`／`updateUserRole` 不一致。現改為在 handler 內部用 `canManageUser()` 驗證：**只有 SUPER ADMIN 可重設 ADMIN、ADMIN 不可重設 ADMIN**、副團長不可重設團長、團長不可重設 ADMIN、成員不可重設任何人；高權限可重設低權限（低權限帳號本就由其上級批核／可停用）。因檢查置於 handler 內部，同時覆蓋 **token 入口**與**上游簽章（link-signed）入口**（後者原本完全冇角色檢查）。被拒時目標帳號 hash 完全不變。
- **重設後清走登入鎖定**：重設成功（自設密碼／一次性臨時密碼兩條分支）後刪除 `LOGIN_FAIL:<ymis>`，否則帳號被鎖 15 分鐘期間，領袖改完密碼用戶仍然登入不到（對唔熟電腦嘅用戶易誤以為「壞了」）。
- **重設後踢走舊 session**：重設成功後呼叫 `destroyUserTokens(targetYmis)`，與電郵自助重設行為一致（被盜裝置即時失效）；管理員自己的 session 不受影響。
- **文件**：`docs/LEADER_GUIDE.md` 忘記密碼一段補充重設權限階級限制與重設後效果。
- **GS 版本**：`GS_VERSION` 5.2.3 → **5.2.4**（`GS_RELEASE_DATE` 2026-11-02、`GS_INIT_REQUIRED` 維持 false），`assets/gs-release.js` 的 `GS_LATEST` 同步；各旅團更新 `Code.gs` 後在既有部署建立新版本即可。
- **部署指引（新慣例）**：`README.md`、`docs/DEPLOY_GUIDE_V5_DUALTRACK.md`、`APP_ADMIN_WORKFLOW.md` 一致加入「**每次更新後都建議跑一次 `initializeSheets()`**」——即使該版 `GS_INIT_REQUIRED=false`。原因：初始化只做增補（建表、補空白表頭、補缺失列），可安全重跑、不刪不改既有資料；由舊版一次跨多版升級時必須執行，否則會缺新版所需的表／欄。
- **mock／示範後端**：`tests/mock-gas.mjs` 的 `resetPassword` 同步同一授權規則（呼叫者須 ≥ 領袖、只可重設自己管得到的角色）及重設後踢走該帳號舊 session，令示範環境與正式行為一致。
- **測試**：`tests/auth-hardening.test.mjs` 由 8 項增至 11 項（admin 改 admin／團長改管理員／副團長改團長／成員改任何人皆被拒且目標不變；SUPER ADMIN 可重設 ADMIN 且保留帳號本身不可被重設；重設後解除鎖定、清 session、強制首登改密）。`tests/gas-harness.mjs` 增加 `handleResetPassword` 測試內省匯出（僅測試用）。

## 2026-11-02（續） — G11 完整圖標集＋A17 舊找回密碼防枚舉＋A12 私隱聲明＋授權聲明

- **G11 圖標標準**：`assets/icons/` 新增完整 9 件圖標（16/32/48/192/256/512 PNG＋maskable 192/512＋favicon.ico，合計 157,848 B ≤ 260KB 上限），另加 `og-image-1200x630.png`（134KB）。新增 `assets/manifest.webmanifest`（any＋maskable 用途、theme/background #0D47A1），`index.html` head 加 manifest 連結、192/512 icon、`theme-color`、og: 系統 meta（`og:image` 用絕對網址 `https://roverbadge.vercel.app/assets/icons/og-image-1200x630.png`）＋ twitter:card。圖標檔名固定後**不可改名**（G11 不變性），換圖要加新檔名。html-integrity 加 9 項 G11 守護（現 53 項）。部署不受影響（`assets/` 本已在 build 白名單）。
- **A17 舊 `forgotPassword` 防枚舉**：舊 action 保留向後兼容，但回應改為全中性——找不到帳號／未登記電郵／被停用／節流／寄信失敗全部回同一個 `{success:true, message:'如該帳號已登記電郵，臨時密碼已寄出…'}`，唔再回 `email_hint` 或「找不到此帳號」；實際只向已登記電郵寄臨時密碼，寄信失敗記審計 `forgot_password_mail_failed`。mock-gas 鏡像同一行為；相關斷言更新，auth-hardening 新增舊 action 一致性測試（8/8）。
- **A12 私隱聲明**：`docs/LEADER_GUIDE.md` 新增「私隱聲明」章節（收集乜／目的／儲喺邊：各旅團自己 Google Sheet、中央唔儲個人資料／保留期／查閱更正刪除權／安全措施），依《個人資料（私隱）條例》第486章。
- **授權聲明**：`README.md` 明确本 repo **All rights reserved、未附開源 LICENSE**（刻意唔用 MIT/CC-BY，避免第三方合法取用），見該章說明。
- 測試：`npm test` 全綠（html-integrity 53/0、code-gs 156/0、auth-hardening 8/8 等）。

## 2026-11-02 — 對齊 readme repo（PLAYBOOK）硬規則：A3 密碼雜湊升級＋A5 登入鎖定＋A17 防枚舉＋W1 版權 meta＋CI

對照 [`playerkousas-rgb/readme`](https://github.com/playerkousas-rgb/readme) 嘅 PLAYBOOK／docs/31（有身份系統嘅硬性底線）審查，本輪強化（前端仍 v5.2；GS 仍 5.2.3，冇新增工作表／欄位，既有資料不變）：

- **A3 密碼雜湊**：由單次 SHA-256 升級為 **PBKDF2-HMAC-SHA256（120,000 迭代＋每用戶 16-byte 隨機 salt）**，格式 `pbkdf2$<iter>$<salt>$<dk>`，寫入 `Users.password_hash` 同一欄。舊 64-hex SHA-256 hash 仍可驗證，**登入成功時自動升級**（密碼本身不變，只改儲存格式）；`upsertUser`／匯出匯入同時接受兩種格式（跨節點搬舊數唔受影響）；新開戶／改密碼／領袖重設／忘記密碼重設一律寫新格式；預設密碼 `changeme` 判斷兼容兩種格式。重設碼本身仍是高熵一次性碼，維持 SHA-256 儲存。
- **A5 登入閘**：同一帳號連續 **5 次登入失敗鎖 15 分鐘**（ScriptProperties 記錄 `LOGIN_FAIL:*`，增補式；鎖定中連正確密碼都拒，寫審計 `login_locked`）；成功登入清記錄。**改密碼後踢走該用戶其他所有 session**（保留當前 token，`destroyUserTokensExcept`）。
- **A17 防枚舉**：本地登入「找不到帳號」與「密碼錯誤」統一回 `帳號或密碼錯誤`；找不到帳號時另做一次假 KDF 令時序一致。
- **W1**：`index.html` `<head>` 加 `<meta name="copyright" content="© SCOUT SYSTEM">` 同 `<meta name="app-version">`（html-integrity 加守護，現 44 項）。
- **CI（G8／docs/20 P2 建議）**：新增 `.github/workflows/ci.yml`（push／PR 跑 `npm run lint`＋`check`＋`test`；actions 以 commit SHA pin）。
- **AGENTS.md**：新增根目錄指引，叫施工嘅 Agent 先讀 readme repo 嘅 PLAYBOOK＋docs/19 專案案例＋docs/31，同本 repo嘅硬性規則。
- **測試**：新增 `tests/auth-hardening.test.mjs`（7 項：PBKDF2 儲存、舊 hash 自動升級、預設密碼兩格式觸發強制改密、5 次鎖定 15 分鐘＋統一訊息＋審計、防枚舉訊息一致、改密碼踢舊 session 保留當前、upsertUser 雙格式兼容）；`password-reset`／`troop_link` morsel 断言改為按新格式（行為不變）。全套 `npm test` 綠。

## 2026-11-02 — Repo 全面審查修復（無功能變更，前端仍 v5.2／GS 仍 5.2.3）

對照 repo 自己嘅設計文件（`docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md` 架構＋自檢清單、`APP_ADMIN_WORKFLOW.md` 發佈檢查清單、`VERCEL_ENV_SETUP.md` 部署政策）審查，修復以下問題：

- **補返缺失嘅 `data/mock_import.csv`**：`index.html` 測試工具有「📄 下載 CSV 匯入 Sheet」連結但檔案唔存在（部署後 404）。現由 `data/mock_members.json` 十個 MOCK 成員按批量開戶格式（`ymis,name,email,role,can_tick,password,note`）產生，密碼統一 123456。
- **架構圖 WebP 由 1.1MB 重壓到 ~173KB**（quality 85，768×1376 不變，目視檢查文字清晰），符合 repo「唔好用大原圖」部署瘦身原則；`tests/build.test.mjs`／`credential-display.test.mjs` 嘅 >100KB 守護仍然過（防殘圖）。
- **`VERCEL_ENV_SETUP.md` 圖片原則過時**：舊文寫「AVIF/WebP 暫不採用」，但 5.2.2 起已部署 WebP 架構圖。已更新為「唯一例外」條款（單一 lazy-loaded 圖、有下載連結、壓到 ~170KB、測試守住 >100KB）。
- **新增 `README.md`**：repo 原本冇 README（姊妹 repo vsbadge／scoutbadge 有），補返一份講明架構、核心功能、審批流程、安全／資料保全硬性規則、發佈檢查要求、部署雙軌同開發指令。
- **支援 `?lang=en`／`?lang=zh` 分享連結鎖定語言**（同 vsbadge 一致）：boot 時讀 URL 參數寫入 `localStorage: roverbadge_lang`，即時生效免重新載入；`tests/html-integrity.test.mjs` 加守護（43 項）。
- **審查確認已符合設計、無需改動**：`vercel.json` 只含官方頂層欄位且冇 legacy builds/routes/functions；`.vercelignore` 不存在；`/api/proxy`、`/api/super` GET 回 405；`/api/troops` 淨係 id+name（短暫快取係刻意設計，見 build.test 註解）；`loadTroops()` 淨係讀 `/api/troops` 冇 fallback；防卡死（`_switching` 鎖、ESC、雙擊 header）、審批中心合併、其他獎章併入進度、私隱開關、內嵌教學、全團總覽上限、中央帳號零痕跡守護、MOCK 工具——全部都喺。
- 測試：`npm test` 全綠（check.mjs 85/0、html-integrity 43/0、code-gs 156/0、run-e2e 166/0、password-reset 18/18 等）。

## 2026-11-02 — GS 5.2.3：忘記密碼（電郵一次性重設碼，自助式）

- **新功能**：登入頁（兩個登入分頁底部）新增「🔑 忘記密碼」兩步式 modal —— 輸入 YMIS 或登記電郵 → 寄 8 位一次性重設碼到登記電郵 → 即場輸入重設碼並設定新密碼。後端新增公開 action `requestPasswordReset`／`confirmPasswordReset`（登入前毋須 token），以及 `testPasswordResetMail()`（寄測試信去執行者電郵並清走發信故障旗標）。
- **安全**：重設碼只存 SHA-256 雜湊（新增「密碼重設」工作表），15 分鐘有效、最多 5 次錯誤鎖定、一次性（used／superseded／expired／locked／void）、新申請作廢舊碼；同一電郵 30 分鐘最多 3 次、全團每小時 30 次、LockService 鎖防並發；回應不洩漏帳戶是否存在；電郵欄位拒絕 `=+-@` 開頭（公式注入）；成功後撤銷所有 session 並寫中性操作紀錄。合資格帳戶：已啟用、非 super_admin、已登記電郵且已設密碼（成員都可以用）。
- **Proxy**：`api/proxy.js` 把兩個新 action 列入 `PUBLIC_ACTIONS`，同時主動剷走請求內的身份欄位（token／ymis／target_ymis／role／password_hash／code_hash／user／apikey／sig*），API Key 只在 server 端補上。
- **發信故障處理**：MailApp 失敗（常見：換 Code.gs 後未重新授權 gmail.send）時回 `{success:true, delivery:'unavailable'}`，前端提示聯絡領袖；旗標全團共通，重新授權後成功發信即自動清走。
- **舊版相容**：v8.8 臨時密碼 `forgotPassword` 流程完整保留；舊 GS 收到新 action 會回 `Unknown action`，前端顯示友善提示叫聯絡領袖重設。舊 Sheet 毋須重跑 `initializeSheets()`——「密碼重設」表會在首次申請時自動補建（新安裝則由 initializeSheets 一併建立），既有資料不變。
- **版本**：GS 升至 **5.2.3（2026-11-02）**（`Code.gs` 與 `assets/gs-release.js` 同步）；前端維持 v5.2，不改 package.json 版本。
- **字典**：`i18n_dict.tsv` 新增 21 組中英字串並移除 3 個孤兒鍵（1004 列），`index.html` LANG_DICT 手動同步（1007 項）。
- **測試**：新增 `tests/password-reset.test.mjs`（18 項：完整流程、YMIS 申請、不洩漏、鎖定／過期／作廢、限速、注入、session 撤銷＋紀錄、發信失敗、自動補建、閂口、proxy 剷場、端到端 proxy→mock GAS），已加入 `npm test`；`scripts/check.mjs` 85/0、`code-gs.test.mjs` 156/0、`run-e2e.mjs` 166/0 全綠。
- **文件**：新增 `docs/PASSWORD_RESET.md`；`docs/LEADER_GUIDE.md`、`APP_ADMIN_WORKFLOW.md`、`docs/DEPLOY_GUIDE_V5_DUALTRACK.md` 加入一行說明。
- **部署提醒**：各旅團貼上新 Code.gs 並在既有部署選「新版本」後，**記得重新授權 gmail.send 範圍**，再執行一次 `testPasswordResetMail()` 測試發信。


## 2026-10-24 — GS 5.2.2：API Key-only 接入顯示、系統介紹與安全的可選初始化

- **接入顯示**：`initializeSheets()` 與旅系統選單只提供 API Key；不讀取或顯示自動／快取 URL，初始化回傳物件移除 `scriptUrl`，保留初始化結果及本旅團管理員首次登入提示。既有 URL 屬性保留原值。內部登入／簽名驗證未更改。
- **新旅團流程**：不要求 GS 設定旅團編號、不新增貼 URL 設定；部署 URL 從 Google 部署視窗取得，用戶在原有 ADMIN FORM 填旅團編號、名稱、URL、API Key。
- **系統介紹**：首頁加入「系統介紹」分頁，與新旅團部署教學雙向切換；部署通用繁中 WebP 架構圖並提供放大／下載。加入中英架構、Google 授權範圍、Sheet 分享、帳密與 API Key 區別及未認證 API 的安全界線說明。
- **版本／初始化**：GS 版本升至 5.2.2（2026-10-24），`GS_INIT_REQUIRED=false`。既有 Sheet 的顯示修正不需重跑初始化；新 Sheet 仍需首次初始化。前端不偽造初始化標記。
- **回歸測試**：新增 `tests/credential-display.test.mjs`，覆蓋多個可能回報 URL＋舊快取、所有 credential 顯示入口、無旅團 ID 新安裝、重跑資料與 Key 保全、介紹頁切換及安全文案；Build 測試確認圖片與 Code.gs 下載產物存在。
- **預覽**：本機開發／Demo server 增加 `image/webp` MIME。
- **部署狀態**：僅修改 roverbadge repository；未操作線上 Google Apps Script 部署。

## 2026-10-23 — GS 5.2.1：最新版本公告、GS 初始化核對、資料保全規則

- **最新版本公告**：首頁、登入頁、登入後主頁頂部顯示公告（最新 GS 版本 v5.2.1、2026-10-23），附 Code.gs 下載、更新步驟、「🔄 重新檢查」按鈕（`index.html`、`assets/gs-release.js`）。
- **GS 版本核對**：`Code.gs` 新增 `GS_VERSION`／`GS_RELEASE_DATE`／`GS_INIT_REQUIRED` 與 `ecStatus` action（位於閂口之前，只回版本與標記）；`load` 同時回傳 `gsVersion`、`initializedGsVersion`。前端三種狀態：GS 未更新／GS 已更新但未初始化（顯示「必須執行一次 initializeSheets()」）／全部完成（綠色「✅ 已核對」）。`api/proxy.js` 加入 `ecStatus` 白名單。
- **初始化標記**：Script Property `INITIALIZED_GS_VERSION` 只在 `initializeSheets()` 全部步驟成功後最後寫入；中途失敗不寫入（測試覆蓋）。
- **資料保全（硬性規則）**：
  - `initializeSheets()` 不再自動刪除 Users 內的 super_admin 殘留列，也不再刪除 Tokens 內的舊版保留帳號 session；兩個 `remove*Rows()` 函式保留給人手執行。
  - 殘留 super_admin 列讀取時略過（`isLegacySuperRow_`），不能作為登入身分。
  - 不再於每次初始化時逐列改寫 `force_change_password`；預設密碼（changeme）的強制改密改為登入時判斷（`isDefaultPasswordHash_`），效果不變、不寫入資料。
  - 表頭補寫只寫空白格，不覆蓋既有欄名。
- **文件**：`docs/LEADER_GUIDE.md` 新增「最新版本公告、GS 更新與資料保全（必讀）」；`APP_ADMIN_WORKFLOW.md` 新增 GS 版本核對規格與發佈檢查清單。
- **字典**：`i18n_dict.tsv` 新增 22 組中英字串，同步 `index.html`（963 筆）。
- **測試**：新增 `tests/release-version.test.mjs`（12 項：版本一致、三狀態、閂口下 ecStatus、標記時機、舊結構升級、完整 before/after 快照、前端接線與翻譯覆蓋、proxy 白名單），已加入 `npm test`；`tests/code-gs.test.mjs` 2b 與殘留列斷言改為新規則。
- **部署提醒**：Vercel 重新部署後，各旅團須在 Apps Script 貼上新 `Code.gs` 並在既有部署上選**新版本**（沿用原 Web App 網址，不要新建部署），再執行一次 `initializeSheets()`。

## 2026-10-23 — 其他章節殘留審計（VSBADGE 骨架混入）＋ 新制表格重建

詳細修正清單、修正前→修正後對照、官方連結見 `docs/OTHER_SECTION_RESIDUE_AUDIT_2026-10.md`。

- **首頁四級方塊**：由 `items.json` 即時產生（`RoverScope.levelSummaries`），取代硬寫的「12項／23項基礎技能／4段章 100+／4金帶」。
- **表格列印**：PT/21、PT/22、PT/69 改為第五版新制結構（`assets/forms.js`），依官方 PDF 逐列核對；PT/22 八列、急救證書編號必填、樂行獎章證書編號必填；PT/69 為計劃申請，不勾已完成狀態、不預填日期。舊制（第四版）表格只提供連結，不由系統產生。
- **權限**：`assets/rover-scope.js` 統一判斷（`*`／獎章／段章／項目／`OTHER`），修正前綴誤判（`L3-INT` 不再放行 `L3-INTL-*`）；未知代碼不放行、原樣保留。執委預設統一為 `L1,OTHER`（來源 `items.json → permissionDefaults`）。
- **舊版紀錄**：12 個舊 ID 保留，標示「舊版紀錄／不計完成度」，不計完成度、不出現於新表格，進度頁以卡片顯示。
- **資料**：`items.json` 與 `items_en.json` 結構對齊；熱線首位加入 P022 列出的 `2957 6411 / 2957 6417`（`2957 6414` 保留待核）；撤回 `items_en` 中未經綱要核對的兩條時限提示。
- **字典**：`i18n_dict.tsv` 改名 6 鍵、刪除 46 列孤兒列、補入 17 鍵；刪除未引用的「三選二」「三選一剔號」；同步 index.html（946 筆）。
- **後端**：Code.gs 與 `assets/batch-onboard/Code.gs` 執委預設改為 `L1,OTHER`；示例與註解去除「深資」。
- **文件**：`AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md` 第 167 行（PT 代碼錯配）、`EXEC_GUIDE.md`、`LEADER_GUIDE.md`、`MEMBER_GUIDE.md`、`MAIN_SYSTEM_INTEGRATION.md` 第 121 行。
- **測試**：新增 `tests/rover-scope.test.mjs`、`tests/forms-generator.test.mjs`（Node harness 實際執行產生器）、`tests/residue-audit.test.mjs`；已加入 `npm test`。`npm run check` 65/0。

- **學制（第二批）**：每位成員可選「新制（`new`）／舊制（`old`）／舊制過渡新制（`transition`）」，預設新制。進度頁有學制選擇器（成員本人可改；領袖可為他人改）；表格頁依學制產生對應表格；過渡成員可見「舊制 → 新制過渡對照」面板，只提供待儲存、不自動計入完成度。
- **後端權限（第二批）**：`apps-script/Code.gs` 的 save、saveOtherBadge、requestComplete、reviewRequest、setScheme 均以 token 識別操作者，強制角色、`allowed_badges` 與學制；整批任何一項違規則整批拒絕、零寫入。`ITEM_CATALOG_`／`DEFAULT_PERMS_` 由 `scripts/gen-backend-catalog.mjs` 從 `data/items.json` 生成（`--check` 驗證同步）。
- **代理層安全修正**：`api/proxy.js` 會替每個轉發請求附上旅團 APIKEY，因此身分以 token 為準（帶無效 token 一律拒絕）；只有 APIKEY 而無 token 才視為系統操作。`setScheme` 加入代理層白名單（原本會回 400「不支援的操作」）。
- **改名**：舊制 S4 ID 改為 `S4-AWARD-CORE-01…`、`S4-BP-ELECT-03` 等（前綴與段章代碼一致）；L3 `L3-INTL-A/B`、`L3-CHALLENGE-A/B` 改為 `-01／-02`（用戶授權，尚無用戶）。
- **文件**：`docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md` 表格代碼只保留樂行（用戶指示）。
- **樂行配套核對（第二輪）**：依綱要逐章比對，修正 L4 時限文字（平均於 12 至 18 個月內完成）、L2 簽發人（補助理總部總監）；進度頁 L3 獎章顯示「7 段中 4 段」達標狀態（`awardRule`，`RoverScope.badgeAwardStatus`）；官方連結新增相關表格 PT/75（延長考取期限）。詳見 `docs/OTHER_SECTION_RESIDUE_AUDIT_2026-10.md` §7。
- **測試**：新增 `tests/allowed-badges.test.mjs`、`tests/catalog-sync.test.mjs`、`tests/proxy-actions.test.mjs`、`tests/scheme-dom-test.mjs`（jsdom，可選）；`troop_link`／`security` 夾具改用真實項目 ID `L1-ACT-01`（後端現在驗證項目 ID）。`npm run check` 73/0；`npm test` 結束碼 0。
- **安全（APIKEY）**：移除 GAS addUser／addMember 的「APIKEY 即管理員」後備（原為 const 錯誤而失敗關閉，批量開戶方法 A 同時壞掉）。現行規則：無 token＋有效 APIKEY ＝ 系統操作；帶任何 token 以 token 判斷。見稽核 §2 第 39 項、`tests/apikey-admin.test.mjs`。
- **第八輪**：依用戶決定，移除資料頁「佩戴重點」整段（中英文，字典已同步）。
- **第七輪（佩戴重點核對）**：佩戴重點標籤由「2024新指引」改為「通告 13/2023」；刪除查不到來源的「貝登堡獎章可終身佩戴」（中英文同步，字典已同步）。
- **第五輪（上傳 PDF 全文核對）**：以使用者上傳的綱要中英文（第 1–64 頁）與 PT/21（4/2019）、PT/22、PT/69（1/2024）重新核對。修正：PT/21 審核員欄（撤回第四輪的錯誤）、推薦欄與各階段標題；PT/69 階段標題與預印選項；15 項其他獎章的名稱、說明、佩戴規則、簽發及購買資料；L2 啟導班對象與內容；L3 樂行童軍獎章簽發流程。兩項綱要內部不一致留待決定（見稽核 §4）。
- **舊制表格逐字核對**：`oldForms` 的 PT/21、PT/22、PT/69 舊制文字依官方 PDF 修正（推薦欄、欄位名稱、PT/69 提示）。中英文資料檔同步。見稽核 §4。
- **版號**：用戶選擇 v5.2（遞增）。標題、頁首、副標、頁尾、「最新」卡片、i18n 字典、`items.json`／`items_en.json` meta、`package.json`／`package-lock.json` 統一為 5.2；v5.1 更新說明保留為歷史段。
- **可勾選（`can_tick`）**：團長決定撤銷後不可勾選、審批或直接編輯（即使角色為領袖）。後端 `canTickUser_` 統一檢查（進度 save、其他獎章、審批、日誌、待審清單、學制為他人）；前端 `canTickNow()` 統一判斷。撤銷後仍可查看。見稽核文件 §2 第 38 項。

**未完成／待決**：熱線 `2957 6414` 未核實；`L1-01`／`L1-02` 舊名未核對；佩戴指引日期標籤未核對；舊制 PT/21、22 項目未逐字對照舊制 PDF；Apps Script 上線前須實測。

## 2026-10-23 — 首次登入教學（App＋文件）＋ 主系統介紹暫時隱藏 ＋ 兩項對齊改善

對齊 scoutbadge PR #42/#43、cubsbadge PR #30。

### 首次登入教學（預設管理員帳號）

- `index.html`「新旅團部署」頁新增第 4 步「首次登入（預設管理員帳號）」：
  YMIS `1111111111`／密碼 `changeme`，用「👤 成員」分頁登入，首次登入強制改密。
- `docs/DEPLOY_GUIDE_V5_DUALTRACK.md` 新增「首次登入（預設管理員帳號）」一節（內容同 App 一致）；
  `docs/LEADER_GUIDE.md` 開頭加快速提示。
- 帳密只出現喺：`initializeSheets()` 完成訊息（Code.gs）、App 部署頁教學、文件——**唔會出現喺任何 API 回應**。

### 主系統介紹暫時隱藏

- `index.html`：主系統平台介紹卡、「兩條路」部署地圖卡、「軌道B」步驟——三段用 HTML 註解隱藏，
  開頭標記：`[主系統暫時隱藏 2026-10]`。步驟重排為：1 下載 → 2 部署 → 3 提交登記（原「軌道A」改題）
  → 4 首次登入 → 5 私隱選擇；H2 標題同「完成後提交」卡改為單一路線文案。
- `docs/DEPLOY_GUIDE_V5_DUALTRACK.md`、`docs/MAIN_SYSTEM_INTEGRATION.md` 頂部加「暫停對外推廣」blockquote。
- **冇刪除任何主系統程式碼**（Portal／sig 照常運作），亦冇刪被註解段落及其翻譯 key。

### 對齊改善（經用戶同意）

1. 首次登入強制改密由 `window.prompt()` 改為 modal 對話框（新密碼＋二次確認，最少 4 位）。
2. `initializeSheets()` 內管理員 seed 對齊 vsbadge `ensureSeedAccount()`：
   每次初始化都檢查，預設管理員被刪會補返（唔覆蓋既有帳號）；
   任何帳號密碼仲係預設 `changeme` 會重標 `force_change_password=true`。

### i18n 同步修復

- 修復 TSV ↔ `index.html` `LANG_DICT` 長期唔同步：56 條淨喺 HTML 嘅 key 已補返入 `i18n_dict.tsv`；
  3 條死重複列已刪；5 條 value 以 TSV 較新嘅 rover 用字為準（角色名、引號款式）。
- `build_i18n.py` 新增 `--sync-dict` 模式（idempotent 重新生成 `LANG_DICT`）；
  TSV 新增 `\n`／`\t`／`\\` 反斜線轉義讀寫約定。
- **往後改動翻譯嘅固定流程**：改 `i18n_dict.tsv` → 跑 `python3 build_i18n.py --sync-dict` → 提交兩個檔案。

## 未來待辦：重啟主系統介紹

主系統（scoutsystem-2.0）完成後：

1. 全 repo 搜尋 `[主系統暫時隱藏]`，解除 `index.html` 三段 HTML 註解
   （主系統介紹卡＋部署地圖卡、「軌道B」步驟）。
2. 步驟號重排，建議：1 下載 → 2 部署 → 3 提交登記 → 4 首次登入 → 5 軌道B → 6 私隱選擇。
3. 移除 `docs/DEPLOY_GUIDE_V5_DUALTRACK.md`、`docs/MAIN_SYSTEM_INTEGRATION.md` 頂部嘅
   「暫停對外推廣」blockquote；H2 標題同「完成後提交」卡可按需要還原雙軌文案（git 歷史有舊文案）。
4. i18n key 全部喺 `i18n_dict.tsv`／`LANG_DICT` 保留咗，**唔使補**，被註解段落一還原就會自動翻譯。
