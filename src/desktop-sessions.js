// What the Claude desktop app records about its sessions: who started whom, which are archived,
// the titles it shows, and which have a turn running.
//
// The desktop app keeps one JSON file per session under its own data folder
// (`claude-code-sessions/<account>/<workspace>/local_<id>.json`). A session that another session
// started names that session in `spawnedFrom.sessionId`, in the desktop app's own id (`local_...`).
// The same file holds `cliSessionId`, the id the CLI gave the session, which is the id every list
// here is keyed by.
//
// `spawnedFrom` is only who created the session. A session taken to the top level in the desktop app
// stays marked as spawned and carries `lineageDetached: true` besides, and the desktop app draws it
// as a top-level session.
//
// Whether a turn is running is not a field of its own. The file records when the last user message
// arrived (`latestUserFrameAt`) and when the last turn ended (`lastTurnEdgeAt`): a user message newer
// than the last end is a turn still going. A turn that was cut off without ever ending would look
// running for good, so a session that has written nothing for RUNNING_FRESH_MS is not counted.
//
// The folder belongs to the desktop app and is only read, never written. Its shape is not a
// contract: a file that cannot be read, or one without the fields, is skipped, and a machine without
// the app has no such folder and an empty answer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultDataDir } from './store/jsonl-table.js';
import { readRunning } from './running-sessions.js';

/** The desktop app's session folder on this machine. */
export function desktopSessionsRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Claude', 'claude-code-sessions');
}

/** A turn that opened and has been quiet for this long is taken as no longer running. */
export const RUNNING_FRESH_MS = 30 * 60 * 1000;

const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** The summary categories under which the desktop app files a session under "Needs input". */
const NEEDS_INPUT_CATEGORIES = new Set(['blocked', 'need_input']);

/**
 * Whether the desktop app shows the session as waiting for a person: the turn's wrap-up names something
 * the user must do, the turn summary's `status_category` is `blocked` or `need_input` with an action
 * named and the person has not opened the session since the turn ended, or a permission request is pending. `undefined` when the file says nothing about it.
 */
export function readAwaitingPerson(parsed, now = Date.now()) {
  // The desktop app counts pending permission requests (a number); the shape in the file is not known, so a list or object counts too.
  const pending = parsed.pendingPermissions;
  const hasPending = typeof pending === 'number' ? pending > 0 : Array.isArray(pending) ? pending.length > 0 : pending !== null && typeof pending === 'object' && Object.keys(pending).length > 0;
  // A session cut off by quitting the app while it waited for a person is waiting still (the app honours this for a day).
  const quitWhileWaiting = parsed.interruptedAwaitingPerson === true && typeof parsed.interruptedByQuitAt === 'number' && now - parsed.interruptedByQuitAt <= 24 * 60 * 60 * 1000;
  if (hasPending || quitWhileWaiting) return true;
  // The summary's "blocked" label goes away once the person has opened the session: the app records that
  // as `lastFocusedAt`, so the label stands only while that is missing or older than the end of the turn.
  const summary = parsed.postTurnSummary;
  const unseen = typeof parsed.lastFocusedAt !== 'number' || typeof parsed.lastTurnEdgeAt !== 'number' || parsed.lastFocusedAt < parsed.lastTurnEdgeAt;
  const turnRunning = typeof parsed.latestUserFrameAt === 'number' && (typeof parsed.lastTurnEdgeAt !== 'number' || parsed.latestUserFrameAt > parsed.lastTurnEdgeAt);
  if (NEEDS_INPUT_CATEGORIES.has(summary?.status_category) && text(summary.needs_action) !== null && unseen && !turnRunning) return true;
  if (parsed.turnWrapUp) return text(parsed.turnWrapUp.needsUser) !== null;
  return parsed.postTurnSummary ? false : undefined;
}

/** The session files under `root`: `<account>/<workspace>/local_*.json`, looked for down to a few levels. */
function sessionFilesUnder(root, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3) files.push(...sessionFilesUnder(full, depth + 1));
    } else if (/^local_.+\.json$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Files already read, by path, so that a refresh reads only the files that changed. */
const readFiles = new Map();

/** Forget the files read (a test). */
export function resetDesktopSessionsCache() {
  readFiles.clear();
}

function readSessionFile(file) {
  try {
    const { mtimeMs } = fs.statSync(file);
    const cached = readFiles.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const read = {
      mtimeMs,
      localId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      cliSessionId: text(parsed.cliSessionId),
      spawnedFromId: typeof parsed.spawnedFrom?.sessionId === 'string' ? parsed.spawnedFrom.sessionId : null,
      lineageDetached: parsed.lineageDetached === true,
      isArchived: parsed.isArchived === true,
      lastFocusedAt: typeof parsed.lastFocusedAt === 'number' ? parsed.lastFocusedAt : null,
      title: text(parsed.title),
      cwd: text(parsed.cwd),
      awaitingPerson: readAwaitingPerson(parsed, Date.now()),
      turnOpen: typeof parsed.latestUserFrameAt === 'number' && (typeof parsed.lastTurnEdgeAt !== 'number' || parsed.latestUserFrameAt > parsed.lastTurnEdgeAt),
      lastActivityAt: typeof parsed.lastActivityAt === 'number' ? parsed.lastActivityAt : 0,
    };
    readFiles.set(file, read);
    return read;
  } catch {
    // Written while being read, or not a session file: the next read sees it whole.
    return null;
  }
}

function readAll(root) {
  return sessionFilesUnder(root).map(readSessionFile).filter((f) => f !== null);
}

/**
 * What the desktop app records about its sessions, by the CLI id of each:
 * `starters` (the session to the one it is drawn under), `archived`, `titles`, `running` and `awaiting`
 * (waiting for a person, as `awaitingPerson` of `desktop-session` says).
 * Plain data, so that it can be printed as JSON.
 */
export function readDesktopState(root = desktopSessionsRoot(), now = Date.now(), dataDir = defaultDataDir()) {
  const files = readAll(root);
  const cliByLocal = new Map();
  for (const file of files) if (file.localId && file.cliSessionId) cliByLocal.set(file.localId, file.cliSessionId);
  const starters = {};
  const archived = [];
  const titles = {};
  const running = [];
  const awaiting = [];
  for (const file of files) {
    if (!file.cliSessionId) continue;
    if (file.spawnedFromId && !file.lineageDetached) {
      const starter = cliByLocal.get(file.spawnedFromId);
      if (starter && starter !== file.cliSessionId) starters[file.cliSessionId] = starter;
    }
    if (file.isArchived) archived.push(file.cliSessionId);
    else if (file.awaitingPerson === true) awaiting.push(file.cliSessionId);
    if (file.title) titles[file.cliSessionId] = file.title;
    if (file.turnOpen && now - file.lastActivityAt < RUNNING_FRESH_MS) running.push(file.cliSessionId);
  }
  // Sessions this package started itself are not in the desktop app's files at all.
  for (const id of readRunning({ dataDir, now })) if (!running.includes(id)) running.push(id);
  return { starters, archived, titles, running, awaiting };
}

/** What one desktop session's own file says, by its desktop id (`local_...`); null when there is no such file. */
export function findDesktopSession(desktopSessionId, root = desktopSessionsRoot()) {
  // The id names a file, so it must be nothing but a name.
  if (typeof desktopSessionId !== 'string' || path.basename(desktopSessionId) !== desktopSessionId || !desktopSessionId.startsWith('local_')) return null;
  const file = readAll(root).find((f) => f.localId === desktopSessionId);
  if (!file) return null;
  return {
    ...(file.title && { title: file.title }),
    ...(file.cliSessionId && { cliSessionId: file.cliSessionId }),
    ...(file.cwd && { cwd: file.cwd }),
    isArchived: file.isArchived,
    lastActivityAt: file.lastActivityAt,
    ...(file.awaitingPerson !== undefined && { awaitingPerson: file.awaitingPerson }),
  };
}

function sameList(a, b) {
  const same = (x, y) => Object.keys(x).length === Object.keys(y).length && Object.entries(x).every(([k, v]) => y[k] === v);
  return same(a.starters, b.starters) && same(a.titles, b.titles) && a.archived.length === b.archived.length && a.archived.every((id) => b.archived.includes(id));
}

function sameRunning(a, b) {
  return a.running.length === b.running.length && a.running.every((id) => b.running.includes(id));
}

function sameAwaiting(a, b) {
  return a.awaiting.length === b.awaiting.length && a.awaiting.every((id) => b.awaiting.includes(id));
}

/**
 * Call `onChange(state, change)` when who is under whom, an archive, a title, or which sessions
 * are running changes. `change` is `{ list, running, awaiting }`. The first call comes at once when a turn is
 * already running (news to every screen); otherwise the first read only becomes the baseline.
 * The desktop app sends nothing, so the folder is watched and read again after a quiet moment; a
 * write that reads to the same answer is not announced. Returns the function that stops watching.
 */
export function watchDesktopState(onChange, root = desktopSessionsRoot(), debounceMs = 400, dataDir = defaultDataDir(), pollMs = 2000) {
  let watcher = null;
  let timer = null;
  let known = null;
  let stopped = false;

  const check = () => {
    const now = readDesktopState(root, Date.now(), dataDir);
    const before = known;
    known = now;
    if (stopped) return;
    const change = {
      list: before !== null && !sameList(before, now),
      running: before === null ? now.running.length > 0 : !sameRunning(before, now),
      awaiting: before !== null && !sameAwaiting(before, now),
    };
    if (change.list || change.running || change.awaiting) onChange(now, change);
  };
  check();

  try {
    watcher = fs.watch(root, { recursive: true, persistent: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, debounceMs);
    });
    watcher.on('error', () => watcher?.close());
  } catch {
    // No such folder (the desktop app is not installed), or this platform cannot watch a tree.
  }

  // A started session's program ends without touching any file the watch can see, so what is recorded
  // for the started sessions is looked at on a short interval.
  let ownKnown = readRunning({ dataDir }).sort().join('\n');
  const poll = setInterval(() => {
    const own = readRunning({ dataDir }).sort().join('\n');
    if (own === ownKnown) return;
    ownKnown = own;
    check();
  }, pollMs);
  poll.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}
