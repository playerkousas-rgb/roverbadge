# 其他章節殘留審計（樂行童軍支部，2026-10）

> 本文件記錄 `roverbadge` 由 VSBADGE（深資童軍支部）骨架複製時混入的其他章節殘留，
> 以及每項修正的「修正前 → 修正後」。權威來源只採用本支部現行《樂行童軍訓練綱要》（第五版，2026年2月）
> 與香港童軍總會樂行支部的官方表格（新制）。

---

## 0. 範圍、方法與一項說明

- **範圍**：整個 repo，包括 `index.html`、`apps-script/Code.gs`、`assets/`、`api/`、`data/`、`i18n_dict.tsv`、`docs/`、`tests/`、`CHANGE_LOG.md` 及其他根目錄文件。`.vercel/` 為 gitignored 的舊建置副本，不作為來源，已排除。
- **關於「第 3 節 grep 清單」**：用戶訊息及 repo 內**都沒有**這份清單。已搜尋 `*.md`（`grep "grep"`），只有 `VERCEL_ENV_SETUP.md:231` 提及 grep 這個詞，並非清單。因此本次清單是**獨立建立**的（見 §1）。
- **權威來源**：見 §5 官方連結。舊制（第四版）表格現在**依學制**產生（見 §2 第 23 項），但其項目與簽署程序仍以官方舊制 PDF 為準。
- **第二批（學制與後端權限）**：見 §2 第 23–33 項；待決事項的處理結果見 §4。

---

## 1. 獨立建立的 grep 清單

```bash
grep -rnE --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.vercel \
  '活動段章|童軍知識|社區服務|個人興趣|認識世界|挑戰項目|童軍技能（I）|深資|VSBADGE|L1,活動段章|L1,L3-ACT|金帶|12項|23項|4段章|必修|選修|Community Service|Scouting Knowledge|Scoutcraft \(I\)|PT/[0-9]{2}' .
```

注意：`PT/[0-9]{2}` 用 `{2}` 才能避免把 `PT/69` 切成 `PT/6`。

### 殘留詞數量（修正前 HEAD `cef3809` → 修正後）

| 檔案 | 殘留詞 | 修正前 | 修正後 | 說明 |
|---|---|---:|---:|---|
| index.html | 活動段章 | 14 | 0 | 已全部移除 |
| index.html | 童軍知識 / 社區服務 / 個人興趣 / 認識世界 / 挑戰項目 | 5 / 14 / 6 / 4 / 3 | 0 | 深資表格結構，已由第五版段章取代 |
| index.html | 金帶 / 12項 / 23項基礎技能 / 4段章 | 8 / 4 / 2 / 2 | 0 | 首頁方塊改由 items.json 產生 |
| index.html | 必修 / 選修 | 19 / 16 | 7 / 1 | 剩餘為「必修」徽章標籤（`mandatory`）及一個未引用的通用字典條目（見 §3） |
| apps-script/Code.gs | 活動段章 / L1,活動段章,OTHER / L1,L3-ACT,OTHER | 4 / 4 / 1 | 0 / 0 / 0 | 執委預設改為 `L1,OTHER` |
| apps-script/Code.gs | 深資 | 1 | 1 | 保留：第 74 行示例已改為「其他支部」，剩餘為架構說明註解（見 §3） |
| data/items.json | 童軍知識 / 金帶 / Scoutcraft (I) | 1 / 0 / 3 | 3 / 3 / 3 | 增加的出現次數全部位於 `legacy`（舊版紀錄）及 `legacyTransition`（舊制對照）；測試已強制限定 |
| data/items_en.json | Scouting Knowledge / Community Service | 0 / 1 | 2 / 2 | 同上，位於 `legacy` 子樹 |
| i18n_dict.tsv | 活動段章 / 童軍知識 / 社區服務 / 金帶 / 12項 | 5 / 2 / 4 / 4 / 2 | 0 | 已同步 |

> 數量增加只發生在舊版紀錄子樹，這是刻意保留（驗收標準 5：舊 ID 不得刪除，須標示「舊版紀錄／不計完成度」）。

---

## 2. 更正清單與「修正前 → 修正後」

| # | 位置 | 修正前（HEAD） | 修正後 | 依據 |
|---|---|---|---|---|
| 1 | index.html 首頁四級方塊（HEAD 389–392） | 硬寫：`L1 會員章 12項 • 含保護兒童`；`L2 肩章 23項基礎技能`；`L3 樂行童軍獎章 4段章 100+選項`；`L4 貝登堡獎章 4金帶 • 最高榮譽` | 由 `RoverScope.levelSummaries(items)` 產生：`L1 13項 • 含必修「保護兒童」`；`L2 1項 • 啟導`；`L3 7段考驗 • 7項中完成4項`；`L4 7項全部完成` | 綱要 pp.15–27：會員章 13 項；肩章 1 項；獎章 15 項／7 段，選 4 段；貝登堡 7 項 |
| 2 | index.html 表格 PT/21（HEAD 4562–4595 分支） | 深資結構：必修「童軍知識」「社區服務(I)」，選修「個人興趣」「認識世界」等（HEAD 4575–4581） | 第五版 7 段：準領袖培訓、童軍技能、服務、國際視野、興趣及技能、身心健康、挑戰；「7個範疇中完成4個」 | 新制 PT/21（uploads/tc/forms/25998） |
| 3 | index.html 表格 PT/22（HEAD 4602–4631 分支） | 深資結構：必修「社區服務(II)」（HEAD 4615）及其他深資段；標題與 PT/21 同樣標示「08/2022最新」 | 8 列：準領袖培訓 ／ 童軍技能 ／ 服務（**有效急救證書編號必填**）／ 服務 ／ 國際視野 ／ 興趣及技能 ／ 身心健康 ／ 挑戰；「於7個範疇中挑選3個」；另加「樂行童軍獎章證書編號（必填）」 | 新制 PT/22（uploads/tc/forms/26001）逐列核對 |
| 4 | PT/22 簽署程序 | 「必修 社區服務(II)」等深資段；簽署人混用 | 依官方順序：3 提名（團長／旅印）→ 4 推薦（區總監／區印）→ 5 批核（青少年活動總監／署印）→ 6 推薦（地域總監／地域印） | 新制 PT/22 第 4–6 節 |
| 5 | PT/69（HEAD 4505–4550 分支） | 深資項目（童軍知識、社區服務(I)、個人興趣、認識世界、挑戰項目等，HEAD 4530–4541）；標題「PT/69 08/2018 最新」 | 7 段考驗計劃（`progressTicks:false`，不勾已完成、不預填日期）；申請獎章：☐ 樂行童軍獎章 ☐ 貝登堡獎章；簽署：申請人 → 團長（RSL／旅印）→ 助理區總監（樂行童軍）ADC(RS)（區印）→ 地域總部總監（樂行童軍）RHQC(RS)（地域印） | 新制 PT/69（uploads/tc/forms/15033）§3 |
| 6 | 表格「說明」字典（index.html 1332 / TSV 497） | `：完成全部7項 (4必修+3選修其中2)，…` | `：完成全部7項（樂行童軍獎章4項＋餘下3項），需區總監及地域總監接見推薦，每年9月15日前交總會，大會操頒發。` | 綱要 L4；PT/22 說明；官方 PT/22 §6 |
| 7 | i18n 字典 | `三選二`、`三選一剔號`（未被程式引用） | 已刪除；TSV 6 個舊鍵改名、46 列孤兒列刪除、17 鍵補入；以 `build_i18n.py --sync-dict` 同步（946 筆） | 殘留掃描 |
| 8 | 執委預設權限（Code.gs 474、1311、1616、1356；batch-onboard 145；index.html 4103、5009、5159；`permSetExecDefault`） | `L1,活動段章,OTHER`／`L1,L3-ACT,OTHER` | `L1,OTHER`，單一來源 `items.json → permissionDefaults.exec_committee`。注意：舊字串中的「活動段章」本來就不是任何現行代碼，實際放行的只有 L1 與 OTHER，因此**有效權限未變，只是去除殘留並統一來源** | 第五版段章代碼；`permissionDefaults` |
| 9 | 權限判斷（index.html HEAD 2361–2383 `canCurrentUserTickItem`） | `itemId.startsWith(a)` 前綴比對：權限 `L3-INT` 會錯誤放行 `L3-INTL-01／B` | `RoverScope.canTickItem`：精確比對 `*`／項目 ID／段章代碼／獎章 ID／`OTHER`；未知代碼不放行且原樣保留 | 修正真實缺陷（測試 `rover-scope.test.mjs` 覆蓋） |
| 10 | 權限選單與預設（index.html 權限 modal 及 `permSetExecDefault`） | 硬寫選項與段章 | 由 `RoverScope.permissionOptions(items)` 產生；段章勾選時子項目自動勾，儲存時剔除已被父層涵蓋的子項 | items.json |
| 11 | 表格與權限的 JS 實作 | 內嵌於 index.html（HEAD 4505 起的 `generatePrintableForm`，含三個深資分支） | 移至 `assets/rover-scope.js`、`assets/forms.js`（UMD，瀏覽器與 Node 共用）；index.html 以 `<script src>` 載入 | 可測試性（驗收 6） |
| 12 | 舊版 ID（HEAD 無獨立分類） | 未分類 | 新增 `legacy.label = 舊版紀錄／不計完成度`，列出 12 個舊 ID（如 `L1-UND-05`、`L1-01`、`L1-02`、`L2-SKILL-01`、`L3-SELF`、`L3-RESP` 等）；保留不刪；不計完成度；不出現於新表格；進度頁以卡片顯示 | 驗收 5 |
| 13 | items.json 與 items_en.json 的 `meta`、L3 `formLabel`／`completion`／`formSummary`、`trainingPlan`、`forms`、`legacyForms`、`permissionDefaults` | 舊結構 | 依第五版重寫；兩檔結構、ID、表格代碼完全對應（測試強制） | 綱要；官方表格 |
| 14 | items.json & items_en.json `safeFromHarm.hotlines` | 首位為 `2957 6414` | 首位新增 `2957 6411 / 2957 6417`（P022 列出的青少年活動署查詢電話）；`2957 6414` 保留（見 §4） | P022/2026 |
| 15 | items_en.json 兩條提示 | `Complete within the first month`（L1-ACT-01）；`New members should complete within 6 months`（L2-INTRO-01） | 已撤回（與 zh 版一致）；未經綱要核對，不應保留 | 未在綱要中找到依據 |
| 16 | Code.gs 第 74 行示例、第 1352 行註解 | `深資` 示例；舊版註解 | `其他支部`；註解改為指向 items.json | 殘留 |
| 17 | 表格連結（HEAD index.html 4849–4851） | PT/21、PT/22 連結指向舊制（第四版）PDF（`article_attach/23724`、`23723`），卻與 PT/69 新制連結並列為現行表格；HEAD 表格標題亦標示「最新」 | `RoverForms.officialLinksHtml`：新制三張表為主要連結；舊制三張以「舊制（第四版）· 僅供已依舊制考驗者參考」標示，**不由系統產生** | P022 過渡安排 |
| 17a | 表格版本標示（HEAD index.html 4519、4562、4602 標題） | 「PT/69 08/2018 最新」「PT/21 08/2022最新」「PT/22 08/2022最新」 | 不再以「最新」標示年份；以「第五版（新制）」標示，版本來源為官方 PDF 與 P022/2026 | 新制 PDF 無版本日期（已逐份核對）；舊日期屬於舊版標示 |
| 18 | docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md 第 167 行 | 「樂行是 PT/19 + PT/20，幼童軍是 PT/68，童軍是 PT/18，樂行是 PT/21/PT/22」（PT/19、PT/20 實為深資；PT/68、PT/18 未核對） | 「僅樂行已核對：新制 PT/21／PT/22／PT/69，舊制 PT/21／PT/22／PT/69；其他章節的表格代碼不在本檔核對範圍」（用戶指示：只核對樂行） | P022/2026；用戶指示 |
| 19 | docs/EXEC_GUIDE.md 8–9 行 | 「默認可考核：會員章 + 活動段章(細項不用勾) + 其他獎章逐個勾」 | 「會員章（L1）＋ 其他獎章（OTHER）；其餘獎章由團長／管理員逐個授權」 | 同上 |
| 20 | docs/LEADER_GUIDE.md 43–44、60–61 行 | 「管委默認 L1會員章 + L3活動段章 + OTHER部分」；「活動段章（細項不用）」；「段章完成日期、其他獎章」；只列 PT/21、PT/22 | 管委默認 L1 ＋ OTHER；可勾選範圍為獎章、段章或項目；列出 PT/21、PT/22、PT/69 新制格式；學制可按成員設定（新制／舊制／舊制過渡新制），舊制表格由系統產生（見第 23 項）| 同上 |
| 21 | docs/MEMBER_GUIDE.md 14、20 行 | 「PT/21(樂行童軍獎章)及PT/22(貝登堡獎章)」；「（例如童軍技能）」 | 加入 PT/69；「（例如「童軍技能」段章下的項目）」。注意：「童軍技能」本身是第五版合法段章名（L3-SCOUT），**不是殘留** | 綱要 L3 |
| 22 | docs/MAIN_SYSTEM_INTEGRATION.md 121 行 | 「官方 PT/19/PT/20 格式」 | 「新制官方 PT/21／PT/22／PT/69 格式」 | 同上 |
| 23 | 學制（index.html 進度頁、表格頁；Code.gs「學制設定」工作表；api/proxy.js） | 無學制概念；舊制 PT/21、22、69 只提供連結；成員無法選擇 | 每位成員可選 **新制**（`new`）／**舊制**（`old`）／**舊制過渡新制**（`transition`），預設新制；領袖可為他人設定，成員可改自己的。學制決定可勾項目：新制＝L1–L4＋OT；舊制＝L1、L2、S4-AWARD、S4-BP＋OT；過渡＝L1–L4＋OT（S4 只作對照，不自動計入）。表格：新制 PT/21、22、69；舊制 PT/21_OLD、22_OLD、69_OLD 由系統產生 | 用戶回覆：每位成員自行選擇（見 §4） |
| 24 | 後端權限（Code.gs `handleSave`、`handleSaveOtherBadge`、`handleRequestComplete`、`handleReviewRequest`） | 只檢查角色 `canUserTick(role)`；`allowed_badges` 只在前端判斷，直接呼叫 GAS 可繞過 | 後端以 token 識別操作者，檢查角色＋`allowed_badges`（與前端 `canCurrentUserTickItem` 同一規則，見 `ITEM_CATALOG_`）＋該成員學制；**整批任何一項違規則整批拒絕，零寫入**。審核員只可審核其範圍內的項目 | 用戶要求後端強制執行 |
| 25 | 代理層 APIKEY（api/proxy.js 轉發每個請求時附上旅團 APIKEY） | （草稿若只看 APIKEY，會被代理層繞過：所有經代理的請求都會帶 APIKEY） | 身分**以 token 為準**：帶 token 必須有效且對應用戶存在（否則拒絕）；只有有效 APIKEY 而無 token 才視為系統操作（只檢查學制） | 本次自行發現並修正；測試見 `allowed-badges`「代理層情境」 |
| 26 | 代理層動作白名單（api/proxy.js `TOKEN_ACTIONS`） | 沒有 `setScheme`；前端學制選擇會收到「不支援的操作」（400） | 加入 `setScheme`（需 token）；`LINK_SIG_SUPPORTED` 同步加入 | 測試 `proxy-actions`：前端每個 `apiRequest('…')` 都必須被代理層接受 |
| 27 | 進度頁「舊制 → 新制過渡對照」（index.html `renderTransitionPanel`） | 無 | 只在過渡成員的進度頁出現；列出每項舊制紀錄與對應的新制項目（P022 對照表）；只有單一對應或「全部對應」時才提供「加入待儲存」按鈕，**不自動計入完成度**，儲存前須核實 | P022/2026 第四→五版對照表（`legacyTransition`） |
| 28 | 選修段章（segment header） | 只顯示「完成數／總數」 | 選修段章顯示「須選 N 項」（舊制 S4-AWARD-ELECT 須選 1；S4-BP-ELECT 須選 2）；完成判斷按選取數量 | 舊制 PT/21 選 1、PT/22 選 2 |
| 29 | 表格頁（index.html `renderFormsTab`） | 成員下拉選單會重置（呼叫 `renderFormsTab()` 時未更新 `selectedProgressYmis`）；舊制卡片寫「只提供連結」 | 選擇會保留（`onFormMemberChange`）；表格按鈕依成員學制產生；舊制卡片說明學制及產生方式 | 測試 `scheme-dom-test` |
| 30 | 舊制 S4 ID（items.json `oldBadges`） | `S4-AW-KNOW`、`S4-AW-SVC1A`、`S4-BP-SVC2`、`S4-BP-CHAL` 等縮寫，與段章代碼不一致 | `S4-AWARD-CORE-01…04`、`S4-AWARD-ELECT-01…03`、`S4-BP-CORE-01…03`、`S4-BP-ELECT-01…03`；前綴與所屬段章代碼一致。全 repo 已無舊 S4 ID | 用戶允許改名（尚無用戶） |
| 31 | L3 國際視野及挑戰 ID（items.json、測試） | `L3-INTL-A`／`L3-INTL-B`、`L3-CHALLENGE-A`／`L3-CHALLENGE-B` | `L3-INTL-01`／`-02`、`L3-CHALLENGE-01`／`-02` | 用戶授權改名；§4 原「未改名」項已解決 |
| 32 | 測試夾具（tests/troop_link、tests/security 等） | 以 `itemId: 'L1'`（獎章 ID）寫入進度 | 改為真實項目 ID `L1-ACT-01` | 後端現在會驗證項目 ID，未知 ID 會被拒絕（這是**收緊**，不是放寬）；測試期望值同步更新 |
| 33 | docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md 表格代碼（第 69、159、167 行）| 「幼童軍 PT/68」「童軍 PT/18」「PT/19 + PT/20」；PDF 生成器說明寫「PT/19／PT/20」 | 只保留樂行：新制及舊制 PT/21、PT/22、PT/69；註明其他章節不在本檔核對範圍 | 用戶指示：只核對樂行 |
| 34 | items.json / items_en.json L4 描述（貝登堡獎章時限） | 「需12-18個月，平均18個月以上。」（英文：Average completion time: 12-18 months (18 months+ on average overall)） | 「平均於12至18個月內完成。」（英文：Average completion time: 12 to 18 months） | 綱要 p.14「平均於12至18個月內完成」（貝登堡獎章） |
| 35 | items.json L2 描述（肩章簽發人） | 「區長/助理區總監(樂行)/總部總監確認簽發」（缺助理總部總監） | 「樂行童軍區長／助理區總監（樂行童軍）／助理總部總監（樂行童軍）／總部總監（樂行童軍）確認及簽發」（英文版本已有四個職級） | 綱要 p.18 肩章考核流程 |
| 36 | 官方表格：PT/75（延長考取支部最高獎章期限申請表） | 無；APP 不提供此連結 | 新增 `relatedForms.PT75`，於表格頁官方連結區（資料頁）顯示；中英文資料一致 | 官方表格索引（type=8）列出「幼童軍、童軍、深資童軍、樂行童軍」適用，https://www.scout.org.hk/uploads/tc/forms/12470/PT75.pdf |
| 37 | 進度頁 L3 樂行童軍獎章（獲頒條件） | 進度頁只顯示「已完成項目數／15」，不顯示 7 段中完成幾段，樂行成員無從得知是否符合獲頒條件 | 新增 `awardRule`（7 段中 4 段）；獎章標題顯示「段章 X/7（需 4 段）」，達標時顯示「🏅 段章 X/7：已符合獲頒條件」（實際簽發以總會為準）。段章是否完成沿用 `segmentDone`（任選段章按 completion 規則） | 綱要 p.14、p.19 |
| 38 | 可勾選（`can_tick`）撤銷（團長決定：撤銷後不可勾選、審批或直接編輯，即使角色為領袖） | 只有日誌記錄檢查 `can_tick`（saveLogRecord、deleteLogRecord）；進度勾選（save）、其他獎章（saveOtherBadge）、審批（reviewRequest、reviewLogRequest）、待審清單與學制（setScheme，為他人）只看角色，撤銷後仍可勾選 | Code.gs 統一 `canTickUser_(u)`（角色 ∧ `can_tick===true`），用於 save、saveOtherBadge、reviewRequest、reviewLogRequest、saveLogRecord、deleteLogRecord、getPendingLogRequests、setScheme（為他人）；超管旁路保留於項目層。index.html 統一 `canTickNow()`，用於進度核取框、OT 核取框與按鈕、日誌編輯、審批按鈕。檢視不受影響。測試：`tests/can-tick.test.mjs`（12）、`tests/can-tick-dom-test.mjs`（8）；以變異測試確認測試會因移除檢查而失敗 |
| 39 | GAS addUser／addMember 的 APIKEY 後備（apps-script/Code.gs 約 1250、1257 行） | `if(!mgr && body.apikey===getApiKey()) mgr={role:'admin'}`，`const mgr` 被重新賦值，每次拋出 TypeError；addMember 對無效 token 放行。代理層每個 POST 附上 APIKEY，故若修好 const 錯誤會讓任何帶 token 字串的請求成為管理員 | 只在「完全沒有 token」且 APIKEY 有效時視為系統（`let mgr`＋`!body.token`）；無效 token 一律拒絕（移除 addMember 的例外）。批量開戶方法 A 恢復運作。`tests/apikey-admin.test.mjs` |
| 40 | 舊制 PT/21 表格（上傳 `pt21.pdf`，FORM PT/21 4/2019）（items.json／items_en.json `oldForms.PT21_OLD`） | 第四輪寫成「審核員姓名 Name of Assessor」；推薦欄標題「區會（推薦）」；推薦簽署「區指定人士」；批核、確認欄標為「地域總部」「青少年活動總監」 | 欄位改回表格原文「審核員 Assessor」（第四輪的改動有誤，已撤回）；第 5 格「推薦 Recommendation」，簽署「助理區總監（樂行童軍）／樂行童軍區長／區代表」（表格方格原文，程序段落寫「區指定人士」，見 §4）；第 6 格「批核 Approval」；第 7 格「確認 Confirmation」 | 兩份資料檔同步 |
| 41 | 舊制 PT/69 2024 表格（上傳 `pt69_2024.pdf`，FORM PT/69 1/2024）（`oldForms.PT69_OLD`） | 階段標題為意譯（「團長提名」「區會（樂行）」「地域總部」）；「認識世界」「挑戰項目」沒有表格上的預印選項 | 階段標題改為表格節名：「申請人簽署」「同意」「知會區會」「批核」；加入預印選項：認識世界（境外體驗／本地交流），挑戰項目（個人挑戰／野外挑戰） | 兩份資料檔同步 |
| 42 | 其他獎章 OT（items.json／items_en.json `otherBadges`，15 項） | 英文名稱與綱要不符：Helmsman、Senior Airman、Flying Badge、Parachuting Badge、Catholic Badge、World Scout Heritage、Life Saving；童軍世界遺產章說明為「WOSM世界遺產相關徽章」；多數項目說明只有數字或「XX 相關」；缺少佩戴規則、簽發人、購買或領取文件 | 名稱依綱要第三、四章：Advance Aircrew Badge、Coxswain Badge、Scout Wings、Scout Canopy Wings、Patrimonito Scout Badge、Scout Lifesaving Badge、Kiro Badge（公教章）；說明與佩戴規則（飛行章與跳傘章不可同時佩戴、公教章與宗教章位置相同只能擇一、AYP 金章優先且佩於左袖）、積極公民五項、社區參與章 6 個月與 7 個課題、宗教章 6 種課程、簽發（綱要第五章）、購買或領取文件。id 不變 | 中英同步；英文名稱依英文綱要 |
| 43 | L2 樂行童軍啟導班（`L2-INTRO-01` detail）與 L3 獎章說明（`badges[2].description`） | 啟導班只寫「見附錄」；L3 說明未提樂行童軍獎章的簽發流程 | 啟導班加入對象與內容（綱要附錄 p.57）；L3 加入「經區會確認及推薦，地域審批，總會確認及簽發」（綱要 p.19，英文版同意）。**綱要內部不一致**，見 §4 | 中英同步 |

---

## 3. 檢查後保留（不是殘留）

| 項目 | 理由 |
|---|---|
| `ADC(RS)`、`RHQC(RS)`、地域總部總監（樂行童軍） | 新制 PT/21、PT/69 的官方簽署人名稱 |
| 審核員 Assessor | 新制 PT/21、PT/22 的官方欄位名稱 |
| 童軍技能 | 第五版 L3-SCOUT 段章的正式名稱 |
| `legacyTransition` 內的「童軍技能（I）」、「社區服務」、「個人興趣」等舊名 | 這是 P022/2026 第四版→第五版的對照表，必須保留；已與 `items_en.json` 逐項相等（測試） |
| OT-* 其他獎章的甲／乙標籤 | 屬其他獎章自身結構，與本支部綱要的甲／乙（國際視野、挑戰）是不同層級 |
| 必修（徽章標籤）、選修（通用字典） | 「必修」用於 `mandatory` 徽章標示（保護兒童）；「選修」僅剩一個未引用的通用字典條目 |
| `api/_admin.js`、`api/portal.js`、`api/troops.js`、Code.gs 第 45、668、799 行 VSBADGE／深資 註解、CHANGE_LOG、APP_ADMIN_WORKFLOW、VERCEL_ENV_SETUP | 架構與姊妹系統的說明，不是表格或數據殘留 |
| `tests/troop_link.test.mjs` 第 82 旅深資 | 測試夾具（fixture）資料，不影響產品內容 |
| `.vercel/` | gitignored 舊建置副本，不是來源 |

---

## 4. 未驗證／待決事項

| 項目 | 狀態 | 建議／處理 |
|---|---|---|
| 熱線 `2957 6414` | **已解決**：用戶確認為青少年活動署電話；標示「童軍總會 青少年活動署」 | — |
| `L1-01`、`L1-02` 舊名「舊版 ID（童軍知識）」 | 名稱未與舊制 PT/21 逐項核對 | 核對舊制紀錄冊後修正名稱（ID 不變） |
| 佩戴指引日期標籤「2024-04-01起」 | 未核對，維持原樣 | 對照通告 37/2024 |
| `items.json` L4 描述「需12-18個月，平均18個月以上」 | **已解決（第二輪）**：綱要 p.14 為「平均於12至18個月內完成」，已改為同一文字（§2 第 34 項） | — |
| 舊制 PT/21、PT/22、PT/69 的文字（`oldForms`） | 第四輪前的版本是依網上抓取的 PDF 核對。第五輪以使用者上傳的 `pt21.pdf`、`pt22.pdf`、`pt69_2024.pdf` 重新逐字核對 | ✅ **已逐字核對（第五輪）**：PT/22 原本已與表格一致（欄位、規則、9 月 15 日、階段）。PT/21、PT/69 的修正見 §2 第 40、41 項。第四輪把 PT/21 審核員欄改為「審核員姓名」是錯的，已撤回。 |
| 首次登入後的過渡選擇（新制／舊制） | **已解決**：用戶選擇「每位成員各自選擇新制／舊制／舊制過渡新制」，已實作（§2 第 23 項） | — |
| `L3-INTL-*`、`L3-CHALLENGE-*` ID 與段章代碼不一致 | **已解決**：用戶授權改名，改為 `-01`／`-02`（§2 第 31 項） | — |
| `allowed_badges` 只在前端判斷 | **已解決**：後端強制（§2 第 24 項） | — |
| 學制的資格（宣誓日期） | **已決定（用戶）**：系統不檢查宣誓日期，由旅團自行處理 | — |
| 後端 `can_tick` 旗標（「可勾選」） | **已解決（團長決定：撤銷即全面生效）**：見 §2 第 38 項 | 部署前確認 users 工作表第 7 欄（`can_tick`）為 TRUE／FALSE；空白視為不可勾選（若現有領袖此欄為空白，須先設為 TRUE） |
| Apps Script 語法 | `node --check` 無法解析 `.gs`；後端由 `tests/gas-harness.mjs` 實際執行驗證 | 上線前在 Apps Script 編輯器實測 |
| 代理層 APIKEY | 原：`api/proxy.js` 每個 POST 均附上旅團 APIKEY；GAS 的 addUser／addMember 以 APIKEY 後備提升為 admin，但 `const mgr` 重新賦值使其拋出 TypeError（失敗關閉，同時批量開戶方法 A 亦已壞掉）。 | **已解決（用戶選擇 A）**：刪除「APIKEY 即管理員」的後備；只有「完全沒有 token ＋ 有效 APIKEY」才視為系統操作（批量開戶方法 A 保留）；帶任何 token 一律以 token 判斷，無效即拒絕。代理層仍附上 APIKEY（收窄為只附於無 token 請求留待後續，未做）。`tests/apikey-admin.test.mjs`（6 項）。 |
| 學制未套用於總覽、按項目、矩陣頁 | **已決定（用戶）**：不擴展。舊制成員沒有 S4 獎章紀錄，這三頁顯示 S4 沒有實際用途 | — |
| 瀏覽器端到端 | jsdom 測試覆蓋學制 UI（`scheme-dom-test`）；未與真實 Apps Script 後端連線測試 | 上線前實測 |
| 綱要內部不一致：樂行童軍肩章的簽發人 | 第二章 p.18 寫「樂行童軍區長／助理區總監（樂行童軍）／助理總部總監（樂行童軍）／總部總監（樂行童軍）確認及簽發」；第五章 p.48 寫「童軍區：區總監、助理區總監（樂行童軍）、樂行童軍區長或區總監指定人士；地域；青少年活動署」 | APP 依第二章文字（L2 說明）；未改。**需要使用者決定以哪一章為準** |
| 綱要內部不一致：啟導班對象年齡 | 中文附錄 p.57 寫「17 歲或以上之深資童軍」；英文附錄寫「Venture Scouts who are aged 18 or above」 | 中文版寫 17 歲，英文版寫 18 歲；L2 detail 中英文各按原文。**需要使用者決定** |
| 第五章簽發人表、第六章宣誓流程、錦標賽、第一章制服表 | 不屬於進度獎章的資料；APP 沒有這些功能（典禮流程僅為參考） | 未收錄。若要收錄，需另行決定範圍 |

## 5. 官方來源（連結）

| 文件 | 連結 | 用途 |
|---|---|---|
| 第五版《樂行童軍訓練綱要》（中文，2026年2月） | https://drive.google.com/file/d/16DQ-MhjRp3LU5Im3IoeJQGqi0Rhgx0iw/view | 權威：段章、項目、簽署流程 |
| 第五版（英文） | https://drive.google.com/file/d/1l-TVstxy94F526DEFN8M7BIYBFhL2p-A/view | 英文用語核對 |
| 樂行資訊網 | https://sites.google.com/view/hong-kong-rover-scout/ | 紀錄冊、通告來源 |
| P022/2026 新修訂支部訓練綱要通告 | https://www.scout.org.hk/uploads/tc/circulars/23585/p022-26.pdf | 第五版生效日期（2026-08-15）、過渡期、四→五版對照 |
| 新制 PT/21 | https://www.scout.org.hk/uploads/tc/forms/25998/PT21.pdf | 表格結構、簽署流程 |
| 新制 PT/22 | https://www.scout.org.hk/uploads/tc/forms/26001/PT22.pdf | 8 列結構、急救證書編號、9月15日 |
| 新制 PT/69 | https://www.scout.org.hk/uploads/tc/forms/15033/PT69.pdf | 考驗計劃、申請獎章、簽署流程 |
| 舊制 PT/21（第四版） | https://www.scout.org.hk/article_attach/23724/PT21.pdf | 僅對照，不產生 |
| 舊制 PT/22（第四版） | https://www.scout.org.hk/article_attach/23723/PT22.pdf | 僅對照，不產生 |
| 舊制 PT/69（2024） | https://www.scout.org.hk/uploads/tc/forms/26139/PT69_2024.pdf | 僅對照，不產生 |
| 表格索引 | https://www.scout.org.hk/tc/circulars-forms/forms/index.html?type=8 | 所有表格版本入口 |
| 延長考取支部最高獎章期限（PT/75） | https://www.scout.org.hk/uploads/tc/forms/12470/PT75.pdf | 官方索引列出幼童軍、童軍、深資童軍、樂行童軍適用（第 36 項） |

---

## 6. 驗證

| 驗證 | 結果 |
|---|---|
| `npm run check` | 73 通過 / 0 失敗（修正前 58 / 0） |
| `npm test` | 結束碼 0；所有既有測試通過；新增測試已加入指令鏈 |
| `tests/rover-scope.test.mjs` | 20 項：權限精確比對、前綴誤判修正、舊版紀錄依學制、學制目錄、選修「須選 N 項」、權限選單 |
| `tests/forms-generator.test.mjs` | 14 項：PT/21 七段、PT/22 八列與急救證書編號、PT/69 不勾選不預填、簽署人來自 items.json、舊制表格、非法段章／項目拋錯 |
| `tests/residue-audit.test.mjs` | 10 項：殘留掃描、items.json 與 items_en.json 結構一致、舊 ID 標示、Code.gs 與 index.html 無寫死清單 |
| `tests/catalog-sync.test.mjs` | 6 項：`ITEM_CATALOG_`／`DEFAULT_PERMS_` 與 items.json 一致（`scripts/gen-backend-catalog.mjs --check`） |
| `tests/allowed-badges.test.mjs` | 15 項：後端 allowed_badges 強制、批次原子拒絕、審核範圍、學制強制、代理層情境（APIKEY＋token）、無效 token 拒絕 |
| `tests/proxy-actions.test.mjs` | 2 項：前端每個 `apiRequest` 動作都被代理層接受；`setScheme` 需 token |
| `tests/scheme-dom-test.mjs` | 10 項（需 jsdom，未安裝時跳過）：過渡／舊制／新制進度頁、學制選擇器、成員本人可改、表格按鈕、成員切換不重置、無腳本錯誤。已在 jsdom 24 下實際執行通過 |
| `tests/troop_link.test.mjs`、`tests/security.test.mjs` | 夾具改為真實項目 ID（§2 第 32 項）；斷言與權限邏輯未放寬 |

**Node harness 輸出樣本**：`/tmp/audit/forms-out/`（測試用假資料，非真實成員）。

---

## 7. 樂行童軍支部配套核對（第二輪，2026-10-23）

用戶要求：核對整個 APP 是否配套樂行童軍支部，而非只看表格代碼。依第五版《樂行童軍訓練綱要》（中文，2026年2月）逐章比對。

| 範圍 | 綱要 | APP 現況 | 結果 |
|---|---|---|---|
| 年齡 | 18–25 歲；滿 26 歲當日身分結束（綱要 p.8） | 只見於 trainingPlan 說明；不做年齡檢查 | 文字一致；不做檢查（如需要另議） |
| 會員章（L1） | 活動 1、理解 4、禮節 6、許諾 1、保護童軍課程 1，共 13 項（pp.15–17） | 13 項，段章與項目一致 | ✅ 一致 |
| 肩章（L2） | 啟導班或同等項目；團長批核推薦，區長／助理區總監／助理總部總監／總部總監確認簽發（p.18） | 1 項；簽發人文字已修正（第 35 項） | ✅ 修正後一致 |
| 獎章（L3） | 7 段：準領袖培訓、童軍技能、服務、國際視野、興趣及技能、身心健康、挑戰；完成 7 段中 4 段即可獲頒（pp.19–27） | 7 段、15 項一致；國際視野與挑戰為甲或乙；獲頒條件原先未顯示 | ✅ 修正（第 37 項） |
| 貝登堡獎章（L4） | 完成全部 7 項；區總監及地域總監接見及推薦；總會審批簽發；平均 12–18 個月（pp.14、19） | 3 項一致；時限文字已修正（第 34 項） | ✅ 修正後一致 |
| 考驗細節 | 準領袖培訓（木章 1、2 階段或服務童軍旅 12 個月／52 小時）；童軍技能（3 項）；服務（急救證書有效、探索課程、自願服務）；國際視野（甲 6 個月、乙 5 日 4 夜）；興趣（12 個月 52 小時，非體育）；身心健康（SOUL Keeper 50 小時、體育 12 個月 52 小時）；挑戰（甲 3 日 2 夜、乙個人挑戰） | 逐項比對，數字與條件一致 | ✅ 一致 |
| 其他獎章（OT） | 寰宇童軍章、地球部落、童軍世界遺產章、急救章、拯溺布章、高級空勤員章、舵手章、飛行章、跳傘章、積極公民系列、社區參與章、宗教章、公教章、AYP 金章／銀章（第三、四章） | 14 項全部存在 | ✅ 一致（樂行先修章只在 L2 說明中提及） |
| 官方表格（新制） | PT/21、PT/22、PT/69（P022 及索引） | 三張表格、簽署流程、按鈕與連結一致 | ✅ 一致（見 §2 第 2–5 項） |
| 官方表格（舊制） | 舊制 PT/21、PT/22、PT/69（第四版／2024 版） | 由系統產生；三份已對照使用者上傳的 PDF（第五輪）並修正 | ✅ 見 §2 第 40、41 項 |
| 延長期限 | PT/75（官方索引列出樂行童軍適用） | 新增連結（第 36 項） | ✅ 已補 |
| 熱線 | P022 列出青少年活動署查詢電話 2957 6411／6417；2957 6414 經用戶確認為署電話 | 兩組皆保留，標示為青少年活動署 | ✅ 已核 |
| 保護童軍課程日期 | 綱要只寫「網上自學課程」，未寫日期 | APP 寫「2025年7月1日起」，出處未核實 | ⚠️ 未核實，建議查通告後保留或刪除 |
| 版本標示 | 綱要：第五版（2026年2月） | 第三輪前：頁面標題寫「v5.1」，資料檔 meta 寫「5.0 Rover」 | ✅ **已解決（用戶選擇 v5.2）**：標題、頁首、副標、頁尾、「最新」卡片、items 與 package 版號統一為 v5.2；v5.1 更新說明保留為歷史段 |
| 其他支部文字 | — | 使用者介面與資料中無深資、幼童軍、童軍獎章等殘留（只剩架構註解） | ✅ 已清理 |
| 未核對範圍 | 綱要第一至第六章與附錄（上傳的中英文 PDF，第 1–64 頁） | **第五輪已全部讀完**（中文 1–60 頁、英文 1–64 頁，無需再透過網頁抓取）。結果：第一章組織規條（年齡 18–25、團最低標準、領袖資格）與制服表——APP 不列出，只引用「制服手冊」，屬於組織規條，不在 APP 範圍；第二章、第三章——已與 APP 逐項吻合；第四章 OT——名稱與要求已依綱要修正（§2 第 42 項）；第五章簽發與領取——已摘要寫入 OT 的說明（§2 第 42 項），完整簽發人表未逐一列出；第六章宣誓儀式、錦標賽、啟導班概要——不屬於 APP 的進度獎章資料，未收錄（見 §4）。 |

### `can_tick` 說明

- `can_tick` 是用戶的「可勾選」欄位（users 工作表第 7 欄），管理頁有「授權勾選／收回權限」按鈕。
- 現況（第三輪修正）：撤銷後不可勾選進度、審批、其他獎章、日誌新增／刪除、學制（為他人），仍可查看。見 §2 第 38 項。
