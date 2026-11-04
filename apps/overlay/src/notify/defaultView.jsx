import React from 'react';
import { secondsLeft } from './shared.js';

// Fallback view for any notification `kind` that has no registered view.
// Expects `data: { title?, text? }`; offers a single "dismiss" action.

function Card({ n, act }) {
  const d = n.data ?? {};
  return (
    <div className="card">
      <div className="row">
        <span className="title mono">{d.title ?? n.kind}</span>
        <span className="meta mono">{Math.ceil(secondsLeft(n))}s</span>
      </div>
      {d.text && <div className="text" style={{ margin: '8px 0' }}>{d.text}</div>}
      <div className="btns two" style={{ marginTop: 8 }}>
        <button className="neutral" onClick={() => act([n.id], 'dismiss')}>Dismiss</button>
      </div>
    </div>
  );
}

export const defaultView = {
  Card,
  noun: 'notification',
  bulk: [{ action: 'dismiss', label: 'Dismiss all', style: 'neutral' }],
};
