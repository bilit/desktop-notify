import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { createDeviceTokens } from './deviceToken.js';

// Embeddable notification server. Attach it to the HTTP server your backend already runs:
//
//   const notify = createNotifyServer({
//     server,                                        // your http.Server
//     path: '/notify',
//     authenticate: (req) => req.session?.userId,    // who is this browser connection? (null = reject)
//     secret: process.env.NOTIFY_SECRET,             // enables device tokens for the desktop overlay
//   });
//   notify.publish(userId, { kind: 'order-filled', ttlSeconds: 30, data: { ... } });
//   notify.on('action', ({ userId, id, action, payload }) => { ... });
//
// It owns live notification state per user (TTL expiry, first action wins) and fans each notification out to that
// user's connected clients only: their browser tabs and their desktop overlay. It knows nothing about any kind.
//
// Wire messages (plain JSON):
//   server -> client:  NOTIFY {notification} | UPDATE {notification} | RESOLVED {id, kind, action, payload, by}
//                      SNAPSHOT {notifications} | PRESENCE {desktopConnected}
//   client -> server:  ACTION {id, action, payload?}
//                      CLIPBOARD {text}   (desktop role only; becomes a browser-only "clipboard" notification)

const ACTION_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KIND_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ROLES = new Set(['browser', 'desktop']);
const DEFAULT_DESKTOP_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:1420'];
const DEFAULT_DEVICE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // tokens can't be revoked individually, so keep them short

export function createNotifyServer(options = {}) {
  const {
    server,
    path = '/notify',
    authenticate,
    authenticateDesktop,
    secret,
    allowedOrigins,
    desktopOrigins = DEFAULT_DESKTOP_ORIGINS,
    maxPayload = 64 * 1024,
    maxLivePerUser = 1000,
    maxClipboardChars = 5000,
    heartbeatMs = 20_000,
    logger = console,
  } = options;

  if (!server || typeof server.on !== 'function') throw new TypeError('notify-server: `server` (an http.Server) is required');
  if (typeof authenticate !== 'function') throw new TypeError('notify-server: `authenticate(req)` is required');
  const tokens = secret ? createDeviceTokens(secret) : null;

  const events = new EventEmitter();
  /** userId -> { live: Map<id, {n, expiresAt, timer}>, clients: Set<{ws, role, alive}> } */
  const users = new Map();
  let nextId = 1000;

  // ------------------------------------------------------------------ helpers

  const normalizeUserId = (userId) => {
    if (userId === null || userId === undefined || String(userId) === '') {
      throw new TypeError('notify-server: userId is required');
    }
    return String(userId);
  };

  const userState = (uid) => {
    let u = users.get(uid);
    if (!u) {
      u = { live: new Map(), clients: new Set() };
      users.set(uid, u);
    }
    return u;
  };

  /** Forget a user with nothing live and nobody connected, so `users` can't grow without bound. */
  const prune = (uid) => {
    const u = users.get(uid);
    if (u && u.live.size === 0 && u.clients.size === 0) users.delete(uid);
  };

  // A throwing listener must never take the server down.
  const emit = (name, payload) => {
    try { events.emit(name, payload); } catch (err) { logger.error?.(`notify-server: '${name}' listener threw:`, err); }
  };

  const remaining = (e) => Math.max(1, Math.ceil((e.expiresAt - Date.now()) / 1000));
  const view = (e) => ({ ...e.n, ttlSeconds: remaining(e) }); // clients get time *left*, not the original TTL

  const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const broadcast = (uid, msg) => { for (const c of users.get(uid)?.clients ?? []) send(c.ws, msg); };

  const hasDesktop = (uid) => {
    for (const c of users.get(uid)?.clients ?? []) if (c.role === 'desktop') return true;
    return false;
  };
  const broadcastPresence = (uid) => broadcast(uid, { type: 'PRESENCE', desktopConnected: hasDesktop(uid) });

  // ------------------------------------------------------------------ lifecycle

  /**
   * Publish a notification to one user. A known `id` updates it in place (its original expiry keeps running, so a
   * refreshed value isn't treated as a brand-new notification); an unknown id creates it.
   * @returns the notification as stored (including its `id`)
   */
  function publish(userId, input) {
    const uid = normalizeUserId(userId);
    if (!input || typeof input !== 'object') throw new TypeError('notify-server: notification must be an object');
    const kind = String(input.kind ?? '');
    if (!KIND_RE.test(kind)) throw new TypeError('notify-server: notification.kind must match [A-Za-z0-9._:-]{1,64}');
    const id = input.id !== undefined && input.id !== null ? String(input.id) : `${kind}-${nextId++}`;

    const u = userState(uid);
    const existing = u.live.get(id);
    if (existing) {
      existing.n = { ...existing.n, ...input, id, kind };
      broadcast(uid, { type: 'UPDATE', notification: view(existing) });
      return existing.n;
    }

    if (u.live.size >= maxLivePerUser) throw new Error(`notify-server: user already has ${maxLivePerUser} live notifications`);
    const ttl = Number.isFinite(input.ttlSeconds) ? Math.min(Math.max(input.ttlSeconds, 1), 3600) : 30;
    const entry = { n: { ...input, id, kind, createdAt: Date.now() }, expiresAt: Date.now() + ttl * 1000, timer: null };
    entry.timer = setTimeout(() => resolve(uid, id, 'EXPIRED', null, 'system'), ttl * 1000);
    u.live.set(id, entry);
    broadcast(uid, { type: 'NOTIFY', notification: view(entry) });
    return entry.n;
  }

  /** First resolution wins; later attempts on the same id are ignored. Returns whether this call resolved it. */
  function resolve(uid, id, action, payload, by) {
    const u = users.get(uid);
    const entry = u?.live.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    u.live.delete(id);

    broadcast(uid, { type: 'RESOLVED', id, kind: entry.n.kind, action, payload: payload ?? null, by });
    if (action === 'EXPIRED') emit('expired', { userId: uid, id, kind: entry.n.kind, notification: entry.n });
    else if (by !== 'system') emit('action', { userId: uid, id, kind: entry.n.kind, action, payload: payload ?? null, by, notification: entry.n });
    prune(uid);
    return true;
  }

  /** Withdraw a live notification from every client of that user (e.g. the order was cancelled upstream). */
  function cancel(userId, id) {
    return resolve(normalizeUserId(userId), String(id), 'CANCELLED', null, 'system');
  }

  // ------------------------------------------------------------------ WebSocket

  const wss = new WebSocketServer({ noServer: true, maxPayload });

  const reject = (socket, code, why) => {
    socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  /** Browsers always send Origin on a WebSocket upgrade, which is what blocks cross-site hijacking of a cookie login. */
  const browserOriginOk = (origin, req) => {
    if (Array.isArray(allowedOrigins)) return allowedOrigins.includes(origin);
    try { return new URL(origin).host === req.headers.host; } catch { return false; } // default: same origin only
  };

  async function upgrade(req, socket, head, url) {
    const role = url.searchParams.get('role');
    if (!ROLES.has(role)) return reject(socket, 400, 'Bad Request');

    // A missing Origin means a non-browser client, which has no ambient cookies to abuse.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const ok = role === 'browser' ? browserOriginOk(origin, req) : desktopOrigins.includes(origin);
      if (!ok) return reject(socket, 403, 'Forbidden');
    }

    let userId = null;
    if (role === 'browser') {
      userId = await authenticate(req); // your function: read the session, ask your SSO, whatever it takes
    } else {
      const token = url.searchParams.get('token');
      userId = tokens?.verify(token) ?? null;
      if (userId === null && authenticateDesktop) {
        // `user` is whatever name the overlay says it is. It is UNVERIFIED: it is only ever handed to your own
        // `authenticateDesktop`, never trusted by this library. Returning it as-is lets anyone who can reach the
        // server impersonate that user; do that only on a trusted network, and replace it once the overlay has SSO.
        const claimed = url.searchParams.get('user');
        const user = claimed && claimed.length <= 128 ? claimed : null;
        userId = await authenticateDesktop(token, req, { user });
      }
    }
    if (userId === null || userId === undefined || String(userId) === '') return reject(socket, 401, 'Unauthorized');
    if (socket.destroyed) return; // the client gave up while we were authenticating

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, role, String(userId)));
  }

  const onUpgrade = (req, socket, head) => {
    let url;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return; }
    if (url.pathname !== path) return; // not ours: leave it to whatever else listens for upgrades on this server
    upgrade(req, socket, head, url).catch((err) => {
      logger.error?.('notify-server: upgrade failed:', err);
      if (!socket.destroyed) reject(socket, 500, 'Internal Server Error');
    });
  };
  server.on('upgrade', onUpgrade);

  function onConnection(ws, role, uid) {
    const client = { ws, role, alive: true };
    const u = userState(uid);
    u.clients.add(client);
    emit('connect', { userId: uid, role });

    // Late joiners catch up on whatever is still live for this user.
    send(ws, { type: 'SNAPSHOT', notifications: [...u.live.values()].map(view) });
    broadcastPresence(uid);

    ws.on('pong', () => { client.alive = true; });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; } // malformed input is dropped

      // Text sent from any app by the desktop overlay's global hotkey. Only the desktop role may send it, and the
      // server builds the notification itself, so a client can't inject arbitrary fields or kinds. Never logged.
      if (msg?.type === 'CLIPBOARD') {
        if (role !== 'desktop' || typeof msg.text !== 'string') return;
        const text = msg.text.trim().slice(0, maxClipboardChars).trimEnd();
        if (!text) return;
        publish(uid, {
          kind: 'clipboard',
          ttlSeconds: 20,
          surfaces: ['browser'], // shown in the browser only; the sender's overlay doesn't echo it back
          data: { title: 'Clipboard from desktop', text },
        });
        return;
      }

      if (msg?.type !== 'ACTION' || typeof msg.id !== 'string') return;
      if (typeof msg.action !== 'string' || !ACTION_RE.test(msg.action) || msg.action === 'EXPIRED') return;
      resolve(uid, msg.id, msg.action, msg.payload, role);
    });

    ws.on('close', () => {
      u.clients.delete(client);
      emit('disconnect', { userId: uid, role });
      broadcastPresence(uid);
      prune(uid);
    });
    ws.on('error', () => ws.terminate());
  }

  // Drop half-open connections (e.g. a laptop that slept) so presence stays accurate.
  const heartbeat = setInterval(() => {
    for (const u of users.values()) {
      for (const c of u.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        c.ws.ping();
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  // ------------------------------------------------------------------ public API

  return {
    publish,
    cancel,

    /**
     * Issue a token the desktop overlay uses to log in as `userId`. Call it from an endpoint that has already
     * authenticated that user (e.g. the web app's "Connect desktop" button). Requires the `secret` option.
     */
    createDeviceToken(userId, { ttlSeconds = DEFAULT_DEVICE_TOKEN_TTL_SECONDS } = {}) {
      if (!tokens) throw new Error('notify-server: set the `secret` option to issue device tokens');
      if (!(ttlSeconds > 0)) throw new RangeError('notify-server: ttlSeconds must be positive');
      return tokens.create(normalizeUserId(userId), ttlSeconds);
    },

    /** @returns the user id a device token belongs to, or null if invalid/expired. Mostly useful in tests. */
    verifyDeviceToken: (token) => tokens?.verify(token) ?? null,

    liveIds: (userId) => [...(users.get(normalizeUserId(userId))?.live.keys() ?? [])],
    desktopConnected: (userId) => hasDesktop(normalizeUserId(userId)),
    stats() {
      let clients = 0;
      let live = 0;
      for (const u of users.values()) { clients += u.clients.size; live += u.live.size; }
      return { users: users.size, clients, live };
    },

    /** `action` {userId,id,kind,action,payload,by,notification}, `expired` {...}, `connect`/`disconnect` {userId,role} */
    on: (name, listener) => events.on(name, listener),
    off: (name, listener) => events.off(name, listener),

    /** Stop listening, drop every connection, and cancel all timers. */
    async close() {
      server.off('upgrade', onUpgrade);
      clearInterval(heartbeat);
      for (const u of users.values()) {
        for (const e of u.live.values()) clearTimeout(e.timer);
        for (const c of u.clients) c.ws.terminate();
      }
      users.clear();
      await new Promise((r) => wss.close(r));
    },
  };
}
