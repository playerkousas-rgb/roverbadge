/*
 * rover-scope.js — 樂行童軍：學制、權限範圍、舊版紀錄、首頁摘要、權限選單
 *
 * 所有名單都由 data/items.json（或 items_en.json）即時計算，不寫死任何獎章／段章／項目。
 * 瀏覽器：window.RoverScope；Node（測試）：module.exports。
 *
 * 學制（每位成員自行選擇，存於 學制設定 工作表）：
 *   new        新制（第五版）  → badges（L1–L4）＋ OT
 *   old        舊制（第四版）  → L1、L2（共用）＋ oldBadges（S4-*）＋ OT
 *   transition 舊制過渡新制    → badges（L1–L4）＋ OT；oldBadges 只作對照，不計完成度
 *
 * 權限代碼（allowed_badges，逗號分隔）：
 *   *            全部
 *   OTHER        全部其他獎章（OT-*）
 *   L1 / L2 / L3 / L4 / S4-AWARD / S4-BP   整個獎章
 *   L3-SCOUT 等  段章代碼（items 內 segments[].code）
 *   L3-SCOUT-01 等 項目 ID
 *   OT-FA 等     單個其他獎章
 * 其他字串（例如舊版 活動段章、L3-ACT-SCOUT）不會放行任何項目，也不會被刪除。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.RoverScope = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var SCHEME_KEYS = ['new', 'old', 'transition'];

  function parseTokens(allowed) {
    if (allowed === null || allowed === undefined) return [];
    return String(allowed).split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function segmentItemIds(seg) {
    var ids = [];
    seg.items.forEach(function (it) {
      if (it.subItems && it.subItems.length) it.subItems.forEach(function (s) { ids.push(s.id); });
      else ids.push(it.id);
    });
    return ids;
  }

  // 所有獎章（現行＋舊制）
  function allBadges(items) {
    return (items.badges || []).concat(items.oldBadges || []);
  }

  function findBadge(items, id) {
    return allBadges(items).find(function (b) { return b.id === id; }) || null;
  }

  // 依段章代碼在所有獎章中找段章；回傳 { badge, segment } 或 null
  function findSegment(items, code) {
    var hit = null;
    allBadges(items).some(function (b) {
      return (b.segments || []).some(function (s) {
        if (s.code === code) { hit = { badge: b, segment: s }; return true; }
        return false;
      });
    });
    return hit;
  }

  function schemeList(items) {
    return (items.schemes && items.schemes.list) || {};
  }

  // 學制代碼正規化；未知值回傳預設（new）
  function schemeKey(items, scheme) {
    var s = scheme || (items.schemes && items.schemes.default) || 'new';
    return schemeList(items)[s] ? s : 'new';
  }

  function schemeLabel(items, scheme) {
    var d = schemeList(items)[schemeKey(items, scheme)] || {};
    return d.label || scheme;
  }

  // 該學制的獎章目錄（依 items.schemes.list[x].catalogBadges）
  function schemeBadges(items, scheme) {
    var def = schemeList(items)[schemeKey(items, scheme)] || {};
    return (def.catalogBadges || []).map(function (id) { return findBadge(items, id); }).filter(Boolean);
  }

  // 該學制下計完成度的項目 ID（其他獎章 OT-* 三種學制都計）
  function schemeItemIds(items, scheme) {
    var ids = {};
    schemeBadges(items, scheme).forEach(function (b) {
      (b.segments || []).forEach(function (s) { segmentItemIds(s).forEach(function (id) { ids[id] = true; }); });
    });
    (items.otherBadges || []).forEach(function (ob) { ids[ob.id] = true; });
    return ids;
  }

  // 建立索引：所有已知 ID -> 所屬獎章／段章；本學制計完成度的 activeIds；舊版 ID 清單
  function buildIndex(items, scheme) {
    var sk = schemeKey(items, scheme);
    var idx = {
      scheme: sk, badgeIds: {}, segmentCodes: {}, itemIds: {}, itemBadge: {}, itemSegment: {},
      otherIds: {}, legacy: {}, itemNames: {}, activeIds: schemeItemIds(items, sk), _items: items
    };
    allBadges(items).forEach(function (b) {
      idx.badgeIds[b.id] = true;
      (b.segments || []).forEach(function (s) {
        idx.segmentCodes[s.code] = b.id;
        segmentItemIds(s).forEach(function (id) {
          idx.itemIds[id] = true;
          idx.itemBadge[id] = b.id;
          idx.itemSegment[id] = s.code;
        });
        s.items.forEach(function (it) { if (it.id) idx.itemNames[it.id] = it.name; });
      });
    });
    (items.otherBadges || []).forEach(function (ob) {
      idx.badgeIds[ob.id] = true;
      idx.itemIds[ob.id] = true;
      idx.otherIds[ob.id] = true;
      idx.itemNames[ob.id] = ob.name;
    });
    ((items.legacy && items.legacy.ids) || []).forEach(function (l) {
      idx.legacy[l.id] = l;
    });
    return idx;
  }

  // 單一項目是否獲此權限字串放行（領袖「全部」與角色預設由呼叫端處理）
  function canTickItem(allowed, itemId, idx) {
    var tokens = parseTokens(allowed);
    if (tokens.indexOf('*') >= 0) return true;
    if (tokens.indexOf(itemId) >= 0) return true;
    var seg = idx.itemSegment[itemId];
    if (seg && tokens.indexOf(seg) >= 0) return true;
    var badge = idx.itemBadge[itemId];
    if (badge && tokens.indexOf(badge) >= 0) return true;
    if (idx.otherIds[itemId] && tokens.indexOf('OTHER') >= 0) return true;
    return false;
  }

  // 段章完成判斷：completion = 'all'（預設，全部項目）／'one'（任選其一）／'pick'（任選 pick 項）
  function segmentDone(seg, flat) {
    var ids = segmentItemIds(seg);
    var n = ids.filter(function (id) { return !!flat[id]; }).length;
    if (seg.completion === 'one') return n >= 1;
    if (seg.completion === 'pick') return n >= (seg.pick || 1);
    return n === ids.length;
  }

  // 進度中不屬於本學制計完成度的紀錄 — 只顯示，不計完成度
  function legacyEntries(flat, idx, scheme) {
    var items = idx._items;
    var sk = schemeKey(items, scheme || idx.scheme);
    var active = schemeItemIds(items, sk);
    var out = [];
    Object.keys(flat || {}).forEach(function (id) {
      var v = flat[id];
      if (!v || active[id]) return;
      var meta = idx.legacy[id];
      var badge = idx.itemBadge[id];
      var reason;
      if (meta) reason = meta.reason;
      else if (badge && /^S4-/.test(badge)) reason = sk === 'transition'
        ? '舊制（第四版）紀錄，可對照過渡至第五版項目（須核實，不自動計入）'
        : '舊制（第四版）紀錄，不計入本學制完成度';
      else if (idx.itemIds[id]) reason = '第五版項目，不計入舊制（第四版）完成度';
      else reason = '不在現行《樂行童軍訓練綱要》內';
      out.push({
        id: id,
        date: (v && typeof v === 'object') ? String(v.date || '') : String(v),
        name: meta ? meta.name : (idx.itemNames[id] || '未登錄 ID'),
        reason: reason,
        known: !!(meta || idx.itemIds[id])
      });
    });
    out.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
    return out;
  }

  // 權限選單的選項（由 items.json 產生；舊制獎章單獨一組）
  function permissionOptions(items) {
    var opts = [{ value: '*', label: '全部（所有現行獎章與項目）', level: 0, group: 'all' }];
    (items.badges || []).forEach(function (b) {
      opts.push({ value: b.id, label: b.id + ' ' + b.name + '（全部）', level: 0, group: 'badge' });
      (b.segments || []).forEach(function (s) {
        opts.push({ value: s.code, label: (s.formLabel || s.name) + '（段章）', level: 1, group: 'segment', parent: b.id });
      });
    });
    (items.oldBadges || []).forEach(function (b) {
      opts.push({ value: b.id, label: b.id + ' ' + b.name + '（全部，舊制）', level: 0, group: 'old' });
      (b.segments || []).forEach(function (s) {
        opts.push({ value: s.code, label: (s.formLabel || s.name) + '（舊制段章）', level: 1, group: 'old-segment', parent: b.id });
      });
    });
    opts.push({ value: 'OTHER', label: '其他獎章 全部（OT-*）', level: 0, group: 'other' });
    (items.otherBadges || []).forEach(function (ob) {
      opts.push({ value: ob.id, label: (ob.icon || '') + ' ' + ob.name, level: 1, group: 'other', parent: 'OTHER' });
    });
    return opts;
  }

  function execDefaultTokens(items) {
    return parseTokens(items.permissionDefaults && items.permissionDefaults.exec_committee);
  }

  // 用戶管理列表顯示：空字串 + 成員 = 無；領袖空字串 = 全部
  function defaultPermissionString(role, items) {
    var d = items.permissionDefaults || {};
    if (role === 'member') return d.member || '';
    if (role === 'exec_committee') return d.exec_committee || '';
    return d.leader || '*';
  }

  function defaultPermissionLabel(role, items) {
    var s = defaultPermissionString(role, items);
    return s === '' ? '無' : s;
  }

  function countItems(badge) {
    var n = 0;
    (badge.segments || []).forEach(function (s) { n += segmentItemIds(s).length; });
    return n;
  }

  // 首頁四級方塊：全部由 items.json 計算（現行獎章）
  function levelSummaries(items) {
    return (items.badges || []).map(function (b) {
      var parts = [];
      if (b.requirements) {
        if ((b.segments || []).length > 1) parts.push((b.segments.length) + '段考驗');
        parts.push(b.requirements);
      } else {
        parts.push(countItems(b) + '項');
        var mand = [];
        (b.segments || []).forEach(function (s) {
          if (s.items.some(function (it) { return it.mandatory; })) mand.push(s.name);
        });
        if (mand.length) parts.push('含必修「' + mand.join('、') + '」');
        else if ((b.segments || []).length > 1) parts.push((b.segments.length) + '段');
        else parts.push((b.segments || []).map(function (s) { return s.name; }).join('、'));
      }
      return { id: b.id, name: b.name, icon: b.icon || '', desc: parts.join(' • ') };
    });
  }

  return {
    SCHEME_KEYS: SCHEME_KEYS,
    parseTokens: parseTokens,
    segmentItemIds: segmentItemIds,
    allBadges: allBadges,
    findBadge: findBadge,
    findSegment: findSegment,
    schemeKey: schemeKey,
    schemeLabel: schemeLabel,
    schemeBadges: schemeBadges,
    schemeItemIds: schemeItemIds,
    buildIndex: buildIndex,
    canTickItem: canTickItem,
    segmentDone: segmentDone,
    legacyEntries: legacyEntries,
    permissionOptions: permissionOptions,
    execDefaultTokens: execDefaultTokens,
    defaultPermissionString: defaultPermissionString,
    defaultPermissionLabel: defaultPermissionLabel,
    levelSummaries: levelSummaries,
    countItems: countItems
  };
});
