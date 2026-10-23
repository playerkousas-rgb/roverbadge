// 前端每個 apiRequest('動作') 都必須被 api/proxy.js 接受（否則前端功能會在代理層直接失敗）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const proxy = readFileSync(new URL('../api/proxy.js', import.meta.url), 'utf8');

function setOf(name) {
  const m = proxy.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(m, `${name} not found in api/proxy.js`);
  return new Set([...m[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1]));
}

test('前端呼叫的每個 action 都在代理層允許清單內', () => {
  const accepted = new Set([...setOf('PUBLIC_ACTIONS'), ...setOf('TOKEN_ACTIONS'), ...setOf('LOCAL_ACTIONS')]);
  const used = [...new Set([...html.matchAll(/apiRequest\('([A-Za-z]+)'/g)].map(m => m[1]))];
  assert.ok(used.length > 10, 'expected to find apiRequest calls in index.html');
  const missing = used.filter(a => !accepted.has(a));
  assert.deepEqual(missing, [], '以下前端動作會被代理層拒絕（不支援的操作）');
});

test('setScheme 必須經 token 驗證（非公開動作）', () => {
  assert.ok(setOf('TOKEN_ACTIONS').has('setScheme'));
  assert.ok(!setOf('PUBLIC_ACTIONS').has('setScheme'));
});
