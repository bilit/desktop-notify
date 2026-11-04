import type { Server, IncomingMessage } from 'node:http';

export interface NotificationInput {
  /** What kind of notification this is. Clients pick a view by kind. [A-Za-z0-9._:-]{1,64} */
  kind: string;
  /** Publishing with an existing live id updates that notification in place (its expiry keeps running). */
  id?: string;
  /** Lifetime in seconds, 1..3600. Default 30. */
  ttlSeconds?: number;
  /** Anything the view for this kind needs. Passed to clients untouched. */
  data?: unknown;
  /** Which kinds of client show it. Absent = default routing (browser stays quiet while a desktop overlay is up). */
  surfaces?: Array<'browser' | 'desktop'>;
}

export interface Notification extends NotificationInput {
  id: string;
  createdAt: number;
}

export interface ActionEvent {
  userId: string;
  id: string;
  kind: string;
  /** Whatever the client sent, e.g. 'accept', 'dismiss'. */
  action: string;
  payload: unknown;
  /** Which kind of client the user acted in. */
  by: 'browser' | 'desktop';
  notification: Notification;
}

export interface ExpiredEvent {
  userId: string;
  id: string;
  kind: string;
  notification: Notification;
}

export interface NotifyServerOptions {
  /** The HTTP server your backend already runs. The WebSocket attaches to it; other upgrade paths are left alone. */
  server: Server;
  /** WebSocket path. Default '/notify'. */
  path?: string;
  /**
   * Who is this browser connection? Return the user id (e.g. from your session), or null/undefined to reject.
   * May be async. Called for role=browser connections only.
   */
  authenticate: (req: IncomingMessage) => string | number | null | undefined | Promise<string | number | null | undefined>;
  /** Signing secret (16+ chars). Required to issue device tokens for the desktop overlay. */
  secret?: string;
  /**
   * Optional login for role=desktop, tried when the token isn't a valid device token. Return the user id, or null to
   * refuse.
   *
   * `claim.user` is the username the overlay says it is (`?user=`, max 128 chars, else null). It is **unverified**.
   * Returning it as-is (`(_t, _r, { user }) => user`) lets anyone who can reach the server read that user's
   * notifications and act as them, so use that only on a trusted network, and replace it with a real check
   * (your SSO, a signed token) when the overlay can sign in. Without this hook a bare `?user=` authenticates no one.
   */
  authenticateDesktop?: (
    token: string | null,
    req: IncomingMessage,
    claim: { user: string | null }
  ) => string | number | null | undefined | Promise<string | number | null | undefined>;
  /** Browser Origins allowed to connect. Default: same origin only (Origin host must equal the Host header). */
  allowedOrigins?: string[];
  /** Origins the desktop overlay's webview connects from. Default: the Tauri origins. */
  desktopOrigins?: string[];
  /** Max inbound WebSocket message size in bytes. Default 65536. */
  maxPayload?: number;
  /** Max simultaneously live notifications per user. Default 1000. */
  maxLivePerUser?: number;
  /** Clipboard text from the overlay is truncated to this many characters. Default 5000. */
  maxClipboardChars?: number;
  heartbeatMs?: number;
  logger?: Pick<Console, 'error'>;
}

export interface NotifyServer {
  /** Publish to one user's connected clients (and to their next connection, until it expires). */
  publish(userId: string | number, notification: NotificationInput): Notification;
  /** Withdraw a live notification from that user's clients. Returns false if it wasn't live. */
  cancel(userId: string | number, id: string): boolean;
  /** Issue a token the desktop overlay uses to log in as this user. Requires `secret`. Default lifetime 7 days. */
  createDeviceToken(userId: string | number, opts?: { ttlSeconds?: number }): string;
  verifyDeviceToken(token: string): string | null;
  liveIds(userId: string | number): string[];
  desktopConnected(userId: string | number): boolean;
  stats(): { users: number; clients: number; live: number };
  on(event: 'action', listener: (e: ActionEvent) => void): void;
  on(event: 'expired', listener: (e: ExpiredEvent) => void): void;
  on(event: 'connect' | 'disconnect', listener: (e: { userId: string; role: 'browser' | 'desktop' }) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  close(): Promise<void>;
}

export function createNotifyServer(options: NotifyServerOptions): NotifyServer;
