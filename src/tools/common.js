import path from 'node:path';
import { getCliSession } from '../cli-sessions.js';
import { SessionMark } from '../store/entities.js';
import { resolveSessionId } from './context.js';

// A message from one session to another: plain text whose first line names the sender,
// `From <title> (session <id>):`. The first line is a contract: a program that draws transcripts
// reads the sender out of it and shows the message as coming from that session, not as typed text.
// It is not the CLI's own `<cross-session-message>` tag, because the CLI drops a typed message
// that is only that tag (nobody may fake a peer), and the session would never see it.
export function framePeerMessage({ from, name, body }) {
  const title = String(name ?? '').replace(/[\r\n]+/g, ' ').trim() || 'another session';
  return `From ${title}${from ? ` (session ${from})` : ''}:\n${body}`;
}

// A tool that has nothing behind it yet: listed, so the model sees the whole surface, and honest when called.
export function notYet(name, properties, required, description, reason) {
  return {
    name,
    description: `${description} (Not available in this server yet: ${reason}.)`,
    inputSchema: { type: 'object', properties, required },
    handler: async () => { throw new Error(`unavailable: ${reason}`); },
  };
}

// The folder the calling session works in (what "inside the session's folders" means).
export function sessionFolder(ctx, sessionId) {
  const id = sessionId ?? ctx.selfSessionId;
  if (id) {
    const cwd = getCliSession({ configDir: ctx.configDir, sessionId: resolveSessionId(ctx, id) }).cwd;
    if (cwd) return cwd;
  }
  return process.env.SWTTCH_CWD || process.cwd();
}

export function markOf(ctx, sessionId) {
  return ctx.store.marks.find(sessionId) ?? new SessionMark({ sessionUid: sessionId });
}

export function insideFolder(base, target) {
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path must be inside the session folder (${base}).`);
  }
  return resolved;
}
