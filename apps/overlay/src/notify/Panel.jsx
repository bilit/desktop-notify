import React, { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import BulkButtons from './BulkButtons.jsx';
import CardShell from './CardShell.jsx';
import { defaultView } from './defaultView.jsx';
import { secondsLeft } from './shared.js';

const AT_TOP_PX = 40;  // within this of the top counts as "looking at the newest"

/**
 * Panel mode (3+ live notifications): one draggable, resizable window.
 *  - header: summary + bulk actions per kind (drag the header to move the window)
 *  - list: every live notification as its kind's card, newest on top, scrollable
 *  - "N new" chip when something arrives while you're scrolled down
 *  - grip in the bottom-right corner to resize
 */
export default function Panel({ items, views, act, onOpen, onHide }) {
  const listRef = useRef(null);
  const [atTop, setAtTop] = useState(true);
  const seen = useRef(new Set()); // ids the user has had the chance to see (they were at the top)

  // While at the top, everything live counts as seen; otherwise new ids accumulate as "new".
  useEffect(() => {
    if (atTop) items.forEach((n) => seen.current.add(n.id));
  });
  const unseen = atTop ? 0 : items.filter((n) => !seen.current.has(n.id)).length;

  const ordered = [...items].reverse(); // newest first
  const viewOf = (kind) => views[kind] ?? defaultView;

  // One bulk group per kind so a bulk action only ever touches notifications of the same type.
  const groups = new Map();
  items.forEach((n) => groups.set(n.kind, [...(groups.get(n.kind) ?? []), n]));

  const soonest = Math.max(0, Math.ceil(Math.min(...items.map(secondsLeft))));
  const breakdown = [...groups].map(([kind, g]) => viewOf(kind).subtitle?.(g)).filter(Boolean).join(' • ');
  const oneKind = groups.size === 1 ? viewOf([...groups.keys()][0]) : null;
  const title = oneKind ? `${items.length} ${items.length === 1 ? oneKind.noun : `${oneKind.noun}s`}` : `${items.length} notifications`;

  return (
    <div id="panel">
      <div className="panel-head" data-tauri-drag-region>
        <button
          className="panel-close"
          aria-label="Hide all notifications"
          title="Hide all (they stay live elsewhere; no action is sent). Left-click the tray icon to bring them back."
          onClick={() => onHide(items.map((n) => n.id))}
        >
          ×
        </button>
        <div className="panel-title">
          <h2 className="mono">{title}</h2>
          <div className="sub">{breakdown ? `${breakdown} • ` : ''}soonest expires in {soonest}s</div>
        </div>
        <div className="bulks">
          {[...groups].map(([kind, g]) => <BulkButtons key={kind} items={g} act={act} view={viewOf(kind)} />)}
        </div>
      </div>

      <div className="plist-wrap">
        {unseen > 0 && (
          <button className="new-chip" onClick={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>
            ▲ {unseen} new
          </button>
        )}
        <div className="plist" ref={listRef} onScroll={(e) => setAtTop(e.currentTarget.scrollTop < AT_TOP_PX)}>
          {ordered.map((n) => (
            <CardShell key={n.id} n={n} view={viewOf(n.kind)} act={act} onOpen={onOpen} onHide={onHide} />
          ))}
        </div>
      </div>

      <div
        className="grip"
        title="Drag to resize"
        onMouseDown={(e) => { e.preventDefault(); getCurrentWindow().startResizeDragging('SouthEast'); }}
      />
    </div>
  );
}
