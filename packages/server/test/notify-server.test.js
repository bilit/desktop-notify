import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
// NOTIFY_ENTRY (a file:// URL) lets the same tests run against the bundled single-file drop-in (tools/dropin/verify.mjs).
const { createNotifyServer } = await import(process.env.NOTIFY_ENTRY ?? '../index.js');

const SECRET = 'test-secret-test-secret';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { error() {} };

/** A real HTTP server + notify server on an ephemeral port. `authenticate` reads an `x-user` header. */
async function start(options = {}) {
  const server = http.createServer((req, res) => res.end('ok'));
  const notify = createNotifyServer({
    server,
    path: '/notify',
    authenticate: (req) => req.headers['x-user'] ?? null,
    secret: SECRET,
    logger: quiet,
    ...options,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const clients = [];

  return {
    notify,
    server,
    port,
    /** Resolves with the open client; rejects with {status} if the server refuses the upgrade. */
    connect(role, { user, token, claimedUser, origin, path = '/notify' } = {}) {
      return new Promise((resolve, reject) => {
        const q = new URLSearchParams({ role });
        if (token) q.set('token', token);
        if (claimedUser) q.set('user', claimedUser); // the overlay's unverified "I am <name>"
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?${q}`, {
          headers: user ? { 'x-user': user } : {},
          origin,
        });
        const c = { ws, msgs: [], of: (type) => c.msgs.filter((m) => m.type === type) };
        ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
        ws.on('open', () => { clients.push(c); resolve(c); });
        ws.on('unexpected-response', (req, res) => {
          req.destroy();
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        });
        ws.on('error', () => {}); // surfaced through unexpected-response
      });
    },
    send: (c, msg) => c.ws.send(JSON.stringify(msg)),
    async stop() {
      clients.forEach((c) => c.ws.terminate());
      await notify.close();
      await new Promise((r) => server.close(r));
    },
  };
}

const refused = (promise) => promise.then(() => assert.fail('connection should have been refused'), (e) => e.status);

test('refuses a browser connection that has no identity (401)', async () => {
  const h = await start();
  try {
    assert.equal(await refused(h.connect('browser')), 401);
  } finally { await h.stop(); }
});

test('accepts an async authenticate, and refuses one that throws (500)', async () => {
  const ok = await start({ authenticate: async (req) => { await wait(20); return req.headers['x-user'] ?? null; } });
  try {
    const c = await ok.connect('browser', { user: 'alice' });
    assert.ok(c.ws.readyState === WebSocket.OPEN);
  } finally { await ok.stop(); }

  const bad = await start({ authenticate: () => { throw new Error('sso down'); } });
  try {
    assert.equal(await refused(bad.connect('browser', { user: 'alice' })), 500);
  } finally { await bad.stop(); }
});

test('browser Origin: same-origin allowed, cross-site refused (blocks hijacking a cookie login)', async () => {
  const h = await start();
  try {
    assert.equal(await refused(h.connect('browser', { user: 'a', origin: 'http://evil.example' })), 403);
    const ok = await h.connect('browser', { user: 'a', origin: `http://127.0.0.1:${h.port}` });
    assert.ok(ok.ws.readyState === WebSocket.OPEN);
  } finally { await h.stop(); }
});

test('allowedOrigins overrides the same-origin default', async () => {
  const h = await start({ allowedOrigins: ['http://localhost:5173'] });
  try {
    const ok = await h.connect('browser', { user: 'a', origin: 'http://localhost:5173' });
    assert.ok(ok.ws.readyState === WebSocket.OPEN);
    assert.equal(await refused(h.connect('browser', { user: 'a', origin: `http://127.0.0.1:${h.port}` })), 403);
  } finally { await h.stop(); }
});

test('delivers a notification only to the addressed user, across all their tabs', async () => {
  const h = await start();
  try {
    const alice1 = await h.connect('browser', { user: 'alice' });
    const alice2 = await h.connect('browser', { user: 'alice' });
    const bob = await h.connect('browser', { user: 'bob' });

    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 20, data: { label: 'alpha' } });
    await wait(150);

    for (const c of [alice1, alice2]) {
      const got = c.of('NOTIFY');
      assert.equal(got.length, 1);
      assert.equal(got[0].notification.id, n.id);
      assert.equal(got[0].notification.data.label, 'alpha');
    }
    assert.equal(bob.of('NOTIFY').length, 0, "bob must not see alice's notification");
  } finally { await h.stop(); }
});

test('a connecting client gets a SNAPSHOT of its own live notifications only', async () => {
  const h = await start();
  try {
    h.notify.publish('alice', { kind: 'a', ttlSeconds: 30, data: 1 });
    h.notify.publish('bob', { kind: 'b', ttlSeconds: 30, data: 2 });
    const late = await h.connect('browser', { user: 'alice' });
    await wait(100);
    const snap = late.of('SNAPSHOT')[0];
    assert.deepEqual(snap.notifications.map((n) => n.kind), ['a']);
  } finally { await h.stop(); }
});

test('first action wins: one RESOLVED, one `action` event, later actions ignored', async () => {
  const h = await start();
  try {
    const events = [];
    h.notify.on('action', (e) => events.push(e));
    const browser = await h.connect('browser', { user: 'alice' });
    const other = await h.connect('browser', { user: 'alice' });
    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 20, data: {} });
    await wait(100);

    h.send(browser, { type: 'ACTION', id: n.id, action: 'accept', payload: { amount: 14.6 } });
    await wait(80);
    h.send(other, { type: 'ACTION', id: n.id, action: 'pass' });
    await wait(120);

    assert.equal(other.of('RESOLVED').length, 1);
    assert.equal(other.of('RESOLVED')[0].action, 'accept');
    assert.equal(events.length, 1);
    assert.equal(events[0].userId, 'alice');
    assert.equal(events[0].id, n.id);
    assert.equal(events[0].action, 'accept');
    assert.deepEqual(events[0].payload, { amount: 14.6 });
    assert.equal(events[0].by, 'browser');
    assert.equal(events[0].notification.kind, 'job');
  } finally { await h.stop(); }
});

test("a user cannot act on another user's notification", async () => {
  const h = await start();
  try {
    const events = [];
    h.notify.on('action', (e) => events.push(e));
    const bob = await h.connect('browser', { user: 'bob' });
    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 20, data: {} });
    h.send(bob, { type: 'ACTION', id: n.id, action: 'accept' });
    await wait(150);
    assert.equal(events.length, 0);
    assert.deepEqual(h.notify.liveIds('alice'), [n.id], 'still live for alice');
  } finally { await h.stop(); }
});

test('rejects malformed actions', async () => {
  const h = await start();
  try {
    const events = [];
    h.notify.on('action', (e) => events.push(e));
    const c = await h.connect('browser', { user: 'alice' });
    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 20, data: {} });
    h.send(c, { type: 'ACTION', id: n.id, action: 'has spaces!' });
    h.send(c, { type: 'ACTION', id: n.id, action: 'EXPIRED' }); // only the server may expire
    h.send(c, { type: 'ACTION', id: 42, action: 'accept' });
    c.ws.send('not json');
    await wait(150);
    assert.equal(events.length, 0);
    assert.equal(h.notify.liveIds('alice').length, 1);
  } finally { await h.stop(); }
});

test('expires after its TTL: RESOLVED EXPIRED and an `expired` event, no `action` event', async () => {
  const h = await start();
  try {
    const actions = [];
    const expired = [];
    h.notify.on('action', (e) => actions.push(e));
    h.notify.on('expired', (e) => expired.push(e));
    const c = await h.connect('browser', { user: 'alice' });
    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 1, data: {} });
    await wait(1400);
    const r = c.of('RESOLVED')[0];
    assert.equal(r.id, n.id);
    assert.equal(r.action, 'EXPIRED');
    assert.equal(r.by, 'system');
    assert.equal(expired.length, 1);
    assert.equal(expired[0].userId, 'alice');
    assert.equal(actions.length, 0);
  } finally { await h.stop(); }
});

test('publishing a live id updates it in place and keeps the original expiry', async () => {
  const h = await start();
  try {
    const c = await h.connect('browser', { user: 'alice' });
    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 5, data: { n: 1 } });
    await wait(1200);
    h.notify.publish('alice', { id: n.id, kind: 'job', data: { n: 2 } });
    await wait(100);
    const update = c.of('UPDATE')[0];
    assert.equal(update.notification.data.n, 2);
    assert.ok(update.notification.ttlSeconds <= 4, 'time left reflects the original expiry, not a fresh TTL');
    assert.equal(c.of('NOTIFY').length, 1);
  } finally { await h.stop(); }
});

test('cancel() withdraws a notification for that user without an `action` event', async () => {
  const h = await start();
  try {
    const events = [];
    h.notify.on('action', (e) => events.push(e));
    const c = await h.connect('browser', { user: 'alice' });
    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 20, data: {} });
    assert.equal(h.notify.cancel('alice', n.id), true);
    assert.equal(h.notify.cancel('alice', n.id), false, 'already gone');
    await wait(100);
    assert.equal(c.of('RESOLVED')[0].action, 'CANCELLED');
    assert.equal(events.length, 0);
  } finally { await h.stop(); }
});

test('device token: the desktop overlay logs in as the same user, and presence is per user', async () => {
  const h = await start();
  try {
    const alice = await h.connect('browser', { user: 'alice' });
    const bob = await h.connect('browser', { user: 'bob' });
    await wait(80);
    assert.equal(alice.of('PRESENCE').at(-1).desktopConnected, false);

    const token = h.notify.createDeviceToken('alice');
    assert.equal(h.notify.verifyDeviceToken(token), 'alice');
    const overlay = await h.connect('desktop', { token });
    await wait(100);

    assert.equal(alice.of('PRESENCE').at(-1).desktopConnected, true);
    assert.equal(bob.of('PRESENCE').at(-1).desktopConnected, false, "bob's presence must not change");
    assert.equal(h.notify.desktopConnected('alice'), true);
    assert.equal(h.notify.desktopConnected('bob'), false);

    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 20, data: {} });
    await wait(100);
    assert.equal(overlay.of('NOTIFY')[0].notification.id, n.id);
    assert.equal(bob.of('NOTIFY').length, 0);
  } finally { await h.stop(); }
});

test('device token: tampered, garbage, wrong-secret and missing tokens are refused (401)', async () => {
  const h = await start();
  try {
    const good = h.notify.createDeviceToken('alice');
    const [payload, sig] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ u: 'bob', e: 9999999999 })).toString('base64url');

    assert.equal(await refused(h.connect('desktop', { token: `${forgedPayload}.${sig}` })), 401); // reused signature
    assert.equal(await refused(h.connect('desktop', { token: `${payload}.AAAA` })), 401);
    assert.equal(await refused(h.connect('desktop', { token: 'garbage' })), 401);
    assert.equal(await refused(h.connect('desktop')), 401);

    const other = await start({ secret: 'a-completely-different-secret' });
    try {
      assert.equal(await refused(h.connect('desktop', { token: other.notify.createDeviceToken('alice') })), 401);
    } finally { await other.stop(); }
  } finally { await h.stop(); }
});

test('device token: expires', async () => {
  const h = await start();
  try {
    const token = h.notify.createDeviceToken('alice', { ttlSeconds: 1 });
    assert.equal(h.notify.verifyDeviceToken(token), 'alice');
    await wait(2100);
    assert.equal(h.notify.verifyDeviceToken(token), null);
    assert.equal(await refused(h.connect('desktop', { token })), 401);
  } finally { await h.stop(); }
});

test('a claimed username authenticates no one unless the integrator opts in via authenticateDesktop', async () => {
  // Secure by default: a bare ?user=alice is refused.
  const closed = await start();
  try {
    assert.equal(await refused(closed.connect('desktop', { claimedUser: 'alice' })), 401);
  } finally { await closed.stop(); }

  // Opting in (what "the overlay just passes a username" means): the hook receives the claim and decides.
  const calls = [];
  const open = await start({
    authenticateDesktop: (token, _req, { user }) => { calls.push({ token, user }); return user; },
  });
  try {
    const alice = await open.connect('desktop', { claimedUser: 'alice' });
    const bob = await open.connect('browser', { user: 'bob' });
    open.notify.publish('alice', { kind: 'k', ttlSeconds: 20, data: 1 });
    await wait(120);
    assert.equal(alice.of('NOTIFY').length, 1, 'the claimed user receives their own notification');
    assert.equal(bob.of('NOTIFY').length, 0);
    assert.deepEqual(calls[0], { token: null, user: 'alice' });

    // a real device token still wins, and the hook is not consulted for it
    const before = calls.length;
    await open.connect('desktop', { token: open.notify.createDeviceToken('carol'), claimedUser: 'mallory' });
    assert.equal(calls.length, before);
    assert.deepEqual(open.notify.liveIds('carol'), []);
    assert.equal(open.notify.desktopConnected('carol'), true, 'connected as carol (the token), not mallory');
    assert.equal(open.notify.desktopConnected('mallory'), false);

    // empty or absurdly long claims are passed as null
    await open.connect('desktop', { claimedUser: 'x'.repeat(129) }).then(() => assert.fail('should refuse'), (e) => assert.equal(e.status, 401));
    assert.equal(calls.at(-1).user, null);
  } finally { await open.stop(); }

  // The hook may refuse a claim
  const picky = await start({ authenticateDesktop: (_t, _r, { user }) => (user === 'alice' ? user : null) });
  try {
    assert.equal(await refused(picky.connect('desktop', { claimedUser: 'mallory' })), 401);
    assert.ok((await picky.connect('desktop', { claimedUser: 'alice' })).ws.readyState === WebSocket.OPEN);
  } finally { await picky.stop(); }
});

test('device tokens need a secret, and the secret must be long enough', async () => {
  const h = await start({ secret: undefined });
  try {
    assert.throws(() => h.notify.createDeviceToken('alice'), /secret/);
  } finally { await h.stop(); }
  assert.throws(() => createNotifyServer({ server: http.createServer(), authenticate: () => 'x', secret: 'short' }), /16/);
});

test('desktop Origin: Tauri origins and non-browser clients allowed, other sites refused', async () => {
  const h = await start();
  try {
    const token = h.notify.createDeviceToken('alice');
    const tauri = await h.connect('desktop', { token, origin: 'http://tauri.localhost' });
    assert.ok(tauri.ws.readyState === WebSocket.OPEN);
    assert.equal(await refused(h.connect('desktop', { token, origin: 'http://evil.example' })), 403);
  } finally { await h.stop(); }
});

test('clipboard: desktop-only, delivered to that user as a browser-only notification, trimmed and capped', async () => {
  const h = await start({ maxClipboardChars: 20 });
  try {
    const aliceBrowser = await h.connect('browser', { user: 'alice' });
    const bobBrowser = await h.connect('browser', { user: 'bob' });
    const overlay = await h.connect('desktop', { token: h.notify.createDeviceToken('alice') });

    // the browser role may not send it
    h.send(aliceBrowser, { type: 'CLIPBOARD', text: 'wrong role' });
    await wait(120);
    assert.equal(aliceBrowser.of('NOTIFY').length, 0);

    h.send(overlay, { type: 'CLIPBOARD', text: '   ' }); // blank ignored
    h.send(overlay, { type: 'CLIPBOARD', text: '  Quarterly report draft and a long tail that gets cut  ' });
    await wait(150);

    const got = aliceBrowser.of('NOTIFY');
    assert.equal(got.length, 1);
    assert.equal(got[0].notification.kind, 'clipboard');
    // trimmed, capped at 20 characters ("Quarterly report dra" is 20), then trimmed again so no trailing space remains
    assert.equal(got[0].notification.data.text, 'Quarterly report dra');
    assert.deepEqual(got[0].notification.surfaces, ['browser']);
    assert.equal(bobBrowser.of('NOTIFY').length, 0, "alice's clipboard must never reach bob");
  } finally { await h.stop(); }
});

test('an oversized message closes that connection', async () => {
  const h = await start({ maxPayload: 1024 });
  try {
    const c = await h.connect('browser', { user: 'alice' });
    const closed = new Promise((r) => c.ws.on('close', () => r(true)));
    c.ws.send('x'.repeat(5000));
    assert.equal(await Promise.race([closed, wait(1500).then(() => false)]), true);
  } finally { await h.stop(); }
});

test('enforces maxLivePerUser per user', async () => {
  const h = await start({ maxLivePerUser: 2 });
  try {
    h.notify.publish('alice', { kind: 'a', data: 1 });
    h.notify.publish('alice', { kind: 'a', data: 2 });
    assert.throws(() => h.notify.publish('alice', { kind: 'a', data: 3 }), /2 live/);
    h.notify.publish('bob', { kind: 'a', data: 1 }); // a different user is unaffected
  } finally { await h.stop(); }
});

test('publish validates its input', async () => {
  const h = await start();
  try {
    assert.throws(() => h.notify.publish('alice', { kind: 'has spaces' }), TypeError);
    assert.throws(() => h.notify.publish('alice', {}), TypeError);
    assert.throws(() => h.notify.publish('alice', null), TypeError);
    assert.throws(() => h.notify.publish('', { kind: 'a' }), TypeError);
    assert.throws(() => h.notify.publish(undefined, { kind: 'a' }), TypeError);
  } finally { await h.stop(); }
});

test('a throwing event listener does not crash the server', async () => {
  const h = await start();
  try {
    h.notify.on('action', () => { throw new Error('listener bug'); });
    const c = await h.connect('browser', { user: 'alice' });
    const n = h.notify.publish('alice', { kind: 'job', ttlSeconds: 20, data: {} });
    h.send(c, { type: 'ACTION', id: n.id, action: 'accept' });
    await wait(120);
    assert.equal(c.of('RESOLVED').length, 1);
  } finally { await h.stop(); }
});

test('coexists with other WebSocket paths on the same server', async () => {
  const h = await start();
  const other = new WebSocketServer({ noServer: true });
  h.server.on('upgrade', (req, socket, head) => {
    if (req.url === '/other') other.handleUpgrade(req, socket, head, (ws) => ws.send('hello from /other'));
  });
  try {
    const greeting = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/other`);
      ws.on('message', (d) => { resolve(d.toString()); ws.close(); });
      ws.on('error', reject);
    });
    assert.equal(greeting, 'hello from /other');
    const ours = await h.connect('browser', { user: 'alice' });
    assert.ok(ours.ws.readyState === WebSocket.OPEN);
  } finally {
    other.close();
    await h.stop();
  }
});

test('close() stops timers, drops connections and stops listening', async () => {
  const h = await start();
  const c = await h.connect('browser', { user: 'alice' });
  h.notify.publish('alice', { kind: 'a', ttlSeconds: 30, data: 1 });
  const closed = new Promise((r) => c.ws.on('close', () => r(true)));
  await h.notify.close();
  assert.equal(await Promise.race([closed, wait(1000).then(() => false)]), true);
  assert.equal(h.notify.stats().live, 0);
  await new Promise((r) => h.server.close(r));
});
