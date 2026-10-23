/*
 * forms.js — 樂行童軍表格產生器（依 data/items.json 的 forms（新制）／oldForms（舊制）定義）
 *
 * 表格結構、考驗範疇、簽署程序全部來自 items.json；本檔只負責排版與帶入資料。
 * 依賴 assets/rover-scope.js（先載入）。
 * 瀏覽器：window.RoverForms；Node（測試）：module.exports。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.RoverForms = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function scope() {
    var S = (typeof globalThis !== 'undefined' && globalThis.RoverScope) || null;
    if (!S) throw new Error('forms.js: rover-scope.js must be loaded first');
    return S;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>\"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 新制表格（forms）與舊制表格（oldForms）合併查找
  function allForms(items) {
    var out = {};
    Object.keys(items.forms || {}).forEach(function (k) { out[k] = items.forms[k]; });
    Object.keys(items.oldForms || {}).forEach(function (k) { out[k] = items.oldForms[k]; });
    return out;
  }

  function formsForScheme(items, scheme) {
    var S = scope();
    var def = (items.schemes && items.schemes.list && items.schemes.list[S.schemeKey(items, scheme)]) || {};
    var all = allForms(items);
    return (def.forms || Object.keys(items.forms || {})).filter(function (k) { return !!all[k]; });
  }

  // 把 form.rows 展開成列。段章可在所有獎章（現行＋舊制）中查找；
  // 列可指定 items 子集（舊制選修：每個選修一列）。
  function resolveRows(form, items) {
    var S = scope();
    var defs;
    if (form.rows === 'L3-SEGMENTS') {
      var l3 = S.findBadge(items, 'L3');
      if (!l3) throw new Error('forms: badge L3 not found');
      defs = l3.segments.map(function (s) { return { segment: s.code }; });
    } else {
      defs = form.rows;
    }
    return defs.map(function (r) {
      var hit = S.findSegment(items, r.segment);
      if (!hit) throw new Error('forms: unknown segment ' + r.segment);
      var seg = hit.segment;
      var segIds = S.segmentItemIds(seg);
      var ids = r.items ? r.items.slice() : segIds.slice();
      ids.forEach(function (id) {
        if (segIds.indexOf(id) < 0) throw new Error('forms: item ' + id + ' is not in ' + seg.code);
      });
      return {
        segment: seg.code,
        label: r.label || seg.formLabel || seg.name,
        hint: r.hint || '',
        summary: seg.formSummary || '',
        itemIds: ids,
        isSub: !!r.items,
        segItemIds: segIds,
        segCompletion: seg.completion || 'all',
        pick: seg.pick || 1
      };
    });
  }

  // 列是否已完成：子集列 = 其項目全部完成；整段列 = 依段章規則（all／one／pick）
  function rowDone(row, flat) {
    if (row.isSub || row.segCompletion === 'all') return row.itemIds.every(function (id) { return !!flat[id]; });
    return segDone(row, flat);
  }

  function segDone(row, flat) {
    var n = row.segItemIds.filter(function (id) { return !!flat[id]; }).length;
    if (row.segCompletion === 'one') return n >= 1;
    if (row.segCompletion === 'pick') return n >= row.pick;
    return n === row.segItemIds.length;
  }

  function rowDate(row, flat) {
    var ds = row.itemIds.map(function (id) { return flat[id]; }).filter(Boolean).sort();
    return ds.length ? ds[ds.length - 1] : '';
  }

  // 已完成的段章數（依段章本身的完成規則；同一段章的多列只計一次）
  function doneSegmentCount(rows, flat) {
    var seen = {};
    rows.forEach(function (r) { if (!seen[r.segment] && segDone(r, flat)) seen[r.segment] = true; });
    return Object.keys(seen).length;
  }

  function formTitle(form) {
    return form.name + '（' + form.code + '）';
  }

  // awardChoice：true = 現行 L3／L4；陣列 = 指定獎章 ID（舊制 PT/69）
  function awardNames(items, choice) {
    var ids = Array.isArray(choice) ? choice : ['L3', 'L4'];
    var S = scope();
    return ids.map(function (id) { return S.findBadge(items, id); }).filter(Boolean).map(function (b) { return b.name; });
  }

  function buildForm(type, ctx) {
    var items = ctx.items;
    var form = allForms(items)[type];
    if (!form) throw new Error('forms: unknown form ' + type);
    var flat = ctx.flat || {};
    var member = ctx.member || {};
    var today = ctx.today || '';
    var rows = resolveRows(form, items);
    var prefill = form.prefillDates !== false;
    var h = [];

    h.push('<div class="print-area" id="officialForm" data-form="' + esc(type) + '">');
    h.push('<div style="text-align:center;border-bottom:3px double #000;padding-bottom:10px;margin-bottom:12px">');
    h.push('<div style="font-size:12px;font-weight:700">香港童軍總會 Scout Association of Hong Kong · 樂行童軍支部 Rover Scout Section</div>');
    h.push('<div style="font-size:15px;font-weight:800;margin-top:4px">' + esc(formTitle(form)) + '</div>');
    h.push('<div style="font-size:11px">' + esc(form.edition) + ' · ' + esc(form.description) + '</div>');
    h.push('</div>');

    // (1) 個人摘要
    h.push('<div class="form-section" style="font-size:12px;font-weight:700;background:#F0F0F0;padding:4px 8px;border:1px solid #000">(1) 個人摘要 Personal Particulars</div>');
    h.push('<table class="print-table" style="font-size:11px"><tr>' +
      '<td>姓名 Name（須與身份證相同）</td><td><input value="' + esc(member.name) + '" style="width:90%"></td>' +
      '<td>童軍成員編號 Scout ID (YMIS)</td><td><input value="' + esc(member.ymis) + '" style="width:90%"></td></tr>' +
      '<tr><td>所屬旅團 Group</td><td><input value="' + esc(ctx.troopName || '') + '" style="width:90%"></td>' +
      '<td>申請日期 Date of Application</td><td><input type="date" value="' + esc(today) + '"></td></tr></table>');

    if (form.awardChoice) {
      h.push('<div style="font-size:11px;margin:6px 0">申請獎章 Award applied for：' +
        awardNames(items, form.awardChoice).map(function (n) { return '☐ ' + esc(n); }).join('　') + '</div>');
    }

    // (2) 考驗項目
    var secTitle = type.indexOf('PT69') === 0 ? '(2) 考驗計劃 Assessment Plan' : '(2) 考驗項目 Components';
    h.push('<div class="form-section" style="font-size:12px;font-weight:700;background:#F0F0F0;padding:4px 8px;border:1px solid #000;margin-top:10px">' + secTitle + '</div>');
    var doneN = doneSegmentCount(rows, flat);
    if (form.rule) {
      h.push('<div style="font-size:11px;margin:4px 0">' + esc(form.rule.text) + '　｜　本成員已完成 <b>' + doneN + '</b> 段（系統計算，僅供參考）</div>');
    }
    var cols = form.columns || [];
    h.push('<table class="print-table" style="font-size:11px"><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>');
    rows.forEach(function (r) {
      // 計劃申請（progressTicks:false，如 PT/69）不勾選已完成狀態
      var done = form.progressTicks !== false && rowDone(r, flat);
      var label = (done ? '☑ ' : '☐ ') + esc(r.label) +
        (r.summary ? '<br><small>' + esc(r.summary) + '</small>' : '') +
        (r.hint ? '<br><small style="color:#B00020">' + esc(r.hint) + '</small>' : '');
      var date = prefill ? rowDate(r, flat) : '';
      if (cols.length === 3) {
        h.push('<tr><td>' + label + '</td><td><input style="width:95%"></td><td><input type="date" style="width:100%"></td></tr>');
      } else if (cols.length === 4) {
        h.push('<tr><td>' + label + '</td><td><input style="width:95%"></td><td><input style="width:95%"></td><td><input style="width:95%"></td></tr>');
      } else {
        h.push('<tr><td>' + label + '</td><td><input style="width:95%"></td><td><input type="date" value="' + esc(date) + '" style="width:100%"></td><td><input style="width:95%"></td><td><input style="width:95%"></td></tr>');
      }
    });
    h.push('</table>');

    var extra = [];
    if (form.certField) extra.push(form.certField);
    (form.extraFields || []).forEach(function (f) { extra.push(f); });
    if (extra.length) {
      h.push('<table class="print-table" style="font-size:11px;margin-top:8px">');
      extra.forEach(function (f) {
        h.push('<tr><td style="width:50%">' + esc(f.label) +
          (f.required ? ' <b style="color:#B00020">（必填）</b>' : '') + '</td><td><input style="width:95%"></td></tr>');
      });
      h.push('</table>');
    }

    // (3) 簽署程序
    h.push('<div class="form-section" style="font-size:12px;font-weight:700;background:#F0F0F0;padding:4px 8px;border:1px solid #000;margin-top:10px">(3) 簽署及批核 Endorsement</div>');
    h.push('<table class="print-table" style="font-size:11px"><tr><th>程序 Stage</th><th>簽署人 Signer</th><th>簽署 Signature</th><th>日期 Date</th><th>印章 Stamp</th></tr>');
    (form.stages || []).forEach(function (st) {
      h.push('<tr><td>' + esc((st.no ? st.no + '. ' : '') + st.title) + '</td><td>' + esc(st.signer) + '</td><td></td><td></td><td>' + esc(st.stamp || '') + '</td></tr>');
    });
    h.push('</table>');

    h.push('<div style="margin-top:10px;font-size:9px;background:#E3F2FD;padding:6px;border-radius:4px">' +
      '本列印版依《樂行童軍支部' + esc(form.edition) + '》官方表格排版，內容（項目、簽署程序）取自 items.json。' +
      '正式遞交請以官方 PDF 為準：<a href="' + esc(form.officialUrl) + '" target="_blank" rel="noopener">' + esc(form.officialUrl) + '</a></div>');
    h.push('</div>');
    return h.join('');
  }

  // 生成按鈕（依學制逐個產生）
  function formButtonsHtml(items, scheme) {
    var all = allForms(items);
    return formsForScheme(items, scheme).map(function (key) {
      var f = all[key];
      return '<button class="btn btn-primary" onclick="generatePrintableForm(\'' + esc(key) + '\')">🖨️ ' + esc(f.code) + ' ' + esc(f.name) + '</button>';
    }).join('');
  }

  // 官方表格連結卡（新制＋舊制，標明版本）
  function officialLinksHtml(items) {
    var out = [];
    var groups = [
      { forms: items.forms || {}, icon: '📄', tag: '新制（第五版）官方表格 (PDF)' },
      { forms: items.oldForms || {}, icon: '🗃️', tag: '舊制（第四版）官方表格 (PDF)・僅供沿用第四版者' }
    ];
    groups.forEach(function (g) {
      Object.keys(g.forms).forEach(function (key) {
        var f = g.forms[key];
        out.push('<a href="' + esc(f.officialUrl) + '" target="_blank" rel="noopener" class="link-card"><div class="link-icon">' + g.icon + '</div><div class="link-text"><div class="title">' + esc(f.code) + ' ' + esc(f.name) + '</div><div class="url">' + esc(g.tag) + '</div></div></a>');
      });
    });
    return out.join('');
  }

  return {
    allForms: allForms,
    formsForScheme: formsForScheme,
    resolveRows: resolveRows,
    rowDone: rowDone,
    rowDate: rowDate,
    doneSegmentCount: doneSegmentCount,
    buildForm: buildForm,
    formButtonsHtml: formButtonsHtml,
    officialLinksHtml: officialLinksHtml,
    escapeHtml: esc
  };
});
