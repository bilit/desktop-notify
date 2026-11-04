import React, { useEffect, useRef, useState } from 'react';
import { CONFIRM_MS } from './shared.js';

/**
 * Bulk actions for a group of same-kind notifications, as declared by the kind's view:
 * `view.bulk` = [{action, label, style, confirm?}]. A `confirm` action needs a second click within 3s.
 * Whole-group actions are risky for some kinds (e.g. approving payments) and harmless for others (dismissing), which
 * is why each kind's view declares which ones need the confirming click. `style` is a button class: primary, info,
 * neutral or warn.
 */
export default function BulkButtons({ items, act, view }) {
  const [confirming, setConfirming] = useState(null); // action awaiting a second click
  const timer = useRef(null);
  const ids = items.map((x) => x.id);

  // A changed set invalidates a pending confirmation: the user hasn't seen the new set.
  const key = ids.join('|');
  useEffect(() => { setConfirming(null); clearTimeout(timer.current); }, [key]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = (b) => {
    if (b.confirm && confirming !== b.action) {
      setConfirming(b.action);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(null), CONFIRM_MS);
      return;
    }
    clearTimeout(timer.current);
    setConfirming(null);
    act(ids, b.action);
  };

  return (
    <div className="bulk">
      <span className="bulk-label mono">{items.length} {items.length === 1 ? view.noun : `${view.noun}s`}</span>
      {view.bulk.map((b) => {
        const armed = confirming === b.action;
        return (
          <button key={b.action} className={armed ? 'warn' : b.style} onClick={() => run(b)}>
            {armed ? `Confirm ${items.length}?` : b.label}
          </button>
        );
      })}
    </div>
  );
}
