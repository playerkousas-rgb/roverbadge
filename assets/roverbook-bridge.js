/*
 * roverbook-bridge.js — ROVERBADGE ⇄ ROVERBOOK 對接（純邏輯，無 DOM、無網絡）
 *
 * 位置：ROVERBADGE 是「領袖端／後端」，ROVERBOOK 是「成員自己手機的前端紀錄冊」。
 *
 * 三條鐵律（對應 2026-11-04 的產品決定）：
 *   1. 成員個人資料**只留在成員自己的手機**：這個檔案的任何函數都不會接收、回傳、儲存
 *      姓名／電話／電郵／地址／出生日期／近照／簽名墨跡／緊急聯絡人。傳入的 JSON 即使有，
 *      會被明確剝走（privacyReport() 會列出剝走了什麼，方便審核）。
 *   2. ROVERBADGE 只記**進度**（{ scoutId: { itemId: 'YYYY-MM-DD' } }），方便領袖一次過統管。
 *   3. 簽發（award/badge 頒發）只由**領袖**一次過做，成員只會收到唯讀的頒發結果。
 *
 * 介面版本：
 *   roverbadge.progress.v1               ROVERBOOK 目前的匯出（members[] + progress{scoutId:{itemId:date}}）
 *   roverbadge.progress.roverbook.v2     本版新增：進度 + 頒發 + 審核員（仍然零個資）
 *   roverbadge.award.v1                  領袖 → 成員：一次過頒發的唯讀清單
 *   roverbadge.signoff.v2                領袖 → 成員：核簽單（只帶一筆「已簽」證明，不帶簽名圖）
 *
 * 瀏覽器：window.RoverBookBridge；Node（測試／建置）：module.exports
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoverBookBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCHEMA_PROGRESS_IN = 'roverbadge.progress.v1';
  const SCHEMA_PROGRESS_V2 = 'roverbadge.progress.roverbook.v2';
  const SCHEMA_AWARD = 'roverbadge.award.v1';
  const SCHEMA_SIGNOFF = 'roverbadge.signoff.v2';
  const BRIDGE_VERSION = 2;

  // 只准這兩個欄位跨越裝置邊界（其餘一律剝走）
  const ALLOWED_MEMBER_FIELDS = ['scoutId'];
  // 明確列出「永遠不會離開成員手機」的欄位，用於 privacyReport 與文件
  const NEVER_TRANSFER_FIELDS = [
    'nameZh', 'nameEn', 'name', 'ymis_name', 'photo', 'dob', 'placeOfBirth',
    'phone', 'email', 'address', 'emergencyName', 'emergencyPhone', 'bloodType',
    'holderSignature', 'signatures', 'signature', 'png', 'group', 'crew',
    'district', 'region', 'sponsoringAuthority', 'groupAddress', 'gsl', 'rsl',
    'meetingPlace', 'dateJoined', 'dateScoutMovement', 'issueDate'
  ];
  // 項目 ID 形狀與 data/items.json 一致：L1-ACT-01、OT-WOSM-SW、L1-ACT-01-part
  // 規則：大寫字母前綴（1–3 字，可帶一位數字）＋一串「-段」（每段 1–12 個大寫字母／數字）。
  // 唔寫死清單（綱要會改版），但一定要「有前綴、分段、全大寫」——咁樣姓名（陳大文／Chan Tai Man）、
  // 電話（91234567）、日期（2026-03-01）等就唔可能被當成項目 ID 寫入。
  const ITEM_ID_RE = /^[A-Z]{1,3}[0-9]?(?:-[A-Z0-9]{1,12}){1,4}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ★ 信任邊界（雙向、fail-closed）
  //   BADGE → BOOK：BOOK「無條件相信」領袖核實過嘅紀錄 → 只認 verified===true 且來源屬這張清單。
  //   BOOK → BADGE：一律唔信（成員部機可以改任何欄位），到 BADGE 只會變成「待領袖核實」。
  const TRUSTED_SIGNOFF_SOURCES = ['ROVERBADGE', 'roverbadge', 'roverbadge/signoff', 'roverbadge.signoff.v2', 'LEADER'];
  const TRUST_BASIS = {
    // 與 Code.gs 的 BOOK_TRUST_LEADER／BOOK_TRUST_CLAIM 用同一組字串（跨端契約）
    SIGNED_BY_LEADER: 'leader-signed',   // BADGE 領袖簽核（BOOK 可無條件採用）
    MEMBER_CLAIM: 'member-claim'         // 成員自己標記（BOOK 只顯示；BADGE 一律待核實）
  };

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n || 200);
  const sid = (v) => text(v, 32).replace(/[^0-9A-Za-z_-]/g, '');

  // 正規化日期：接受 YYYY-MM-DD 或 YYYY/M/D；唔合法回 ''（寧願唔寫，唔好寫錯）
  function normDate(v) {
    const s = text(v, 32);
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (!m) return '';
    const y = m[1];
    const mo = String(parseInt(m[2], 10)).padStart(2, '0');
    const d = String(parseInt(m[3], 10)).padStart(2, '0');
    const out = `${y}-${mo}-${d}`;
    if (!DATE_RE.test(out)) return '';
    const t = new Date(`${out}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== out) return '';
    return out;
  }

  // 只保留「成員手機裡有什麼被剝走了」的統計 —— 不含任何實際值
  function privacyReport(raw) {
    const removed = [];
    const seen = new Set();
    const walk = (v, path) => {
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
      if (!isObj(v)) return;
      Object.keys(v).forEach((k) => {
        const p = path ? path + '.' + k : k;
        if (NEVER_TRANSFER_FIELDS.indexOf(k) >= 0) {
          if (!seen.has(k)) { seen.add(k); removed.push(k); }
          return;
        }
        walk(v[k], p);
      });
    };
    walk(raw, '');
    return { removedFields: removed, removedCount: removed.length };
  }

  // ---- 進度：{ scoutId: { itemId: date } } -------------------------------------
  // opts.withTrust=true 時，另外回傳 verified／claims（同一個 itemId 只會在其中一邊）：
  //   verified = 有 trusted 來源 + verified===true（BOOK 可以無條件採用）
  //   claims   = 其餘（成員自己標記）→ 上到 BADGE 只會變「待領袖核實」
  function sanitizeProgress(map, opts) {
    const o = opts || {};
    const out = {};
    const verified = {};
    const claims = {};
    const dropped = { badItemId: 0, badDate: 0, overflow: 0 };
    let kept = 0;
    const max = o.maxItems || 500;
    if (!isObj(map)) return { progress: out, verified, claims, kept: 0, dropped };
    Object.keys(map).forEach((itemId) => {
      const id = text(itemId, 32);
      if (!ITEM_ID_RE.test(id)) { dropped.badItemId++; return; }
      const raw = map[itemId];
      const t = trustOf(raw);
      const date = t.date;
      if (!date) { dropped.badDate++; return; }
      if (kept >= max) { dropped.overflow++; return; }
      out[id] = date;
      if (t.verified) verified[id] = date; else claims[id] = date;
      kept++;
    });
    return { progress: out, verified, claims, kept: kept, dropped };
  }

  // 判斷一個進度值係「領袖已核實」定「成員自己標記」
  // 接受兩種寫法：
  //   { date, verified:true, source:'ROVERBADGE', assessor:'團長' }
  //   { date, verification:{ by:'團長', at:'2026-03-02', source:'roverbadge/signoff' } }
  // 其餘（純日期字串、或冇 trusted 來源）＝ 成員自己標記 → 唔會當成已完成。
  function trustOf(entry) {
    if (!isObj(entry)) return { date: normDate(entry), verified: false, source: '', assessor: '' };
    const date = normDate(entry.date || entry.verifiedDate);
    const src = text(entry.source, 40);
    const ver = isObj(entry.verification) ? entry.verification : null;
    const srcOk = src && TRUSTED_SIGNOFF_SOURCES.some((x) => src.toLowerCase().indexOf(x.toLowerCase()) >= 0);
    const verSrc = ver ? text(ver.source, 40) : '';
    const verSrcOk = verSrc && TRUSTED_SIGNOFF_SOURCES.some((x) => verSrc.toLowerCase().indexOf(x.toLowerCase()) >= 0);
    // 兩種寫法都算「聲稱由領袖簽」：
    //   ① 頂層 verified===true ＋ 受信 source
    //   ② 有 verification 子物件（by/at/source）＋ 受信 source（冇明確 verified:false）
    // 兩者仍然只係「BOOK 聲稱」，到 BADGE 一樣要入待批。
    const verified =
      (entry.verified === true && (srcOk || verSrcOk)) ||
      (!!ver && entry.verified !== false && verSrcOk);
    return {
      date: date,
      verified: !!verified,
      source: src || verSrc,
      assessor: text(entry.assessor || (ver && ver.by), 80)
    };
  }

  /**
   * ROVERBOOK → ROVERBADGE（領袖掃描／上載成員二維碼或 JSON 用）。
   * 只會取出：scoutId、progress、assessor（審核員姓名 —— 佢係領袖，唔係成員個資）、
   * badges（頒發日期）。姓名／電話／電郵／相／簽名一律剝走。
   */
  function fromRoverBook(payload, opts) {
    const o = opts || {};
    const src = isObj(payload) ? payload : {};
    // 接受：ROVERBOOK 原樣（RB1 解碼後）or 已匯出的 roverbadge.progress.v1
    const member = isObj(src.member) ? src.member : {};
    const scoutId = sid(src.scoutId || member.scoutId || member.memberNo || (src.members && src.members[0] && (src.members[0].scoutId || src.members[0].ymis)) || o.scoutId);
    const progressSrc = isObj(src.progress) ? src.progress : (isObj(member.progress) ? member.progress : {});
    // progress 可能係 {itemId: date}（成員自己）或 {scoutId: {itemId: date}}（匯出檔）
    const own = (scoutId && isObj(progressSrc[scoutId])) ? progressSrc[scoutId] : progressSrc;
    const p = sanitizeProgress(own, o);
    // 審核員姓名：佢係領袖（唔係成員個資），但只在「該項目真的有進度」時才帶，免得變成整份名單。
    const assessors = {};
    const assessorSrc = isObj(src.progress) ? (isObj(src.progress[scoutId]) ? src.progress[scoutId] : (own === progressSrc ? src.progress : {})) : {};
    Object.keys(assessorSrc || {}).forEach((k) => {
      const v = assessorSrc[k];
      const a = isObj(v) && text(v.assessor, 80);
      const id = text(k, 32);
      if (a && ITEM_ID_RE.test(id) && p.progress[id]) assessors[id] = a;
    });
    const awards = {};
    if (isObj(src.badges)) {
      Object.keys(src.badges).forEach((k) => {
        const id = text(k, 16);
        const d = normDate(isObj(src.badges[k]) ? src.badges[k].date : src.badges[k]);
        if (/^L\d$/.test(id) && d) awards[id] = d;
      });
    }
    const privacy = privacyReport(src);
    // ★ 分成兩堆：領袖已核實（可信）／成員自己標記（一定要領袖核實）
    // BADGE 端一律先把兩堆都放入「待批」，唔會因為 JSON 寫住 verified 就自動完成；
    // 但領袖會清楚見到邊幾項係「BOOK 顯示已核實」（可以快速全部確認），
    // 邊幾項係「成員自己標記」（逐項判斷）。
    const verifiedItems = p.verified || {};
    const claimItems = p.claims || {};
    return {
      ok: !!scoutId,
      reason: scoutId ? '' : '缺少 SCOUT ID／YMIS：成員需要在紀錄冊填一次成員編號（只需填在佢自己部機）',
      scoutId: scoutId,
      progress: p.progress,
      verified: verifiedItems,
      claims: claimItems,
      // 逐項信任標記（前端要連同 progress 一齊送去 BADGE；進度本身只是日期字串，唔會帶得到信任資訊）
      trusts: Object.keys(p.progress).reduce((acc, id) => {
        acc[id] = verifiedItems[id] ? TRUST_BASIS.SIGNED_BY_LEADER : TRUST_BASIS.MEMBER_CLAIM;
        return acc;
      }, {}),
      verifiedCount: Object.keys(verifiedItems).length,
      claimCount: Object.keys(claimItems).length,
      kept: p.kept,
      dropped: p.dropped,
      assessors: assessors,
      awards: awards,
      privacy: privacy,
      // 方便一次過貼入進度追蹤表（附 trust 標記，讓 BADGE 知道邊啲係領袖簽過）
      changes: Object.keys(p.progress).map((itemId) => ({
        ymis: scoutId, itemId, date: p.progress[itemId],
        trust: verifiedItems[itemId] ? TRUST_BASIS.SIGNED_BY_LEADER : TRUST_BASIS.MEMBER_CLAIM
      })),
      source: text(src.schema || src.source || 'ROVERBOOK', 40)
    };
  }

  /**
   * BOOK 側：把 BADGE 匯出的進度寫入成員手機紀錄冊。
   * 「無條件相信在 BADGE 內領袖核實了的資料，未核實的不錄入（不當完成）」：
   *   只有 verified 的項目會寫成完成；claims（成員自己標記）只會回報為 notes，不會蓋掉任何已完成日期，
   *   亦不會被當成已完成。日期只加不減（舊資料唔會蓋走手機上較後嘅紀錄）。
   * bookData: { progress:{itemId:date}, awards:{badge:date}, signoffs:[{id,date,verified}] }
   * 回傳 { progress, awards, applied, kept, removed, notes }
   */
  function applySignoff(bookData, exported, opts) {
    const o = opts || {};
    const book = isObj(bookData) ? bookData : {};
    const src = isObj(exported) ? exported : {};
    const progress = Object.assign({}, isObj(book.progress) ? book.progress : {});
    const awards = Object.assign({}, isObj(book.awards) ? book.awards : {});
    const notes = [];
    // BADGE 匯出的 signoffs 係「領袖核實」嘅唯一權威來源
    const signedIds = {};
    (Array.isArray(src.signoffs) ? src.signoffs : []).forEach((x) => {
      const id = text(x && x.id, 32);
      const d = normDate(x && x.date);
      if (!ITEM_ID_RE.test(id) || !d) return;
      if (x.verified !== true) { notes.push({ itemId: id, reason: 'BADGE 標示未核實，不錄入' }); return; }
      signedIds[id] = d;
    });
    const verifiedMap = {};
    (Array.isArray(src.items) ? src.items : []).forEach((x) => {
      const id = text(x && x.id, 32);
      const d = normDate(x && x.date);
      if (!ITEM_ID_RE.test(id) || !d) return;
      if (x.verified !== true) { notes.push({ itemId: id, reason: 'BADGE 標示未核實，不錄入' }); return; }
      signedIds[id] = d;
    });
    const pv = isObj(src.verified) ? src.verified : {};
    Object.keys(pv).forEach((k) => {
      const id = text(k, 32); const d = normDate(pv[k]);
      if (ITEM_ID_RE.test(id) && d) signedIds[id] = d;
    });
    let applied = 0, kept = 0;
    Object.keys(signedIds).forEach((id) => {
      const d = signedIds[id];
      const have = normDate(progress[id]);
      if (have && have >= d) { kept++; return; }         // 只加不減：較舊唔覆寫
      progress[id] = d; applied++;
    });
    // 成員自己標記嘅（BADGE 話未核實）→ 只記錄、唔會變完成
    const pc = isObj(src.claims) ? src.claims : {};
    Object.keys(pc).forEach((k) => {
      const id = text(k, 32);
      if (ITEM_ID_RE.test(id)) notes.push({ itemId: id, reason: 'BADGE 尚未核實（只保留手機上的標記）' });
    });
    // 領袖撤回：明確清單（唯一可以「減」的情況；由 BADGE 領袖主動產生，唔係成員自己講）
    const removed = [];
    (Array.isArray(src.withdrawn) ? src.withdrawn : []).forEach((id) => {
      const k = text(id, 32);
      if (!ITEM_ID_RE.test(k)) return;
      if (Object.prototype.hasOwnProperty.call(progress, k)) { delete progress[k]; removed.push(k); }
    });
    if (removed.length) notes.push({ itemId: removed.join(','), reason: '領袖已撤回，BOOK 已移除完成紀錄' });

    // 頒發（只加不減）
    const awardsIn = isObj(src.awards) ? src.awards : {};
    Object.keys(awardsIn).forEach((k) => {
      const badge = text(k, 16).toUpperCase(); const d = normDate(awardsIn[k]);
      if (!/^L\d$/.test(badge) || !d) return;
      if (normDate(awards[badge]) && normDate(awards[badge]) >= d) return;
      awards[badge] = d;
    });
    return { progress, awards, applied, kept, removed, notes, source: text(src.schema, 40) };
  }

  /** ROVERBADGE → ROVERBOOK：只匯出進度（＋頒發），絕不匯出任何個人資料。 */
  function toRoverBook(troop, opts) {
    const o = opts || {};
    const t = isObj(troop) ? troop : {};
    const out = {
      schema: SCHEMA_PROGRESS_V2,
      source: 'ROVERBADGE',
      v: BRIDGE_VERSION,
      exportedAt: new Date().toISOString(),
      troopId: text(t.troopId, 32),
      privacy: { personalData: 'none', note: '只交換進度；姓名／聯絡／相片／簽名只留在成員手機' }
    };
    // 只要係 BADGE 匯出，就係「領袖核實過」嘅紀錄（來源標記 + verified 讓 BOOK 無條件採用）
    out.verified = true;
    out.verifiedBy = text(t.troopId ? 'ROVERBADGE' : 'ROVERBADGE', 40);
    if (o.scoutId) {
      const s = sid(o.scoutId);
      const p = sanitizeProgress((t.progress || {})[s] || t.progress, o);
      out.scoutId = s;
      out.progress = p.progress;
      out.signoffs = Object.keys(p.progress).map((id) => ({ id: id, date: p.progress[id], verified: true, source: 'ROVERBADGE' }));
      out.awards = isObj((t.awards || {})[s]) ? (t.awards || {})[s] : {};
    } else {
      out.progress = {};
      Object.keys(t.progress || {}).forEach((k) => {
        const s = sid(k);
        if (!s) return;
        const p = sanitizeProgress(t.progress[k], o);
        if (p.kept) out.progress[s] = p.progress;
      });
    }
    return out;
  }

  /** 領袖一次過頒發：只回「哪個成員、哪個章、哪日」，不含姓名。 */
  function buildAwards(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const awards = [];
    const bad = [];
    list.forEach((e) => {
      const s = sid(e && (e.scoutId || e.ymis));
      const badge = text(e && (e.badgeId || e.badge), 16).toUpperCase();
      const date = normDate(e && (e.date || e.awardDate));
      if (!s || !/^L\d$/.test(badge) || !date) { bad.push({ scoutId: s, badgeId: badge, date: text(e && e.date, 20) }); return; }
      awards.push({ scoutId: s, badgeId: badge, date: date });
    });
    return {
      schema: SCHEMA_AWARD,
      v: BRIDGE_VERSION,
      issuedAt: new Date().toISOString(),
      privacy: { personalData: 'none' },
      awards: awards,
      rejected: bad
    };
  }

  /**
   * 領袖 → 成員的核簽單（取代 ROVERBOOK 自帶的「內嵌簽名 PNG」回傳碼）。
   * 唔帶簽名圖：只帶「哪個項目、簽署人姓名、職銜、日期、核簽編號」。
   * 成員掃到之後，ROVERBOOK 一樣可以寫入 date/assessor，只係冇墨跡 —— 墨跡留在領袖部機／BADGE。
   */
  function buildSignoff(args) {
    const a = args || {};
    const items = (Array.isArray(a.items) ? a.items : [])
      .map((it) => {
        const id = text(it && it.id, 32);
        const d = normDate(it && (it.date || (it.entry && it.entry.date)));
        if (!ITEM_ID_RE.test(id) || !d) return null;
        return { id: id, date: d, verified: true };
      })
      .filter(Boolean);
    const seq = text(a.seq, 40) || ('rb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    return {
      schema: SCHEMA_SIGNOFF,
      t: 'roverbook/signoff',
      v: 2,
      seq: seq,
      at: new Date().toISOString(),
      scoutId: sid(a.scoutId),
      leader: {
        name: text(a.leaderName, 80),
        title: text(a.leaderTitle || '樂行童軍團長', 40),
        at: normDate(a.date) || new Date().toISOString().slice(0, 10),
        // 明確聲明：唔附墨跡
        ink: null
      },
      items: items,
      note: text(a.note || 'ROVERBADGE 領袖核簽', 200),
      privacy: { personalData: 'none', ink: 'withheld' }
    };
  }

  /** 驗證／讀取領袖核簽單（ROVERBOOK 端用；亦供本 repo 測試） */
  function parseSignoff(json) {
    const s = typeof json === 'string' ? safeJson(json) : json;
    if (!isObj(s)) throw new Error('核簽單格式不正確');
    if (s.schema !== SCHEMA_SIGNOFF) throw new Error('這不是 ROVERBADGE 的核簽單（schema=' + text(s.schema, 40) + '）');
    const items = (Array.isArray(s.items) ? s.items : [])
      .map((it) => ({ id: text(it && it.id, 32), date: normDate(it && it.date), verified: !!(it && it.verified) }))
      .filter((it) => ITEM_ID_RE.test(it.id) && it.date && it.verified);
    return {
      ok: items.length > 0,
      seq: text(s.seq, 40),
      scoutId: sid(s.scoutId),
      leader: { name: text(s.leader && s.leader.name, 80), title: text(s.leader && s.leader.title, 40), at: normDate(s.leader && s.leader.at) },
      items: items,
      note: text(s.note, 200)
    };
  }

  function safeJson(x) { try { return JSON.parse(String(x)); } catch (e) { return null; } }

  /** 伺服器端審核：只准白名單欄位通過（api/proxy.js 轉發前會用這個再清一次） */
  function sanitizeBridgePayload(body) {
    const b = isObj(body) ? body : {};
    const out = {
      scoutId: sid(b.scoutId || (b.member && b.member.scoutId)),
      progress: sanitizeProgress(b.progress).progress,
      grants: buildAwards(b.awards || b.grants || []).awards
    };
    return { payload: out, privacy: privacyReport(b) };
  }

  return {
    BRIDGE_VERSION,
    SCHEMA_PROGRESS_IN,
    SCHEMA_PROGRESS_V2,
    SCHEMA_AWARD,
    SCHEMA_SIGNOFF,
    ALLOWED_MEMBER_FIELDS,
    NEVER_TRANSFER_FIELDS,
    TRUSTED_SIGNOFF_SOURCES,
    TRUST_BASIS,
    trustOf,
    applySignoff,
    normDate,
    privacyReport,
    sanitizeProgress,
    sanitizeBridgePayload,
    fromRoverBook,
    toRoverBook,
    buildAwards,
    buildSignoff,
    parseSignoff
  };
});
