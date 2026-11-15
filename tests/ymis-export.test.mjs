import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../assets/ymis-export.js');
const YmisExport = globalThis.YmisExport;

let pass = 0;
function test(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  pass++;
}

console.log('=== YMIS 獎章匯出（試行版）測試 ===\n');

test('常數與工作表欄名逐字一致', () => {
  assert.equal(YmisExport.YMIS_SECTION, 'Rover Scout');
  assert.equal(YmisExport.YMIS_SHEET_NAME, 'Sheet1');
  assert.deepEqual(YmisExport.YMIS_HEADERS, [
    'Scout ID',
    'Badge-Section',
    'Badge-Badge',
    'Badge-award date (YYYYMMDD)'
  ]);
});

test('只支援 3 款樂行童軍獎章（不含肩章）', () => {
  assert.equal(YmisExport.YMIS_BADGES.length, 3);
  assert.equal(YmisExport.YMIS_BADGE_MAP.L1.zh, '會員章');
  assert.equal(YmisExport.YMIS_BADGE_MAP.L1.ymisBadge, 'Membership Badge');
  assert.equal(YmisExport.YMIS_BADGE_MAP.L3.zh, '樂行童軍獎章');
  assert.equal(YmisExport.YMIS_BADGE_MAP.L3.ymisBadge, 'Rover Scout Award');
  assert.equal(YmisExport.YMIS_BADGE_MAP.L4.zh, '貝登堡獎章');
  assert.equal(YmisExport.YMIS_BADGE_MAP.L4.ymisBadge, 'Baden-Powell Award');
  assert.equal(YmisExport.YMIS_BADGE_MAP.L2, undefined);
});

test('Scout ID 必須係 10 位數字（保留前導零）', () => {
  assert.equal(YmisExport.isValidScoutId('0000081420'), true);
  assert.equal(YmisExport.isValidScoutId('1234567890'), true);
  assert.equal(YmisExport.isValidScoutId('81420'), false);
  assert.equal(YmisExport.isValidScoutId('12345678901'), false);
  assert.equal(YmisExport.isValidScoutId('L000000001'), false);
  assert.equal(YmisExport.isValidScoutId(''), false);
});

test('日期轉換 YYYY-MM-DD → YYYYMMDD 並驗證合法性', () => {
  assert.equal(YmisExport.formatAwardDate('2026-11-15'), '20261115');
  assert.equal(YmisExport.formatAwardDate('2026-02-30'), '');
  assert.equal(YmisExport.formatAwardDate(''), '');
});

test('buildYmisRows 去重、過濾無效 ID、保留前導零', () => {
  const rows = YmisExport.buildYmisRows({
    badgeKey: 'L3',
    awardDate: '2026-11-15',
    members: [
      { name: 'A', ymis: '0000081420' },
      { name: 'A-dup', ymis: '0000081420' },
      { name: 'B', ymis: '81420' },
      { name: 'C', ymis: 'L123456789' },
      { name: 'D', ymis: '1234560001' }
    ]
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    'Scout ID': '0000081420',
    'Badge-Section': 'Rover Scout',
    'Badge-Badge': 'Rover Scout Award',
    'Badge-award date (YYYYMMDD)': '20261115'
  });
  assert.equal(rows[1]['Scout ID'], '1234560001');
});

test('index.html 角色檢查、SRI 與試行提示完整', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.includes('<script src="assets/ymis-export.js"></script>'));
  assert.ok(html.includes('isYmisLeaderRole()'));
  assert.ok(html.includes('sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA=='));
  assert.ok(html.includes('尚未有真實資料喺 YMIS 實測；匯出不等於匯入成功；冇跨次重複上傳偵測。'));
});

console.log(`\n=== 結果：${pass} 通過，0 失敗 ===`);
