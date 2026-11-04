import { useEffect, useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import type { Notification, OpenEvent, Resolved, SendAction, ToastRenderer } from './types';

/** `/notify` -> `wss://<this page's host>/notify` (cookies travel with a same-origin WebSocket). Absolute URLs pass through. */
function resolveWsUrl(url: string): string {
  if (/^wss?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${url}`;
  return url;
}

export interface HubOptions {
  /**
   * Where the notify server listens: an absolute `ws(s)://` URL, or a path on this page's origin like `'/notify'`.
   * Default `'/notify'`, which suits a server embedded in your own backend.
   */
  url?: string;
  /**
   * Query token sent with the connection. Omit it (the default) when your server identifies the browser from the
   * session cookie, which is the embedded setup. Only the standalone dev hub needs one.
   */
  token?: string | null;
  /** A new notification, or an in-place update of one already shown (same id). */
  onNotify?: (n: Notification) => void;
  /** How a notification ended: acted on anywhere, or expired. */
  onResolved?: (r: Resolved) => void;
  /**
   * The user clicked a notification in the desktop overlay and this page is hosted in the overlay's app window
   * (see NOTIFY_APP_URL): navigate to or highlight whatever it refers to. Only fires inside that window; a normal
   * browser tab never receives it. Safe to ignore.
   */
  onOpen?: (e: OpenEvent) => void;
  /**
   * Toast renderers by notification `kind`. Kinds without one get a plain toast with a Dismiss button.
   * Toasts only appear while no desktop overlay is connected, so nothing is shown twice.
   */
  toasts?: Record<string, ToastRenderer>;
}

// Subtle synthesized chime using Web Audio API (no external mp3 required)
function playAlertChime() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12); // E6
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // Ignore if user hasn't interacted with DOM yet
  }
}

function showFallbackToast(n: Notification, sendAction: SendAction) {
  const d = (n.data ?? {}) as { title?: string; text?: string };
  toast(d.title ?? n.kind, {
    id: n.id, // same id => update-in-place instead of a duplicate toast
    description: d.text,
    duration: n.ttlSeconds * 1000,
    action: { label: 'Dismiss', onClick: () => sendAction(n.id, 'dismiss') },
  });
}

/**
 * Connects the page to the notification hub as role "browser" and reconnects automatically.
 * Returns connection state plus `sendAction` for views to report the user's decision.
 */
export function useHub(options: HubOptions) {
  const [hubConnected, setHubConnected] = useState(false);
  const [desktopConnected, setDesktopConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const desktopRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options; // always use the latest callbacks without reconnecting

  const sendAction = useCallback<SendAction>((id, action, payload) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ACTION', id, action, payload }));
  }, []);

  // The overlay's app window pushes a clicked notification in as a plain DOM event. If the click happened before this
  // page had mounted its listener (still loading, or mid-login redirect), the detail is parked on `window` instead.
  useEffect(() => {
    const w = window as unknown as { __notifyOpenPending?: OpenEvent };
    const deliver = (detail: OpenEvent) => {
      delete w.__notifyOpenPending; // handled; don't replay it on the next mount
      optionsRef.current.onOpen?.(detail);
    };
    const listener = (e: Event) => deliver((e as CustomEvent<OpenEvent>).detail);
    window.addEventListener('notify-open', listener);
    if (w.__notifyOpenPending) deliver(w.__notifyOpenPending);
    return () => window.removeEventListener('notify-open', listener);
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;

    const showToast = (n: Notification) => {
      // An explicit `surfaces` list wins. Otherwise the browser stays quiet while a desktop overlay is showing things.
      if (n.surfaces) {
        if (!n.surfaces.includes('browser')) return;
      } else if (desktopRef.current) {
        return;
      }
      const render = optionsRef.current.toasts?.[n.kind];
      if (render) render(n, sendAction);
      else showFallbackToast(n, sendAction);
    };

    const connect = () => {
      if (stopped) return;
      const { url = '/notify', token = null } = optionsRef.current;
      const query = new URLSearchParams({ role: 'browser' });
      if (token) query.set('token', token);
      const ws = new WebSocket(`${resolveWsUrl(url)}?${query}`);
      wsRef.current = ws;

      ws.onopen = () => setHubConnected(true);

      ws.onmessage = (event) => {
        let m: { type: string; [k: string]: unknown };
        try { m = JSON.parse(event.data); } catch { return; }

        switch (m.type) {
          case 'PRESENCE': {
            const present = Boolean(m.desktopConnected);
            desktopRef.current = present;
            setDesktopConnected(present);
            if (present) toast.dismiss(); // the overlay now owns what's live
            break;
          }
          case 'SNAPSHOT':
            (m.notifications as Notification[]).forEach((n) => {
              optionsRef.current.onNotify?.(n);
              showToast(n);
            });
            break;
          case 'NOTIFY':
          case 'UPDATE': {
            const n = m.notification as Notification;
            optionsRef.current.onNotify?.(n);
            if (m.type === 'NOTIFY') playAlertChime();
            showToast(n);
            break;
          }
          case 'RESOLVED':
            toast.dismiss(m.id as string);
            optionsRef.current.onResolved?.(m as unknown as Resolved);
            break;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setHubConnected(false);
        setDesktopConnected(false);
        desktopRef.current = false;
        if (!stopped) retry = window.setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [sendAction]);

  return { hubConnected, desktopConnected, sendAction };
}
