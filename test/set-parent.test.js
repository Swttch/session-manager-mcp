import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';
import { setSessionParent, INHERIT } from '../src/set-parent.js';
import { resolveContext } from '../src/tools/context.js';

// Who started a session is recorded in the marks. set_session_parent changes that record by hand:
// a session is put under another one, or taken out to the top level. It only edits the record. It
// does not make the new parent hear when the session ends a turn; that is set up when a session is
// started.

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const id of ['aaaa', 'bbbb', 'cccc', 'dddd']) {
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: `p ${id}` } }) + '\n');
  }
  const runtime = { listLive: async () => [] };
  const ctx = resolveContext({ configDir, dataDir, runtime, owners: {} });
  const tools = Object.fromEntries(createSessionMgmtTools({ configDir, dataDir, runtime, owners: {} }).map((t) => [t.name, t.handler]));
  const parentOf = (id) => ctx.store.marks.find(id)?.parentSessionUid ?? null;
  return { ctx, tools, parentOf };
}

test('puts a session under another one', async () => {
  const { ctx, parentOf } = setup();
  const answer = setSessionParent(ctx, 'bbbb', 'aaaa');
  assert.equal(answer.changed, true);
  assert.equal(parentOf('bbbb'), 'aaaa');
});

test('null takes the session out to the top level', async () => {
  const { ctx, parentOf } = setup();
  setSessionParent(ctx, 'bbbb', 'aaaa');
  const answer = setSessionParent(ctx, 'bbbb', null);
  assert.equal(answer.changed, true);
  assert.equal(answer.parent_session_id, null);
  // Kept as '' (top-level on purpose), which is not the null of "nothing chosen".
  assert.equal(parentOf('bbbb'), '');
});

test('taking a session that has no mark to the top level leaves a record of the choice', async () => {
  const { ctx, parentOf } = setup();
  assert.equal(parentOf('cccc'), null);
  assert.equal(setSessionParent(ctx, 'cccc', null).changed, true);
  assert.equal(parentOf('cccc'), '');
  assert.equal(setSessionParent(ctx, 'cccc', null).changed, false);
});

test('INHERIT forgets what was chosen, whether a parent or the top level', async () => {
  const { ctx, parentOf } = setup();
  setSessionParent(ctx, 'bbbb', 'aaaa');
  assert.equal(setSessionParent(ctx, 'bbbb', INHERIT).changed, true);
  assert.equal(parentOf('bbbb'), null);
  setSessionParent(ctx, 'cccc', null);
  assert.equal(setSessionParent(ctx, 'cccc', INHERIT).changed, true);
  assert.equal(parentOf('cccc'), null);
  // Nothing was chosen for a session without a mark: no mark is made for it.
  assert.equal(setSessionParent(ctx, 'dddd', INHERIT).changed, false);
  assert.equal(ctx.store.marks.find('dddd'), undefined);
});

test('moving a session to its current parent changes nothing and says so', async () => {
  const { ctx } = setup();
  setSessionParent(ctx, 'bbbb', 'aaaa');
  assert.equal(setSessionParent(ctx, 'bbbb', 'aaaa').changed, false);
});

test('refuses a session as its own parent', async () => {
  const { ctx } = setup();
  assert.throws(() => setSessionParent(ctx, 'bbbb', 'bbbb'), /its own parent/);
});

test('refuses a parent that is below the session, which would make a loop', async () => {
  const { ctx, parentOf } = setup();
  setSessionParent(ctx, 'bbbb', 'aaaa');
  setSessionParent(ctx, 'cccc', 'bbbb');
  assert.throws(() => setSessionParent(ctx, 'aaaa', 'cccc'), /below it/);
  assert.equal(parentOf('aaaa'), null);
});

test('refuses a session that does not exist, either side', async () => {
  const { ctx } = setup();
  assert.throws(() => setSessionParent(ctx, 'nope', 'aaaa'), /not found/i);
  assert.throws(() => setSessionParent(ctx, 'bbbb', 'nope'), /not found/i);
});

test('keeps every other column of the mark', async () => {
  const { ctx } = setup();
  const mark = ctx.store.marks.find('bbbb') ?? new (await import('../src/store/entities.js')).SessionMark({ sessionUid: 'bbbb' });
  mark.handle = 'second';
  mark.archivedAt = 1794301002844;
  ctx.store.marks.save(mark);
  setSessionParent(ctx, 'bbbb', 'aaaa');
  const after = ctx.store.marks.find('bbbb');
  assert.equal(after.handle, 'second');
  assert.equal(after.archivedAt, 1794301002844);
});

test('is a tool of the session_mgmt area', async () => {
  const { tools, parentOf } = setup();
  const answer = await tools.set_session_parent({ session_id: 'bbbb', parent_session_id: 'aaaa' });
  assert.equal(answer.changed, true);
  assert.equal(parentOf('bbbb'), 'aaaa');
  const cleared = await tools.set_session_parent({ session_id: 'bbbb' });
  assert.equal(cleared.changed, true);
  assert.equal(parentOf('bbbb'), '');
});
