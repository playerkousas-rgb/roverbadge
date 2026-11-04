# ROVERBOOK ⇄ ROVERBADGE 對接（GS 5.4.0，2026-11-04）

> **一句話**：ROVERBOOK 是成員自己手機上的紀錄冊（前端）；ROVERBADGE 是領袖統管（後端）。
> 兩者只交換**進度**。成員的姓名以外個人資料（電話、電郵、地址、出生日期、相片、簽名墨跡、
> 緊急聯絡人）**永遠留在成員自己部機，唔會上傳、唔會寫入任何 Google Sheet**。

---

## 1. 三條鐵律

| # | 鐵律 | 在程式裡怎樣保證 |
| --- | --- | --- |
| ① | **個資只留成員手機** | `assets/roverbook-bridge.js` 的 `fromRoverBook()` 只取 `scoutId`／`itemId`／`date`／`assessor`；其餘欄位（`NEVER_TRANSFER_FIELDS`）即場剝走並回報 `privacy.removedFields`。GAS 端 `handleBookSync()` 再剝一次（兩道防線），`bookStripPersonal_()` 掃描整個請求物件。 |
| ② | **ROVERBADGE 只記進度** | 新工作表「紀錄冊核簽」只有 10 欄：簽核編號／SCOUT ID／項目 ID／完成日期／核簽領袖／職銜／核簽日期／來源／寫入時間／備註。冇電話、冇電郵、冇地址、冇相片、冇墨跡。 |
| ③ | **頒發只由領袖一次過做** | `bookAward` 需要「可勾選的領袖」權限，可以一次 submit 多成員多獎章；成員只能用 `bookPull` 取回唯讀結果。 |

三條都寫成測試：`tests/roverbook-bridge.test.mjs`（17 項）。其中一項會把整份模擬紀錄冊
（滿載個資）餵入，然後掃描「所有工作表、所有儲存格」，確認任何一個個人資料值都冇出現。

## 2. 誰在什麼時候用什麼

```
成員手機（ROVERBOOK）                     領袖（ROVERBADGE）
─────────────────────────                ─────────────────────────
逐頁填寫、簽名、離線可用                  一次過看全團、簽核、頒發
localStorage（只在自己部機）               Google Sheet（旅團自己擁有）

        ── 進度／核簽（bookSync）──────▶   寫入「紀錄冊核簽」
        ◀── 進度／頒發（bookPull）────     讀「進度追蹤」＋「紀錄冊頒發」

        ── 領袖一次過頒發（bookAward）──▶  寫入「紀錄冊頒發」
```

- 成員**永遠唔需要**帳號去用 ROVERBOOK（本機就是他的資料）。
- 成員只在想「交進度給領袖」或「取回頒發結果」時才需要 BADGE 帳號（`bookPull` 用 token 認人，
  只回自己那行；不接受任意 SCOUT ID）。

## 3. 介面（格式版本）

| 格式 | 方向 | 內容 | 個資 |
| --- | --- | --- | --- |
| `roverbadge.progress.v1` | BOOK → BADGE | 舊格式（`members[]` + `progress{scoutId:{itemId:date}}`）；**本版仍接受** | 舊檔可能夾帶姓名／團籍，接收時剝走 |
| `roverbadge.progress.roverbook.v2` | BADGE → BOOK | `{ scoutId, progress{itemId:date}, awards{L1:date}, privacy }` | 零 |
| `roverbadge.signoff.v2` | BADGE → BOOK | 領袖核簽單：`{ seq, scoutId, leader{name,title,at,ink:null}, items[{id,date,verified}] }` | 零（**唔附墨跡**，`ink: 'withheld'`） |
| `roverbook/signoff@1` | BADGE → BOOK | 上述 `roverbadge.signoff.v2` 的 type 標記（`t:'roverbook/signoff'`、`v:2`）；接收方可據此路由 | 零 |
| `roverbadge.award.v1` | BADGE → BOOK | 一次過頒發結果：`awards[{scoutId,badgeId,date}]` | 零 |

ROVERBOOK 原本的 `RB1…` 二維碼（gzip）仍然係成員自己裝置之間的事；本對接**唔會**要求成員上傳它。

## 4. ROVERBADGE 端的四個 action

| action | 誰可呼叫 | 作用 | 寫入邊 |
| --- | --- | --- | --- |
| `bookSync` | 可勾選的領袖 | 接收成員紀錄冊（貼上 JSON 或上載檔案）；個資即場剝走；項目／學制／日期全部驗過才寫 | 「紀錄冊核簽」 |
| `bookAward` | 可勾選的領袖 | **一次過**頒發（多成員、多獎章、一行一筆） | 「紀錄冊頒發」 |
| `bookPull` | 任何已登入成員（**只回自己**） | 取回自己的進度／頒發／核簽，貼回 ROVERBOOK | 唯讀 |
| `bookRoster` | 可勾選的領袖 | 全團「已完成邊啲項目」一覽（零個資）＋「成員交上嚟但未入帳」清單 | 唯讀 |

上游簽名（`sig`）亦可呼叫這四個 action（支部／進度節點一次過統管），
已加入 `LINK_SIG_READ_ACTIONS`／`LINK_SIG_WRITE_ACTIONS` 與 `api/proxy.js` 的
`TOKEN_ACTIONS`／`LINK_SIG_SUPPORTED`。

前端：主畫面新增分頁「📖 ROVERBOOK 對接」（只對領袖顯示），三步：接收進度 → 一次過頒發 → 成員取回。
Sheet 選單新增「📖 ROVERBOOK 對接狀態」（只計數字，唔含任何個資）。

## 5. 部署（GS 5.4.0）

1. 覆寫 `apps-script/Code.gs` →「部署 → 管理部署作業 → ✏️ → 建立新版本」（保留同一條 `/exec`）。
2. Sheet 選單「🔗 旅系統 → 🔧 初始化／更新」按一次：自動補建「紀錄冊核簽」「紀錄冊頒發」
   兩張表（**只增不刪**，唔會改任何既有資料）。
3. 選單「📖 ROVERBOOK 對接狀態」確認兩張表存在。
4. （可選）Vercel 部署本版前端，領袖就有新的「📖 ROVERBOOK 對接」分頁。

## 6. ROVERBOOK 端要做的改動（另一個 repo）

本 repo **不會**直接改 ROVERBOOK。跑一次：

```bash
node scripts/roverbook-dropin.mjs   # 產物在 dist/roverbook/（已 gitignore）
```

會生成三個檔案：

| 生成物 | 放到 ROVERBOOK | 用途 |
| --- | --- | --- |
| `roverbadge-bridge.mjs` | `shared/bridge/roverbadge-bridge.mjs` | 同一套規則的 ESM 版（`import Bridge from …`） |
| `bridge-fixtures.json` | `test/fixtures/bridge-fixtures.json` | 跨 repo 測試向量（同輸入同輸出） |
| `PATCH.md` | — | 三個檔案的貼上位置（`shared/transfer.js`／`shared/book.js`／`web/src/pages/Appendix.jsx`） |

**為什麼係另一邊做**：ROVERBOOK 是獨立 repo，有自己的版本節奏；本 repo 只負責介面與後端。
`tests/roverbook-bridge.test.mjs` 會真的跑一次生成，並 import 生成物比對「核心 vs drop-in 輸出完全一致」，
所以兩個 repo 唔會各自走樣。

## 7. 私隱說明（可以照抄給家長／成員）

- 你部電話上的紀錄冊（姓名、相片、聯絡方法、簽名）**只存在你部電話**，我們（旅團／系統）睇唔到。
- 你按「交給領袖」時，只會傳：你的成員編號、邊個項目、完成日期。
- 系統會在收到的一刻把其他欄位剝走，並顯示剝走了幾多項（例如「已剝走個資欄位：10」）。
- 領袖頒發獎章後，你可以按「取回我的進度」只拿回自己的資料。
- 拿走 / 換電話：ROVERBOOK 附錄有「匯出備份」，匯入即可；不需要向任何人拿密碼。

## 8. 相關檔案

- `assets/roverbook-bridge.js` — 共用規則（瀏覽器 + Node，UMD）
- `apps-script/Code.gs` — `handleBookSync`／`handleBookAward`／`handleBookPull`／`handleBookRoster`／`menuBookStatus`
- `api/proxy.js` — 四個 action 的白名單 + 上游 sig 支援
- `scripts/roverbook-dropin.mjs` — 生成 ROVERBOOK 端 drop-in
- `tests/roverbook-bridge.test.mjs` — 17 項回歸（含整份試算表個資掃描）
