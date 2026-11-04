// Runs the overlay with a particular set of notification views, so you don't have to set an environment variable by hand:
//
//   node tools/overlay/run.mjs <dev|build> <path/to/views.js>
//
// It sets OVERLAY_VIEWS (an absolute path) and then runs `tauri dev` or `tauri build` for apps/overlay. See
// apps/overlay/vite.config.js for what OVERLAY_VIEWS does. Run it as:  npm run overlay:views -- dev /path/to/views.js

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const [mode, viewsArg] = process.argv.slice(2);
if (!['dev', 'build'].includes(mode) || !viewsArg) {
  console.error('usage: node tools/overlay/run.mjs <dev|build> <path/to/views.js>');
  process.exit(2);
}
const views = path.resolve(viewsArg);
if (!fs.existsSync(views)) {
  console.error(`views module not found: ${views}`);
  process.exit(2);
}
if (!process.env.npm_execpath) {
  console.error('run this through npm so it can be found: npm run overlay:views -- <dev|build> <path/to/views.js>');
  process.exit(2);
}

// Same Node binary and npm CLI that started us, so no shell and no PATH lookup is involved.
const result = spawnSync(
  process.execPath,
  [process.env.npm_execpath, 'run', 'tauri', '--workspace', 'apps/overlay', '--', mode],
  { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, OVERLAY_VIEWS: views } }
);
process.exit(result.status ?? 1);
