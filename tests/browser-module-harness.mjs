// 在 Node 內載入瀏覽器用的 UMD 檔（assets/rover-scope.js、assets/forms.js）。
// 兩個檔案都是經典 script（非 ES module），故以 new Function 執行原始碼，
// 與瀏覽器 <script src> 的行為一致：RoverScope／RoverForms 會掛到 globalThis。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export function loadAssetModule(relPath) {
  const src = fs.readFileSync(path.join(root, relPath), 'utf8');
  const holder = { exports: {} };
  new Function('module', 'exports', src)(holder, holder.exports);
  return holder.exports;
}

export function loadRoverModules() {
  globalThis.RoverScope = loadAssetModule('assets/rover-scope.js');
  globalThis.RoverForms = loadAssetModule('assets/forms.js');
  return { RoverScope: globalThis.RoverScope, RoverForms: globalThis.RoverForms };
}

export const repoRoot = root;
