# ROVERBOOK ⇄ ROVERBADGE 對接（GS 5.4.0，2026-11-04）

> **一句話**：ROVERBADGE 的定位**不變**——仍然係領袖統管＋一次過簽發的後端；ROVERBOOK 只係
> **多一個「成員自己擁有」的前端**（手機 localStorage），方便出外時隨時翻閱自己的紀錄冊。
> 兩者只交換**進度**。成員的姓名以外個人資料（電話、電郵、地址、出生日期、相片、簽名墨跡、
> 緊急聯絡人）**永遠留在成員自己部機，唔會上傳、唔會寫入任何 Google Sheet**。
>
> **成員喺 BOOK 自己簽嘅，唔算完成。** BOOK 交上嚟嘅紀錄一律先放入「紀錄冊待批」，
> 要領袖逐項／一次過 **CONFIRM** 才會寫入正式「進度追蹤」；未確認之前
> `bookPull`／`bookRoster` 都唔會把它當成已完成。

---

## 1. 三條鐵律

| # | 鐵律 | 在程式裡怎樣保證 |
| --- | --- | --- |
| ① | **個資只留成員手機** | `assets/roverbook-bridge.js` 的 `fromRoverBook()` 只取 `scoutId`／`itemId`／`date`／`assessor`；其餘欄位（`NEVER_TRANSFER_FIELDS`）即場剝走並回報 `privacy.removedFields`。GAS 端 `handleBookSync()` 再剝一次（兩道防線），`bookStripPersonal_()` 掃描整個請求物件。 |
| ② | **ROVERBADGE 只記進度** | 新工作表「紀錄冊核簽」只有 10 欄：簽核編號／SCOUT ID／項目 ID／完成日期／核簽領袖／職銜／核簽日期／來源／寫入時間／備註。冇電話、冇電郵、冇地址、冇相片、冇墨跡。 |
| ③ | **頒發只由領袖一次過做** | `bookAward` 需要「可勾選的領袖」權限，可以一次 submit 多成員多獎章；成員只能用 `bookPull` 取回唯讀結果。「團集會／考驗營有參加就一次過簽」照舊用「全團總覽 → 🚀 考驗營批量完成」或「待批 → 批量批准」，**唔經 BOOK**。 |
| ④ | **BOOK 的簽名唔等於完成（CONFIRM 閘）** | `bookSync` 只寫「紀錄冊待批」；`bookConfirm` 才由領袖寫入「進度追蹤」＋「紀錄冊核簽」。成員交上嚟嘅資料永遠唔會自動計入進度（測試會斷言 `bookSync` 之後 `進度追蹤` 仍然只有表頭）。 |
| ⑥ | **SCOUT ID 前導零正規化** | `81420 ⇄ 0000081420` 視為同一人（`scoutNorm_`／`scoutAliases_`／`scoutMatches_`）。只影響比對，唔改寫舊資料；新紀錄一律存 10 位正規化值，唔會一人兩份。 |
| ⑤ | **只加不減（防舊資料回寫）** | 同一 (SCOUT ID, 項目) 已有較後日期時，較舊的提交只會標為 `older` 交回前端提示，**唔會入待批、唔會蓋走**；即使有人手動塞入待批，`bookConfirm` 預設都唔會覆寫（領袖要明確 `overwrite: true` 才可以改日期——「可以改」）。重覆提交同一日期會標 `duplicate` 而不新增列。 |

三條都寫成測試：`tests/roverbook-bridge.test.mjs`（17 項）。其中一項會把整份模擬紀錄冊
（滿載個資）餵入，然後掃描「所有工作表、所有儲存格」，確認任何一個個人資料值都冇出現。

### 1.1 雙向信任規則（2026-11-05 定案）

| 方向 | 規則 | 為什麼 |
| --- | --- | --- |
| **BADGE → BOOK** | BOOK **無條件相信**「BADGE 內領袖核實過」的紀錄：只採用 `verified===true` ＋ 受信來源（`ROVERBADGE`／`roverbadge/signoff`／`LEADER`）或者 `signoffs[]` 內 `verified===true` 的項目；**未核實的一律不錄入**，不會被當成完成，只會出現在 `notes` 內。 | BOOK 是成員的前端，沒有能力判斷真假；既然 BADGE 已經有領袖核實，就照用，避免 BOOK 自己再「猜」。同時「只加不減」——較舊日期不會蓋走手機上較後的紀錄。 |
| **BOOK → BADGE** | BADGE **一律不信**成員手機上的任何自稱：即使 JSON 寫住 `verified:true, source:'ROVERBADGE'`（`source` 只係一個字串，誰都可以填），仍然只會進入「紀錄冊待批」，等領袖 CONFIRM。 | 成員部機係佢自己控制，任何欄位都可以改；只有領袖在本系統按確認，才算核實。 |
| 分類（方便領袖判斷，不會放寬） | 待批每項附 `trust`：`leader-signed`（BOOK **聲稱**已由領袖簽，通常是上次 `bookPull` 回傳後被 BOOK 採用）／`member-claim`（成員自己標記）。前端有「🔏 只確認 BOOK 顯示已簽的」一鍵處理前者。 | 讓「上次已核實」的項目可以快批，同時保留人手關卡。 |

實作位置：

| 端 | 函數 | 行為 |
| --- | --- | --- |
| BOOK 端（共用） | `Bridge.applySignoff(book, exported)` | 只寫入已核實項目、`kept`（較舊不改）、`notes`（未核實原因）；回 `{progress, awards, applied, kept, notes}` |
| BOOK 端（共用） | `Bridge.trustOf(entry)` | 判斷單一項目是否「聲稱由領袖核實」（冇受信來源＝`member-claim`） |
| BADGE 端 | `bookTrustOf_(entry)`（Code.gs） | 同一套判斷，寫入待批的 `差異／備註` |
| BADGE 端 | `handleBookSync` → `stageBookPending_` | **兩種 trust 都一樣入待批**，永不自動批准（測試會掃原始碼確認） |
| BADGE 端 | `handleBookPull` | 回 `verified:true`、`verifiedInBadge`（＝領袖核實過的進度）、`pending`（未核實，BOOK 只可顯示「申請中」） |

> 一句總結：**「BADGE 講嘅就信，BOOK 講嘅只當申請」**。

### 1.2 撤回、更正、打錯編號（2026-11-05 審計修正）

| 情況 | 規則 | 原因 |
| --- | --- | --- |
| 領袖在「我的進度」取消完成（撤回） | 該項目即刻由 `bookProgressOf_`／`bookRoster` 移除，`bookPull` **唔會**再由核簽補回，並在 `withdrawn[]` 明確告知 BOOK；BOOK 側 `applySignoff()` 會把該項目由「已完成」移除 | 舊版：領袖撤回後核簽殘留，`bookPull` 仍回 `verified:true` → BOOK 會重新採用，等於「撤回無效」 |
| 打錯 SCOUT ID（幽靈成員） | `bookSync`／`bookAward` 一律拒絕（`unknownScoutId`），頒發更是**整批拒絕、不會半寫**；判定範圍＝Users（active）＋成員名單 | 舊版會寫入無人跟進的待批／頒發紀錄 |
| 頒發錯日期 | 預設永不改（`written 0, skipped N`）；領袖明確 `confirm:true` ＋ `correct:true` 才會改，並在備註記「更正頒發日期（原 …）」 | 「只加不減，但可以改」——改要人手確認 |
| 頒發錯人／錯章 | 明確 `confirm:true` ＋ `remove:true` 才刪（`removed`） | 同上 |
| 「全部確認」 | 必須明確 `all:true`（前端有 `window.confirm`）；冇 `pendingIds`／`scoutId` 就一律拒絕 | 舊版「冇帶 id＝全團」，誤按會一次過確認全團 |
| 信任標記傳遞 | 前端送 `trusts`（bridge `fromRoverBook().trusts`），GAS 以 `leader-signed`／`member-claim` 記錄；缺失或亂填只影響顯示，一樣入待批、一樣要 CONFIRM | 舊版 `progress` 只有日期字串，信任標記在傳輸中丟失，「只確認已簽」永遠找不到 |

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

> **ROVERBOOK 自己嘅前端**唔會直接用下面呢四個 action：佢只經 `/api/roverbook`（只准
> `login`／`logout`／`load`／`requestComplete`，零個資、寫入 403），見 [ROVERBOOK_API.md](ROVERBOOK_API.md)。
> 下面四個 action 係**領袖在 ROVERBADGE 前端**用的（或者領袖掃 QR 後手動貼上）。

## 4. ROVERBADGE 端的四個 action

| action | 誰可呼叫 | 作用 | 寫入邊 |
| --- | --- | --- | --- |
| `bookSync` | 可勾選的領袖 | 接收成員紀錄冊（貼上 JSON 或上載檔案）；個資即場剝走；項目／學制／日期驗過才**放入待批**；回 `leaderSignedCount`／`memberClaimCount` | 「紀錄冊待批」 |
| `bookConfirm` | 可勾選的領袖 | 逐項或一次過 **CONFIRM**（可改日期）；寫入正式進度並產生核簽；亦可 `decision:'reject'` | 「進度追蹤」＋「紀錄冊核簽」 |
| `bookPending` | 領袖看全部／成員只看自己 | 讀待批清單（零個資） | 唯讀 |
| `bookAward` | 可勾選的領袖 | **一次過**頒發（多成員、多獎章、一行一筆） | 「紀錄冊頒發」 |
| `bookPull` | 任何已登入成員（**只回自己**） | 取回自己的進度／頒發／核簽，貼回 ROVERBOOK | 唯讀 |
| `bookRoster` | 可勾選的領袖 | 全團「已完成邊啲項目」一覽（零個資）＋待批清單 | 唯讀 |

上游簽名（`sig`）亦可呼叫這四個 action（支部／進度節點一次過統管），
已加入 `LINK_SIG_READ_ACTIONS`／`LINK_SIG_WRITE_ACTIONS` 與 `api/proxy.js` 的
`TOKEN_ACTIONS`／`LINK_SIG_SUPPORTED`。

前端：主畫面新增分頁「📖 ROVERBOOK 對接」（只對領袖顯示），三步：
① 接收進度（貼上／上載 → **放入待批** → 表格逐項勾選／全部確認／拒絕，可見到「新項目／較後日期／
較舊（預設不改）／同一日」差異）→ ② 一次過頒發 → ③ 成員取回（**只回自己**，未確認的會另列
「待領袖確認（未計入進度）」）。
Sheet 選單新增「📖 ROVERBOOK 對接狀態」（只計數字，唔含任何個資）。

## 5. 部署（GS 5.4.0）

1. 覆寫 `apps-script/Code.gs` →「部署 → 管理部署作業 → ✏️ → 建立新版本」（保留同一條 `/exec`）。
2. Sheet 選單「🔗 旅系統 → 🔧 初始化／更新」按一次：自動補建「紀錄冊待批」「紀錄冊核簽」
   「紀錄冊頒發」三張表（**只增不刪**，唔會改任何既有資料）。
3. 選單「📖 ROVERBOOK 對接狀態」確認三張表存在，以及「待領袖確認 N 項」。
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
- 你交上去只係「申請」，**唔會**令你變成已完成；要領袖確認才計入進度（防止有人自己簽完就當完成）。
- 反過來，領袖已經核實過的項目，你的 ROVERBOOK 會直接採用（不用再自己填）。
- 系統會在收到的一刻把其他欄位剝走，並顯示剝走了幾多項（例如「已剝走個資欄位：10」）。
- 領袖頒發獎章後，你可以按「取回我的進度」只拿回自己的資料。
- 拿走 / 換電話：ROVERBOOK 附錄有「匯出備份」，匯入即可；不需要向任何人拿密碼。

## 8. 「只加不減，但可以改」的實際規則

| 情況 | 結果 |
| --- | --- |
| BOOK 有、BADGE 完全未有 | 入待批（`diff='new'`），確認後寫入 |
| BOOK 日期 **較後** | 入待批（`diff='newer'`），確認後更新為較後日期 |
| BOOK 日期 **較舊**（例如換機、還原舊備份、貼錯舊檔） | **唔入待批**，回 `older:[{itemId,date,existing}]` 提示「已保留較後紀錄」 |
| 同一日期再交一次 | 標 `duplicate`，唔會新增列、唔會重覆寫 |
| 領袖想改（例如打錯日期） | CONFIRM 時可帶 `overwrite:true`（或前端改日期後提交）；或者直接在「進度追蹤」改 |
| 已頒發的獎章 | 永不改、永不重覆寫（`written 0, skipped N`） |

所以「舊同步去新」在資料層已經被擋住：較舊日期既入唔到待批，就算入到，CONFIRM 預設都唔會覆寫。

## 9. 權限一覽（誰可以做什麼）

| | 成員（自己） | 可勾選的領袖 |
| --- | --- | --- |
| 上載自己的紀錄冊 | ✗（要領袖代收，或用「📋 待批」的成員申請通道） | ✓ 任何成員 |
| 確認（CONFIRM） | ✗（測試斷言：成員呼叫會得「權限不足」） | ✓ 受 `allowed_badges` 限制 |
| 頒發 | ✗ | ✓ 一次過多成員多獎章 |
| 取回自己進度 | ✓ 只限 token 本人 | ✓（只限自己） |
| 看全團一覽 | ✗（除 `allow_member_view_others`） | ✓ 零個資 |

## 10. 相關檔案

- `assets/roverbook-bridge.js` — 共用規則（瀏覽器 + Node，UMD）
- `apps-script/Code.gs` — `handleBookSync`／`handleBookConfirm`／`handleBookPending`／`handleBookAward`／`handleBookPull`／`handleBookRoster`／`menuBookStatus`
- `api/proxy.js` — 四個 action 的白名單 + 上游 sig 支援
- `scripts/roverbook-dropin.mjs` — 生成 ROVERBOOK 端 drop-in
- `tests/roverbook-bridge.test.mjs` — 31 項回歸（含整份試算表個資掃描、CONFIRM 閘、只加不減、雙向信任、前後端契約）
