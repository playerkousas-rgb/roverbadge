/*
 * gs-release.js — 樂行童軍：最新版本公告的版本判斷（純邏輯，無 DOM）
 *
 * 瀏覽器：window.GsRelease；Node（測試）：module.exports。
 *
 * GS_LATEST 是「本前端頁面所公告的最新後端版本」。發佈新版 Code.gs 時必須同步：
 *   - apps-script/Code.gs 的 GS_VERSION／GS_RELEASE_DATE／GS_INIT_REQUIRED
 *   - 本檔 GS_LATEST（tests/gs-release.test.mjs 會檢查兩者一致）
 *
 * 旅團 GS 回報（ecStatus 或 load）：
 *   gsVersion              旅團 Apps Script 正在執行的版本（舊版無此欄位 ＝ 未更新）
 *   initRequired           該版本是否要求執行一次 initializeSheets()
 *   initializedGsVersion   initializeSheets() 最後一步寫入的版本標記（未執行過 ＝ 空字串）
 *
 * 三種狀態（statusOf）：
 *   outdated    GS 未更新（沒有版本欄位，或版本低於 GS_LATEST.version）
 *   needs_init  GS 已更新但未初始化（需要初始化，而標記不等於目前 GS 版本）
 *   ok          全部完成（前端顯示綠色「已核對」）
 *   unchecked   尚未核對（沒有任何回報）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GsRelease = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const GS_LATEST = Object.freeze({
    version: '5.2.2',
    releaseDate: '2026-10-24',
    initRequired: false,
    codeUrl: 'apps-script/Code.gs'
  });

  // 比較點分版本號（例 "5.2.1" vs "5.10.0"）：回傳 -1／0／1
  function compareVersions(a, b) {
    const x = String(a || '').trim().split('.').map(function (n) { return parseInt(n, 10) || 0; });
    const y = String(b || '').trim().split('.').map(function (n) { return parseInt(n, 10) || 0; });
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // info：ecStatus 或 load 的回傳物件；latest 預設 GS_LATEST
  function statusOf(info, latest) {
    const L = latest || GS_LATEST;
    if (!info) return { code: 'unchecked', gsVersion: '', initializedGsVersion: '', latestVersion: L.version };
    const gsVersion = String(info.gsVersion || '');
    const initialized = String(info.initializedGsVersion || '');
    const base = { gsVersion: gsVersion, initializedGsVersion: initialized, latestVersion: L.version };
    if (!gsVersion || compareVersions(gsVersion, L.version) < 0) return Object.assign({ code: 'outdated' }, base);
    const needInit = info.initRequired !== undefined ? !!info.initRequired : !!L.initRequired;
    if (needInit && initialized !== gsVersion) return Object.assign({ code: 'needs_init' }, base);
    return Object.assign({ code: 'ok' }, base);
  }

  // 「必須執行 initializeSheets()」是否要顯示（需要初始化的版本，且尚未標記完成）
  function initNotice(info, latest) {
    const L = latest || GS_LATEST;
    const st = statusOf(info, L);
    return st.code === 'needs_init' || (st.code === 'outdated' && L.initRequired);
  }

  return { GS_LATEST: GS_LATEST, compareVersions: compareVersions, statusOf: statusOf, initNotice: initNotice };
});
