/* ============================================================
 * ROVERBOOK 匯出二維碼（純前端、零依賴、離線可用）
 *
 * 為什麼自己寫：本系統前端係單一 index.html + assets/ 經典 script，
 * 冇打包器、冇 npm runtime 依賴。加一條 CDN <script> 會令「離線可用」失效，
 * 亦會令部署多一個外部信任點。所以 QR 編碼器（byte mode、ECC L/M/Q/H、
 * version 1–40、自動選版本 + 自動選遮罩）直接寫喺呢個檔案，
 * 只輸出 SVG／矩陣，唔會發任何網絡請求。
 *
 * 介面（UMD；瀏覽器掛 window.RoverQr，Node 可 require）：
 *   RoverQr.encode(text, { ecl: 'M' })  → { version, size, ecl, mask, modules[][] }
 *   RoverQr.svg(text, opts)             → SVG 字串（可直接 innerHTML）
 *   RoverQr.VERSION                     → 模組版本
 *   RoverQr.MAX_VERSION                 → 40
 *
 * 規格：ISO/IEC 18004。只實作 byte mode（UTF-8）——足夠應付
 * 「https://…#rb=RBC1.…」這類純 ASCII 匯入連結；中文內容會以 UTF-8 bytes 編碼。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoverQr = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_VERSION = 40;

  // ECC 每區塊錯誤更正碼字數（index = version，0 位不用）
  var ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  };

  // 錯誤更正區塊數（index = version，0 位不用）
  var NUM_ECC_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 2, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 2, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  };

  // 格式資訊用的 ECC 編號（L=1, M=0, Q=3, H=2）
  var ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function bit(x, i) { return ((x >>> i) & 1) !== 0; }

  // GF(2^8) 乘法（本原多項式 0x11D）
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  // Reed–Solomon 生成多項式（次數 degree，最高次項係 1）
  function rsDivisor(degree) {
    var result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  // 計算 data 的 RS 餘數（錯誤更正碼字）
  function rsRemainder(data, divisor) {
    var result = new Array(divisor.length).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result.shift();
      result.push(0);
      for (var j = 0; j < divisor.length; j++) result[j] ^= gfMul(divisor[j], factor);
    }
    return result;
  }

  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ECC_BLOCKS[ecl][ver];
  }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var size = ver * 4 + 17;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function utf8Bytes(text) {
    var s = String(text == null ? '' : text);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(out);
  }

  function chooseVersion(byteLen, ecl) {
    for (var ver = 1; ver <= MAX_VERSION; ver++) {
      var ccBits = ver <= 9 ? 8 : 16;
      var usedBits = 4 + ccBits + byteLen * 8;
      if (usedBits <= dataCodewords(ver, ecl) * 8) return ver;
    }
    return -1;
  }

  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = NUM_ECC_BLOCKS[ecl][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var divisor = rsDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var col = 0; col < blocks[0].length; col++) {
      for (var b = 0; b < blocks.length; b++) {
        // 短區塊的 padding byte（0）要跳過
        if (col !== shortBlockLen - blockEccLen || b >= numShortBlocks) result.push(blocks[b][col]);
      }
    }
    return result;
  }

  function encode(text, opts) {
    var options = opts || {};
    var ecl = String(options.ecl || 'M').toUpperCase();
    if (!ECC_CODEWORDS_PER_BLOCK[ecl]) ecl = 'M';
    var bytes = utf8Bytes(text);
    var ver = chooseVersion(bytes.length, ecl);
    if (ver < 0) throw new Error('內容太長，一個二維碼放唔落（QR 上限 ' + MAX_VERSION + ' 版）');

    var ccBits = ver <= 9 ? 8 : 16;
    var capacityBits = dataCodewords(ver, ecl) * 8;
    var bits = [];
    function append(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    append(0x4, 4); // byte mode
    append(bytes.length, ccBits);
    for (var i = 0; i < bytes.length; i++) append(bytes[i], 8);
    // terminator + 補齊到 byte
    var term = Math.min(4, capacityBits - bits.length);
    append(0, term);
    append(0, (8 - (bits.length % 8)) % 8);
    // pad bytes
    for (var pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) append(pad, 8);

    var dataCw = [];
    for (var j = 0; j < bits.length; j += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[j + k];
      dataCw.push(v);
    }

    var allCw = addEccAndInterleave(dataCw, ver, ecl);
    var size = ver * 4 + 17;
    var modules = [], isFunction = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }

    function setFn(x, y, dark) {
      modules[y][x] = !!dark;
      isFunction[y][x] = true;
    }

    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = cx + dx, yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }

    function drawAlignment(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    // 固定圖案
    for (var t = 0; t < size; t++) {
      setFn(6, t, t % 2 === 0);
      setFn(t, 6, t % 2 === 0);
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);
    var align = alignmentPositions(ver);
    var numAlign = align.length;
    for (var ai = 0; ai < numAlign; ai++) {
      for (var aj = 0; aj < numAlign; aj++) {
        // 三個角落唔畫（已被 finder 佔用）
        if ((ai === 0 && aj === 0) || (ai === 0 && aj === numAlign - 1) || (ai === numAlign - 1 && aj === 0)) continue;
        drawAlignment(align[ai], align[aj]);
      }
    }

    function drawFormatBits(mask) {
      var data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fmt = ((data << 10) | rem) ^ 0x5412;
      for (var a = 0; a <= 5; a++) setFn(8, a, bit(fmt, a));
      setFn(8, 7, bit(fmt, 6));
      setFn(8, 8, bit(fmt, 7));
      setFn(7, 8, bit(fmt, 8));
      for (var b = 9; b < 15; b++) setFn(14 - b, 8, bit(fmt, b));
      for (var c = 0; c < 8; c++) setFn(size - 1 - c, 8, bit(fmt, c));
      for (var d = 8; d < 15; d++) setFn(8, size - 15 + d, bit(fmt, d));
      setFn(8, size - 8, true); // 固定深色模組
    }

    function drawVersion() {
      if (ver < 7) return;
      var rem = ver;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bitsVal = (ver << 12) | rem;
      for (var j = 0; j < 18; j++) {
        var b = bit(bitsVal, j);
        var a = size - 11 + (j % 3);
        var c = Math.floor(j / 3);
        setFn(a, c, b);
        setFn(c, a, b);
      }
    }

    // 先畫格式資訊佔位（避免資料寫入），最後再按遮罩重畫
    drawFormatBits(0);
    drawVersion();

    // 寫入 codewords（右下角 zigzag）
    var bitIdx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var jj = 0; jj < 2; jj++) {
          var x = right - jj;
          var upward = ((right + 1) & 2) === 0;
          var yy2 = upward ? size - 1 - vert : vert;
          if (!isFunction[yy2][x] && bitIdx < allCw.length * 8) {
            modules[yy2][x] = bit(allCw[bitIdx >>> 3], 7 - (bitIdx & 7));
            bitIdx++;
          }
        }
      }
    }

    var MASKS = [
      function (x, y) { return (x + y) % 2 === 0; },
      function (x, y) { return y % 2 === 0; },
      function (x, y) { return x % 3 === 0; },
      function (x, y) { return (x + y) % 3 === 0; },
      function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function (x, y) { return (x * y) % 2 + (x * y) % 3 === 0; },
      function (x, y) { return ((x * y) % 2 + (x * y) % 3) % 2 === 0; },
      function (x, y) { return ((x + y) % 2 + (x * y) % 3) % 2 === 0; }
    ];

    function applyMask(mask) {
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
        }
      }
    }

    // 遮罩罰分（ISO 18004 §8.8.2 四條規則）
    function penalty() {
      var score = 0, x, y;
      // 規則 1：連續 5 個以上同色
      for (y = 0; y < size; y++) {
        for (var dir = 0; dir < 2; dir++) {
          var run = 1;
          for (x = 1; x < size; x++) {
            var cur = dir === 0 ? modules[y][x] : modules[x][y];
            var prev = dir === 0 ? modules[y][x - 1] : modules[x - 1][y];
            if (cur === prev) {
              run++;
              if (run === 5) score += 3;
              else if (run > 5) score += 1;
            } else run = 1;
          }
        }
      }
      // 規則 2：2×2 同色
      for (y = 0; y < size - 1; y++) {
        for (x = 0; x < size - 1; x++) {
          var c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
      }
      // 規則 3：1:1:3:1:1 類似 finder 的圖案（兩邊各 4 個淺色）
      function lineScore(get) {
        var s = 0;
        for (var i = 0; i + 10 < size; i++) {
          if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6) &&
              !get(i + 7) && !get(i + 8) && !get(i + 9) && !get(i + 10)) s += 40;
          if (!get(i) && !get(i + 1) && !get(i + 2) && !get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6) &&
              get(i + 7) && get(i + 8) && !get(i + 9) && get(i + 10)) s += 40;
        }
        return s;
      }
      for (y = 0; y < size; y++) {
        (function (row) { score += lineScore(function (i) { return modules[row][i]; }); })(y);
        (function (col) { score += lineScore(function (i) { return modules[i][col]; }); })(y);
      }
      // 規則 4：深淺比例偏離 50%
      var dark = 0;
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (modules[y][x]) dark++;
      var total = size * size;
      var k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
      score += k * 10;
      return score;
    }

    var bestMask = 0, bestScore = Infinity;
    var bestSnapshot = null;
    for (var mask = 0; mask < 8; mask++) {
      applyMask(mask);
      drawFormatBits(mask);
      var s = penalty();
      if (s < bestScore) {
        bestScore = s;
        bestMask = mask;
        bestSnapshot = modules.map(function (row) { return row.slice(); });
      }
      applyMask(mask); // XOR 兩次 = 還原
    }
    modules = bestSnapshot;

    return { version: ver, size: size, ecl: ecl, mask: bestMask, modules: modules };
  }

  function svg(text, opts) {
    var options = opts || {};
    var qr = encode(text, options);
    var margin = options.margin === undefined ? 4 : Math.max(0, Math.floor(options.margin));
    var dim = qr.size + margin * 2;
    var cell = options.cell || 1; // SVG 用 viewBox，cell 只影響 width/height 屬性
    var dark = options.dark || '#000000';
    var light = options.light || '#ffffff';
    var title = options.title || 'ROVERBOOK QR';
    var parts = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) parts.push('M' + (x + margin) + ' ' + (y + margin) + 'h1v1h-1z');
      }
    }
    var px = dim * cell;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" width="' + px + '" height="' + px +
      '" role="img" aria-label="' + escapeXml(title) + '" shape-rendering="crispEdges">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + escapeXml(light) + '"/>' +
      '<path fill="' + escapeXml(dark) + '" d="' + parts.join('') + '"/></svg>';
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  return { VERSION: VERSION, MAX_VERSION: MAX_VERSION, encode: encode, svg: svg, dataCodewords: dataCodewords, alignmentPositions: alignmentPositions };
});
