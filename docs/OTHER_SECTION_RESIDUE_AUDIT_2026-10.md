# 其他章節殘留審計（樂行童軍支部，2026-10）

> 本文件記錄 `roverbadge` 由 VSBADGE（深資童軍支部）骨架複製時混入的其他章節殘留，
> 以及每項修正的「修正前 → 修正後」。權威來源只採用本支部現行《樂行童軍訓練綱要》（第五版，2026年2月）
> 與香港童軍總會樂行支部的官方表格（新制）。

---

## 0. 範圍、方法與一項說明

- **範圍**：整個 repo，包括 `index.html`、`apps-script/Code.gs`、`assets/`、`api/`、`data/`、`i18n_dict.tsv`、`docs/`、`tests/`、`CHANGE_LOG.md` 及其他根目錄文件。`.vercel/` 為 gitignored 的舊建置副本，不作為來源，已排除。
- **關於「第 3 節 grep 清單」**：用戶訊息及 repo 內**都沒有**這份清單。已搜尋 `*.md`（`grep "grep"`），只有 `VERCEL_ENV_SETUP.md:231` 提及 grep 這個詞，並非清單。因此本次清單是**獨立建立**的（見 §1）。
- **權威來源**：見 §5 官方連結。舊制（第四版）表格只用於對照，不用於產生新表格。

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
| 9 | 權限判斷（index.html HEAD 2361–2383 `canCurrentUserTickItem`） | `itemId.startsWith(a)` 前綴比對：權限 `L3-INT` 會錯誤放行 `L3-INTL-A／B` | `RoverScope.canTickItem`：精確比對 `*`／項目 ID／段章代碼／獎章 ID／`OTHER`；未知代碼不放行且原樣保留 | 修正真實缺陷（測試 `rover-scope.test.mjs` 覆蓋） |
| 10 | 權限選單與預設（index.html 權限 modal 及 `permSetExecDefault`） | 硬寫選項與段章 | 由 `RoverScope.permissionOptions(items)` 產生；段章勾選時子項目自動勾，儲存時剔除已被父層涵蓋的子項 | items.json |
| 11 | 表格與權限的 JS 實作 | 內嵌於 index.html（HEAD 4505 起的 `generatePrintableForm`，含三個深資分支） | 移至 `assets/rover-scope.js`、`assets/forms.js`（UMD，瀏覽器與 Node 共用）；index.html 以 `<script src>` 載入 | 可測試性（驗收 6） |
| 12 | 舊版 ID（HEAD 無獨立分類） | 未分類 | 新增 `legacy.label = 舊版紀錄／不計完成度`，列出 12 個舊 ID（如 `L1-UND-05`、`L1-01`、`L1-02`、`L2-SKILL-01`、`L3-SELF`、`L3-RESP` 等）；保留不刪；不計完成度；不出現於新表格；進度頁以卡片顯示 | 驗收 5 |
| 13 | items.json 與 items_en.json 的 `meta`、L3 `formLabel`／`completion`／`formSummary`、`trainingPlan`、`forms`、`legacyForms`、`permissionDefaults` | 舊結構 | 依第五版重寫；兩檔結構、ID、表格代碼完全對應（測試強制） | 綱要；官方表格 |
| 14 | items.json & items_en.json `safeFromHarm.hotlines` | 首位為 `2957 6414` | 首位新增 `2957 6411 / 2957 6417`（P022 列出的青少年活動署查詢電話）；`2957 6414` 保留（見 §4） | P022/2026 |
| 15 | items_en.json 兩條提示 | `Complete within the first month`（L1-ACT-01）；`New members should complete within 6 months`（L2-INTRO-01） | 已撤回（與 zh 版一致）；未經綱要核對，不應保留 | 未在綱要中找到依據 |
| 16 | Code.gs 第 74 行示例、第 1352 行註解 | `深資` 示例；舊版註解 | `其他支部`；註解改為指向 items.json | 殘留 |
| 17 | 表格連結（HEAD index.html 4849–4851） | PT/21、PT/22 連結指向舊制（第四版）PDF（`article_attach/23724`、`23723`），卻與 PT/69 新制連結並列為現行表格；HEAD 表格標題亦標示「最新」 | `RoverForms.officialLinksHtml`：新制三張表為主要連結；舊制三張以「舊制（第四版）· 僅供已依舊制考驗者參考」標示，**不由系統產生** | P022 過渡安排 |
| 17a | 表格版本標示（HEAD index.html 4519、4562、4602 標題） | 「PT/69 08/2018 最新」「PT/21 08/2022最新」「PT/22 08/2022最新」 | 不再以「最新」標示年份；以「第五版（新制）」標示，版本來源為官方 PDF 與 P022/2026 | 新制 PDF 無版本日期（已逐份核對）；舊日期屬於舊版標示 |
| 18 | docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md 第 167 行 | 「樂行是 PT/19 + PT/20，幼童軍是 PT/68，童軍是 PT/18，樂行是 PT/21/PT/22」（PT/19、PT/20 實為深資；PT/68、PT/18 未核對） | 「深資 PT/19 + PT/20（P022/2026 所列）；樂行 PT/21／PT/22／PT/69（新制）；幼童軍及童軍的表格代碼未於本次核對，請各章節自行對照綱要後填寫」 | P022/2026 |
| 19 | docs/EXEC_GUIDE.md 8–9 行 | 「默認可考核：會員章 + 活動段章(細項不用勾) + 其他獎章逐個勾」 | 「會員章（L1）＋ 其他獎章（OTHER）；其餘獎章由團長／管理員逐個授權」 | 同上 |
| 20 | docs/LEADER_GUIDE.md 43–44、60–61 行 | 「管委默認 L1會員章 + L3活動段章 + OTHER部分」；「活動段章（細項不用）」；「段章完成日期、其他獎章」；只列 PT/21、PT/22 | 管委默認 L1 ＋ OTHER；可勾選範圍為獎章、段章或項目；列出 PT/21、PT/22、PT/69 新制格式，舊制只提供連結 | 同上 |
| 21 | docs/MEMBER_GUIDE.md 14、20 行 | 「PT/21(樂行童軍獎章)及PT/22(貝登堡獎章)」；「（例如童軍技能）」 | 加入 PT/69；「（例如「童軍技能」段章下的項目）」。注意：「童軍技能」本身是第五版合法段章名（L3-SCOUT），**不是殘留** | 綱要 L3 |
| 22 | docs/MAIN_SYSTEM_INTEGRATION.md 121 行 | 「官方 PT/19/PT/20 格式」 | 「新制官方 PT/21／PT/22／PT/69 格式」 | 同上 |

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

| 項目 | 狀態 | 建議 |
|---|---|---|
| 熱線 `2957 6414` | 未在 P022 找到，仍保留 | 向青少年活動署查證後刪除或保留 |
| `L1-01`、`L1-02` 舊名「舊版 ID（童軍知識）」 | 名稱未與舊制 PT/21 逐項核對 | 核對舊制紀錄冊後修正名稱（ID 不變） |
| 佩戴指引日期標籤「2024-04-01起」 | 未核對，維持原樣 | 對照通告 37/2024 |
| `items.json` L4 描述「需12-18個月，平均18個月以上」 | 時限用語未在綱要 chunk 中核實 | 以第五版綱要原文核對 |
| 首次登入後的過渡選擇（新制／舊制） | **待用戶決定**（見下） | — |
| `L3-INTL-A／B`、`L3-CHAL-A／B` 的 ID 慣例與段章代碼不一致 | 已標記，未改名（改名會破壞既有儲存資料） | 另做資料遷移計劃 |
| `allowed_badges` 只在前端判斷，後端 `canUserTick`（Code.gs 約 636 行）只看角色 | **安全缺口，未修**，屬後端改動 | 另開 PR 在後端強制執行 |
| 瀏覽器測試 | 已用 jsdom 冒煙測試（見 §6）；未做有後端的端到端測試 | 上線前在 Apps Script 環境實測 |

**待用戶決定**：P022/2026 容許 2026-08-15 前入會的成員，在 2029-08-14 前選擇舊制或新制。目前系統只產生新制表格，舊制只提供連結。請問需要：
(a) 只支援新制；或
(b) 依成員入會日期，同時支援新制與舊制（舊制需另建 PT/21／22／69 的產生器）。

---

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

---

## 6. 驗證

| 驗證 | 結果 |
|---|---|
| `npm run check` | 65 通過 / 0 失敗（修正前 58 / 0） |
| `npm test` | 結束碼 0；原有測試全部通過（未刪除任何既有測試），並新增三個測試檔並加入 `npm test` 指令鏈 |
| 新增 `tests/rover-scope.test.mjs` | 權限精確比對、前綴誤判修正、舊版紀錄不計完成度、完成度「任選一」、首頁摘要 |
| 新增 `tests/forms-generator.test.mjs` | 以 Node harness 實際執行 `assets/forms.js`：PT/21 七段、PT/22 八列與急救證書編號、PT/69 不勾選不預填、簽署人來自 items.json、舊制不可產生、非法段章／項目會拋錯 |
| 新增 `tests/residue-audit.test.mjs` | 殘留掃描（排除舊版子樹）、items.json 與 items_en.json 結構一致、舊 ID 標示、Code.gs 與 index.html 無寫死清單 |
| 瀏覽器冒煙測試（jsdom，/tmp，未加入 repo） | 首頁 4 個方塊由 items.json 產生；進度頁顯示舊版紀錄卡（含 L1-01）；表格頁 3 個按鈕；PT/21 依進度正確勾選 2 段（LEADER、SERVICE）；PT/69 無勾選 |

**Node harness 輸出樣本**（`/tmp/audit/forms-out/`，測試用假資料，非真實成員）：PT/21 4011 字元；PT/22 4480 字元；PT/69 3319 字元。
