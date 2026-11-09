// Reaching the program that holds a session's CLI process.
//
// Only the program that started a CLI can write to its stdin. The plugin's Node backend records,
// in its CLI registry (<home>/.claude-code-gui/cli-registry/<pid>.json), the port and token of its
// own /internal/* routes next to each CLI it starts. This reads that record and calls the route.
// A session held by any other program (a terminal, another desktop app) has no such record, and
// the tools then say so instead of pretending.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultRegistryDirs() {
  const dirs = [path.join(os.homedir(), '.claude-code-gui', 'cli-registry')];
  if (process.env.CCG_HOME) dirs.unshift(path.join(process.env.CCG_HOME, 'cli-registry'));
  return dirs;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function createOwnerClient({ registryDirs = defaultRegistryDirs() } = {}) {
  async function find(sessionId) {
    for (const dir of registryDirs) {
      let names;
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { continue; }
      for (const name of names) {
        let entry;
        try { entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
        if (entry?.sessionId !== sessionId || !entry.control?.port || !entry.control?.token) continue;
        if (!Number.isInteger(entry.pid) || !alive(entry.pid)) continue;
        return { pid: entry.pid, control: entry.control };
      }
    }
    return null;
  }

  async function control(owner, body) {
    const response = await fetch(`http://127.0.0.1:${owner.control.port}/internal/session-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ccg-token': owner.control.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    let answer = {};
    try { answer = await response.json(); } catch { /* an empty body is fine */ }
    if (!response.ok) throw new Error(answer.error ?? `The holding program answered ${response.status}.`);
    return answer;
  }

  return { find, control };
}
