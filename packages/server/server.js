// Standalone notification hub: the embeddable module (src/createNotifyServer.js) plus the HTTP bits a stand-alone
// process needs, for publishers that can't call the module in-process.
//
//  - GET  /health
//  - POST /publish   (Authorization: Bearer <token>)  publish { kind, id?, ttlSeconds?, data? }
//  - plugin routes   (see below)
//  - WebSocket at /ws
//
// This mode has ONE user ("local") and ONE shared token. It is for development and single-user setups. To serve
// real users, embed the module in your own backend instead (see README): you supply `authenticate`, and every
// notification is delivered to just that user's clients.

import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createNotifyServer } from './index.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST || '127.0.0.1'; // loopback by default
// The default token is published in this repo's source and README, so it is only acceptable while the hub is reachable
// from this machine alone. An empty NOTIFY_TOKEN counts as unset (an empty token would let anyone in).
const DEFAULT_TOKEN = 'local_dev_handshake_token';
const TOKEN = process.env.NOTIFY_TOKEN || DEFAULT_TOKEN;
const loopback = HOST === 'localhost' || HOST === '::1' || HOST.startsWith('127.');
if (!loopback && (TOKEN === DEFAULT_TOKEN || TOKEN.length < 16)) {
  console.error(
    `Refusing to listen on ${HOST}: the hub would be reachable from the network with a ${
      TOKEN === DEFAULT_TOKEN ? 'built-in, publicly known' : 'too short'
    } token.\nSet NOTIFY_TOKEN to a long random value (16+ characters), or keep HOST on 127.0.0.1.`
  );
  process.exit(1);
}
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ??
  // web app (dev), then the Tauri webview (dev server, and packaged build on Windows)
  'http://localhost:5173,http://127.0.0.1:5173,http://localhost:1420,http://tauri.localhost,https://tauri.localhost'
).split(',');
const MAX_BODY_BYTES = 64 * 1024;
const LOCAL_USER = 'local';

function tokenOk(supplied) {
  const a = Buffer.from(String(supplied ?? ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  return origin === undefined || ALLOWED_ORIGINS.includes(origin); // non-browser callers send no Origin
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString() || 'null')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- plugins
//
// The hub knows nothing about any kind of notification. A plugin adds HTTP routes, typically a feed that publishes
// into the hub (for example, a feed that publishes sample data). A plugin is an ES module whose default export is
//
//     (hub) => async (req, res, { json }) => handled      // return true if it served the request
//
// where `hub` is { publish(notification), liveIds() }. Load plugins with `--plugin <path>` (repeatable) or the
// NOTIFY_PLUGINS environment variable (comma-separated). Paths are relative to the working directory.
// Plugin routes run after the Origin check but are NOT token-protected: plugins are trusted, local code.

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!originAllowed(req)) return void res.writeHead(403).end('origin not allowed');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  if (req.method === 'GET' && req.url === '/health') {
    const s = notify.stats();
    return json(200, { ok: true, live: s.live, clients: s.clients, desktopConnected: notify.desktopConnected(LOCAL_USER) });
  }

  // Generic ingest: any system can POST a notification here. Requires the bearer token.
  if (req.method === 'POST' && req.url === '/publish') {
    if (!tokenOk(req.headers.authorization?.replace(/^Bearer /, ''))) return json(401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || typeof body.kind !== 'string' || !body.kind) {
        return json(400, { error: 'body must be an object with a string "kind"' });
      }
      return json(200, notify.publish(LOCAL_USER, body));
    } catch (err) {
      return json(400, { error: err instanceof TypeError ? err.message : 'invalid json' });
    }
  }

  for (const handle of pluginHandlers) {
    if (await handle(req, res, { json })) return;
  }

  json(404, { error: 'not found' });
});

const queryToken = (req) => new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');

const notify = createNotifyServer({
  server,
  path: '/ws',
  // Single shared token for both kinds of client, as before.
  authenticate: (req) => (tokenOk(queryToken(req)) ? LOCAL_USER : null),
  authenticateDesktop: (token) => (tokenOk(token) ? LOCAL_USER : null),
  allowedOrigins: ALLOWED_ORIGINS,
  desktopOrigins: ALLOWED_ORIGINS,
});
notify.on('connect', ({ role }) => console.log(`+ ${role} connected (${notify.stats().clients} clients)`));
notify.on('disconnect', ({ role }) => console.log(`- ${role} disconnected (${notify.stats().clients} clients)`));

const pluginPaths = [
  ...process.argv.flatMap((arg, i, all) => (arg === '--plugin' && all[i + 1] ? [all[i + 1]] : [])),
  ...(process.env.NOTIFY_PLUGINS ?? '').split(',').map((p) => p.trim()).filter(Boolean),
];
const pluginHandlers = [];
for (const p of pluginPaths) {
  const mod = await import(pathToFileURL(path.resolve(p)).href);
  if (typeof mod.default !== 'function') throw new Error(`plugin ${p} must default-export (hub) => handler`);
  pluginHandlers.push(
    mod.default({ publish: (n) => notify.publish(LOCAL_USER, n), liveIds: () => notify.liveIds(LOCAL_USER) })
  );
  console.log(`plugin loaded: ${p}`);
}

server.listen(PORT, HOST, () => {
  console.log(`Notification hub on http://${HOST}:${PORT} (ws path /ws, ${pluginHandlers.length} plugin${pluginHandlers.length === 1 ? '' : 's'})`);
});
