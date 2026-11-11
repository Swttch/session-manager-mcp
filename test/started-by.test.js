import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startedBy } from '../src/started-by.js';
import { resolveContext } from '../src/tools/context.js';
import { SessionMark } from '../src/store/entities.js';
import { resetDesktopSessionsCache } from '../src/desktop-sessions.js';

function setup() {
  resetDesktopSessionsCache();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-desktop-'));
  const dir = path.join(desktopRoot, 'account', 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cliSessionId: 'cli-a' }));
  fs.writeFileSync(path.join(dir, 'local_b.json'), JSON.stringify({ sessionId: 'local_b', cliSessionId: 'cli-b', spawnedFrom: { sessionId: 'local_a' } }));
  const ctx = resolveContext({ configDir, dataDir, runtime: {}, owners: {} });
  const mark = (sessionUid, parentSessionUid) => ctx.store.marks.save(new SessionMark({ sessionUid, parentSessionUid }));
  return { ctx, desktopRoot, mark };
}

test('answers with the session that started it, from the record kept here', () => {
  const { ctx, desktopRoot, mark } = setup();
  mark('cli-x', 'cli-boss');
  assert.deepEqual(startedBy(ctx, 'cli-x', { desktopRoot }), { startedBy: 'cli-boss', source: 'marks', cwd: null });
});

test('answers from the desktop app only when nothing was chosen here', () => {
  const { ctx, desktopRoot } = setup();
  assert.deepEqual(startedBy(ctx, 'cli-b', { desktopRoot }), { startedBy: 'cli-a', source: 'desktop', cwd: null });
  assert.deepEqual(startedBy(ctx, 'cli-a', { desktopRoot }), { startedBy: null, source: null, cwd: null });
});

test('what was chosen here beats the desktop app, including the top level on purpose', () => {
  const { ctx, desktopRoot, mark } = setup();
  mark('cli-b', '');
  assert.deepEqual(startedBy(ctx, 'cli-b', { desktopRoot }), { startedBy: null, source: 'marks', cwd: null });
  mark('cli-b', 'cli-other');
  assert.deepEqual(startedBy(ctx, 'cli-b', { desktopRoot }), { startedBy: 'cli-other', source: 'marks', cwd: null });
});

test('names the folder the starting session works in when its transcript is found', () => {
  const { ctx, desktopRoot, mark } = setup();
  const proj = path.join(ctx.configDir, 'projects', '-work-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'cli-boss.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'cli-boss', cwd: '/work/app', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'hi' } }) + '\n');
  mark('cli-x', 'cli-boss');
  assert.deepEqual(startedBy(ctx, 'cli-x', { desktopRoot }), { startedBy: 'cli-boss', source: 'marks', cwd: '/work/app' });
});
