import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';
import { createSidebarTools } from '../src/tools/sidebar.js';

function setup(selfSessionId) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const [id, ts] of [['aaaa', '2026-11-01'], ['bbbb', '2026-11-02'], ['cccc', '2026-11-03']]) {
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: `${ts}T00:00:00Z`, message: { role: 'user', content: `prompt ${id}` } }) + '\n');
    fs.utimesSync(path.join(proj, `${id}.jsonl`), new Date(`${ts}T01:00:00Z`), new Date(`${ts}T01:00:00Z`));
  }
  const ctx = { configDir, dataDir, selfSessionId, runtime: { listLive: async () => [], spawnDetached: async () => {} } };
  const sidebar = Object.fromEntries(createSidebarTools(ctx).map((t) => [t.name, t.handler]));
  const mgmt = Object.fromEntries(createSessionMgmtTools(ctx).map((t) => [t.name, t.handler]));
  return { ctx, sidebar, mgmt };
}

test('create_group returns an id and list_groups shows it with a count of zero', async () => {
  const { sidebar } = setup();
  const made = await sidebar.create_group({ name: 'Doing' });
  assert.ok(made.id);
  const groups = await sidebar.list_groups({});
  assert.deepEqual(groups.map((g) => [g.id, g.name, g.session_count, g.order]), [[made.id, 'Doing', 0, 0]]);
});

test('group names must be 1 to 200 characters', async () => {
  const { sidebar } = setup();
  await assert.rejects(sidebar.create_group({ name: '' }), /1/);
  await assert.rejects(sidebar.create_group({ name: 'x'.repeat(201) }), /200/);
});

test('move_sessions files sessions under a group and list_sessions reports the group', async () => {
  const { sidebar, mgmt } = setup();
  const { id } = await sidebar.create_group({ name: 'Doing' });
  await sidebar.move_sessions({ session_ids: ['aaaa', 'bbbb'], group_id: id });
  const rows = await mgmt.list_sessions({});
  assert.deepEqual(rows.find((r) => r.sessionId === 'aaaa').group, { id, name: 'Doing' });
  assert.equal(rows.find((r) => r.sessionId === 'cccc').group, null);
  assert.equal((await sidebar.list_groups({}))[0].session_count, 2);
  assert.deepEqual((await mgmt.list_sessions({ group: 'Doing' })).map((r) => r.sessionId).sort(), ['aaaa', 'bbbb']);
});

test('group_id null moves sessions back to Ungrouped', async () => {
  const { sidebar, mgmt } = setup();
  const { id } = await sidebar.create_group({ name: 'Doing' });
  await sidebar.move_sessions({ session_ids: ['aaaa'], group_id: id });
  await sidebar.move_sessions({ session_ids: ['aaaa'], group_id: null });
  assert.equal((await mgmt.list_sessions({})).find((r) => r.sessionId === 'aaaa').group, null);
});

test('moving into a group that does not exist is an error', async () => {
  const { sidebar } = setup();
  await assert.rejects(sidebar.move_sessions({ session_ids: ['aaaa'], group_id: 'missing' }), /missing/);
});

test('deleting a group leaves its sessions Ungrouped and removes only the group', async () => {
  const { sidebar, mgmt } = setup();
  const { id } = await sidebar.create_group({ name: 'Doing' });
  await sidebar.move_sessions({ session_ids: ['aaaa'], group_id: id });
  await sidebar.delete_group({ group_id: id });
  assert.deepEqual(await sidebar.list_groups({}), []);
  const rows = await mgmt.list_sessions({});
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.sessionId === 'aaaa').group, null);
});

test('rename_group changes the name', async () => {
  const { sidebar } = setup();
  const { id } = await sidebar.create_group({ name: 'Doing' });
  await sidebar.rename_group({ group_id: id, name: 'Done' });
  assert.equal((await sidebar.list_groups({}))[0].name, 'Done');
});

test('set_pinned marks the row pinned and unpinned again; moving a pinned session into a group unpins it', async () => {
  const { sidebar, mgmt } = setup();
  await sidebar.set_pinned({ session_id: 'aaaa', pinned: true });
  assert.equal((await mgmt.list_sessions({})).find((r) => r.sessionId === 'aaaa').pinned, true);
  const { id } = await sidebar.create_group({ name: 'Doing' });
  await sidebar.move_sessions({ session_ids: ['aaaa'], group_id: id });
  assert.equal((await mgmt.list_sessions({})).find((r) => r.sessionId === 'aaaa').pinned, false);
  await sidebar.set_pinned({ session_id: 'aaaa', pinned: true });
  await sidebar.move_sessions({ session_ids: ['aaaa'], group_id: null });
  assert.equal((await mgmt.list_sessions({})).find((r) => r.sessionId === 'aaaa').pinned, true);
});

test('"self" resolves for set_pinned and set_unread', async () => {
  const { sidebar, mgmt } = setup('bbbb');
  await sidebar.set_pinned({ session_id: 'self', pinned: true });
  await sidebar.set_unread({ session_id: 'self', unread: true });
  const row = await mgmt.get_session({ session_id: 'self' });
  assert.equal(row.pinned, true);
  assert.equal(row.unread, true);
});

test('archive_session hides a session from list_sessions until include_archived, unarchive brings it back', async () => {
  const { mgmt } = setup();
  await mgmt.archive_session({ session_id: 'aaaa' });
  assert.equal((await mgmt.list_sessions({})).some((r) => r.sessionId === 'aaaa'), false);
  const all = await mgmt.list_sessions({ include_archived: true });
  assert.equal(all.find((r) => r.sessionId === 'aaaa').isArchived, true);
  await mgmt.unarchive_session({ session_id: 'aaaa' });
  assert.equal((await mgmt.list_sessions({})).find((r) => r.sessionId === 'aaaa').isArchived, false);
});

test('archiving the calling session is refused, like the reference tool refuses a running one', async () => {
  const { mgmt } = setup('bbbb');
  await assert.rejects(mgmt.archive_session({ session_id: 'self' }), /calling session/);
});

test('list_sections lists the built-ins then one manual section per group', async () => {
  const { sidebar } = setup();
  const { id } = await sidebar.create_group({ name: 'Doing' });
  const sections = await sidebar.list_sections({});
  assert.deepEqual(sections.map((s) => [s.id, s.kind]), [['pinned', 'pinned'], ['routines', 'routines'], [id, 'manual'], ['sessions', 'sessions']]);
});

test('create_section is the same record as create_group; built-in sections cannot be renamed or deleted', async () => {
  const { sidebar } = setup();
  const { id } = await sidebar.create_section({ name: 'Later' });
  assert.deepEqual((await sidebar.list_groups({})).map((g) => g.id), [id]);
  await assert.rejects(sidebar.rename_section({ section_id: 'pinned', name: 'x' }), /built-in/i);
  await assert.rejects(sidebar.delete_section({ section_id: 'sessions' }), /built-in/i);
  await sidebar.delete_section({ section_id: id });
  assert.deepEqual(await sidebar.list_groups({}), []);
});

test('set_view stores only the given fields, validates enums, and returns the settings afterwards', async () => {
  const { sidebar } = setup();
  const first = await sidebar.set_view({ group_by: 'project', sort_by: 'alpha' });
  assert.deepEqual([first.group_by, first.sort_by], ['project', 'alpha']);
  const second = await sidebar.set_view({ status: 'archived' });
  assert.deepEqual([second.group_by, second.sort_by, second.status], ['project', 'alpha', 'archived']);
  await assert.rejects(sidebar.set_view({ group_by: 'weird' }), /group_by/);
});

test('the marks survive a fresh server process: a second set of tools sees the same data', async () => {
  const { ctx, sidebar } = setup();
  const { id } = await sidebar.create_group({ name: 'Doing' });
  const again = Object.fromEntries(createSidebarTools(ctx).map((t) => [t.name, t.handler]));
  assert.deepEqual((await again.list_groups({})).map((g) => g.id), [id]);
});
