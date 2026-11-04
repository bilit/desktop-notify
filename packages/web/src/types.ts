// What the hub sends. It relays plain JSON; `data` is interpreted by the view registered for each `kind`.

export interface Notification<T = unknown> {
  id: string;
  kind: string;
  ttlSeconds: number; // time left when the hub sent it
  data: T;
  /** If present, only these kinds of client show it. Absent = default routing (browser stays quiet while a desktop overlay is up). */
  surfaces?: Array<'browser' | 'desktop'>;
  /** Where "open this" should lead, e.g. `{ path: '/orders/7' }`. The publisher chooses the shape; your `onOpen` interprets it. */
  open?: unknown;
}

/** Delivered to `onOpen` when the user clicks a notification in the desktop overlay's card. */
export interface OpenEvent {
  id: string;
  kind: string;
  data: unknown;
  /** The notification's `open` target, if the publisher set one. */
  open: unknown;
}

export interface Resolved {
  id: string;
  kind: string;
  action: string; // whatever the acting view sent ('accept', 'dismiss', ...) or 'EXPIRED'
  payload: Record<string, unknown> | null;
  by: 'browser' | 'desktop' | 'system';
}

/** Send a decision to the hub. The first action on an id wins; later ones are ignored. */
export type SendAction = (id: string, action: string, payload?: unknown) => void;

/** Shows (or updates, since the toast id is the notification id) a browser toast for one notification. */
export type ToastRenderer = (n: Notification, sendAction: SendAction) => void;
