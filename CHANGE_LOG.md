# CHANGE_LOG

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
