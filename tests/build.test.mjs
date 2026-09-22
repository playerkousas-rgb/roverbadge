// 部署產物守護：npm run build 產出的 Vercel Build Output 必須
//   1) 只含 .vercelignore 之後的靜態檔（tests/scripts/機密 MD 一律唔上線）
//   2) 5 個 function bundle 全部可獨立起 server 並回應正確 method
//   3) 公開的 Code.gs 唔含版號字樣
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel', 'output');

test('Build Output API 只含 .vercelignore 之後的靜態檔＋5 個可運行 function', async t => {
  // 自含式：每次測試都重跑 build（快、零依賴、冪等）
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { stdio: 'pipe' });

  const config = JSON.parse(fs.readFileSync(path.join(out, 'config.json'), 'utf8'));
  assert.equal(config.version, 3);

  const files = fs.readdirSync(out, { recursive: true }).map(String);
  // 排除底線：機密／開發檔一律唔可以出現
  for (const bad of [
    'tests', 'scripts', '.git', 'node_modules', 'i18n_dict.tsv', 'build_i18n.py',
    'VERCEL_ENV_SETUP.md', 'APP_ADMIN_WORKFLOW.md', '.vercelignore',
    'docs/AGENT_TEMPLATE_FOR_OTHER_SECTIONS.md', 'docs/DEPLOY_GUIDE_V5_DUALTRACK.md',
    'docs/MAIN_SYSTEM_INTEGRATION.md', 'docs/VERCEL_API_404_POSTMORTEM.md',
    'docs/TROOP_UPGRADE_2026.md'
  ]) {
    assert.equal(
      files.some(f => f === bad || f.startsWith(bad + path.sep) || f.includes(bad + path.sep)),
      false, '產物唔應該包含：' + bad
    );
  }
  // 前端依賴的公開檔必須存在（index.html 有下載／查看連結）
  for (const need of [
    'static/index.html',
    'static/apps-script/Code.gs',
    'static/apps-script/appsscript.json',
    'static/assets/ymis-parse.js',
    'static/assets/batch-onboard/Code.gs',
    'static/data/mock_members.json',
    'static/docs/EXEC_GUIDE.md',
    'static/docs/MEMBER_GUIDE.md'
  ]) {
    assert.equal(fs.existsSync(path.join(out, need)), true, '缺公開檔：' + need);
  }
  assert.equal(fs.existsSync(path.join(out, 'static/api')), false, 'api/ 只以 function bundle 形式存在');

  // 公開 Code.gs 唔含版號字樣（版號只留 MD）
  const gsText = fs.readFileSync(path.join(out, 'static/apps-script/Code.gs'), 'utf8');
  assert.equal(/\bv\d+\.\d+(\.\d+)?\b/.test(gsText), false);

  assert.equal(files.filter(f => f.endsWith('.vc-config.json')).length, 5);

  // health：未設 TROOP_* env 時診斷端點回 503（部署診斷用），設定後 200 —— 兩者都係正確行為
  const expected = {
    health: { method: 'GET', status: [200, 503] },
    troops: { method: 'GET', status: 200 },
    portal: { method: 'POST', status: 405 },
    proxy: { method: 'GET', status: 405 },
    'verify-super-ticket': { method: 'GET', status: 200 }
  };
  for (const [name, spec] of Object.entries(expected)) {
    const dir = path.join(out, 'functions', 'api', name + '.func');
    const runtime = JSON.parse(fs.readFileSync(path.join(dir, '.vc-config.json'), 'utf8'));
    assert.equal(runtime.runtime, 'nodejs22.x');
    assert.equal(runtime.handler, 'index.mjs');
    assert.equal(fs.existsSync(path.join(dir, 'apps-script')), false, 'function bundle 唔可以連整份 GAS 源碼');
    const { default: handler } = await import(pathToFileURL(path.join(dir, 'index.mjs')).href + '?t=' + Date.now() + name);
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${name}`, { method: spec.method });
      const allowed = Array.isArray(spec.status) ? spec.status : [spec.status];
      assert.ok(allowed.includes(response.status), `${name} ${spec.method} 應回 ${allowed.join('/')}`);
      assert.match(response.headers.get('content-type') || '', /application\/json/);
      assert.match(response.headers.get('cache-control') || '', /no-store/);
      const body = await response.json();
      assert.equal(typeof body, 'object');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    // 舊 .js 別名要路由去同一個 function
    const route = config.routes.find(r => r.src && new RegExp(r.src).test('/api/' + name + '.js'));
    assert.ok(route, 'Legacy .js alias 必須路由到 bundle：' + name);
  }
});
