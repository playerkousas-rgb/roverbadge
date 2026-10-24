# CHANGE_LOG

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
