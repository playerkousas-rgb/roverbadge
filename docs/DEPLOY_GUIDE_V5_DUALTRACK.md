# 🗺️ 部署雙軌指南 - 有主系統 vs 無主系統

> ⚠️ **主系統（scoutsystem-2.0）暫停對外推廣（2026-10）**：面向用家嘅主系統介紹已喺 `index.html`
> 「新旅團部署」頁用 `[主系統暫時隱藏]` 標記註解隱藏，現階段只推廣進度追蹤系統本身。
> 以下主系統相關內容及整合程式碼（Portal／sig 流程）**全部保留並照常運作**，僅供開發／維運參考；
> 主系統完成後搜尋該標記解除註解即可重啟（步驟見 [CHANGE_LOG](../CHANGE_LOG.md)）。

> 有主系統 ≠ 一定要接上，可自由選擇

## 首次登入（預設管理員帳號）

旅團喺 Vercel 環境變數登記完成後，首頁就會出現該旅團卡片。**第一個可以登入嘅帳號**係
`initializeSheets()` 自動建立嘅預設管理員：

| 項目 | 值 |
| --- | --- |
| 登入分頁 | 「👤 成員」（YMIS 登入） |
| YMIS | `1111111111` |
| 密碼 | `changeme` |

1. 開首頁 → 揀該旅團卡片
2. 揀「👤 成員」分頁，輸入 YMIS `1111111111` ＋ 密碼 `changeme`
   （唔好用「👨‍💼 領袖」＝Email 分頁；預設管理員嘅 `admin@example.com` 只係佔位電郵）
3. 首次登入會**強制改密碼**（彈出對話框，最少 4 位、二次確認）
4. 之後喺「用戶管理」開返各領袖帳號並設角色；「審批中心」批成員申請

注意：

- `1111111111` 只係佔位 YMIS，開好真帳號後可停用或留作後備
- 忘記密碼：由另一個 admin／團長重設，重設後首次登入會再強制改密
- 之後由領袖開嘅帳號（臨時密碼 `1234`）首次登入仍然強制改密
- 預設管理員俾人刪咗都唔緊要：重跑一次 `initializeSheets()` 會自動補返（2026-10 起）；
  帳號密碼仲係 `changeme` 嘅話，登入時仍會被要求「首次登入強制改密」（2026-10 起由登入時判斷，重跑初始化唔會改寫任何既有帳號列；見 `docs/LEADER_GUIDE.md`）

## 主系統平台是什麼？

**scoutsystem-2.0** 是樂行童軍進度追蹤以外的更龐大平台：

- Dashboard 儀表板
- 成員管理 (全旅團名單、YMIS、家長)
- 集會考勤 QR Code
- 財務管理
- 活動報名
- 插件市場 (本系統是 Tier 3 插件之一)

本系統可獨立用，也可作為插件一鍵接入主系統，享受單一登入。

## 兩條軌道

**共通**：下載 Code.gs → 建 Sheet → 執行 initializeSheets（只顯示 API Key）→ 部署；正式 URL 從 Google 部署視窗取得，再在既有 ADMIN FORM 填旅團編號、名稱、URL、API Key。不需設定旅團編號或把 URL 貼入 Apps Script。

**軌道A 無主系統/有但想獨立用**：
- 在既有 ADMIN FORM 填入 Google 部署視窗提供的 URL 及 API Key → 喺 Vercel 加 `TROOP_{ID}_NAME/_BACKEND/_APIKEY` 環境變數 → Redeploy → 完成
- 用法：roverbadge.vercel.app → 選旅團 → 登入
- 優點：簡單

**軌道B 有主系統並想接上**：
- 同樣交 roverbadge 管理員
- 額外：交主系統管理員填入旅團設定→元件設定 backend+apikey
- 用法：主系統 Dashboard 點卡片 → 自動帶入身份 from=portal&embed=1 → 直接用
- 優點：單一登入

兩條路可同時用。

## 為何要告訴用家有主系統？

讓只用 roverbadge 的旅團知道，原來有更大平台可同時使用，Dashboard、考勤、財務等更多功能。

## 詳細步驟見 DEPLOY_GUIDE_FOR_TROOPS.md


## API Key 與部署 URL（2026-10-24 更新）

`initializeSheets()` 及「🔗 旅系統 → 🔑 顯示 API KEY（交 ADMIN）」只提供 API Key；不會顯示 `getService().getUrl()` 或舊 URL 快取。正式 Web App URL 由 Google 部署視窗提供。旅團在現有 ADMIN FORM 填寫 ID、名稱、URL、API Key；不需要新增 GAS URL 設定。既有正常 Sheet 因本次顯示修正不必重跑初始化。
