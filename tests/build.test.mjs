import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { accountId } from '../scripts/runtime-config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, '.vercel/output');

test('Build Output API contains only intended static files and four runnable function bundles', async () => {
  // 自含式：每次測試都重跑 build（快、零依賴、冪等）
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { stdio: 'pipe' });

  const config = JSON.parse(fs.readFileSync(path.join(out, 'config.json')));
  assert.equal(config.version, 3);
  const files = fs.readdirSync(out, { recursive: true }).map(String);
  assert(!files.some(f => /(^|\/)(tests|operations|node_modules|scripts|\.git)(\/|$)|troops\.json|\.env/.test(f)));
  // 內部文件一律唔上線（output purity 由 build.mjs 顯式清單守護）
  assert(!files.some(f => /AGENT_TEMPLATE|DEPLOY_GUIDE|MAIN_SYSTEM_INTEGRATION|VERCEL_API_404|TROOP_UPGRADE_2026|VERCEL_ENV_SETUP|APP_ADMIN_WORKFLOW/.test(f)));
  assert.equal(files.filter(f => f.endsWith('.vc-config.json')).length, 4);
  assert(fs.existsSync(path.join(out, 'static/apps-script/Code.gs')));
  assert(fs.existsSync(path.join(out, 'static/data/mock_members.json')));
  assert(!fs.existsSync(path.join(out, 'static/api')));
  // 公開靜態檔唔准出現保留帳號字串（Code.gs 只准一行宣告；.md 亦不例外）
  for (const file of files.filter(f => f.startsWith('static/') && /\.(html|md|js|gs)$/.test(f))) {
    const text = fs.readFileSync(path.join(out, file), 'utf8').toLowerCase();
    assert.equal(text.split(accountId).length - 1, file === 'static/apps-script/Code.gs' ? 1 : 0, 'Public artifact contains unexpected account text: ' + file);
  }
  for (const name of ['proxy', 'troops', 'portal', 'super']) {
    const dir = path.join(out, 'functions/api', name + '.func');
    if (name === 'proxy' || name === 'super') {
      const auth = await import(pathToFileURL(path.join(dir, '_super.js')));
      assert(auth.isSuperId(accountId));
      assert(auth.isSuperId(`${accountId.toUpperCase()}@roverbadge.local`));
      assert(!auth.isSuperId('unregistered-account'));
      assert(!fs.existsSync(path.join(dir, 'apps-script')), 'Function must not duplicate the entire GAS source');
    }
    const runtime = JSON.parse(fs.readFileSync(path.join(dir, '.vc-config.json')));
    assert.equal(runtime.runtime, 'nodejs22.x');
    const { default: handler } = await import(pathToFileURL(path.join(dir, runtime.handler)));
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${name}`);
      assert.equal(response.status, name === 'troops' ? 200 : name === 'portal' ? 404 : 405);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.match(response.headers.get('cache-control'), /no-store/);
      const body = await response.json(); assert.equal(typeof body, 'object');
    } finally { await new Promise(resolve => server.close(resolve)); }
    const route = config.routes.find(r => r.src && new RegExp(r.src).test('/api/' + name + '.js'));
    assert(route, 'Legacy .js alias must route to bundled function');
  }
});
