// Archiving a session by hand, for a program that is not a model (a session list). It edits the record of
// the session (the mark's archivedAt) and nothing else: no process is stopped and no worktree is touched.
// The archive_session tool does the same marking and also removes the worktree this server made.

import { getCliSession } from './cli-sessions.js';
import { SessionMark } from './store/entities.js';

/**
 * What the mark's archivedAt holds:
 *   > 0   archived, since that time (milliseconds)
 *   -1    brought back on purpose; a record kept elsewhere that says archived (the Claude desktop app's) is not to be shown
 *   0     nothing chosen; a program that knows of another record may show that one
 * Everything that asks whether a session is archived asks archivedAt > 0, so -1 and 0 both say "not archived".
 */
export const UNARCHIVED_ON_PURPOSE = -1;

/** Passed as the state to forget what was chosen: the session is then neither archived nor brought back by choice. */
export const INHERIT_ARCHIVE = Symbol('inherit-archive');

/**
 * Archive [sessionId] (state true), bring it back on purpose (false), or forget what was chosen (INHERIT_ARCHIVE).
 */
export function setSessionArchived(ctx, sessionId, state) {
  const { store, configDir } = ctx;
  getCliSession({ configDir, sessionId }); // throws "Session not found" for an unknown id
  const existing = store.marks.find(sessionId);
  const mark = existing ?? new SessionMark({ sessionUid: sessionId });
  const before = mark.archivedAt ?? 0;
  if (state === true) {
    if (before > 0) return { session_id: sessionId, archived: true, changed: false, message: 'It already is archived.' };
    mark.archivedAt = Date.now();
  } else if (state === false) {
    if (before === UNARCHIVED_ON_PURPOSE) return { session_id: sessionId, archived: false, changed: false, message: 'It already was brought back.' };
    mark.archivedAt = UNARCHIVED_ON_PURPOSE;
  } else {
    if (before === 0) return { session_id: sessionId, archived: false, changed: false, message: 'Nothing was chosen for it by hand.' };
    mark.archivedAt = 0;
  }
  store.marks.save(mark);
  return {
    session_id: sessionId,
    archived: mark.archivedAt > 0,
    changed: true,
    message: state === true ? 'It is now archived.' : state === false ? 'It is brought back.' : 'What was chosen for it by hand is forgotten.',
  };
}
