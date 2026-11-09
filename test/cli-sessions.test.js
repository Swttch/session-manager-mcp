import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCliSessions, readCliSessionEvents, searchCliSessions } from '../src/cli-sessions.js';

function makeConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-mcp-'));
  const proj = path.join(dir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  const write = (id, lines, mtime) => {
    const f = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (mtime) fs.utimesSync(f, mtime, mtime);
  };
  return { dir, write };
}

const user = (id, text, ts, extra = {}) => ({ type: 'user', uuid: `u-${text}`, sessionId: id, cwd: '/tmp/demo', timestamp: ts, message: { role: 'user', content: text }, ...extra });
const asst = (id, text, ts) => ({ type: 'assistant', uuid: `a-${text}`, sessionId: id, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('lists sessions newest first with the custom title winning over the ai title and the first prompt', () => {
  const { dir, write } = makeConfigDir();
  write('aaaa', [user('aaaa', 'first prompt of a', '2026-11-01T00:00:00Z'), { type: 'ai-title', aiTitle: 'AI title A', sessionId: 'aaaa' }, { type: 'custom-title', customTitle: 'My title A', sessionId: 'aaaa' }], new Date('2026-11-01T01:00:00Z'));
  write('bbbb', [user('bbbb', 'only a prompt here', '2026-11-02T00:00:00Z')], new Date('2026-11-02T01:00:00Z'));
  const list = listCliSessions({ configDir: dir });
  assert.deepEqual(list.map((s) => s.sessionId), ['bbbb', 'aaaa']);
  assert.equal(list[1].title, 'My title A');
  assert.equal(list[0].title, 'only a prompt here');
  assert.equal(list[0].cwd, '/tmp/demo');
  assert.equal(list[0].lastActivityAt, '2026-11-02T01:00:00.000Z');
});

test('the limit keeps only the most recent sessions', () => {
  const { dir, write } = makeConfigDir();
  write('aaaa', [user('aaaa', 'a', '2026-11-01T00:00:00Z')], new Date('2026-11-01T01:00:00Z'));
  write('bbbb', [user('bbbb', 'b', '2026-11-02T00:00:00Z')], new Date('2026-11-02T01:00:00Z'));
  assert.deepEqual(listCliSessions({ configDir: dir, limit: 1 }).map((s) => s.sessionId), ['bbbb']);
});

test('search returns one hit per session with a snippet around the match, case-insensitive', () => {
  const { dir, write } = makeConfigDir();
  write('aaaa', [user('aaaa', 'please fix the Login bug today', '2026-11-01T00:00:00Z'), asst('aaaa', 'login fixed', '2026-11-01T00:01:00Z')]);
  write('bbbb', [user('bbbb', 'unrelated', '2026-11-02T00:00:00Z')]);
  const hits = searchCliSessions({ configDir: dir, query: 'login' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'aaaa');
  assert.match(hits[0].snippet, /Login bug/);
});

test('search refuses a query shorter than two characters', () => {
  const { dir } = makeConfigDir();
  assert.throws(() => searchCliSessions({ configDir: dir, query: 'a' }), /2/);
});

test('events render the recent turns as plain text, oldest first, and page backwards with a cursor', () => {
  const { dir, write } = makeConfigDir();
  write('aaaa', [user('aaaa', 'one', '2026-11-01T00:00:00Z'), asst('aaaa', 'two', '2026-11-01T00:00:01Z'), user('aaaa', 'three', '2026-11-01T00:00:02Z')]);
  const page1 = readCliSessionEvents({ configDir: dir, sessionId: 'aaaa', limit: 2 });
  assert.match(page1.text, /two[\s\S]*three/);
  assert.doesNotMatch(page1.text, /one/);
  assert.ok(page1.cursor);
  const page2 = readCliSessionEvents({ configDir: dir, sessionId: 'aaaa', limit: 2, beforeUuid: page1.cursor });
  assert.match(page2.text, /one/);
  assert.equal(page2.cursor, null);
});

test('events of an unknown session throw a readable error', () => {
  const { dir } = makeConfigDir();
  assert.throws(() => readCliSessionEvents({ configDir: dir, sessionId: 'zzzz' }), /zzzz/);
});
