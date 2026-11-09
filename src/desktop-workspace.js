// What the desktop has on screen, read from the workspace record it keeps (<home>/workspace.json).
// Read-only here: the desktop is the only writer. No record means no desktop has run on this home.

import fs from 'node:fs';
import path from 'node:path';

export function readWorkspace(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'));
    return value?.layout ? value : null;
  } catch {
    return null;
  }
}

// Panels in reading order, each with the column and row it sits in.
function place(node, col, row) {
  if (node.kind === 'panel') return { panes: [{ panel: node, col, row }], cols: 1, rows: 1 };
  const across = node.direction === 'columns';
  const panes = [];
  let x = col;
  let y = row;
  let cols = across ? 0 : 1;
  let rows = across ? 1 : 0;
  for (const child of node.children) {
    const placed = place(child, x, y);
    panes.push(...placed.panes);
    if (across) { x += placed.cols; cols += placed.cols; rows = Math.max(rows, placed.rows); }
    else { y += placed.rows; rows += placed.rows; cols = Math.max(cols, placed.cols); }
  }
  return { panes, cols, rows };
}

export function describeWorkspace(workspace, selfSessionId) {
  const panes = workspace ? place(workspace.layout, 0, 0).panes.map(({ panel, col, row }, index) => {
    const active = panel.tabs.find((tab) => tab.id === panel.activeTabId);
    return {
      index, col, row, kind: active?.kind === 'terminal' ? 'terminal' : 'session',
      session_id: active?.kind === 'terminal' ? null : (active?.sessionId ?? null),
      focused: panel.id === workspace.activePanel,
    };
  }) : [];
  const mine = selfSessionId ? panes.find((pane) => pane.session_id === selfSessionId) : undefined;
  return {
    panes,
    this_session: { session_id: selfSessionId ?? null, on_screen: Boolean(mine), shown_in: mine ? `main window, pane ${mine.index}` : 'not on screen' },
  };
}
