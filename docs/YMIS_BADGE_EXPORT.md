# YMIS 獎章匯出（試行版） / YMIS Badge Export (Pilot)

> ⚠️ **試行提示 / Pilot Notice**：
> - 尚未有真實資料喺 YMIS 實測；匯出不等於匯入成功；冇跨次重複上傳偵測。
> - Not yet tested with real data on YMIS; export does not guarantee import success; no cross-upload duplicate detection.

## 功能入口

領袖登入 → **全團總覽** → **「📤 匯出 YMIS 獎章（試行）」**（成員帳號無法見到及呼叫）。

## 輸出格式（`.xlsx`）

- 工作表名稱：`Sheet1`
- 四欄欄名與次序：
  1. `Scout ID`（10 位數字，文字儲存保留前導零）
  2. `Badge-Section`（固定值：`Rover Scout`）
  3. `Badge-Badge`（支援以下 3 款）：
     - `Membership Badge`（會員章）
     - `Rover Scout Award`（樂行童軍獎章）
     - `Baden-Powell Award`（貝登堡獎章）
  4. `Badge-award date (YYYYMMDD)`（文字儲存，無預設值，須由領袖自行填寫）

## 使用規則

- 本功能**不讀取考核進度**、**不寫回任何紀錄**、**不呼叫後端**、**不更新 Google Sheet**。
- 每次匯出一款獎章、多位成員；同一成員同一獎章不可重複；非 10 位數字 Scout ID 的成員會顯示但不可勾選。
- 下載後由領袖自行登入 YMIS，前往 **「成員註冊 → 資料檔案上傳 → 新增支部獎章紀錄」** 上傳。
