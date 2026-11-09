import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A config dir with a few sessions, a data dir, and a fake runtime that records what the tools ask of the system.
export function makeEnv({ self = 'cccc', cwd = '/tmp/demo', exec } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const id of ['aaaa', 'cccc']) {
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd, timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: `p ${id}` } }) + '\n');
  }
  const calls = { exec: [], programs: [] };
  const runtime = {
    claudeBin: 'claude',
    listLive: async () => [],
    spawnDetached: async () => {},
    exec: async (cmd, args, opts) => { calls.exec.push({ cmd, args, cwd: opts?.cwd }); return exec ? exec(cmd, args, opts) : { code: 0, stdout: '', stderr: '' }; },
    spawnProgram: async (cmd, args) => { calls.programs.push({ cmd, args }); },
    which: async (cmd) => ({ code: true, cursor: true }[cmd] ? `/usr/bin/${cmd}` : null),
    platform: 'darwin',
  };
  const owners = { find: async () => null, control: async () => ({}) };
  const ctx = { configDir, dataDir, selfSessionId: self, runtime, owners };
  const tools = (create) => Object.fromEntries(create(ctx).map((t) => [t.name, t.handler]));
  return { ctx, calls, tools, configDir, dataDir };
}
