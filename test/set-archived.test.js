import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSessionArchived, INHERIT_ARCHIVE, UNARCHIVED_ON_PURPOSE } from '../src/set-archived.js';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';
import { resolveContext } from '../src/tools/context.js';

// archivedAt: > 0 archived, -1 brought back on purpose, 0 nothing chosen.

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const id of ['aaaa', 'bbbb']) {
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: `p ${id}` } }) + '\n');
  }
  const runtime = { listLive: async () => [] };
  const ctx = resolveContext({ configDir, dataDir, runtime, owners: {} });
  const tools = Object.fromEntries(createSessionMgmtTools({ configDir, dataDir, runtime, owners: {} }).map((t) => [t.name, t.handler]));
  return { ctx, tools, archivedAt: (id) => ctx.store.marks.find(id)?.archivedAt };
}

test('archives a session, and says so when it already is', () => {
  const { ctx, archivedAt } = setup();
  assert.equal(setSessionArchived(ctx, 'aaaa', true).changed, true);
  assert.ok(archivedAt('aaaa') > 0);
  assert.equal(setSessionArchived(ctx, 'aaaa', true).changed, false);
});

test('bringing a session back keeps a record of the choice, which is not 0', () => {
  const { ctx, archivedAt } = setup();
  setSessionArchived(ctx, 'aaaa', true);
  const answer = setSessionArchived(ctx, 'aaaa', false);
  assert.equal(answer.changed, true);
  assert.equal(answer.archived, false);
  assert.equal(archivedAt('aaaa'), UNARCHIVED_ON_PURPOSE);
  // A session no mark holds is still recorded as brought back on purpose.
  assert.equal(setSessionArchived(ctx, 'bbbb', false).changed, true);
  assert.equal(archivedAt('bbbb'), UNARCHIVED_ON_PURPOSE);
});

test('inherit forgets the choice, and makes no mark for a session without one', () => {
  const { ctx, archivedAt } = setup();
  setSessionArchived(ctx, 'aaaa', false);
  assert.equal(setSessionArchived(ctx, 'aaaa', INHERIT_ARCHIVE).changed, true);
  assert.equal(archivedAt('aaaa'), 0);
  assert.equal(setSessionArchived(ctx, 'bbbb', INHERIT_ARCHIVE).changed, false);
  assert.equal(ctx.store.marks.find('bbbb'), undefined);
});

test('refuses a session that does not exist', () => {
  const { ctx } = setup();
  assert.throws(() => setSessionArchived(ctx, 'nope', true), /not found/i);
});

test('unarchive_session records the choice the same way, so an archive kept elsewhere is not shown again', async () => {
  const { tools, archivedAt } = setup();
  await tools.archive_session({ session_id: 'aaaa' });
  await tools.unarchive_session({ session_id: 'aaaa' });
  assert.equal(archivedAt('aaaa'), UNARCHIVED_ON_PURPOSE);
});
