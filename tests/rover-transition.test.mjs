import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import items from '../data/items.json' with { type: 'json' };
import itemsEn from '../data/items_en.json' with { type: 'json' };

const html = fs.readFileSync('index.html', 'utf8');

test('Rover legacy transition follows P022/2026 and contains Rover, not Venture, mapping', () => {
  const transition = items.legacyTransition;
  assert.equal(transition.effectiveDate, '2026-08-15');
  assert.equal(transition.deadline, '2029-08-14');
  assert.match(transition.sourceUrl, /p022-26\.pdf$/);
  assert.match(transition.title, /第四版.*第五版/);
  assert.equal(transition.mappings.length, 9);
  assert.ok(transition.mappings.some(row => row.old.includes('童軍技能（I）') && row.new.includes('服務')));
  assert.ok(transition.mappings.some(row => row.old.includes('個人興趣') && row.new.includes('身心健康')));
  assert.ok(transition.additionalNotes.some(row => row.zh.includes('木章訓練系統')));
  assert.ok(!JSON.stringify(transition).includes('深資童軍'));
  assert.deepEqual(itemsEn.legacyTransition, transition, 'English catalog uses the same policy content and bilingual fields');
  assert.match(html, /第四版已完成項目/);
  assert.match(html, /submitFeedback/);
  assert.match(html, /deliveryStatus==='confirmed'/);
  assert.match(html, /正在傳送，請稍候/);
});
