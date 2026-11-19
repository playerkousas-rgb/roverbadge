# 📱 匯出一位成員的紀錄成 QR（成員用相機掃 → 變成自己的 ROVERBOOK）

> **一句話**：領袖喺 ROVERBADGE 揀一位成員，系統把他的**進度＋頒發**壓成一張「匯入卡」，
> 放進連結 `https://<ROVERBOOK>/#rb=RBC1.…` 再印成二維碼；成員用手機**相機**一掃，
> ROVERBOOK 就會開，按一下「加入我的紀錄冊」就成為他自己的紀錄冊 —— **毋須密碼、毋須帳號、毋須先教他登入**。
>
> 卡內**零個資**：只有旅團編號、SCOUT ID、已完成項目同日期、獎章日期。
> 姓名、電話、電郵、地址、生日、相片、簽名墨跡等**個人資料一律唔會入卡**（同 `bookPull` 一致）。

---

## 1. 為什麼這樣做（設計取捨）

| 問題 | 答案 |
| --- | --- |
| 手機相機掃 QR 可以「自動開 ROVERBOOK 並載入資料」嗎？ | **可以，但只能透過一條網址。** iOS／Android 的相機 app 只會把 QR 解成 URL／文字；它不會把二進位資料交給某個 app。所以我們把資料放入 URL 的 **hash**（`#rb=`）——開啟網址的瀏覽器／PWA 讀得到，而 hash **永遠唔會送去伺服器**。 |
| 可否直接深層連結到手機上已安裝的 ROVERBOOK（Universal Link／App Link）？ | ROVERBOOK 是 PWA／網頁。用同一條 https 網址就最穩：已安裝到主畫面時多數會用同一個 origin 開啟（iOS 由 Safari 開啟後可「在主畫面開啟」）。不需要另設自家 scheme，亦避免相機 app 對未知 scheme 的封鎖。 |
| 可否連姓名、相片、簽名一齊掃？ | **唔會，亦唔應該。** ① 三條鐵律：個資只留成員手機；② 簽名墨跡／相片會令 QR 變成 version 30+（177×177 格），手機相機極難讀；③ 成員可以在 ROVERBOOK 自己填姓名／相片（只留在自己部機）。 |
| 為什麼不叫成員登入再「取回進度」？ | 咁樣要每位成員記住／輸入密碼。QR 係「一張紙交給他」的流程，適合集會、考驗營、派紀錄冊。兩條路可以並存（步驟 3 的 `bookPull` 仍然存在）。 |
| 掃完之後可不可以「自己簽完就當完成」？ | 不可以。卡只帶 **領袖已核實**的項目（`verified:true`、來源 `ROVERBADGE`）。成員在 BOOK 自己填的東西仍然只會是「待領袖確認」，回到 BADGE 一律入「紀錄冊待批」。 |

**雙向信任規則不變**：BADGE → BOOK 無條件相信（只採用領袖已核實）；BOOK → BADGE 一律只當申請。

---

## 2. 領袖怎樣用（30 秒）

1. 開「📖 ROVERBOOK 對接」→ **📱 4 · 匯出 QR（交給成員）**。
2. 揀成員（下拉選單會列出全團；未載入就先開一次「📊 我的進度」或「🏠 全團總覽」）。
3. （可選）改 ROVERBOOK 網址，預設 `https://roverbook.vercel.app`；改過會記住喺呢部機。
4. 按 **📱 產生 QR** → 畫面即刻出 QR、SCOUT ID、進度／獎章數目。
5. 按 **🖨️ 列印**（A4，QR 大字）派給本人；或者 **🔗 複製連結** 用 WhatsApp／Signal 傳給他。
6. 成員：手機相機對準 QR → 點彈出的連結 → ROVERBOOK 開 → 按「加入我的紀錄冊」。

> 舊版 ROVERBOOK（未支援 `#rb=`）仍然可以用同一頁的
> **📋 複製 JSON**，貼入 ROVERBOOK「從 ROVERBADGE 匯入」。內容同卡完全一樣（`cardToPull()`）。

### 派發禮儀（等同紙本紀錄冊）

- 一張卡只給**該位成員本人**。卡上只有 SCOUT ID（不是姓名），但仍屬他的紀錄。
- 連結**不會過期**；如果派錯／遺失，重新產生一張即可（內容一樣，冇「作廢」概念）。
- 卡內沒有相片／簽名，所以外洩的損失等同「知道他完成了哪幾項」——與紙本紀錄冊同一等級。

---

## 3. 成員看到什麼

| 步驟 | 畫面 |
| --- | --- |
| 相機掃到 | 彈出連結（iOS：頂部通知；Android：畫面下方） |
| 開啟 | ROVERBOOK `/import`（或 App 首頁的匯入畫面） |
| 核對 | `SCOUT ID 0000081420 · 進度 12 項 · 獎章 1 個` |
| 一按 | ✅「加入我的紀錄冊」→ 只加不減寫入（手機上較後的日期永遠不會被蓋走） |
| 完成 | 回到封面；附錄「從 ROVERBADGE 匯入」會顯示今次匯入了幾項 |

**只加不減**：如果手機已有同一項目但日期較後，卡的日期**不會**覆寫。
**未核實不錄入**：卡只會有已核實項目；`claims`／`pending` 從不出現在卡內。

---

## 4. 資料格式（跨 repo 契約）

### 4.1 卡物件（`roverbadge.card.v1`）

```json
{
  "schema": "roverbadge.card.v1",
  "v": 1,
  "troopId": "0082",
  "scoutId": "0000081420",
  "issuedAt": "2026-11-19",
  "progress": { "L1-ACT-01": "2026-03-01", "L3-INT-01": "2026-05-05" },
  "awards":   { "L1": "2026-04-01" },
  "privacy":  { "personalData": "none", "ink": "withheld" }
}
```

### 4.2 權杖（`RBC1.<base64url>`）

二進位（大端）：

| 欄位 | bytes | 說明 |
| --- | --- | --- |
| 格式版本 | 1 | 固定 `1`（唔係 `1` 一律拒絕） |
| flags | 1 | 保留（現時 0） |
| troopId | 1 + n | ASCII，最長 64 |
| scoutId | 1 + n | 正規化 10 位（`81420` → `0000081420`） |
| issuedAt | 2 | 2000-01-01 起第幾日（u16；超出範圍的日期會被丟棄） |
| 進度數量 | 2 | u16 |
| 每項 | 1（或 1+1+n）+ 2 | 索引 0–31（見 `CARD_ITEMS`）；`255` = 逃生門，跟住 1-byte 長度＋ASCII ID；再跟 2-byte 日數 |
| 頒發數量 | 1 | u8 |
| 每個獎章 | 1 + 2 | `0–5` = L1–L6；再跟 2-byte 日數 |

- `CARD_ITEMS` 係**追加式**索引表（32 項，順序 = `data/items.json` 初版順序）。
  **只准在尾加新項目，唔准重排**，否則舊 QR 會解錯。`tests/roverbook-card.test.mjs` 會同
  `data/items.json` 對照，綱要改版就會 fail，迫你處理。
- 未知項目（例如未加入索引表的其他獎章）用 `255` 逃生門，照樣解得返。

### 4.3 連結

```
https://<ROVERBOOK>/<路徑>/#rb=RBC1.<base64url>
```

- **一定係 hash**（`#`）：不會出現在 HTTP request、server log、Referer。
- `cardUrl(base, token)` 會清走舊 `?query`／`#hash` 同結尾斜線；冇 `https://` 會補上。
- 讀取：`Bridge.cardFromUrl(location.hash)` → `{ ok, card }`。

### 4.4 給 ROVERBOOK 的現成 JSON（`cardToPull()`）

ROVERBOOK 直接把 `cardToPull(card)` 交給它自己的 `importFromRoverBadge()` 即可：

```js
const { card } = Bridge.cardFromUrl(location.hash);
const result = importFromRoverBadge(Bridge.cardToPull(card), book); // 只加不減、未核實不錄入
```

回傳 `schema: 'roverbadge.progress.roverbook.v2'`、`verified: true`、`verifiedBy: 'ROVERBADGE'`、
`signoffs[]`（全部 `verified:true`）、`flatProgress`、`awards`、`badgeDates`。

---

## 5. ROVERBOOK 端要加什麼（另一個 repo）

跑：

```bash
npm run book:dropin          # node scripts/roverbook-dropin.mjs
```

`dist/roverbook/PATCH.md` 的 **④** 有完整可貼的 `web/src/pages/ImportCard.jsx` 與路由改動。
重點只有三步：

1. 啟動時讀 `location.hash`：`Bridge.cardFromUrl(location.hash)`；成功就存 session 並跳 `/import`。
2. 即刻 `history.replaceState({}, '', '/import')` 清走 hash（唔好留低可轉發的連結）。
3. 按「加入我的紀錄冊」→ `importFromRoverBadge(Bridge.cardToPull(card), book)`。

> ROVERBOOK **未更新**時：掃到連結只會開首頁（等同沒有這個功能），不會壞；
> 領袖改用「複製 JSON」手動貼上即可。

---

## 6. 安全與私隱檢查（已寫成測試）

| 檢查 | 測試 |
| --- | --- |
| 卡不含任何個資（姓名／電話／電郵／地址／生日／相片／簽名墨跡）——連 base64 解碼後都掃 | `tests/roverbook-card.test.mjs` A 組 |
| 權杖／網址／`cardToPull` JSON 三個方向都掃過禁值 | 同上 |
| 壞資料（截斷、亂碼、版本未支援）明確報錯，不會出半截卡 | 同上 B 組 |
| 32 項全滿＋3 獎章 → 權杖 < 200 字元、QR ≤ v12（≤ 65×65 格） | 同上 C 組 |
| QR 矩陣有獨立解碼器（jsQR）交叉驗證的指紋；定位圖案／時間圖案／靜區正確 | 同上 D 組 |
| 產生 QR **不呼叫任何後端 action**（冇新增寫入面） | 同上 E 組 |
| 卡格式同 ROVERBOOK drop-in 完全一致（fixtures 對照） | 同上 E 組＋`npm run test:book` |

> **威脅模型**：QR 只是「領袖給成員的唯讀快照」。任何人改卡上的日期都不會影響 BADGE
> （成員交回來的東西一律入待批、要 CONFIRM）；亦不可能用卡冒充別人（`scoutId` 對不上會被 ROVERBOOK 拒絕）。
> 卡內沒有姓名，撿到卡的人只會知道一個 SCOUT ID 完成了哪幾項。

---

## 7. 常見問題

**Q：掃完沒有反應／只顯示一堆字？**
A：部分相機 app 只會顯示 URL 而不自動開啟；點一下該 URL 即可。若是用 ROVERBOOK 內建掃描器
（`/scan`），它讀的是 `RB1.…` 格式，不是本功能產生的 `#rb=` 連結——請用**手機相機**或直接開啟連結。

**Q：QR 很大、難對焦？**
A：卡採用了二進位壓縮（32 項全滿仍 ≤ 65×65 格）。如果仍難讀：① 螢幕調光；② 列印時放大；
③ 用「複製連結」直接傳。

**Q：成員未有進度也可以產生 QR 嗎？**
A：可以。空白卡會綁定 SCOUT ID，成員先有自己的紀錄冊；之後再匯出一次就會補上進度（只加不減）。

**Q：一次過派全團？**
A：現時一次一位（一位成員一張卡，方便核對）。批量列印可以逐位產生後列印，或把連結貼進群組私訊
（**不要**貼在群組，卡屬個人紀錄）。

**Q：卡會不會過期？**
A：不會。卡是快照，不是 token；重複掃只會重複套用同樣資料（只加不減，不會重複寫）。

**Q：可以帶「待領袖確認」的項目嗎？**
A：不會。卡只帶領袖已核實的項目；成員自己申報的仍然要經「📥 1 · 接收進度」再 CONFIRM。

---

## 8. 相關檔案

| 檔案 | 作用 |
| --- | --- |
| `assets/roverbook-bridge.js` | `buildCard`／`encodeCard`／`decodeCard`／`cardUrl`／`cardFromUrl`／`cardToPull`（純邏輯，零 DOM） |
| `assets/roverbook-qr.js` | 零依賴 QR 編碼器（byte mode、ECC L/M/Q/H、v1–40、自動遮罩）→ SVG／矩陣 |
| `index.html` | 「📖 ROVERBOOK 對接 → 📱 4 · 匯出 QR」介面、列印區、i18n |
| `scripts/roverbook-dropin.mjs` | 產生 ROVERBOOK 端模組、fixtures 與 `PATCH.md`（含 `/import` 頁面） |
| `tests/roverbook-card.test.mjs` | 14 項回歸（私隱、編解碼、體積、QR 指紋、前端接線、跨 repo 一致） |
| `docs/ROVERBOOK_BRIDGE.md` | 整體對接規則（三條鐵律、CONFIRM 閘、只加不減） |
