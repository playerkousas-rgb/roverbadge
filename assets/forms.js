/*
 * forms.js — 樂行童軍表格產生器（依 data/items.json 的 forms／legacyForms 定義）
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
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 把 form.rows 展開成列（每列對應一個段章或段章內的部分項目）
  function resolveRows(form, items) {
    var S = scope();
    var l3 = S.findBadge(items, 'L3');
    if (!l3) throw new Error('forms: badge L3 not found');
    var defs = form.rows === 'L3-SEGMENTS'
      ? l3.segments.map(function (s) { return { segment: s.code }; })
      : form.rows;
    return defs.map(function (r) {
      var seg = l3.segments.find(function (s) { return s.code === r.segment; });
      if (!seg) throw new Error('forms: unknown segment ' + r.segment);
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
        completion: r.items ? 'all' : (seg.completion || 'all')
      };
    });
  }

  function rowDone(row, flat) {
    if (row.completion === 'one') return row.itemIds.some(function (id) { return !!flat[id]; });
    return row.itemIds.every(function (id) { return !!flat[id]; });
  }

  function rowDate(row, flat) {
    var ds = row.itemIds.map(function (id) { return flat[id]; }).filter(Boolean).sort();
    return ds.length ? ds[ds.length - 1] : '';
  }

  // 已完成的段章數（同一段章的多列只計一次）
  function doneSegmentCount(rows, flat) {
    var seen = {};
    rows.forEach(function (r) { if (rowDone(r, flat)) seen[r.segment] = true; });
    return Object.keys(seen).length;
  }

  function formTitle(form) {
    return form.name + '（' + form.code + '）';
  }

  function awardNames(items) {
    return (items.badges || []).filter(function (b) { return b.id === 'L3' || b.id === 'L4'; })
      .map(function (b) { return b.name; });
  }

  function buildForm(type, ctx) {
    var items = ctx.items;
    var form = (items.forms || {})[type];
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
        awardNames(items).map(function (n) { return '☐ ' + esc(n); }).join('　') + '</div>');
    }

    // (2) 考驗項目
    var secTitle = type === 'PT69' ? '(2) 考驗計劃 Assessment Plan' : '(2) 考驗項目 Components';
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
      if (form.columns && form.columns.length === 3 && type === 'PT69') {
        h.push('<tr><td>' + label + '</td><td><input style="width:95%"></td><td><input type="date" style="width:100%"></td></tr>');
      } else {
        h.push('<tr><td>' + label + '</td><td><input style="width:95%"></td><td><input type="date" value="' + esc(date) + '" style="width:100%"></td><td><input style="width:95%"></td><td><input style="width:95%"></td></tr>');
      }
    });
    h.push('</table>');

    if (form.certField) {
      h.push('<table class="print-table" style="font-size:11px;margin-top:8px"><tr><td style="width:50%">' + esc(form.certField.label) +
        (form.certField.required ? ' <b style="color:#B00020">（必填）</b>' : '') + '</td><td><input style="width:95%"></td></tr></table>');
    }

    // (3) 簽署程序
    h.push('<div class="form-section" style="font-size:12px;font-weight:700;background:#F0F0F0;padding:4px 8px;border:1px solid #000;margin-top:10px">(3) 簽署及批核 Endorsement</div>');
    h.push('<table class="print-table" style="font-size:11px"><tr><th>程序 Stage</th><th>簽署人 Signer</th><th>簽署 Signature</th><th>日期 Date</th><th>印章 Stamp</th></tr>');
    (form.stages || []).forEach(function (st) {
      h.push('<tr><td>' + esc(st.no + '. ' + st.title) + '</td><td>' + esc(st.signer) + '</td><td></td><td></td><td>' + esc(st.stamp || '') + '</td></tr>');
    });
    h.push('</table>');

    h.push('<div style="margin-top:10px;font-size:9px;background:#E3F2FD;padding:6px;border-radius:4px">' +
      '本列印版依《樂行童軍支部' + esc(form.edition) + '》官方表格排版，內容（項目、簽署程序）取自 items.json。' +
      '正式遞交請以官方 PDF 為準：<a href="' + esc(form.officialUrl) + '" target="_blank" rel="noopener">' + esc(form.officialUrl) + '</a></div>');
    h.push('</div>');
    return h.join('');
  }

  // 生成按鈕（依 items.forms 逐個產生）
  function formButtonsHtml(items) {
    return Object.keys(items.forms || {}).map(function (key) {
      var f = items.forms[key];
      return '<button class="btn btn-primary" onclick="generatePrintableForm(\'' + esc(key) + '\')">🖨️ ' + esc(f.code) + ' ' + esc(f.name) + '</button>';
    }).join('');
  }

  // 官方表格連結卡（新制＋舊制；舊制標明不由本系統產生）
  function officialLinksHtml(items) {
    var out = [];
    Object.keys(items.forms || {}).forEach(function (key) {
      var f = items.forms[key];
      out.push('<a href="' + esc(f.officialUrl) + '" target="_blank" rel="noopener" class="link-card"><div class="link-icon">📄</div><div class="link-text"><div class="title">' + esc(f.code) + ' ' + esc(f.name) + '</div><div class="url">新制（第五版）官方表格 (PDF)</div></div></a>');
    });
    Object.keys(items.legacyForms || {}).forEach(function (key) {
      var f = items.legacyForms[key];
      out.push('<a href="' + esc(f.officialUrl) + '" target="_blank" rel="noopener" class="link-card" style="opacity:.75"><div class="link-icon">🗃️</div><div class="link-text"><div class="title">' + esc(f.code) + ' ' + esc(f.name) + '</div><div class="url">舊制（第四版）· 僅供已依舊制考驗者參考</div></div></a>');
    });
    return out.join('');
  }

  return {
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
