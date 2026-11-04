// Compiles the way a TypeScript backend would use the copied-in server file. Never run; only type-checked.
import http from 'node:http';
import { createNotifyServer, type ActionEvent, type NotificationInput } from '../../../dist/dropin/notify-server.mjs';

const server = http.createServer();
const notify = createNotifyServer({
  server,
  path: '/notify',
  authenticate: async (req) => (req.headers['x-user'] as string | undefined) ?? null,
  secret: 'x'.repeat(16),
});

const n: NotificationInput = { kind: 'order-filled', ttlSeconds: 30, data: { orderId: 7 } };
const stored = notify.publish('alice', n);
const token: string = notify.createDeviceToken('alice', { ttlSeconds: 60 });

notify.on('action', (e: ActionEvent) => {
  console.log(e.userId.toUpperCase(), e.action, e.by === 'desktop', e.notification.id);
});

export { stored, token };
