# AGENTS.md — 给在本 repo 施工的 AI Agent

> 本 repo（roverbadge｜樂行童軍進度追蹤）是 playerkousas-rgb 生態系的其中一個「進度追蹤 leaf」App。
> **通用規則（S/F/A/W/V/G/VL/X/C 系列＋審核流程）的唯一真理在 [`playerkousas-rgb/readme`](https://github.com/playerkousas-rgb/readme)**：
> 開工前先讀佢個 `README.md` ＋ `PLAYBOOK.md`（規則 ID 表），以及專案案例 `docs/19-ecportal-troop-case.md`（五個 badge repo 的專案設定）
> 同 `docs/31-system-basics.md`（有身份系統嘅 8 項帳號生命週期＋ 8 項 ADMIN 回報驗收）。
>
> 呢個 repo 自己嘅設計/發佈規則見 [`README.md`](README.md) ＋ [`APP_ADMIN_WORKFLOW.md`](APP_ADMIN_WORKFLOW.md)（發佈新版 GS 檢查清單＋資料保全硬性規則）。

## 施工前必跑（本機閘門，對應 readme repo docs/30 L1）

```bash
npm run lint     # 無 TODO／行尾空格／可疑 log
npm run check    # 語法＋結構守護（自動確保所有 tests/*.test.mjs 已註冊）
npm test         # 全套：真實 Code.gs harness + mock GAS + 真 proxy 端到端（要全綠先好 commit）
```

CI（`.github/workflows/ci.yml`）會在 push／PR 跑同一條鏈。

## 本 repo嘅硬性規則（不可違反，違反 = regression）

1. **資料保全**：任何 patch／`initializeSheets()` 唔准刪除、覆寫、重設用戶資料；只做向後兼容增補。例外必須經用戶確認並寫入 `CHANGE_LOG.md`。
2. **中央帳號零痕跡**：保留帳號識別字只在 `apps-script/Code.gs` 一行常數；密碼只在 Vercel env 驗證，GAS／Sheet／前端／已部署文件永遠唔好出現（`tests/html-integrity.test.mjs` 會掃）。
3. **密碼**：PBKDF2-HMAC-SHA256 ≥100k 迭代＋ per-user salt（`pbkdf2$…` 格式，見 Code.gs `hashPasswordV2`）；舊單次 SHA-256 hash 仍可驗，登入成功自動升級。永不儲存／回傳／記錄明文密碼（臨時密碼寄出後不留底）。
4. **新 action → proxy 白名單 + 測試**（`tests/proxy-actions.test.mjs` 會掃前端每個 `apiRequest('…')`）。
5. **i18n**：新 UI 字串要入 `i18n_dict.tsv` ＋ `index.html` 內嵌 `LANG_DICT` 兩處（`tests/residue-audit`／`html-integrity` 會盯）。
6. **部署形態**：Build Output 模式 —— `vercel.json` 只准官方頂層欄位、絕對唔好有 legacy `builds`/`routes`/`functions`、唔准有 `.vercelignore`（`tests/vercel-config.test.mjs` 會守）。
7. **commit 前**：見上面三條命令全綠；PR 描述寫明身份錨點／registry／新 action／回滾指令有冇動過。

## 結構速覽

```
index.html            前端全部邏輯（單一 HTML）
api/                  Vercel serverless：proxy / troops / portal / super（_ 下劃線為內部模組）
apps-script/Code.gs   各旅團 Google Sheet 後端（單一檔案；部署指南下載用）
assets/ data/ docs/   靜態資源／項目目錄／教學（build 時白名單部署）
tests/                全部測試（gas-harness 真實跑 Code.gs；mock-gas 模擬 GAS；run-e2e 真 HTTP 端到端）
scripts/build.mjs     建置 → .vercel/output（Build Output API）
```
