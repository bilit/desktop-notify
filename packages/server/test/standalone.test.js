import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The standalone hub (server.js) is a script, so these tests run it as a child process.
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

/** Environment for the child: the parent's, minus anything that would change the hub's own defaults. */
const baseEnv = () => {
  const env = { ...process.env, PORT: '0' }; // port 0: let the OS pick, so tests never collide with a running hub
  delete env.NOTIFY_TOKEN;
  delete env.HOST;
  delete env.NOTIFY_PLUGINS;
  return env;
};

test('refuses to listen beyond loopback with the publicly known default token', () => {
  const r = spawnSync(process.execPath, [SERVER], { env: { ...baseEnv(), HOST: '0.0.0.0' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to listen on 0\.0\.0\.0/);
  assert.match(r.stderr, /NOTIFY_TOKEN/);
});

test('an empty NOTIFY_TOKEN counts as unset, not as "no password"', () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...baseEnv(), HOST: '0.0.0.0', NOTIFY_TOKEN: '' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /publicly known/);
});

test('refuses a short custom token beyond loopback', () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...baseEnv(), HOST: '0.0.0.0', NOTIFY_TOKEN: 'abc123' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /too short/);
});

test('still starts on loopback with the default token (the normal development setup)', async () => {
  const child = spawn(process.execPath, [SERVER], { env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const started = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`hub did not start; output so far: ${out}`)), 10000);
      child.stdout.on('data', (d) => {
        out += d;
        if (/Notification hub on http:\/\/127\.0\.0\.1:/.test(out)) { clearTimeout(timer); resolve(out); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`hub exited early (code ${code}): ${out}`)); });
    });
    assert.match(started, /127\.0\.0\.1/);
  } finally {
    child.kill();
  }
});
