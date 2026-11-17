import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { findDesktopSession, readAwaitingPerson, readDesktopState, resetDesktopSessionsCache, watchDesktopState } from '../src/desktop-sessions.js';
import { MAX_AGE_MS, clearRunning, readRunning, recordRunning, runningDir } from '../src/running-sessions.js';
import { createSessionTools } from '../src/tools/session.js';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cli = path.resolve(import.meta.dirname, '../src/cli.js');

// --- "Needs input": the desktop app also files a session there by its turn summary category.

test('a session whose turn summary is blocked or need_input is waiting for a person, with no wrap-up at all', () => {
  // The shape of real session files: turnWrapUp null, postTurnSummary.status_category blocked, never opened since.
  assert.equal(readAwaitingPerson({ turnWrapUp: null, postTurnSummary: { status_category: 'blocked', needs_action: 'pick one' } }), true);
  assert.equal(readAwaitingPerson({ postTurnSummary: { status_category: 'need_input', needs_action: 'answer' } }), true);
});

test('opening the session after its turn ended clears the label; a summary with no action named never had one', () => {
  const base = { postTurnSummary: { status_category: 'blocked', needs_action: 'pick one' }, lastTurnEdgeAt: 1000 };
  assert.equal(readAwaitingPerson({ ...base, lastFocusedAt: 999 }), true);
  assert.equal(readAwaitingPerson({ ...base, lastFocusedAt: 1001 }), false);
  assert.equal(readAwaitingPerson({ ...base }), true, 'never opened: no lastFocusedAt at all');
  assert.equal(readAwaitingPerson({ ...base, postTurnSummary: { status_category: 'blocked', needs_action: '' } }), false);
  assert.equal(readAwaitingPerson({ ...base, latestUserFrameAt: 2000 }), false, 'a turn is running now');
});

test('desktop-watch-style change: opening a session moves it out of awaiting, and the watch says so', async () => {
  resetDesktopSessionsCache();
  const root = tmp('swttch-desk-');
  const dir = path.join(root, 'account', 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'local_a.json');
  const write = (extra) => fs.writeFileSync(file, JSON.stringify({ sessionId: 'local_a', cliSessionId: 'cli-a', lastTurnEdgeAt: 1000, postTurnSummary: { status_category: 'blocked', needs_action: 'x' }, ...extra }));
  write({});
  assert.deepEqual(readDesktopState(root, Date.now(), tmp('swttch-data-')).awaiting, ['cli-a']);
  const seen = [];
  const dataDir = tmp('swttch-data-');
  const stop = watchDesktopState((state, change) => seen.push({ state, change }), root, 20, dataDir, 1000);
  try {
    await new Promise((r) => setTimeout(r, 400));
    write({ lastFocusedAt: 5000 });
    await waitFor(() => seen.length > 0);
    assert.equal(seen.at(-1).change.awaiting, true);
    assert.deepEqual(seen.at(-1).state.awaiting, []);
  } finally {
    stop();
  }
});

test('a finished or working summary is not waiting; no wrap-up and no summary says nothing', () => {
  assert.equal(readAwaitingPerson({ turnWrapUp: null, postTurnSummary: { status_category: 'completed' } }), false);
  assert.equal(readAwaitingPerson({ postTurnSummary: { status_category: 'working' } }), false);
  assert.equal(readAwaitingPerson({ turnWrapUp: null }), undefined);
  assert.equal(readAwaitingPerson({}), undefined);
});

test('the wrap-up still decides when the summary is silent, and a pending permission request waits too', () => {
  assert.equal(readAwaitingPerson({ turnWrapUp: { needsUser: 'Choose A or B' } }), true);
  assert.equal(readAwaitingPerson({ turnWrapUp: { needsUser: '  ' } }), false);
  assert.equal(readAwaitingPerson({ postTurnSummary: { status_category: 'completed' }, pendingPermissions: [{ tool: 'Bash' }] }), true);
  assert.equal(readAwaitingPerson({ postTurnSummary: { status_category: 'completed' }, pendingPermissions: [] }), false);
  assert.equal(readAwaitingPerson({ postTurnSummary: { status_category: 'completed' }, pendingPermissions: 2 }), true);
  assert.equal(readAwaitingPerson({ postTurnSummary: { status_category: 'completed' }, pendingPermissions: 0 }), false);
});

test('a session cut off by quitting while it waited is waiting for a day, not longer', () => {
  const quit = 1_000_000;
  const file = { postTurnSummary: { status_category: 'completed' }, interruptedAwaitingPerson: true, interruptedByQuitAt: quit };
  assert.equal(readAwaitingPerson(file, quit + 1000), true);
  assert.equal(readAwaitingPerson(file, quit + 25 * 60 * 60 * 1000), false);
  assert.equal(readAwaitingPerson({ ...file, interruptedAwaitingPerson: false }, quit + 1000), false);
});

test('desktop-session reports awaitingPerson for a blocked summary read from a file', () => {
  resetDesktopSessionsCache();
  const root = tmp('swttch-desk-');
  const dir = path.join(root, 'account', 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_blocked.json'), JSON.stringify({ sessionId: 'local_blocked', cliSessionId: 'cli-b', turnWrapUp: null, postTurnSummary: { status_category: 'blocked', needs_action: 'pick one' } }));
  assert.equal(findDesktopSession('local_blocked', root).awaitingPerson, true);
});

// --- Sessions this package started appear in `running` while their program lives.

test('a recorded started session is listed while its process lives and dropped once it is gone', () => {
  const dataDir = tmp('swttch-data-');
  recordRunning('sess-1', 111, { dataDir });
  recordRunning('sess-2', 222, { dataDir });
  assert.deepEqual(readRunning({ dataDir, alive: (pid) => pid === 111 }), ['sess-1']);
  assert.equal(fs.existsSync(path.join(runningDir(dataDir), 'sess-2.json')), false, 'the record of a dead process is removed');
  clearRunning('sess-1', { dataDir });
  assert.deepEqual(readRunning({ dataDir, alive: () => true }), []);
});

test('a record older than a day is not trusted, because its process id may belong to another program now', () => {
  const dataDir = tmp('swttch-data-');
  recordRunning('old', process.pid, { dataDir, now: 1000 });
  assert.deepEqual(readRunning({ dataDir, now: 1000 + MAX_AGE_MS + 1 }), []);
});

test('readDesktopState lists a started session in running even though the desktop app has no file for it', () => {
  resetDesktopSessionsCache();
  const root = tmp('swttch-desk-');
  const dataDir = tmp('swttch-data-');
  recordRunning('started-cli-id', process.pid, { dataDir });
  assert.deepEqual(readDesktopState(root, Date.now(), dataDir).running, ['started-cli-id']);
});

test('start_session records the program, and its exit removes the record', async () => {
  const configDir = tmp('swttch-cfg-');
  const dataDir = tmp('swttch-data-');
  let options;
  const runtime = { listLive: async () => [], spawnDetached: async (args, cwd, o) => { options = o; return { pid: process.pid }; } };
  const ctx = { configDir, dataDir, selfSessionId: null, runtime, owners: { find: async () => null, control: async () => ({}) } };
  const tools = Object.fromEntries(createSessionTools(ctx).map((t) => [t.name, t.handler]));
  const out = await tools.start_session({ initiation: 'user_asked', title: 'Sum', prompt: 'Add 1 to 5', background: 'x'.repeat(90), cwd: os.tmpdir(), name: 'sum' });
  assert.deepEqual(readRunning({ dataDir }), [out.session_id]);
  await options.onExit(0);
  assert.deepEqual(readRunning({ dataDir }), []);
});

test('the watch announces a started session when it begins and again when its process ends', async () => {
  resetDesktopSessionsCache();
  const root = tmp('swttch-desk-');
  const dataDir = tmp('swttch-data-');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const seen = [];
  const stop = watchDesktopState((state, change) => seen.push({ running: [...state.running], change }), root, 20, dataDir, 30);
  try {
    recordRunning('started-cli-id', child.pid, { dataDir });
    await waitFor(() => seen.some((s) => s.running.includes('started-cli-id')));
    assert.equal(seen.at(-1).change.running, true);
    child.kill();
    await waitFor(() => seen.some((s) => s.running.length === 0 && seen.indexOf(s) > 0));
    assert.deepEqual(seen.at(-1).running, []);
    assert.equal(seen.at(-1).change.running, true);
  } finally {
    stop();
    child.kill();
  }
});

test('desktop-state, run as a command, lists a started session in running', () => {
  const home = tmp('swttch-home-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, '.config'), CCG_HOME: path.join(home, 'ccg') };
  recordRunning('started-cli-id', process.pid, { dataDir: env.CCG_HOME });
  const out = spawnSync(process.execPath, [cli, 'desktop-state'], { env, encoding: 'utf8' }).stdout;
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()).running, ['started-cli-id']);
});

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('waited for a change that never came');
}

// --- A session woken headlessly by send_message is on the record while its program runs.

function wakeSetup({ live = [], holder = false } = {}) {
  const configDir = tmp('swttch-cfg-');
  const dataDir = tmp('swttch-data-');
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const id of ['aaaa', 'cccc']) {
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: `p ${id}` } }) + '\n');
  }
  const spawned = [];
  let nextPid = process.pid; // a process that surely lives
  const runtime = {
    listLive: async () => live,
    spawnDetached: async (args, cwd, options) => { spawned.push({ args, cwd, options }); return { pid: nextPid }; },
  };
  const owners = { find: async () => (holder ? { pid: 4242, control: { port: 1, token: 't' } } : null), control: async () => ({}) };
  const ctx = { configDir, dataDir, selfSessionId: 'cccc', runtime, owners };
  const mgmt = Object.fromEntries(createSessionMgmtTools(ctx).map((t) => [t.name, t.handler]));
  return { mgmt, dataDir, spawned, setPid: (pid) => { nextPid = pid; } };
}

test('send_message that wakes a resting session records its program, and the program ending removes the record', async () => {
  const { mgmt, dataDir, spawned } = wakeSetup();
  const answer = await mgmt.send_message({ session_id: 'aaaa', message: 'work' });
  assert.match(answer, /resumed session aaaa headlessly/);
  assert.deepEqual(readRunning({ dataDir }), ['aaaa']);
  await spawned[0].options.onExit(0);
  assert.deepEqual(readRunning({ dataDir }), []);
});

test('send_message that hands the message to the program already running the session records nothing', async () => {
  const { mgmt, dataDir, spawned } = wakeSetup({ live: [{ pid: 9, cwd: '/tmp/demo', kind: 'interactive', sessionId: 'aaaa', name: 'aaaa', status: 'idle' }], holder: true });
  await mgmt.send_message({ session_id: 'aaaa', message: 'work' });
  assert.equal(spawned.length, 0);
  assert.deepEqual(readRunning({ dataDir }), []);
});

test('a session woken again while its first program still runs stays running until the last program ends', async () => {
  const { mgmt, dataDir, spawned, setPid } = wakeSetup();
  const second = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await mgmt.send_message({ session_id: 'aaaa', message: 'one' }); // pid of this test process
    setPid(second.pid);
    await mgmt.send_message({ session_id: 'aaaa', message: 'two' });
    await spawned[1].options.onExit(0); // the later one ends: the first still runs
    assert.deepEqual(readRunning({ dataDir }), ['aaaa']);
    await spawned[0].options.onExit(0);
    assert.deepEqual(readRunning({ dataDir }), []);
  } finally {
    second.kill();
  }
});

test('a woken session whose program lives past a day, or whose process is gone, is not listed', () => {
  const dataDir = tmp('swttch-data-');
  recordRunning('aaaa', process.pid, { dataDir, now: 1000 });
  recordRunning('bbbb', 99999999, { dataDir, now: Date.now() });
  assert.deepEqual(readRunning({ dataDir, now: 1000 + MAX_AGE_MS + 1 }), []);
  assert.deepEqual(fs.readdirSync(runningDir(dataDir)), [], 'both records were removed');
});

test('the record keeps the latest run\'s pid and startedAt at the top, where the first version of this package reads them', () => {
  const dataDir = tmp('swttch-data-');
  recordRunning('aaaa', process.pid, { dataDir, now: Date.now() - 1000 });
  recordRunning('aaaa', process.pid + 0, { dataDir, now: Date.now() });
  const record = JSON.parse(fs.readFileSync(path.join(runningDir(dataDir), 'aaaa.json'), 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(typeof record.startedAt, 'number');
  assert.equal(record.runs.at(-1).startedAt, record.startedAt);
});
