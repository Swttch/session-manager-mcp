// Sessions this package started itself and that are still running.
//
// `start_session` runs `claude -p --session-id <uuid> ...` as a detached program. The Claude desktop app
// knows nothing about it, so its session files never say a turn is running. This package is the one that
// started the program, so it keeps one small file per started session while the program lives:
//
//   <data dir>/session-manager/running/<cliSessionId>.json   { pid, startedAt }
//
// The file is removed when this server sees the program end. A server that is gone by then (it was the
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

/** Notes that the program running this session started. A failure to write is not worth failing the start for. */
export function recordRunning(sessionId, pid, { dataDir = defaultDataDir(), now = Date.now() } = {}) {
  if (!safeId(sessionId) || !Number.isInteger(pid)) return false;
  try {
    fs.mkdirSync(runningDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(runningDir(dataDir), `${sessionId}.json`), JSON.stringify({ pid, startedAt: now }));
    return true;
  } catch {
    return false;
  }
}

/** Notes that the program ended. */
export function clearRunning(sessionId, { dataDir = defaultDataDir() } = {}) {
  if (!safeId(sessionId)) return;
  try {
    fs.rmSync(path.join(runningDir(dataDir), `${sessionId}.json`), { force: true });
  } catch {
    // Already gone, or not removable: the next read drops it if its process is gone.
  }
}

/** The CLI ids of the started sessions whose program is still running. Stale records are removed on the way. */
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
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // written while being read: the next read sees it whole
    }
    const fresh = typeof record?.startedAt === 'number' && now - record.startedAt < MAX_AGE_MS;
    if (fresh && alive(record.pid)) ids.push(id);
    else clearRunning(id, { dataDir });
  }
  return ids;
}
