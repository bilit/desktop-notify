// Compiles the way a TypeScript + React app would use the copied-in web file. Never run; only type-checked.
import { useHub, type Notification, type Resolved, type ToastRenderer } from '../../../dist/dropin/notify-web';

const showOrder: ToastRenderer = (n: Notification, sendAction) => {
  sendAction(n.id, 'dismiss', { seen: true });
};

export function Example() {
  const { hubConnected, desktopConnected, sendAction } = useHub({
    url: '/notify', // same-origin path; the session cookie identifies the user, so no token
    onNotify: (n: Notification) => void n.id,
    onResolved: (r: Resolved) => void r.action,
    toasts: { 'order-filled': showOrder },
  });
  return (
    <button onClick={() => sendAction('some-id', 'accept')}>
      {hubConnected ? 'hub up' : 'hub down'} / {desktopConnected ? 'overlay' : 'no overlay'}
    </button>
  );
}
