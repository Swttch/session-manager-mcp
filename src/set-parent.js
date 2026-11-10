// Changing by hand which session another one is under: the record of who started whom (the mark's
// parentSessionUid) is edited, and nothing else. A session put under a new parent does not start
// reporting the end of its turns to it; that is set up when a session is started.

import { getCliSession } from './cli-sessions.js';
import { SessionMark } from './store/entities.js';

/**
 * Put [sessionId] under [parentSessionId], or at the top level when the parent is null.
 *
 * Refuses a session as its own parent and a parent that is below the session (it would close a
 * loop, and neither session would have a place in a list).
 */
export function setSessionParent(ctx, sessionId, parentSessionId) {
  const { store, configDir } = ctx;
  getCliSession({ configDir, sessionId }); // throws "Session not found" for an unknown id
  if (parentSessionId) {
    if (parentSessionId === sessionId) throw new Error('A session cannot be its own parent.');
    getCliSession({ configDir, sessionId: parentSessionId });
    for (let above = parentSessionId, hops = 0; above && hops < 1000; hops++) {
      const next = store.marks.find(above)?.parentSessionUid ?? null;
      if (next === sessionId) throw new Error(`Session ${parentSessionId} is below it (it descends from ${sessionId}), so it cannot be its parent.`);
      above = next;
    }
  }
  const mark = store.marks.find(sessionId) ?? new SessionMark({ sessionUid: sessionId });
  const before = mark.parentSessionUid ?? null;
  const after = parentSessionId ?? null;
  if (before === after) {
    return { session_id: sessionId, parent_session_id: after, changed: false, message: after ? 'It already is under that session.' : 'It already is at the top level.' };
  }
  mark.parentSessionUid = after;
  store.marks.save(mark);
  return {
    session_id: sessionId,
    parent_session_id: after,
    changed: true,
    message: after
      ? 'It is now under that session. It will not report the end of its turns to it; that is set up only when a session is started.'
      : 'It is now a top-level session.',
  };
}
