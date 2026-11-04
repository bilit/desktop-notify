import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import CardShell from './CardShell.jsx';
import Panel from './Panel.jsx';
import { defaultView } from './defaultView.jsx';

const HUB_WS = import.meta.env.VITE_HUB_WS ?? 'ws://127.0.0.1:4000/ws';
const TOKEN = import.meta.env.VITE_NOTIFY_TOKEN ?? 'local_dev_handshake_token'; // dev token; real auth is a later step
const WIDTH = 380;
// Hybrid layout: 1-2 notifications are compact cards; a burst switches to the resizable panel.
// Enter at 3, leave only at 1 or fewer, so the window doesn't flap while a burst is being worked down.
const PANEL_ENTER = 3;
const PANEL_EXIT = 1;
const GEOMETRY_KEY = 'overlay.panelGeometry';
// After a NEW notification the window stays on top this long, so clicking another app right away can't bury it;
// then it drops back to a normal window. 0 = raise once and don't hold.
const RAISE_HOLD_MS = 5000;

// A notification can restrict which clients show it; no list means every desktop overlay shows it.
const forDesktop = (n) => !n.surfaces || n.surfaces.includes('desktop');

const stamp = (n) => ({ ...n, expiresAt: Date.now() + (n.ttlSeconds ?? 30) * 1000, arrivedAt: Date.now() });

const loadGeometry = () => {
  try { return JSON.parse(localStorage.getItem(GEOMETRY_KEY)) ?? null; } catch { return null; }
};

/**
 * The overlay shell: hub connection, hybrid cards/panel layout, window fitting. It knows nothing about any
 * notification kind. `views` maps kind -> {Card, noun, subtitle?(items), bulk[]}; unknown kinds use defaultView.
 */
export default function Overlay({ views = {} }) {
  const [items, setItems] = useState([]); // oldest -> newest; each is a hub notification + expiresAt/arrivedAt
  const [, setTick] = useState(0);
  const [arrivals, setArrivals] = useState(0); // bumps on each NEW notification (not updates/resolutions)
  const [appConfigured, setAppConfigured] = useState(false); // is there an app window to open? (NOTIFY_APP_URL)
  // Ids the user closed (×) on this overlay. Hiding is local only: nothing is sent, and the notification stays live
  // for everyone else and expires normally. A left-click on the tray icon brings them back.
  const [hidden, setHidden] = useState(() => new Set());
  const hiddenSize = useRef(0);
  hiddenSize.current = hidden.size;
  const wsRef = useRef(null);
  const stackRef = useRef(null);

  const visible = items.filter((n) => !hidden.has(n.id));

  // Pure function of the previous mode and the count, so re-renders can't change the result.
  const panelRef = useRef(false);
  panelRef.current = panelRef.current ? visible.length > PANEL_EXIT : visible.length >= PANEL_ENTER;
  const panel = panelRef.current;

  const hide = useCallback((ids) => setHidden((prev) => new Set([...prev, ...ids])), []);

  // Forget hidden ids once their notification is gone (resolved, expired, or the connection dropped), so the set
  // can't grow without bound.
  useEffect(() => {
    setHidden((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(items.map((n) => n.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  // --- Hub connection (the overlay is just another client, role "desktop") ---
  useEffect(() => {
    let stopped = false;
    let retry;
    let user = null; // NOTIFY_USER, else the Windows user name (see overlay_identity in main.rs)

    const connect = () => {
      if (stopped) return;
      // `user` is a claim, not a login: it says whose notifications we want, and the server decides whether to believe it.
      const query = new URLSearchParams({ role: 'desktop', token: TOKEN });
      if (user) query.set('user', user);
      const ws = new WebSocket(`${HUB_WS}?${query}`);
      wsRef.current = ws;

      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'SNAPSHOT') setItems(m.notifications.filter(forDesktop).map(stamp));
        else if (m.type === 'NOTIFY') {
          if (!forDesktop(m.notification)) return; // e.g. clipboard text is for the browser, not for us
          setItems((p) => [...p.filter((x) => x.id !== m.notification.id), stamp(m.notification)]);
          setArrivals((a) => a + 1);
        }
        else if (m.type === 'UPDATE') {
          // Update in place; keep the original expiry (the hub's TTL keeps running).
          setItems((p) => p.map((x) => (x.id === m.notification.id ? { ...x, ...m.notification, expiresAt: x.expiresAt } : x)));
        } else if (m.type === 'RESOLVED') setItems((p) => p.filter((x) => x.id !== m.id));
      };
      ws.onclose = () => {
        wsRef.current = null;
        setItems([]); // can't act while disconnected; the SNAPSHOT on reconnect restores what's live
        if (!stopped) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };
    // Ask for the name once, then connect; if it can't be read we still connect, just without a claim.
    invoke('overlay_identity').then((u) => { user = u; }).catch(() => {}).finally(connect);

    return () => { stopped = true; clearTimeout(retry); wsRef.current?.close(); };
  }, []);

  const act = useCallback((ids, action, payload) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Items leave when the hub confirms with RESOLVED, so every surface stays in sync.
    ids.forEach((id) => ws.send(JSON.stringify({ type: 'ACTION', id, action, payload })));
  }, []);

  useEffect(() => { invoke('app_configured').then(setAppConfigured).catch(() => {}); }, []);

  // Clicking a card (anywhere except its own buttons) opens the app window and tells the page which notification it
  // was. The page gets a plain browser event, never access to native commands; `open` is whatever target the
  // publisher attached, interpreted by the page.
  const open = useCallback((n, e) => {
    if (e.target.closest('button')) return;
    invoke('open_in_app', { notification: { id: n.id, kind: n.kind, data: n.data, open: n.open } }).catch(() => {});
  }, []);

  // --- Tray icon left-click: bring back anything the user closed (×) ---
  useEffect(() => {
    const un = listen('tray-action', (e) => {
      if (e.payload !== 'unhide' || hiddenSize.current === 0) return;
      setHidden(new Set());
      setArrivals((a) => a + 1); // shows and raises the window like a new arrival
    });
    return () => { un.then((f) => f()); };
  }, []);

  // --- Global hotkey (handled in Rust): it read the clipboard; forward the text to the hub, which shows it in the browser ---
  useEffect(() => {
    const un = listen('clipboard-send', (e) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN && typeof e.payload === 'string') {
        ws.send(JSON.stringify({ type: 'CLIPBOARD', text: e.payload }));
      }
    });
    return () => { un.then((f) => f()); };
  }, []);

  // Re-render a few times a second so countdowns move and "fresh" highlights expire.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 250);
    return () => clearInterval(t);
  }, []);

  // --- Window mode: tell Rust when we enter/leave panel mode, and remember where the user puts the panel ---
  useEffect(() => {
    invoke('set_panel_mode', { active: panel, geometry: panel ? loadGeometry() : null });
  }, [panel]);

  useEffect(() => {
    let timer;
    const un = listen('overlay-geometry', (e) => {
      clearTimeout(timer); // moving/resizing fires many events; save once it settles
      timer = setTimeout(() => {
        try { localStorage.setItem(GEOMETRY_KEY, JSON.stringify(e.payload)); } catch { /* storage unavailable */ }
      }, 300);
    });
    return () => { clearTimeout(timer); un.then((f) => f()); };
  }, []);

  // --- New notification: jump above everything and hold there briefly, then behave like a normal window.
  // Runs after the layout effect below has sized and shown the window, so there is something to raise. Raising also
  // gives the window a taskbar button and flashes it, so a card buried under another app can still be found.
  useEffect(() => {
    if (arrivals > 0) invoke('raise_overlay', { holdMs: RAISE_HOLD_MS });
  }, [arrivals]);

  // A taskbar button exists only while something is showing; with nothing to show the overlay stays out of the taskbar.
  const anyVisible = visible.length > 0;
  useEffect(() => {
    invoke('set_taskbar', { show: anyVisible }).catch(() => {});
  }, [anyVisible]);

  // The tray tooltip carries the live count, so "is anything waiting?" never needs a window.
  useEffect(() => {
    invoke('set_tray_status', { live: items.length, hidden: hidden.size }).catch(() => {});
  }, [items.length, hidden.size]);

  // --- Cards mode: the window hugs its content. Panel mode: the user owns the size. ---
  useLayoutEffect(() => {
    if (panel) return;
    const el = stackRef.current;
    if (!el) { invoke('fit_overlay', { width: WIDTH, height: 0 }); return; } // nothing live: hide
    const fit = () => invoke('fit_overlay', { width: WIDTH, height: Math.ceil(el.getBoundingClientRect().height) });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  });

  if (visible.length === 0) return null;

  const onOpen = appConfigured ? open : null;
  if (panel) return <Panel items={visible} views={views} act={act} onOpen={onOpen} onHide={hide} />;

  return (
    <div id="stack" ref={stackRef}>
      {visible.map((n) => (
        <CardShell key={n.id} n={n} view={views[n.kind] ?? defaultView} act={act} onOpen={onOpen} onHide={hide} />
      ))}
    </div>
  );
}
