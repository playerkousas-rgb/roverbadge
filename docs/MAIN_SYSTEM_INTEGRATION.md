# 🔗 接入主系統 (scoutsystem-2.0) 說明

> 獨立用完全沒問題，接入主系統時會怎樣？

## 兩條軌道並存

本系統支援 **雙軌制**（見 ROUTER_TIER3_DUALTRACK.md）：

1. **軌道 A - 獨立使用**：打開 `https://roverbadge.vercel.app/` → 選旅團 → 登入
2. **軌道 B - 接入主系統**：由主系統 Dashboard 卡片點擊進入，身份自動帶入，免再登入

兩條軌道可以同時用：領袖從主系統進入，成員 bookmark 獨立連結。

---

## 接入主系統時的流程

### 主系統會做什麼？

主系統在渲染卡片時，會用 **iframe** 嵌入本系統，並自動帶入 URL 參數：

```
https://roverbadge.vercel.app/?u=0082
  &role=member          ← 主系統知道你是領袖/成員（必須喺 roverbadge 登記嘅允許角色內）
  &ymis=1234567890      ← 主系統知道你的 YMIS（可省略；只用嚟預填／顯示身份）
  &name=陳大文
  &from=portal          ← 標記來源是主系統
  &src=https://main.example.org  ← 主系統網址（伺服器驗證入口來源用，唔好省略）
  &embed=1              ← 嵌入模式，隱藏大標題，精簡介面
```

**結果**：伺服器驗證來源及角色通過後，用戶點卡片就直接進入「我的進度」或「全團總覽」，不需要再選旅團及輸入密碼。**千祈唔好再傳 `backend`／`apikey`**：v3.0 起一律忽略（就算傳都會被棄置），後端一律由伺服器端 Registry 解析，機密唔應該出現喺 URL。

> roverbadge 管理員須先喺 Vercel 環境變數設 `PORTAL_DEFAULT_ORIGIN`（主系統網址）＋`PORTAL_DEFAULT_ROLES`（可用角色，例 `member,group_leader`），再 Redeploy；唔設 = 唔開放 portal（fail closed）。詳見 `VERCEL_ENV_SETUP.md`「主系統 Portal 對接」。

### 本系統會做什麼？

`index.html` 內的 `handlePortalParams()` 會：

1. **檢查** `from=portal` + `ymis` + `role`
2. **若都有**：唔再信 URL 參數，一律打同源 `GET /api/portal?u=&role=&src=` 由伺服器驗證（旅團已登記 → 有 portalOrigin 且未停用 → 瀏覽器 Referer/Origin 同 `src` 對得上登記 origin → 角色喺白名單內）；通過先創建 `currentUser` 免登入，顯示主App，跳過 loginPage
3. **若驗證唔通過**：停喺 🚫 錯誤頁，顯示原因＋錯誤代碼（`unknown_troop`／`troop_not_portal_enabled`／`referer_mismatch`／`origin_not_allowed`／`no_origin`／`role_not_allowed`），可「返回首頁」或「重試」——**唔會** fallback 普通登入
4. **若只有 `u`** (例如 `?u=0082`)：自動預選 0082 旅團，顯示登入框並填入 YMIS
5. **若有 `backend`+`apikey` 參數**：v3.0 起一律**忽略**（console 會有提示）——後端解析已移到伺服器端 Registry，前端唔再接觸 backend/apikey
6. **旅團後端**：由伺服器端 Registry（Vercel 環境變數 `TROOP_{ID}_BACKEND/_APIKEY`）解析；前端只經 `/api/troops` 攞 id+name+en、經 `/api/proxy` 讀寫資料；Portal 設定只留伺服器端
7. **embed=1**：加上 `embed-mode` class，隱藏首頁大Header及Welcome導航，精簡為嵌入式，適合 iframe 高度 600px

### 權限對應

| 主系統 role | 元件內看到的 | 能做的 |
|-------------|--------------|--------|
| member | 我的進度(只看自己) + 表格 + 教學 + 資料庫 | 申請完成，不能直接剔 |
| exec_committee | 同上 + 可選成員查看 + 全團批量(若授權) | 勾選 (範圍由團長設定) |
| branch_leader / group_leader / admin | 全團總覽 + 審批中心 + 用戶管理 | 勾選全部、批量、審批、改角色、設權限 |
| super_admin | 全部 + 測試工具 | 最高權限 |

主系統負責：**是否顯示卡片**（例如非樂行童軍支部不顯示）
本系統負責：**卡片內顯示什麼**（例如 member 只看自己）

---

## 主系統卡片設定範例

### 理想的第3級嵌入卡片

```jsx
// 主系統 Dashboard 渲染（卡片只需設 u 參數；backend/apikey 千祈唔好傳）
<iframe
  src={`https://roverbadge.vercel.app/?u=${troopId}&role=${user.role}&ymis=${user.ymis}&name=${user.name}&from=portal&src=${mainSystemOrigin}&embed=1`}
  style={{width:'100%', height:'750px', border:'none', borderRadius:'12px'}}
  title="樂行童軍進度追蹤"
/>
```

- `troopId` 由旅團在主系統的「旅團設定 → 元件設定」填入（只需旅團編號）
- `mainSystemOrigin` = 主系統網址 origin（例 `https://main.example.org`），須同 roverbadge 登記嘅 `PORTAL_DEFAULT_ORIGIN` 一致
- 每個旅團獨立 Google Sheet，資料隔離；後端 URL＋API Key 只留喺 roverbadge 伺服器端，主系統唔使存、唔使傳

### 卡片最簡 URL（推薦）

```
https://roverbadge.vercel.app/?u=0082&role=member&from=portal&src=https://main.example.org&embed=1
```

（`ymis`／`name` 可省略——只用嚟顯示身份；`src` 唔好省略，伺服器驗證來源用。）

前端會自動：

1. `u=0082` → `/api/troops` 確認旅團已登記 → 所有讀寫經 `/api/proxy`，由伺服器注入 backend + apikey
2. `from=portal` + `role` + `src` → `/api/portal` 伺服器驗證來源及角色 → 通過先免登入

---

## 獨立用 vs 接入主系統對比

|  | 獨立用 | 接入主系統 |
|---|---|---|
| 入口 | roverbadge.vercel.app → 選旅團 | 主系統 Dashboard 卡片 |
| 旅團選擇 | 手動選 | 自動帶入 `u` |
| 登入 | 選 member/leader 輸入 YMIS/Email+密碼 | 經 `/api/portal` 伺服器驗證來源及角色後免密碼進入 (Portal 信任模式) |
| 後端 | 伺服器端 Registry（環境變數）注入 | 同樣由伺服器端 Registry 注入；URL 帶 backend/apikey 會被忽略 |
| 介面 | 完整 Header + Welcome導航 | `embed=1` 精簡，隱藏大標題，適合 iframe |
| 權限 | 同樣按 role 控制 | 同樣按 role 控制 |
| 資料 | 同一 Google Sheet | 同一 Google Sheet |

---

## 常見問題

**Q: 成員從主系統進入後能否看到其他成員？**
A: 預設不能，只看自己。若團長在「用戶管理 → 系統設定」開啟「允許成員互相查看進度」，則成員也可看全團（唯讀），用於互相鼓勵。

**Q: 審批中心在主系統內會怎樣顯示？**
A: 成員看到自己申請狀態，領袖看到兩類：🏅獎章審批 + 👤用戶審批，均在同一「✅審批中心」分頁，內有子切換。

**Q: 表格列印在 iframe 內能否正常列印？**
A: 可以，`window.print()` 會只列印 `.print-area`，隱藏按鈕，官方 PT/19/PT/20 格式，雙面列印符合總會要求。

**Q: 若主系統未傳 backend/apikey，會怎樣？**
A: 冇問題——backend/apikey 由伺服器端 Registry（Vercel 環境變數）解析，卡片只需帶 `u`（加埋 `src` 做來源驗證）。若該 `u` 未登記，錯誤頁會顯示「此旅團未在伺服器登記（錯誤代碼：unknown_troop）」，請 roverbadge 管理員喺 Vercel 加 `TROOP_{ID}_NAME/_BACKEND/_APIKEY` 環境變數再 Redeploy。

**Q: 點卡片出現 🚫「未能以主系統身份進入」，點算？**
A: 睇錯誤代碼：`troop_not_portal_enabled`＝旅團未開放 portal（管理員未設 `PORTAL_DEFAULT_ORIGIN` 或該旅團被停用）；`referer_mismatch`／`origin_not_allowed`＝卡片 `src` 同登記 origin 唔一致（檢查主系統網址有冇轉 domain／加減 `www`）；`no_origin`＝直接開 URL／curl，冇來源可驗（須由 Dashboard 卡片進入）；`role_not_allowed`＝該角色唔喺 `PORTAL_DEFAULT_ROLES` 白名單。改完 Vercel 環境變數要 Redeploy 先生效。

**Q: roverbadge 管理員要為 portal 做啲咩？**
A: 兩步：(1) 每個旅團照常登記 `TROOP_{ID}_NAME/_BACKEND/_APIKEY`；(2) 加設 `PORTAL_DEFAULT_ORIGIN`（主系統網址）＋`PORTAL_DEFAULT_ROLES`（例 `member,group_leader`）。個別旅團可用 `TROOP_{ID}_PORTALORIGIN/_PORTALROLES/_PORTALDISABLED` 覆寫／停用。唔使改任何前端碼。

---

## 一句話總結

- **獨立用**：選旅團 → 登入 → 用
- **接入主系統**：點卡片 → 伺服器驗證來源及角色 → 直接用，`embed=1` 精簡介面，後端一律由伺服器端 Registry 解析（`backend/apikey` 唔傳唔查），權限、進度、表格、批量功能完全一致。

---
COPYRIGHT 2026 Scout System
