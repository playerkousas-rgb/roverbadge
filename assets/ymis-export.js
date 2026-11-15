(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  }
  root.YmisExport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var YMIS_SECTION = 'Rover Scout';
  var YMIS_SHEET_NAME = 'Sheet1';
  var YMIS_HEADERS = [
    'Scout ID',
    'Badge-Section',
    'Badge-Badge',
    'Badge-award date (YYYYMMDD)'
  ];

  // 只支援以下 3 款樂行童軍獎章（不含樂行童軍肩章）
  var YMIS_BADGES = [
    {
      key: 'L1',
      zh: '會員章',
      en: 'Membership Badge',
      ymisBadge: 'Membership Badge'
    },
    {
      key: 'L3',
      zh: '樂行童軍獎章',
      en: 'Rover Scout Award',
      ymisBadge: 'Rover Scout Award'
    },
    {
      key: 'L4',
      zh: '貝登堡獎章',
      en: 'Baden-Powell Award',
      ymisBadge: 'Baden-Powell Award'
    }
  ];

  var YMIS_BADGE_MAP = {};
  for (var i = 0; i < YMIS_BADGES.length; i++) {
    YMIS_BADGE_MAP[YMIS_BADGES[i].key] = YMIS_BADGES[i];
  }

  function isValidScoutId(id) {
    return typeof id === 'string' && /^\d{10}$/.test(id.trim());
  }

  function formatAwardDate(isoDate) {
    if (typeof isoDate !== 'string') return '';
    var m = isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    var y = parseInt(m[1], 10);
    var mo = parseInt(m[2], 10);
    var d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== mo - 1 ||
      dt.getUTCDate() !== d
    ) {
      return '';
    }
    return m[1] + m[2] + m[3];
  }

  function buildYmisRows(opts) {
    opts = opts || {};
    var members = Array.isArray(opts.members) ? opts.members : [];
    var badgeKey = opts.badgeKey;
    var badge = YMIS_BADGE_MAP[badgeKey];
    if (!badge) {
      throw new Error('Unsupported YMIS badge: ' + String(badgeKey || ''));
    }
    var yyyymmdd = formatAwardDate(opts.awardDate);
    if (!yyyymmdd) {
      throw new Error('Invalid award date (expected YYYY-MM-DD)');
    }

    var seen = Object.create(null);
    var rows = [];
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var rawId = m && typeof m.ymis === 'string' ? m.ymis.trim() : '';
      if (!isValidScoutId(rawId)) continue;
      if (seen[rawId]) continue; // 同一成員同一獎章不可重複
      seen[rawId] = true;

      rows.push({
        'Scout ID': rawId,
        'Badge-Section': YMIS_SECTION,
        'Badge-Badge': badge.ymisBadge,
        'Badge-award date (YYYYMMDD)': yyyymmdd
      });
    }
    return rows;
  }

  function buildYmisWorkbook(XLSX, rows) {
    if (!XLSX || !XLSX.utils) {
      throw new Error('SheetJS (XLSX) is not loaded');
    }
    var ws = XLSX.utils.json_to_sheet(rows, { header: YMIS_HEADERS });
    // 強制將 Scout ID (A 欄) 與日期 (D 欄) 設為文字儲存，保留前導零
    var range = XLSX.utils.decode_range(ws['!ref'] || 'A1:D1');
    for (var r = 1; r <= range.e.r; r++) {
      var idCell = ws[XLSX.utils.encode_cell({ r: r, c: 0 })];
      if (idCell) {
        idCell.t = 's';
        idCell.v = String(idCell.v);
        idCell.z = '@';
      }
      var dateCell = ws[XLSX.utils.encode_cell({ r: r, c: 3 })];
      if (dateCell) {
        dateCell.t = 's';
        dateCell.v = String(dateCell.v);
        dateCell.z = '@';
      }
    }
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, YMIS_SHEET_NAME);
    return wb;
  }

  function makeExportFilename(badgeKey, yyyymmdd) {
    var safeKey = String(badgeKey || 'badge').replace(/[^A-Za-z0-9_-]/g, '');
    return 'ymis-rover-awards-' + safeKey + '-' + yyyymmdd + '.xlsx';
  }

  return {
    YMIS_SECTION: YMIS_SECTION,
    YMIS_SHEET_NAME: YMIS_SHEET_NAME,
    YMIS_HEADERS: YMIS_HEADERS,
    YMIS_BADGES: YMIS_BADGES,
    YMIS_BADGE_MAP: YMIS_BADGE_MAP,
    isValidScoutId: isValidScoutId,
    formatAwardDate: formatAwardDate,
    buildYmisRows: buildYmisRows,
    buildYmisWorkbook: buildYmisWorkbook,
    makeExportFilename: makeExportFilename
  };
});
