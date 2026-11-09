// Git worktrees for sessions, made with `git worktree` (the documented command a terminal user would run).
//
// Layout: <project>/.swttch/worktrees/<name>-<suffix>, on a branch <prefix>/<name>-<suffix>. The folder
// is added to the project's .git/info/exclude (a local-only file), so a worktree never shows up in the
// project's own `git status` and nothing tracked is touched.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'session';

export function branchPrefix(ctx) {
  return ctx.store.settings.find('branch_prefix')?.value ?? 'swttch';
}

async function git(ctx, args, cwd) {
  return ctx.runtime.exec('git', args, { cwd });
}

// The main checkout of the repository that `cwd` belongs to (also from inside one of its worktrees).
export async function repoRootOf(ctx, cwd) {
  const common = await git(ctx, ['rev-parse', '--git-common-dir'], cwd);
  if (common.code !== 0) throw new Error(`use_worktree needs a git repository: ${cwd} is not inside one.`);
  const gitDir = path.resolve(cwd, common.stdout.trim());
  return { repo: path.dirname(gitDir), gitDir };
}

function excludeWorktreeFolder(gitDir) {
  const file = path.join(gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!text.split('\n').some((line) => line.trim() === '.swttch/')) {
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}.swttch/\n`);
  }
}

export async function createWorktree(ctx, { cwd, name, sourceBranch }) {
  const { repo, gitDir } = await repoRootOf(ctx, cwd);
  const suffix = randomBytes(4).toString('hex').slice(0, 6);
  const base = `${slug(name)}-${suffix}`;
  const branch = `${branchPrefix(ctx)}/${base}`;
  const target = path.join(repo, '.swttch', 'worktrees', base);
  let source = sourceBranch;
  if (!source) {
    const head = await git(ctx, ['symbolic-ref', '--short', 'HEAD'], repo);
    source = head.code === 0 ? head.stdout.trim() : 'HEAD';
  }
  excludeWorktreeFolder(gitDir);
  const added = await git(ctx, ['worktree', 'add', '-b', branch, target, source], repo);
  if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim()}`);
  return { repo, path: target, branch, sourceBranch: source };
}

export function worktreeExists(wt) {
  return Boolean(wt) && fs.existsSync(wt.path);
}

// Removes the worktree folder (the branch stays). Refuses one with uncommitted changes unless forced.
export async function removeWorktree(ctx, wt, { force = false } = {}) {
  if (!worktreeExists(wt)) {
    await git(ctx, ['worktree', 'prune'], wt.repo);
    return { removed: true, already: true };
  }
  if (!force) {
    const status = await git(ctx, ['status', '--porcelain'], wt.path);
    if (status.code !== 0) return { removed: false, reason: `its worktree could not be checked: ${status.stderr.trim()}` };
    if (status.stdout.trim() !== '') return { removed: false, reason: 'uncommitted changes in its worktree' };
  }
  const res = await git(ctx, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path], wt.repo);
  if (res.code !== 0) return { removed: false, reason: `git worktree remove failed: ${res.stderr.trim()}` };
  return { removed: true };
}

// Deletes the branch only when git agrees nothing would be lost (`branch -d` refuses unmerged commits).
export async function deleteBranchIfSafe(ctx, wt) {
  const res = await git(ctx, ['branch', '-d', wt.branch], wt.repo);
  return res.code === 0;
}

// Brings a removed worktree back on its branch, for a session that resumes after being archived.
export async function restoreWorktree(ctx, wt) {
  if (worktreeExists(wt)) return;
  await git(ctx, ['worktree', 'prune'], wt.repo);
  const res = await git(ctx, ['worktree', 'add', wt.path, wt.branch], wt.repo);
  if (res.code !== 0) throw new Error(`Could not bring the worktree back: ${res.stderr.trim()}`);
}

export function folderBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}
