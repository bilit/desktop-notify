// Proves the single-file drop-ins work, not just that they were written:
//   1. rebuilds them
//   2. type-checks them the way a TS backend / TS+React app would consume them
//   3. runs the server's whole test suite against the bundled notify-server.mjs instead of the source
// Run:  npm run dropin:verify

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Everything runs through this same Node binary (no shell), so nothing depends on npx/npm being on PATH.
function run(label, args, env = {}) {
  console.log(`\n== ${label}`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${label}`);
    process.exit(r.status ?? 1);
  }
}

run('build drop-ins', ['tools/dropin/build.mjs']);
run('type-check as a TS backend and a TS+React app would use them', [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p',
  'tools/dropin/check',
]);

const bundled = pathToFileURL(path.join(root, 'dist', 'dropin', 'notify-server.mjs')).href;
run('server test suite against the bundled notify-server.mjs', ['--test', 'packages/server/test/*.test.js'], {
  NOTIFY_ENTRY: bundled,
});

console.log('\ndrop-ins verified.');
