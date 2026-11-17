// Sessions this package started itself and that are still running.
//
// `start_session` runs `claude -p --session-id <uuid> ...` as a detached program. The Claude desktop app
// knows nothing about it, so its session files never say a turn is running. This package is the one that
// started the program, so it keeps one small file per started session while the program lives:
//
//   <data dir>/session-manager/running/<cliSessionId>.json   { pid, startedAt, runs: [{ pid, startedAt }] }
//   (pid and startedAt are the latest run's, kept where older versions of this package read them)
//
// Both start_session (a new session) and send_message (a session that nobody ran, resumed headlessly) start such
// a program. A session can be woken again while an earlier program of it still runs, so the file lists every
// program of the session, and a program that ends removes only its own entry: the session stays running until
// the last one is gone.
//
// The file is removed when this server sees the last program end. A server that is gone by then (it was the
// CLI's child and went away with it) cannot remove it, so every read also checks that the process still
// exists and drops the file of one that does not. A process id can be handed to an unrelated program once
// the first one is gone, so a record older than MAX_AGE_MS is dropped as well.
//
// The folder belongs to this package; the desktop app's files are never written.

import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from './store/jsonl-table.js';

/** A started session that has been recorded for longer than this is taken as ended, whatever its pid says. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function runningDir(dataDir = defaultDataDir()) {
  return path.join(dataDir, 'session-manager', 'running');
}

// The id names a file, so it must be nothing but a name.
const safeId = (id) => typeof id === 'string' && id !== '' && path.basename(id) === id && !id.includes('..');

/** Whether a process with this id exists (it may belong to another user, which still means it lives). */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The programs recorded for one session. Reads the first shape of the file, `{ pid, startedAt }`, too. */
function runsOf(record) {
  if (Array.isArray(record?.runs)) return record.runs.filter((r) => Number.isInteger(r?.pid) && typeof r?.startedAt === 'number');
  if (Number.isInteger(record?.pid) && typeof record?.startedAt === 'number') return [{ pid: record.pid, startedAt: record.startedAt }];
  return [];
}

function readRecord(file) {
  try {
    return runsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    return error.code === 'ENOENT' ? [] : null; // null: written while being read, or not readable now
  }
}

function writeRuns(dataDir, sessionId, runs) {
  const file = path.join(runningDir(dataDir), `${sessionId}.json`);
  if (runs.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(runningDir(dataDir), { recursive: true });
  // pid and startedAt of the latest run stay at the top, where the 0.5.x readers of the first file shape look for them.
  const latest = runs[runs.length - 1];
  fs.writeFileSync(file, JSON.stringify({ pid: latest.pid, startedAt: latest.startedAt, runs }));
}

/**
 * Notes that a program running this session started. A program of the same session that is still alive stays
 * on the record beside it. A failure to write is not worth failing the start for.
 */
export function recordRunning(sessionId, pid, { dataDir = defaultDataDir(), now = Date.now(), alive = processAlive } = {}) {
  if (!safeId(sessionId) || !Number.isInteger(pid)) return false;
  try {
    const earlier = (readRecord(path.join(runningDir(dataDir), `${sessionId}.json`)) ?? []).filter((r) => r.pid !== pid && now - r.startedAt < MAX_AGE_MS && alive(r.pid));
    writeRuns(dataDir, sessionId, [...earlier, { pid, startedAt: now }]);
    return true;
  } catch {
    return false;
  }
}

/** Notes that a program ended: the one with this pid, or every program of the session when no pid is given. */
export function clearRunning(sessionId, { dataDir = defaultDataDir(), pid } = {}) {
  if (!safeId(sessionId)) return;
  try {
    const runs = pid === undefined ? [] : (readRecord(path.join(runningDir(dataDir), `${sessionId}.json`)) ?? []).filter((r) => r.pid !== pid);
    writeRuns(dataDir, sessionId, runs);
  } catch {
    // Already gone, or not removable: the next read drops it if its process is gone.
  }
}

/** The CLI ids of the sessions with a program still running. Records of programs that are gone are removed on the way. */
export function readRunning({ dataDir = defaultDataDir(), now = Date.now(), alive = processAlive } = {}) {
  const dir = runningDir(dataDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const runs = readRecord(path.join(dir, name));
    if (runs === null) continue;
    const live = runs.filter((r) => now - r.startedAt < MAX_AGE_MS && alive(r.pid));
    if (live.length > 0) ids.push(id);
    if (live.length !== runs.length || runs.length === 0) {
      try {
        writeRuns(dataDir, id, live);
      } catch {
        // The next read tries again.
      }
    }
  }
  return ids;
}

/**
 * Starts a detached program for a session and keeps it on the record while it runs. `onExit(code)` is called
 * after the record has been cleared. Every program this package starts for a session goes through here.
 */
export async function spawnTracked(ctx, sessionId, args, cwd, onExit) {
  let pid = null;
  let exited = false;
  const started = await ctx.runtime.spawnDetached(args, cwd, {
    onExit: (code) => {
      exited = true;
      if (pid !== null) clearRunning(sessionId, { dataDir: ctx.dataDir, pid });
      return onExit?.(code);
    },
  });
  // A runtime that cannot say which process it started leaves nothing on the record.
  if (!exited && typeof started?.pid === 'number') {
    pid = started.pid;
    recordRunning(sessionId, pid, { dataDir: ctx.dataDir });
  }
  return started;
}
