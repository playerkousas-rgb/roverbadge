// 本機 Demo：完全離線跑「靜態站 + 三個 /api function + 假 GAS」，用黎證明登入鏈路完好
// 用法：npm run demo   （或 node tests/demo-server.mjs 3000）
//
// 與 `npm run dev` 的分別：
//   dev   → /api/proxy 會打去真實 Google GAS（沙箱無外網時會回 502）
//   demo  → 把 0082 的 backend 指到本機 mock GAS（tests/mock-gas.mjs，行為與 Code.gs 一致），
//           因此可以真的登入、勾選、寫入、審批，全程唔需要外網
//
// 帳號（只存在於記憶體，關閉即消失）：
//   超管        sheep / 0728
//   旅團管理員  1111111111 / Demo!1234
//   領袖        leader@example.org / Demo!1234   （1234567890 同密碼）
//   成員        1234560001 / Demo!1234
// 旅團請選 0082。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startMockGas } from './mock-gas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
const GAS_PORT = parseInt(process.env.DEMO_GAS_PORT || '3911', 10);
const USERS = 'Demo!1234';

process.env.ROVERBADGE_PROXY_TEST = '1';                       // 容許 mock GAS 用 http://127.0.0.1
process.env.TROOP_0082_BACKEND = `http://127.0.0.1:${GAS_PORT}/exec`;
process.env.TROOP_0082_APIKEY = 'DEMO_KEY';
process.env.ROVERBADGE_REGISTRY_TTL_MS = '0';                   // demo 期間改 troops.json 即刻反映

const mock = await startMockGas({
  port: GAS_PORT,
  name: '第 82 旅 (樂行) — Demo',
  apikey: 'DEMO_KEY',
  users: [
    { ymis: '1111111111', name: '旅團管理員', role: 'admin', can_tick: true, pass: USERS, email: 'admin@example.org' },
    { ymis: '1234567890', name: '陳大文', role: 'group_leader', can_tick: true, pass: USERS, email: 'leader@example.org' },
    { ymis: '1234560001', name: '成員甲', role: 'member', can_tick: false, pass: USERS },
    { ymis: '1234560002', name: '成員乙', role: 'member', can_tick: false, pass: USERS }
  ]
});
console.log(`  mock GAS（假後端）: ${mock.url}`);

const { default: proxyHandler } = await import('../api/proxy.js');
const { default: troopsHandler } = await import('../api/troops.js');
const { default: healthHandler } = await import('../api/health.js');

function vercelize(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  return res;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname === '/api/proxy') return proxyHandler(req, vercelize(res));
  if (u.pathname === '/api/troops') return troopsHandler(req, vercelize(res));
  if (u.pathname === '/api/health') return healthHandler(req, vercelize(res));
  let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    // 對齊 Vercel：未部署的路徑回 HTML 404（唔係 JSON）
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>404: NOT_FOUND</h1></body></html>');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
});

server.listen(APP_PORT, '0.0.0.0', () => {
  console.log(`\n✅ Demo（/api/proxy、/api/troops、/api/health 都已掛上）: http://0.0.0.0:${APP_PORT}`);
  console.log('   選旅團 0082，用 sheep / 0728（超管）或 1234560001 / ' + USERS + '（成員）登入');
  console.log(`   自檢：curl -s localhost:${APP_PORT}/api/health\n`);
});
