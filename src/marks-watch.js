// Watching the package's own record of sessions (the `session_marks` table): who a session was put under by
// hand, what was archived by hand, the short name its family calls it by. The table is written by the tools of
// this package (set_session_parent and the like), which a program that shows the lists does not see run, so a
// change made from any session, including one in the desktop app, is announced from here.
//
// The table is one file. It is polled (`fs.watchFile`) instead of watched with `fs.watch` because the file may not
// exist yet and a first write must still be seen. A write that leaves every row as it was is not announced.

import fs from 'node:fs';
import { openStore } from './store/entities.js';
import { defaultDataDir } from './store/jsonl-table.js';

const POLL_MS = 500;

/**
 * Call `onChange()` when a row of the marks table changes. The first read only becomes the baseline.
 * Returns the function that stops watching.
 */
export function watchMarks(onChange, { dataDir = defaultDataDir(), pollMs = POLL_MS } = {}) {
  const marks = openStore({ dataDir }).marks;
  const file = marks.table.file;
  let known = null;
  let stopped = false;

  const snapshot = () => {
    try {
      const rows = marks.table.readAll();
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return JSON.stringify(rows);
    } catch {
      // Written while being read: the next poll sees it whole.
      return known;
    }
  };

  const check = () => {
    const now = snapshot();
    const before = known;
    known = now;
    if (!stopped && before !== null && now !== before) onChange();
  };
  known = snapshot();

  fs.watchFile(file, { interval: pollMs, persistent: true }, check);
  return () => {
    stopped = true;
    fs.unwatchFile(file, check);
  };
}
