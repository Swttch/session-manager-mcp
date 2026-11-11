// Who started a session. This program's own record answers first: a session started through
// start_session, or put under another by hand, has its parent in the mark. Only when nothing was
// chosen here does the desktop app's record of who started it answer (a session the desktop app
// started is known to it alone).

import { readDesktopState } from './desktop-sessions.js';
import { getCliSession } from './cli-sessions.js';
import { TOP_LEVEL_ON_PURPOSE } from './set-parent.js';

/**
 * `{ startedBy, source, cwd }`: the id of the session that started [sessionId], where that is
 * recorded ('marks' or 'desktop'), and the folder that session works in (null when its transcript is
 * not found), which is what a program needs to look the starter up by. `startedBy` is null, with
 * source 'marks', for a session taken to the top level on purpose, and null with source null when
 * nothing says who started it.
 */
export function startedBy(ctx, sessionId, { desktopRoot } = {}) {
  const answer = (id, source) => ({ startedBy: id, source, cwd: id ? folderOf(ctx, id) : null });
  const chosen = ctx.store.marks.find(sessionId)?.parentSessionUid ?? null;
  if (chosen === TOP_LEVEL_ON_PURPOSE) return answer(null, 'marks');
  if (chosen) return answer(chosen, 'marks');
  const starter = readDesktopState(desktopRoot).starters[sessionId];
  return starter ? answer(starter, 'desktop') : answer(null, null);
}

function folderOf(ctx, sessionId) {
  try {
    return getCliSession({ configDir: ctx.configDir, sessionId }).cwd ?? null;
  } catch {
    return null;
  }
}
