// Changing by hand which session another one is under: the record of who started whom (the mark's
// parentSessionUid) is edited, and nothing else. A session put under a new parent does not start
// reporting the end of its turns to it; that is set up when a session is started.

import { getCliSession } from './cli-sessions.js';
import { SessionMark } from './store/entities.js';

/** Passed as the parent to forget what was chosen by hand: the session is then neither under a parent nor top-level by choice. */
export const INHERIT = Symbol('inherit');

/**
 * What the mark's parentSessionUid holds:
 *   a session id  the session was put under that session (or was started by it)
 *   ''            the session was taken to the top level on purpose; a record kept elsewhere of who started it is not to be shown
 *   null          nothing was chosen; a program that knows of another record of it may show that one
 */
export const TOP_LEVEL_ON_PURPOSE = '';

/**
 * Put [sessionId] under [parentSessionId], take it to the top level on purpose when the parent is null,
 * or forget what was chosen when the parent is INHERIT.
 *
 * Refuses a session as its own parent and a parent that is below the session (it would close a
 * loop, and neither session would have a place in a list).
 */
export function setSessionParent(ctx, sessionId, parentSessionId) {
  const { store, configDir } = ctx;
  getCliSession({ configDir, sessionId }); // throws "Session not found" for an unknown id
  if (parentSessionId && parentSessionId !== INHERIT) {
    if (parentSessionId === sessionId) throw new Error('A session cannot be its own parent.');
    getCliSession({ configDir, sessionId: parentSessionId });
    for (let above = parentSessionId, hops = 0; above && hops < 1000; hops++) {
      const next = store.marks.find(above)?.parentSessionUid ?? null;
      if (next === sessionId) throw new Error(`Session ${parentSessionId} is below it (it descends from ${sessionId}), so it cannot be its parent.`);
      above = next;
    }
  }
  const existing = store.marks.find(sessionId);
  const mark = existing ?? new SessionMark({ sessionUid: sessionId });
  const before = mark.parentSessionUid ?? null;
  const after = parentSessionId === INHERIT ? null : parentSessionId === null ? TOP_LEVEL_ON_PURPOSE : parentSessionId;
  const reported = after || null; // what the answer says: a session id, or null for top-level and for nothing chosen
  if (before === after) {
    return { session_id: sessionId, parent_session_id: reported, changed: false, message: messageFor(parentSessionId, false) };
  }
  mark.parentSessionUid = after;
  store.marks.save(mark);
  return { session_id: sessionId, parent_session_id: reported, changed: true, message: messageFor(parentSessionId, true) };
}

function messageFor(parent, changed) {
  if (parent === INHERIT) return changed ? 'What was chosen for it by hand is forgotten.' : 'Nothing was chosen for it by hand.';
  if (parent === null) return changed ? 'It is now a top-level session.' : 'It already is at the top level.';
  return changed
    ? 'It is now under that session. It will not report the end of its turns to it; that is set up only when a session is started.'
    : 'It already is under that session.';
}
