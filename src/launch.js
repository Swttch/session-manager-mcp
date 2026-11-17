// Starting a fresh local session: validate the brief, then run `claude -p --session-id ...` detached.
// Used by start_session directly and by a proposal when the user starts it.

import { randomUUID } from 'node:crypto';
import { getCliSession } from './cli-sessions.js';
import { SessionMark } from './store/entities.js';
import { createWorktree } from './worktrees.js';
import { reportTurnEnd } from './wake.js';
import { spawnTracked, recordRunning, clearRunning } from './running-sessions.js';

export const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MIN_BACKGROUND = 80;

export function unavailable(what) {
  return new Error(`unavailable: ${what}`);
}

// What this server cannot do for any kind of start.
export function rejectUnsupported(args) {
  if (args.target !== undefined && args.target !== 'local') throw unavailable(`target "${args.target}" is not supported; only local sessions can be started`);
  if (args.preset !== undefined || args.environment !== undefined || args.repository !== undefined) throw unavailable('presets, cloud environments and repositories are not supported');
  if (args.context === 'fork') throw unavailable('context "fork" is not built yet');
}

export function validateTitle(args) {
  if (typeof args.title !== 'string' || args.title.trim() === '') throw new Error('title is required.');
}

export function validateBrief(args) {
  validateTitle(args);
  if (typeof args.prompt !== 'string' || args.prompt.trim() === '') throw new Error('prompt is required.');
  if (typeof args.background !== 'string' || args.background.length < MIN_BACKGROUND) throw new Error(`background is required and must be at least ${MIN_BACKGROUND} characters.`);
  if (args.permission_mode !== undefined && !MODES.includes(args.permission_mode)) throw new Error(`permission_mode must be one of: ${MODES.join(', ')}`);
  if (args.effort !== undefined && !EFFORTS.includes(args.effort)) throw new Error(`effort must be one of: ${EFFORTS.join(', ')}`);
}

function handleFrom(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'session';
}

export async function launchSession(ctx, args, { parentSessionId = ctx.selfSessionId } = {}) {
  rejectUnsupported(args);
  validateBrief(args);
  let cwd = args.cwd ?? (parentSessionId ? safeCwd(ctx, parentSessionId) : null) ?? process.cwd();
  const sessionId = randomUUID();
  const handle = args.name ?? handleFrom(args.title);
  // A worktree when asked for, and by default when the caller itself works in one; never when told not to.
  const parentMark = parentSessionId ? ctx.store.marks.find(parentSessionId) : undefined;
  let worktree = null;
  if (args.use_worktree === true || (args.use_worktree === undefined && parentMark?.worktree)) {
    worktree = await createWorktree(ctx, { cwd, name: args.branch_name ?? handle, sourceBranch: args.source_branch ?? parentMark?.worktree?.sourceBranch });
    cwd = worktree.path;
  }
  // The same frame the desktop apps recognise as "a brief from the session that started this one".
  const text = `Background (from the session that started this one):\n${args.background}\n\nTask:\n${args.prompt}`;
  const cliArgs = ['-p', '--session-id', sessionId, '--name', args.title];
  if (args.model) cliArgs.push('--model', args.model);
  if (args.effort) cliArgs.push('--effort', args.effort);
  if (args.permission_mode) cliArgs.push('--permission-mode', args.permission_mode);
  cliArgs.push(text);
  ctx.store.marks.save(new SessionMark({
    sessionUid: sessionId, title: args.title, handle, cwd, startedAt: Date.now(),
    parentSessionUid: parentSessionId ?? null, worktree, model: args.model ?? null, effort: args.effort ?? null, permissionMode: args.permission_mode ?? null,
  }));
  // The session that asked is told when this one ends its turn, unless it asked not to be or there
  // is no such session. This server is the one watching, so it can only tell while it is still up.
  const wake = args.wake_when_done !== false && Boolean(parentSessionId);
  // While the program runs, `desktop-state` lists the session as running: the desktop app does not know it.
  const onExit = wake ? (exitCode) => reportTurnEnd(ctx, { parentSessionId, sessionId, title: args.title, exitCode }) : undefined;
  // The backend that holds the session that asked runs the new session when it can: a CLI it runs has the channel
  // through which the session asks the person, which a CLI started here does not have. Otherwise it is started here.
  const runByHost = await startThroughHost(ctx, { parentSessionId, sessionId, cwd, text, args, onExit });
  if (!runByHost) await spawnTracked(ctx, sessionId, cliArgs, cwd, onExit);
  return { session_id: sessionId, name: handle, cwd, wake_when_done: wake };
}

/** How long the backend may hold one request that waits for the end of a turn; the wait is asked again after it. */
const TURN_WAIT_MS = 50_000;

/**
 * How long the backend has to answer that it started the session. Longer than an ordinary request: the CLI is
 * started before the answer. A request that gives up while the backend goes on starting the session would look like
 * a failed start of a session that runs, and the caller would start it again.
 */
const START_TIMEOUT_MS = 60_000;

/**
 * Hands the new session to the backend that holds the session that asked, when that backend can run it. Answers whether
 * it did; `false` means nothing was asked of any backend, and the caller starts the session itself.
 *
 * The only thing checked of the backend is whether it can take this request: it is asked what it can do first, and an
 * older backend, which does not know that question either, is answered as one that cannot. A backend that says it can
 * is the one that runs the session; if it then fails, that is an error of the start and not a reason to start a second
 * copy here, because a request that ran out of time may have started the session all the same.
 *
 * While the first turn of the session goes on, the session is on the running record (it has no program of ours to
 * look at, so the backend's own process stands for it), and the end of that turn is waited for with requests that the
 * backend holds up to TURN_WAIT_MS each. When the turn ends, or the backend cannot be asked any more, the record is
 * cleared and `onExit` is called, as it is when a program of ours ends.
 */
async function startThroughHost(ctx, { parentSessionId, sessionId, cwd, text, args, onExit }) {
  if (!parentSessionId || !ctx.owners) return false;
  const owner = await ctx.owners.find(parentSessionId);
  if (!owner) return false;
  if (!(await canRunSessions(ctx, owner))) return false;

  const answer = await ctx.owners.control(
    owner,
    {
      sessionId,
      action: 'start_session',
      workingDir: cwd,
      text,
      title: args.title,
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.permission_mode ? { permissionMode: args.permission_mode } : {}),
    },
    { timeoutMs: START_TIMEOUT_MS },
  );
  if (answer?.ok !== true) throw new Error('The backend did not start the session.');

  recordRunning(sessionId, owner.pid, { dataDir: ctx.dataDir });
  void waitForFirstTurn(ctx, owner, sessionId, Number.isInteger(answer.turnEnds) ? answer.turnEnds : 0, onExit);
  return true;
}

/** Whether the backend answers that it starts sessions and reports the end of their turns. */
async function canRunSessions(ctx, owner) {
  try {
    const answer = await ctx.owners.control(owner, { action: 'capabilities' });
    return Array.isArray(answer?.actions) && answer.actions.includes('start_session') && answer.actions.includes('await_turn_end');
  } catch {
    return false; // an older backend answers "unknown action"
  }
}

async function waitForFirstTurn(ctx, owner, sessionId, seen, onExit) {
  let after = seen;
  try {
    for (;;) {
      const answer = await ctx.owners.control(
        owner,
        { sessionId, action: 'await_turn_end', after, waitMs: TURN_WAIT_MS },
        { timeoutMs: TURN_WAIT_MS + 10_000 },
      );
      if (answer?.ok !== true || answer.ended === true) break;
      after = Number.isInteger(answer.turnEnds) ? answer.turnEnds : after;
    }
  } catch {
    // The backend cannot be asked any more (it ended): the session ended with it.
  }
  clearRunning(sessionId, { dataDir: ctx.dataDir, pid: owner.pid });
  try {
    await onExit?.(null);
  } catch {
    // Nobody waits for the report; see reportTurnEnd.
  }
}

function safeCwd(ctx, sessionId) {
  try { return getCliSession({ configDir: ctx.configDir, sessionId }).cwd; } catch { return null; }
}
