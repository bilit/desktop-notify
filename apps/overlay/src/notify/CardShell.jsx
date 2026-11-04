import React from 'react';

const FRESH_MS = 1500; // how long a new arrival is highlighted

/**
 * Wraps one notification's card with the behaviour every kind gets for free:
 *  - a × that HIDES the card on this overlay. It sends no action: the notification stays live for everyone else
 *    (browser, other devices) and expires normally. Closing must never secretly mean "decline" or "reject".
 *  - click anywhere on the card except its own buttons to open it in the app window, when one is configured
 *  - a brief highlight when it has just arrived
 * Views only draw the card; they don't need to know about any of this.
 */
export default function CardShell({ n, view, act, onOpen, onHide }) {
  const fresh = Date.now() - n.arrivedAt < FRESH_MS;
  return (
    <div
      className={`shell ${fresh ? 'fresh' : ''} ${onOpen ? 'openable' : ''}`}
      onClick={onOpen ? (e) => onOpen(n, e) : undefined}
    >
      <view.Card n={n} act={act} />
      <button
        className="close"
        aria-label="Hide notification"
        title="Hide (it stays live elsewhere; no action is sent)"
        onClick={() => onHide([n.id])}
      >
        ×
      </button>
    </div>
  );
}
