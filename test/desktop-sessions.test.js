import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUNNING_FRESH_MS,
  desktopSessionsRoot,
  findDesktopSession,
  readDesktopState,
  resetDesktopSessionsCache,
  watchDesktopState,
} from '../src/desktop-sessions.js';

// The desktop app keeps a JSON file per session. A session another one started names it in
// `spawnedFrom.sessionId` (the desktop app's own id); `cliSessionId` is the id the lists are keyed by.

function setup() {
  resetDesktopSessionsCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-sessions-'));
  const write = (name, file, mtimeSec) => {
    const dir = path.join(root, 'account', 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, `${name}.json`);
    fs.writeFileSync(full, JSON.stringify(file));
    if (mtimeSec !== undefined) fs.utimesSync(full, mtimeSec, mtimeSec);
  };
  return { root, write };
}

test('answers nothing on a machine without the desktop app', () => {
  const state = readDesktopState(path.join(os.tmpdir(), 'no-such-desktop-folder'));
  assert.deepEqual(state, { starters: {}, archived: [], titles: {}, running: [] });
});

test('maps a started session to the CLI id of the session that started it', () => {
  const { root, write } = setup();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a' });
  write('local_b', { sessionId: 'local_b', cliSessionId: 'cli-b', spawnedFrom: { sessionId: 'local_a' } });
  assert.deepEqual(readDesktopState(root).starters, { 'cli-b': 'cli-a' });
});

test('leaves out a session taken to the top level, and a pair with a side that never ran', () => {
  const { root, write } = setup();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a' });
  write('local_b', { sessionId: 'local_b', cliSessionId: 'cli-b', spawnedFrom: { sessionId: 'local_a' }, lineageDetached: true });
  write('local_c', { sessionId: 'local_c', cliSessionId: 'cli-c', spawnedFrom: { sessionId: 'local_never' } });
  write('local_d', { sessionId: 'local_d', spawnedFrom: { sessionId: 'local_a' } });
  assert.deepEqual(readDesktopState(root).starters, {});
});

test('reports archived sessions and titles by CLI id', () => {
  const { root, write } = setup();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', isArchived: true, title: 'Release manager' });
  write('local_b', { sessionId: 'local_b', cliSessionId: 'cli-b', title: '' });
  const state = readDesktopState(root);
  assert.deepEqual(state.archived, ['cli-a']);
  assert.deepEqual(state.titles, { 'cli-a': 'Release manager' });
});

test('a turn is running when the last user message is newer than the last turn end and the session is fresh', () => {
  const { root, write } = setup();
  const now = 1_000_000_000_000;
  write('local_run', { sessionId: 'local_run', cliSessionId: 'cli-run', latestUserFrameAt: now - 2000, lastTurnEdgeAt: now - 9000, lastActivityAt: now - 1000 });
  write('local_done', { sessionId: 'local_done', cliSessionId: 'cli-done', latestUserFrameAt: now - 9000, lastTurnEdgeAt: now - 2000, lastActivityAt: now - 1000 });
  write('local_cut', { sessionId: 'local_cut', cliSessionId: 'cli-cut', latestUserFrameAt: 5, lastTurnEdgeAt: 1, lastActivityAt: now - RUNNING_FRESH_MS - 1 });
  assert.deepEqual(readDesktopState(root, now).running, ['cli-run']);
});

test('reads a file again after it changed, and skips a file that is not JSON', () => {
  const { root, write } = setup();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'One' }, 1000);
  fs.writeFileSync(path.join(root, 'account', 'workspace', 'local_broken.json'), '{ not json');
  assert.deepEqual(readDesktopState(root).titles, { 'cli-a': 'One' });
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Two' }, 2000);
  assert.deepEqual(readDesktopState(root).titles, { 'cli-a': 'Two' });
});

test('finds one desktop session by its own id, and refuses an id that is not just a name', () => {
  const { root, write } = setup();
  write('local_abc', { sessionId: 'local_abc', cliSessionId: 'cli-abc', title: 'Release manager', cwd: '/work/app', isArchived: true, lastActivityAt: 42, turnWrapUp: { needsUser: 'Which branch?' } });
  write('local_bare', { sessionId: 'local_bare' });
  assert.deepEqual(findDesktopSession('local_abc', root), {
    title: 'Release manager',
    cliSessionId: 'cli-abc',
    cwd: '/work/app',
    isArchived: true,
    lastActivityAt: 42,
    awaitingPerson: true,
  });
  assert.deepEqual(findDesktopSession('local_bare', root), { isArchived: false, lastActivityAt: 0 });
  assert.equal(findDesktopSession('local_missing', root), null);
  assert.equal(findDesktopSession('../local_abc', root), null);
  assert.equal(findDesktopSession('other', root), null);
});

test('the desktop folder is where the desktop app keeps it on each system', () => {
  const home = path.join(path.sep, 'home', 'me');
  assert.equal(desktopSessionsRoot({ platform: 'darwin', home }), path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'));
  assert.equal(desktopSessionsRoot({ platform: 'win32', env: { APPDATA: path.join('C:', 'Roaming') }, home }), path.join('C:', 'Roaming', 'Claude', 'claude-code-sessions'));
  assert.equal(desktopSessionsRoot({ platform: 'linux', env: {}, home }), path.join(home, '.config', 'Claude', 'claude-code-sessions'));
});

test('watching announces a changed title and a turn starting, and nothing for a write that changes nothing', async () => {
  const { root, write } = setup();
  write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'One', latestUserFrameAt: 1, lastTurnEdgeAt: 2, lastActivityAt: Date.now() });
  const seen = [];
  const stop = watchDesktopState((state, change) => seen.push({ state, change }), root, 30);
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 0, 'the first read is only the baseline');

    write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Two', latestUserFrameAt: 1, lastTurnEdgeAt: 2, lastActivityAt: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].change, { list: true, running: false });
    assert.deepEqual(seen[0].state.titles, { 'cli-a': 'Two' });

    write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Two', latestUserFrameAt: 1, lastTurnEdgeAt: 2, lastActivityAt: Date.now() + 5 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(seen.length, 1, 'a rewrite that reads to the same answer is not announced');

    write('local_a', { sessionId: 'local_a', cliSessionId: 'cli-a', title: 'Two', latestUserFrameAt: 9, lastTurnEdgeAt: 2, lastActivityAt: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1].change, { list: false, running: true });
    assert.deepEqual(seen[1].state.running, ['cli-a']);
  } finally {
    stop();
  }
});
