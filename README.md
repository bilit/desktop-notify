# desktop-notify

Add **desktop notifications** to an existing Node backend + web app. Your backend publishes a notification; users
who run the overlay get always-on-top alerts they can act on, and everyone else gets in-page toasts. Whichever
surface handles a notification first wins, and it disappears everywhere.

The library is kind-agnostic: it relays and draws generic notifications (a title and some text, with a Dismiss
button), and you register your own kinds with their own look and actions where you need them.

```
 your backend ──publish──►  packages/server  ◄──────── WebSocket ────────►  your web app
 (or POST /publish)         state · TTL · first action wins                  (packages/web: toasts)
                                    ▲
                                    └──── WebSocket ────►  apps/overlay  (Tauri, on the user's desktop)
```

## Layout

| Path | What it is |
|---|---|
| `packages/server` | `notify-server`: the embeddable server module (`createNotifyServer`) plus a standalone single-user wrapper (`server.js`). Per-user delivery, TTL expiry, first-action-wins, device tokens. Tests in `test/`. |
| `packages/web` | Browser client: `useHub` React hook, per-kind toast registry, plain-toast fallback, `sendAction`. |
| `apps/overlay` | Tauri desktop overlay: cards, resizable panel for bursts, tray icon, global hotkey. Draws every kind with a generic card unless a build sets `OVERLAY_VIEWS` (below). |
| `patches/desktop-notify.patch` | The whole project as one literal patch: applied to an empty folder it creates every file (see "Get the code without cloning"). Generated; don't edit. |
| `tools/dropin` | Builds the copy-and-paste single-file versions of the server and web client, and verifies them. |
| `tools/overlay` | `run.mjs`: runs the overlay with a chosen views module (below). |
| `tools/patch` | Builds and checks `patches/desktop-notify.patch`. |

## Quick start (Windows)

```bash
npm install                                # once, at the repo root (npm workspaces)
npm test                                   # the server's test suite
npm start --workspace packages/server      # standalone hub on http://127.0.0.1:4000 (dev token)
npm run overlay:dev                        # the overlay (needs Rust + MSVC build tools; first build is slow)
```

With the hub and overlay running, publish a notification (PowerShell):

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4000/publish `
  -Headers @{ Authorization = 'Bearer local_dev_handshake_token' } -ContentType 'application/json' `
  -Body '{"kind":"alert","ttlSeconds":30,"data":{"title":"Hello","text":"It works"}}'
```

A card appears in the middle of the screen. Publish a few in a row and it becomes a panel.

The overlay's icons live in `apps/overlay/src-tauri/icons/`. Only what a Windows build uses is kept (`icon.ico`,
`32x32.png`, `128x128.png`, and the 512 px `icon.png` as the master). To use your own artwork, or to build for macOS,
Linux or the Microsoft Store, regenerate the full set from one square PNG:
`npx tauri icon path/to/your-1024px-square.png` (run it from `apps/overlay`), then trim what you don't need.

## Get the code without cloning

`patches/desktop-notify.patch` is one file that recreates the whole project when applied to an **empty** folder: no
clone, no zip.

```bash
mkdir desktop-notify && cd desktop-notify
curl -L https://raw.githubusercontent.com/bilit/desktop-notify/main/patches/desktop-notify.patch | git apply
npm install
```

PowerShell: `Invoke-WebRequest <that url> -OutFile ..\desktop-notify.patch; git apply ..\desktop-notify.patch`.
If you already have the file: `git apply ../desktop-notify.patch`.

- **Needs git.** The icons are in it as binary data, which plain `patch` cannot apply. `git apply` works in any folder; it
  does not need a repository.
- **It is generated, not hand-written.** `npm run patch` rebuilds it from the repository's files (anything in
  `.gitignore` can't get in, and it carries no author name or email); `npm run patch:check` fails if the committed
  copy no longer recreates the current files exactly. Run `npm run patch` before committing code changes, and consider
  running the check in CI.
- **Keep `.gitattributes`.** It marks the patch `-text` so git never converts its line endings. Without it, a Windows
  clone with `core.autocrlf=true` rewrites the file with CRLF and `git apply` then fails. Reviews and diffs show it as a
  single collapsed file for the same reason.
- The patch does not contain itself, so applying it gives you everything except `patches/`; run `npm run patch` in a
  `git init`ed copy to make a new one.

## Using it from your own backend

Embed the server in the HTTP server your backend already runs. **Your code decides who each connection is; the library
does not know about sessions or SSO.**

```js
import { createNotifyServer } from 'notify-server';

const notify = createNotifyServer({
  server,                                   // your existing http.Server; its other routes/upgrades are untouched
  path: '/notify',
  authenticate: async (req) => {            // browser connections. Return the user id, or null to refuse.
    return await yourSessionLookup(req);    // read the session cookie, ask your SSO, whatever you already do
  },
  secret: process.env.NOTIFY_SECRET,        // 16+ chars; signs device tokens for the desktop overlay
});

// publish from anywhere in your backend: it reaches only that user's browser tabs and desktop overlay
notify.publish(userId, { kind: 'order-filled', ttlSeconds: 30, data: { orderId: 7, qty: 100 } });

// find out what the user did
notify.on('action', ({ userId, id, kind, action, payload, by }) => { /* act on it */ });
notify.on('expired', ({ userId, id, kind }) => { /* nobody responded in time */ });
```

- **Browser connections** are identified by your `authenticate(req)`. A WebSocket can't follow redirects, so an invalid
  session is refused with 401; the page itself is already behind your normal login. By default only same-origin pages
  may connect (this is what stops another site from riding a visitor's cookie); pass `allowedOrigins` for a dev
  setup where the web app and backend are on different origins.
- **The desktop overlay can't use your cookie**, so it logs in with a signed device token that your backend issues for
  the already-logged-in user. Add an endpoint for your "Connect desktop" button:
  `app.post('/api/device-token', (req, res) => res.json({ token: notify.createDeviceToken(req.user.id) }))`.
  Tokens last 7 days by default (`{ ttlSeconds }` to change) and cannot be revoked one by one; rotate `secret` to
  invalidate all of them. Entering the token into the overlay is manual for now (see "Overlay setup" below).
- **Cancel** a live notification from your side (e.g. the order was cancelled upstream): `notify.cancel(userId, id)`.
- **Types** ship with the package (`index.d.ts`).

In the web app, use the client library, with a same-origin path and no token (the cookie does the work):

```tsx
const { desktopConnected, sendAction } = useHub({
  url: '/notify',
  onNotify, onResolved,
  toasts: { 'order-filled': showOrderToast },   // optional custom looks; other kinds get a plain toast
});
```

Kinds with no view render as a generic card (`data.title`, `data.text`) with a Dismiss button, in both the browser and
the overlay. For a custom look, add a view per client (below).

### Install by copy and paste (no package needed)

`npm run dropin` generates single-file copies in `dist/dropin/`. Drop them into your projects:

| File | Goes in | Needs |
|---|---|---|
| `notify-server.mjs` + `notify-server.d.mts` | your backend (e.g. `lib/`) | `npm install ws`; ES module, Node 18+ |
| `notify-web.tsx` | your React app (e.g. `src/notify-web.tsx`) | `react` 18+ and `sonner` |

```js
import { createNotifyServer } from './lib/notify-server.mjs';   // backend
```
```tsx
import { useHub } from './notify-web';                          // web app
```

If your backend is CommonJS, load it with `await import('./lib/notify-server.mjs')` (Node 22+ can also `require` it).
Each file starts with a version comment so you can tell which copy you have. Don't edit the copies: change the source
under `packages/` and regenerate. There is no automatic upgrade path; updating means copying the new files over.

`npm run dropin:verify` proves the copies work rather than assuming it: it rebuilds them, type-checks them the way a
TypeScript backend and a TypeScript + React app would consume them, and runs the full server test suite against the
bundled `notify-server.mjs`.

### What this library handles, and what you provide

No SSO, login, pairing or session code is built into the server module, the web client or the overlay. By design,
identity is yours.

| This library | You |
|---|---|
| Routes each notification to one user's connections only | Say who a browser connection is: `authenticate(req)` (cookie, SSO, anything; may be async) |
| Signs and verifies device tokens, if you want them (`createDeviceToken`, needs `secret`) | Decide how the overlay proves who it is: issue device tokens from an endpoint behind your login, **or** implement `authenticateDesktop(token, req)` with your own scheme |
| Same-origin check for browser connections, size limits, TTLs, first-action-wins | Get the server URL and credential into the overlay (today: environment variables at start; no runtime config screen) |
| Emits `action` / `expired` events to your backend | TLS, logout and revocation policy, and the "Connect desktop" experience |

Device tokens are optional. They exist so you don't have to invent a credential for the overlay, but nothing requires
them: the overlay just sends an opaque `token` string with its connection, and your `authenticateDesktop` decides what
it means. Treat anything that lets a connection claim a user without proof (for example returning the token itself
as the user id) as impersonation: anyone who can reach the server could read that user's notifications and act as them.

### Username only (until the overlay can sign in)

For now the overlay can simply announce who it is. On startup it sends a username with its connection
(`?role=desktop&user=alice`): `NOTIFY_USER` if set, otherwise the Windows user name. No token, no setup screen.

**This is a claim, not a login, and the library does not believe it on its own.** A bare `?user=` authenticates no one
unless your server opts in through `authenticateDesktop`, which receives the claim as an explicitly unverified value:

```js
createNotifyServer({
  // ...
  authenticateDesktop: (token, req, { user }) => user,   // believes the claim: trusted networks only
});
```

Doing that means anyone who can reach the server can receive any user's notifications and act as them, so keep it to a
network you trust. When the overlay gains SSO, replace this one function with a real check (your SSO, a signed token);
nothing else changes. Because the claim is the Windows user name, your backend must map it to its own user ids
(e.g. `CORP\alice` vs `alice`).

### Overlay setup (for now)

The overlay reads its server URL and token at build/start time. To point a dev overlay at your backend:

```powershell
$env:VITE_HUB_WS="wss://your-backend/notify"; $env:VITE_NOTIFY_TOKEN="<device token>"; npm run overlay:dev
```

A first-run screen where a user pastes the URL and token (instead of environment variables) is not built yet; it is
needed before handing the overlay to anyone else.

### Standalone mode (single user, any language)

`packages/server/server.js` runs the same module as a separate process with one user and one shared token, for
development or for publishers that can't call the library in-process:

```
POST http://127.0.0.1:4000/publish
Authorization: Bearer <NOTIFY_TOKEN>
{ "kind": "alert", "ttlSeconds": 30, "data": { "title": "Deploy finished", "text": "build 412 is live" } }
```

This mode sends everything to every client and has no per-user identity, so it is only appropriate for one user.

### Adding a notification kind

Nothing to do on the server. For a custom look, add a view to each client you use.

**Browser.** A `ToastRenderer` is `(notification, sendAction) => void`. Use the same toast `id` so an update replaces the
toast instead of stacking a new one:

```tsx
import { toast } from 'sonner';
import { useHub, type ToastRenderer } from './notify-web';

const showJobToast: ToastRenderer = (n, sendAction) => {
  const { name } = n.data as { name: string };
  toast.custom(
    () => (
      <div>
        <b>{name}</b>
        <button onClick={() => sendAction(n.id, 'approve')}>Approve</button>
        <button onClick={() => sendAction(n.id, 'reject')}>Reject</button>
      </div>
    ),
    { id: n.id, duration: n.ttlSeconds * 1000 }
  );
};

useHub({ url: '/notify', toasts: { job: showJobToast } });
```

**Overlay.** Write a module that exports `views` (kind → view) and build the overlay with `OVERLAY_VIEWS` pointing at it.
Your module can live anywhere, import its own CSS, and doesn't touch the overlay's source.

```jsx
// my-views.jsx   (JSX needs the .jsx extension; a .js file would fail to build)
import React from 'react';

function JobCard({ n, act }) {
  const left = Math.max(0, Math.ceil((n.expiresAt - Date.now()) / 1000));
  return (
    <div className="card">
      <div className="row">
        <span className="title mono">{n.data.name}</span>
        <span className="meta mono">{left}s</span>
      </div>
      <div className="btns two">
        <button className="primary" onClick={() => act([n.id], 'approve')}>Approve</button>
        <button className="neutral" onClick={() => act([n.id], 'reject')}>Reject</button>
      </div>
    </div>
  );
}

export const views = {
  job: {
    Card: JobCard,
    noun: 'job',                                          // "3 jobs" in the panel header
    subtitle: (items) => `${items.length} waiting`,       // optional second line in the panel header
    bulk: [                                               // actions that may be applied to a whole group
      { action: 'reject', label: 'Reject all', style: 'neutral' },
      { action: 'approve', label: 'Approve all', style: 'primary', confirm: true },   // needs a second click
    ],
  },
};
```

```bash
npm run overlay:views -- dev /path/to/my-views.jsx      # or: build
```

(Or set the variable yourself: `$env:OVERLAY_VIEWS="C:\path\my-views.jsx"; npm run overlay:dev`.)

The view contract:

- A view is `{ Card, noun, subtitle?(items), bulk[] }`. `bulk` entries are `{ action, label, style, confirm? }`.
- `Card` receives `n`, the notification (`id`, `kind`, `data`, `ttlSeconds`, plus `open` if the publisher set one) with two
  extra fields added on arrival: `expiresAt` (epoch ms) and `arrivedAt`. It also receives `act(ids, action, payload?)`,
  which sends that action to the server for each id. The card disappears when the server confirms it.
- The overlay wraps every card, so you get the following for free and shouldn't build it yourself: the × (hide), click-to-open,
  and the arrival highlight.
- Classes the overlay provides: layout `card`, `row`, `mono`, `meta`, `title`, `text`, `ttl` (a countdown bar:
  `<div className="ttl"><div style={{ width: '60%' }} /></div>`), and `btns` with `two` or `three`; buttons `primary`,
  `info`, `neutral`, `warn`. Anything else, bring your own CSS.

## Hub messages (plain JSON)

```
server -> client   NOTIFY   {notification}                new notification
                   UPDATE   {notification}                same id, updated in place (TTL keeps running)
                   RESOLVED {id, kind, action, payload, by}   first action wins, or action "EXPIRED"
                   SNAPSHOT {notifications}               everything live, sent on connect
                   PRESENCE {desktopConnected}
client -> server   ACTION   {id, action, payload?}
                   CLIPBOARD {text}                       desktop role only; becomes a browser-only notification

notification = { id, kind, ttlSeconds, data, surfaces?, open? }   // ttlSeconds is time LEFT; data is up to the view
```

`surfaces: ['browser' | 'desktop']` says which clients show a notification. Without it, the browser stays quiet while a
desktop overlay is connected, so nothing is shown twice.

### Standalone hub plugins

The standalone hub (`packages/server/server.js`) has no routes beyond `/publish` and `/health`. A plugin adds more: an
ES module whose default export is `(hub) => async (req, res, { json }) => handled`, where `hub = { publish, liveIds }`.
Load with `--plugin <path>` (repeatable) or `NOTIFY_PLUGINS` (comma-separated). Plugin routes are not
token-protected: plugins are trusted, local code.

## Overlay behaviour (Tauri)

- **Cards and panel:** 1–2 live notifications are compact cards, centered and sized to their content. At 3 or more it
  becomes one **panel**: draggable by its header, resizable by the corner grip, remembering its size and position. The
  header summarizes the set and offers bulk actions per kind; below it, every notification is shown as its kind's card,
  newest first, in a scrollable list. A "▲ N new" chip appears if something arrives while you're scrolled down. It goes
  back to cards only when 1 or none are left, so it doesn't flap.
- **Close (×):** every card has one. It hides the card on this overlay only and sends no action: the notification stays
  live for everyone else and expires normally. The panel header has a hide-all ×. Left-click the tray icon to bring
  hidden ones back.
- **Stacking:** not permanently always-on-top. A NEW notification raises the window above everything and holds it there
  for 5s (`RAISE_HOLD_MS` in `src/notify/Overlay.jsx`; `0` = raise once, no hold), then it behaves like a normal window,
  so clicking another app covers it. Updates and resolutions never raise it. **Left-click the tray icon** to bring a
  buried overlay forward (it has no taskbar button).
- **Focus:** cards don't take keyboard focus when they appear.
- **App window (optional, experimental):** set `NOTIFY_APP_URL` to your web app's http(s) address and the overlay also
  hosts it in a normal window (created hidden; tray → "Open app" shows it; closing it hides it, the overlay keeps
  running). **Clicking a card** (not its buttons) brings that window forward and tells the page which notification it
  was, so it can navigate to or highlight it. Publishers can attach a target: `notify.publish(userId, { kind, data,
  open: { path: '/orders/7' } })`; the page decides what it means.
  ```tsx
  useHub({ url: '/notify', onOpen: ({ id, kind, data, open }) => { /* scroll to / flash / navigate */ } });
  ```
  - *Security:* the app window loads a remote page, so it gets **no native commands at all**: the capability file only
    names the overlay's own window. The only thing that reaches it is a one-way browser event
    (`notify-open`), carrying just `id`, `kind`, `data` and `open`, JSON-escaped so notification content can't run as
    script. If the page needs to call native code later, grant specific commands to your origin; don't widen this.
  - *Timing:* if the click lands before the page has mounted (still loading, mid-login redirect), the detail waits on
    `window.__notifyOpenPending`; `onOpen` picks it up when it mounts.
  - *What it is for:* trying whether your SSO and session work inside an embedded WebView2 window. The window keeps its
    own cookies, separate from your normal browser. It is **not** yet a way to authenticate the overlay itself.
  - A tab in a normal browser never receives `onOpen`. Opening or highlighting something in an already-open regular
    browser tab (via the server) and raising that browser window are not built.
- **Selection hotkey:** select text in any app and press **Ctrl+Shift+J**: the hub shows it as a notification **in the
  browser**, no Ctrl+C needed. Change the combination with `OVERLAY_HOTKEY` (e.g. `ctrl+alt+j`); if another app owns it,
  the tray tooltip says so.
  - The overlay waits for you to release the hotkey, simulates Ctrl+C in the focused app, reads the clipboard, then
    restores your previous clipboard **text** (an image or file list on the clipboard is replaced).
  - It never sends a synthetic Ctrl+C to terminals or VS Code/Cursor (it can interrupt a running process). In those, and
    in any app it can't identify, it sends the **current clipboard** instead: copy first, then press it. Add apps with
    `OVERLAY_NO_AUTOCOPY=app1.exe,app2.exe`; `OVERLAY_HOTKEY_MODE=clipboard` always uses the clipboard.
  - Nothing selected, an elevated (admin) window, or an app that ignores synthetic Ctrl+C: nothing is sent and the system
    beeps. It never sends stale clipboard text in place of a selection.
  - It only runs on a keypress; the clipboard is never polled and its contents are never logged. Text is trimmed and
    capped at 5000 chars. The server delivers it to that user's own browser tabs only.

## Configuration

| Variable | Used by | Default |
|---|---|---|
| `NOTIFY_TOKEN` | standalone hub | `local_dev_handshake_token` |
| `ALLOWED_ORIGINS` | standalone hub | local web dev origins and the Tauri webview origins |
| `PORT`, `HOST` | standalone hub | `4000`, `127.0.0.1`. The hub refuses to listen on any other address unless `NOTIFY_TOKEN` is a custom value of 16+ characters (the default token is public) |
| `NOTIFY_PLUGINS` | standalone hub | none (comma-separated module paths) |
| `VITE_HUB_WS`, `VITE_NOTIFY_TOKEN` | overlay (build/start time) | `ws://127.0.0.1:4000/ws`, dev token |
| `OVERLAY_VIEWS` | overlay (build/start time) | none (generic card for every kind) |
| `NOTIFY_USER` | overlay (runtime) | the Windows user name |
| `OVERLAY_HOTKEY`, `OVERLAY_HOTKEY_MODE`, `OVERLAY_NO_AUTOCOPY` | overlay (runtime) | `ctrl+shift+j`, selection, none |
| `NOTIFY_APP_URL` | overlay (runtime) | none (no app window) |

## Security status

Embedded mode: identity comes from your own `authenticate`, delivery is per user, browser connections are same-origin
only by default, the overlay uses signed expiring device tokens, and inbound messages are size-capped. Not done:
revoking a single device token, rate limiting, and the overlay's token entry screen. Standalone mode is dev-grade: one
shared token and everything goes to every client, and it refuses to listen beyond loopback unless you set a custom
`NOTIFY_TOKEN`. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The single-file drop-ins carry the license text in their headers, so the notice travels with a pasted copy.

Third-party dependencies keep their own licenses (all permissive, apart from five file-level-copyleft MPL-2.0 Rust
crates that Tauri pulls in). If you distribute a built overlay, include the notices of the bundled Rust crates; a tool
such as `cargo about` can generate them.
