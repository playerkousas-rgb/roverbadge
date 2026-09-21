// 本機完整示範：起 mock GAS（旅團 0082 後端）+ 預覽伺服器（含 /api/*），
// 用嚟人手驗證「登入頁無怪獸字 + 中央登入全鏈路」。唔屬於 npm test。
//   node tests/local-preview.mjs
import { startMockGas } from './mock-gas.mjs';
import { spawn } from 'child_process';

const MOCK_PORT = 3901;
const APP_PORT = 3000;

const mock = await startMockGas({
  port: MOCK_PORT,
  name: '示範旅團0082',
  apikey: 'KEY_DEMO',
  verifyUrl: `http://127.0.0.1:${APP_PORT}/api/verify-super-ticket`,
  users: [
    { ymis: '1234567890', name: '陳大文', role: 'group_leader', pass: 'Leader!123', can_tick: true, email: 'l@example.org' },
    { ymis: '1234560001', name: '成員甲', role: 'member', pass: 'Member!123', can_tick: false }
  ]
});
console.log(`mock GAS ready: ${mock.url}`);

const child = spawn(process.execPath, ['tests/dev-server.mjs', String(APP_PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    ROVERBADGE_PROXY_TEST: '1',
    TROOP_0082_NAME: '示範旅團0082',
    TROOP_0082_BACKEND: mock.url,
    TROOP_0082_APIKEY: 'KEY_DEMO',
    SUPER_KEY: 'demo-super-pass'
  },
  stdio: 'inherit'
});
child.on('exit', (c) => process.exit(c ?? 0));
