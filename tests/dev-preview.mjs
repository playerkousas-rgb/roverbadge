// 本機完整預覽：mock GAS 旅團後端 + app server（靜態檔 + /api/*）
// 用法：node tests/dev-preview.mjs [port]
import { startMockGas } from './mock-gas.mjs';

const PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
const GAS_PORT = parseInt(process.env.GAS_PORT || '3910', 10);

process.env.ROVERBADGE_PROXY_TEST = '1';
process.env.TROOP_0082_BACKEND = `http://127.0.0.1:${GAS_PORT}/exec`;
process.env.TROOP_0082_APIKEY = 'PREVIEW_KEY';

const mock = await startMockGas({
  port: GAS_PORT, name: '預覽旅團(0082)', apikey: 'PREVIEW_KEY',
  users: [
    { ymis: '1234567890', name: '陳團長', role: 'group_leader', pass: 'PassA!234567', can_tick: true, email: 'leader@example.org' }
  ]
});
console.log(`mock GAS: ${mock.url}  （團長 1234567890 / PassA!234567）`);

await import('./dev-server.mjs');
