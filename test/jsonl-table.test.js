import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTable } from '../src/store/jsonl-table.js';

function table() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-table-'));
  return { root, t: new JsonlTable({ root, domain: 'sidebar', table: 'things' }) };
}

test('the file lives at <root>/entities/<domain>/<table>.entity.jsonl', () => {
  const { root, t } = table();
  t.upsert('a', { n: 1 });
  assert.ok(fs.existsSync(path.join(root, 'entities', 'sidebar', 'things.entity.jsonl')));
});

test('a missing file reads as no rows', () => {
  assert.deepEqual(table().t.readAll(), []);
});

test('upsert merges into the existing row and appends one line per write', () => {
  const { root, t } = table();
  t.upsert('a', { n: 1, tag: 'x' });
  t.upsert('a', { n: 2 });
  assert.deepEqual(t.get('a'), { id: 'a', n: 2, tag: 'x' });
  const lines = fs.readFileSync(path.join(root, 'entities', 'sidebar', 'things.entity.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});

test('rows come back in the order their id first appeared, later lines win', () => {
  const { t } = table();
  t.upsert('a', { n: 1 });
  t.upsert('b', { n: 1 });
  t.upsert('a', { n: 9 });
  assert.deepEqual(t.readAll().map((r) => [r.id, r.n]), [['a', 9], ['b', 1]]);
});

test('remove writes a deleted line and the row disappears', () => {
  const { t } = table();
  t.upsert('a', { n: 1 });
  t.remove('a');
  assert.equal(t.get('a'), undefined);
  assert.deepEqual(t.readAll(), []);
});

test('a line that is not JSON is skipped and survives the next append', () => {
  const { root, t } = table();
  t.upsert('a', { n: 1 });
  const file = path.join(root, 'entities', 'sidebar', 'things.entity.jsonl');
  fs.appendFileSync(file, '{"id":"half","n":'); // a writer died mid-line
  assert.deepEqual(t.readAll().map((r) => r.id), ['a']);
  t.upsert('b', { n: 2 });
  assert.deepEqual(t.readAll().map((r) => r.id), ['a', 'b']);
  assert.match(fs.readFileSync(file, 'utf8'), /"half"/);
});

test('a path that cannot be read as a file throws instead of reading as empty', () => {
  const { root, t } = table();
  fs.mkdirSync(path.join(root, 'entities', 'sidebar', 'things.entity.jsonl'), { recursive: true });
  assert.throws(() => t.readAll(), /unreadable|EISDIR/i);
});
