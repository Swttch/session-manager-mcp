// Starting a fresh local session: validate the brief, then run `claude -p --session-id ...` detached.
// Used by start_session directly and by a proposal when the user starts it.

import { randomUUID } from 'node:crypto';
import { getCliSession } from './cli-sessions.js';
import { SessionMark } from './store/entities.js';
import { createWorktree } from './worktrees.js';

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
  await ctx.runtime.spawnDetached(cliArgs, cwd);
  return { session_id: sessionId, name: handle };
}

function safeCwd(ctx, sessionId) {
  try { return getCliSession({ configDir: ctx.configDir, sessionId }).cwd; } catch { return null; }
}
