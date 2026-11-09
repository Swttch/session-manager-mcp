// Deleting a session for good, with its worktree and branch when nothing would be lost.

import fs from 'node:fs';
import path from 'node:path';
import { findCliSession } from './cli-sessions.js';
import { deleteBranchIfSafe, removeWorktree } from './worktrees.js';

// -> { deleted: true } or { deleted: false, reason }
export async function deleteSessionById(ctx, sessionId, { force = false } = {}) {
  let found;
  try { found = findCliSession({ configDir: ctx.configDir, sessionId }); } catch { return { deleted: false, reason: 'not found' }; }
  const mark = ctx.store.marks.find(sessionId);
  if (mark?.worktree) {
    const removed = await removeWorktree(ctx, mark.worktree, { force });
    if (!removed.removed) return { deleted: false, reason: force ? removed.reason : `${removed.reason} (pass force_worktree_cleanup to discard them)` };
    await deleteBranchIfSafe(ctx, mark.worktree);
  }
  fs.rmSync(found.file);
  fs.rmSync(path.join(path.dirname(found.file), sessionId), { recursive: true, force: true }); // subagent transcripts
  ctx.store.marks.remove(sessionId);
  return { deleted: true };
}
