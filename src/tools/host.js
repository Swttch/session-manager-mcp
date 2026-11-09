// The host area: things on the user's computer. Opening a file in an editor, showing it in the
// file manager, keeping the machine awake, measuring disk use, and merging the base branch.

import fs from 'node:fs';
import path from 'node:path';
import { countCliSessions, defaultConfigDir } from '../cli-sessions.js';
import { findCliSession } from '../cli-sessions.js';
import { deleteSessionById } from '../session-removal.js';
import { folderBytes, removeWorktree, worktreeExists } from '../worktrees.js';
import { insideFolder, sessionFolder } from './common.js';
import { resolveContext } from './context.js';

const EDITORS = { vscode: 'code', cursor: 'cursor', windsurf: 'windsurf', zed: 'zed' };
const AWAKE_SECONDS = { turn_end: 1800, session_idle: 3600 };

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

export function createHostTools(options = {}) {
  const ctx = resolveContext(options);
  const { runtime, configDir } = ctx;
  const git = (args, cwd) => runtime.exec('git', args, { cwd });

  // Worktrees this server made that still exist on disk, with the sessions they belong to.
  const worktreeMarks = () => ctx.store.marks.all().filter((mark) => mark.worktree && worktreeExists(mark.worktree));
  function worktreeUsage() {
    const marks = worktreeMarks();
    return {
      count: marks.length,
      bytes: marks.reduce((sum, mark) => sum + folderBytes(mark.worktree.path), 0),
      kept_after_archive: marks.filter((mark) => mark.isArchived).length,
    };
  }

  return [
    {
      name: 'open_in_editor',
      description: 'Open a file from this session\'s folder in the user\'s code editor (VS Code, Cursor, Windsurf or Zed), optionally at a line and column. If several editors are installed, name one with `editor`.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to open: absolute, or relative to the session folder. Must be inside it.' },
          line: { type: 'number', description: '1-based line.' },
          column: { type: 'number', description: '1-based column; ignored without line.' },
          editor: { type: 'string', enum: Object.keys(EDITORS) },
        },
        required: ['path'],
      },
      handler: async ({ path: target, line, column, editor }) => {
        const file = insideFolder(sessionFolder(ctx), target);
        const installed = [];
        for (const [name, bin] of Object.entries(EDITORS)) if (await runtime.which(bin)) installed.push(name);
        if (installed.length === 0) throw new Error('No supported editor (VS Code, Cursor, Windsurf, Zed) was found on PATH.');
        let chosen = editor;
        if (!chosen) {
          if (installed.length > 1) throw new Error(`Several editors are installed (${installed.join(', ')}); ask the user which one and pass it as editor.`);
          chosen = installed[0];
        }
        if (!installed.includes(chosen)) throw new Error(`Editor ${chosen} is not installed (found: ${installed.join(', ')}).`);
        const spot = line ? `${file}:${line}${column ? `:${column}` : ''}` : file;
        await runtime.spawnProgram(EDITORS[chosen], chosen === 'zed' ? [spot] : ['-g', spot]);
        return `Opened ${spot} in ${chosen}.`;
      },
    },
    {
      name: 'reveal_path',
      description: 'Show a file or folder from this session\'s folder in the system file manager, selected in its parent folder.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File or folder, absolute or relative to the session folder. Must be inside it.' } }, required: ['path'] },
      handler: async ({ path: target }) => {
        const abs = insideFolder(sessionFolder(ctx), target);
        if (runtime.platform === 'darwin') await runtime.spawnProgram('open', ['-R', abs]);
        else if (runtime.platform === 'win32') await runtime.spawnProgram('explorer', [`/select,${abs}`]);
        else await runtime.spawnProgram('xdg-open', [path.dirname(abs)]);
        return `Showed ${abs} in the file manager.`;
      },
    },
    {
      name: 'request_keep_awake',
      description: 'Keep the user\'s computer from idle-sleeping for work that must outlast the turn: about 30 minutes for "turn_end", about an hour for "session_idle". Only built for macOS.',
      inputSchema: {
        type: 'object',
        properties: { until: { type: 'string', enum: Object.keys(AWAKE_SECONDS) }, reason: { type: 'string', description: 'One short sentence: what work needs the machine awake.' } },
        required: ['until', 'reason'],
      },
      handler: async ({ until, reason }) => {
        if (!(until in AWAKE_SECONDS)) throw new Error(`until must be one of: ${Object.keys(AWAKE_SECONDS).join(', ')}`);
        if (runtime.platform !== 'darwin') throw new Error('unavailable: keeping the computer awake is only built for macOS');
        await runtime.spawnProgram('caffeinate', ['-i', '-t', String(AWAKE_SECONDS[until])]);
        return `Holding the computer awake for about ${AWAKE_SECONDS[until] / 60} minutes (${reason}). It prevents idle sleep only; a closed lid still sleeps.`;
      },
    },
    {
      name: 'get_storage_usage',
      description: 'Report how much disk the Claude Code conversation history uses on this computer, and the free space left.',
      inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } } },
      handler: async () => {
        const projects = path.join(configDir ?? defaultConfigDir(), 'projects');
        const stat = fs.statfsSync(configDir);
        return {
          conversation_history_bytes: fs.existsSync(projects) ? directorySize(projects) : 0,
          session_count: countCliSessions({ configDir }),
          free_bytes: Number(stat.bavail) * Number(stat.bsize),
          worktrees: worktreeUsage(),
        };
      },
    },
    {
      name: 'clean_up_worktrees',
      description: 'Free disk by removing the worktrees of sessions with no activity in the last 30, 60 or 90 days. The sessions, their conversations and branches stay. A session that is running, pinned or the calling session is never touched; a worktree with uncommitted changes is left unless include_uncommitted is true. delete_sessions also deletes the idle sessions. Both are permanent: use them only when the user asked for exactly that.',
      inputSchema: {
        type: 'object',
        properties: {
          older_than_days: { type: 'number', enum: [30, 60, 90] },
          include_uncommitted: { type: 'boolean', description: 'Also remove worktrees that hold uncommitted changes, losing those changes. Default false.' },
          delete_sessions: { type: 'boolean', description: 'Also delete the inactive sessions and their conversations. Default false.' },
        },
        required: ['older_than_days'],
      },
      handler: async ({ older_than_days, include_uncommitted = false, delete_sessions = false }) => {
        if (![30, 60, 90].includes(older_than_days)) throw new Error('older_than_days must be 30, 60 or 90.');
        const cutoff = Date.now() - older_than_days * 24 * 3600 * 1000;
        const live = new Set((await runtime.listLive()).map((row) => row.sessionId));
        const removed = [];
        const skipped = [];
        let freed = 0;
        for (const mark of worktreeMarks()) {
          const id = mark.sessionUid;
          if (id === ctx.selfSessionId || mark.pinned || live.has(id)) { skipped.push({ session_id: id, reason: 'running, pinned or the calling session' }); continue; }
          let idleSince;
          try { idleSince = findCliSession({ configDir, sessionId: id }).mtimeMs; } catch { idleSince = mark.startedAt; }
          if (idleSince > cutoff) continue;
          const bytes = folderBytes(mark.worktree.path);
          if (delete_sessions) {
            const result = await deleteSessionById(ctx, id, { force: include_uncommitted });
            if (result.deleted) { removed.push(id); freed += bytes; } else skipped.push({ session_id: id, reason: result.reason });
            continue;
          }
          const result = await removeWorktree(ctx, mark.worktree, { force: include_uncommitted });
          if (result.removed) { removed.push(id); freed += bytes; } else skipped.push({ session_id: id, reason: result.reason });
        }
        return { removed, skipped, freed_bytes: freed };
      },
    },
    {
      name: 'discard_kept_worktree',
      description: 'Delete the worktree an archived session left on disk because it held uncommitted changes, discarding those changes for good. The session stays archived and its branch is kept. Use it only when the user asked to discard that session\'s leftover work.',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, folder: { type: 'string' } }, required: ['session_id'] },
      handler: async ({ session_id }) => {
        const mark = ctx.store.marks.find(session_id);
        if (!mark?.isArchived || !mark.worktree || !worktreeExists(mark.worktree)) throw new Error(`Nothing is kept for session ${session_id}: it is not archived or has no worktree left.`);
        const result = await removeWorktree(ctx, mark.worktree, { force: true });
        if (!result.removed) throw new Error(result.reason);
        return `Discarded the kept worktree of session ${session_id} (${mark.worktree.path}); its branch ${mark.worktree.branch} is still there.`;
      },
    },
    {
      name: 'sync_with_base_branch',
      description: 'Bring the session\'s branch up to date with its base branch: fetch the base from origin and merge it into the checked-out branch. Nothing is pushed. A merge with conflicts is left in progress with the conflicted files listed; pass abort to abandon it. Refuses to touch uncommitted changes.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'The base branch. Default: origin\'s default branch.' },
          folder: { type: 'string', description: 'Which folder to act on. Default: the calling session\'s folder.' },
          abort: { type: 'boolean', description: 'Abandon a merge left in progress.' },
        },
      },
      handler: async ({ base, folder, abort }) => {
        const cwd = folder ?? sessionFolder(ctx);
        if (abort) {
          const res = await git(['merge', '--abort'], cwd);
          if (res.code !== 0) throw new Error(res.stderr.trim() || 'There is no merge in progress.');
          return 'Aborted the merge in progress.';
        }
        const status = await git(['status', '--porcelain'], cwd);
        if (status.code !== 0) throw new Error(status.stderr.trim() || 'Not a git repository.');
        if (status.stdout.trim() !== '') throw new Error('Refusing to merge: there are uncommitted changes (or a merge is already in progress). Commit or discard them first.');
        let branch = base;
        if (!branch) {
          const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
          branch = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : 'main';
        }
        const fetch = await git(['fetch', 'origin', branch], cwd);
        if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr.trim()}`);
        // Whether anything changed is read from HEAD, not from git's message, which is translated.
        const before = (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
        const merge = await git(['merge', '--no-edit', `origin/${branch}`], cwd);
        if (merge.code === 0) {
          const after = (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
          return before === after
            ? `up to date: this branch already has origin/${branch}.`
            : `merged origin/${branch} into this branch. Run the project's checks, then push.`;
        }
        const conflicted = await git(['diff', '--name-only', '--diff-filter=U'], cwd);
        const files = conflicted.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        if (files.length === 0) throw new Error(`git merge failed: ${(merge.stderr || merge.stdout).trim()}`);
        return `conflicts: the merge is left in progress. Conflicted files:\n${files.join('\n')}\nResolve them, git add, then git commit --no-edit; or call again with abort true.`;
      },
    },
  ];
}
