import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { desktopSessionsRoot } from '../src/desktop-sessions.js';

const cli = path.resolve(import.meta.dirname, '../src/cli.js');

// The commands run as a child, with HOME / APPDATA / XDG_CONFIG_HOME pointed at a throwaway folder, so
// they never see the real desktop app.
function fakeMachine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, '.config'), CCG_HOME: path.join(home, 'ccg'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') };
  const root = desktopSessionsRoot({ home, env });
  const write = (name, file) => {
    const dir = path.join(root, 'account', 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(file));
  };
  return { env, write };
}

const lastLine = (out) => JSON.parse(out.trim().split('\n').pop());

test('desktop-state prints what the desktop app records, by CLI id', () => {
  const { env, write } = fakeMachine();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Boss', isArchived: true });
  write('local_b', { sessionId: 'local_b', cliSessionId: 'cli-b', spawnedFrom: { sessionId: 'local_a' } });
  const answer = lastLine(spawnSync(process.execPath, [cli, 'desktop-state'], { env, encoding: 'utf8' }).stdout);
  assert.deepEqual(answer, { ok: true, starters: { 'cli-b': 'cli-a' }, archived: ['cli-a'], titles: { 'cli-a': 'Boss' }, running: [] });
});

test('started-by answers from the desktop app when nothing was chosen here', () => {
  const { env, write } = fakeMachine();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a' });
  write('local_b', { sessionId: 'local_b', cliSessionId: 'cli-b', spawnedFrom: { sessionId: 'local_a' } });
  const answer = lastLine(spawnSync(process.execPath, [cli, 'started-by', 'cli-b'], { env, encoding: 'utf8' }).stdout);
  assert.deepEqual(answer, { ok: true, startedBy: 'cli-a', source: 'desktop', cwd: null });
});

test('desktop-session prints one session by its desktop id, or null', () => {
  const { env, write } = fakeMachine();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Boss' });
  const found = lastLine(spawnSync(process.execPath, [cli, 'desktop-session', 'local_a'], { env, encoding: 'utf8' }).stdout);
  assert.equal(found.session.title, 'Boss');
  const missing = lastLine(spawnSync(process.execPath, [cli, 'desktop-session', 'local_none'], { env, encoding: 'utf8' }).stdout);
  assert.deepEqual(missing, { ok: true, session: null });
});

test('desktop-watch prints a line when a title changes, and ends when its input closes', async () => {
  const { env, write } = fakeMachine();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'One' });
  const child = spawn(process.execPath, [cli, 'desktop-watch'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    await new Promise((r) => setTimeout(r, 700)); // the watcher is up and has its baseline
    write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Two' });
    const deadline = Date.now() + 5000;
    while (!out.includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const line = JSON.parse(out.trim().split('\n')[0]);
    assert.deepEqual(line.change, { list: true, running: false });
    assert.deepEqual(line.titles, { 'cli-a': 'Two' });
  } finally {
    child.stdin.end();
  }
  assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 3000))]), 0);
});

test('desktop-watch prints a line when a session is put under another by the package, with no desktop file moving', async () => {
  const { env, write } = fakeMachine();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a' });
  const child = spawn(process.execPath, [cli, 'desktop-watch'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    await new Promise((r) => setTimeout(r, 900)); // the watchers are up and have their baseline
    const table = path.join(env.CCG_HOME, 'entities', 'sidebar', 'session_marks.entity.jsonl');
    fs.mkdirSync(path.dirname(table), { recursive: true });
    fs.writeFileSync(table, JSON.stringify({ id: 'cli-b', parentSessionUid: 'cli-a' }) + '\n');
    const deadline = Date.now() + 5000;
    while (!out.includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const line = JSON.parse(out.trim().split('\n')[0]);
    assert.deepEqual(line.change, { list: true, running: false });
  } finally {
    child.stdin.end();
  }
  assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 3000))]), 0);
});
