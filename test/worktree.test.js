import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { createSessionTools } from '../src/tools/session.js';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';
import { createHostTools } from '../src/tools/host.js';
import { createSettingsTools } from '../src/tools/settings.js';
import { openStore } from '../src/store/entities.js';

const BG = 'The overall goal and decisions so far, long enough to pass the minimum length of eighty characters.';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const realExec = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, { cwd: opts?.cwd }, (error, stdout, stderr) => resolve(error ? { code: typeof error.code === 'number' ? error.code : 127, stdout: stdout ?? '', stderr: stderr || error.message } : { code: 0, stdout, stderr }));
});

function setup({ callerCwd } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-wt-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'init');
  const configDir = path.join(root, 'cfg'), dataDir = path.join(root, 'data');
  const proj = path.join(configDir, 'projects', '-x'); fs.mkdirSync(proj, { recursive: true });
  const transcript = (id, cwd, mtime) => {
    const f = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd, timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'p' } }) + '\n');
    if (mtime) fs.utimesSync(f, mtime, mtime);
  };
  transcript('caller', callerCwd ?? repo);
  const spawned = [];
  const runtime = { claudeBin: 'claude', listLive: async () => [], spawnDetached: async (args, cwd) => { spawned.push({ args, cwd }); }, exec: realExec, spawnProgram: async () => {}, which: async () => null, platform: 'darwin' };
  const owners = { find: async () => null, control: async () => ({}) };
  const ctx = { configDir, dataDir, selfSessionId: 'caller', runtime, owners };
  const tools = (create) => Object.fromEntries(create(ctx).map((t) => [t.name, t.handler]));
  return { root, repo, ctx, spawned, transcript, store: () => openStore({ dataDir }), session: tools(createSessionTools), mgmt: tools(createSessionMgmtTools), host: tools(createHostTools), settings: tools(createSettingsTools), tools };
}
const brief = (extra = {}) => ({ initiation: 'user_asked', title: 'Do work', prompt: 'P', background: BG, ...extra });

test('use_worktree true makes a worktree and a branch under the project, hides the folder from git, and runs the session there', async () => {
  const env = setup();
  const out = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name: 'work' }));
  const mark = env.store().marks.find(out.session_id);
  assert.ok(mark.worktree, 'the session records its worktree');
  assert.ok(mark.worktree.path.startsWith(path.join(fs.realpathSync(env.repo), '.swttch', 'worktrees')) || mark.worktree.path.startsWith(path.join(env.repo, '.swttch', 'worktrees')));
  assert.match(mark.worktree.branch, /^swttch\/work-[a-z0-9]{6}$/);
  assert.ok(fs.existsSync(path.join(mark.worktree.path, 'a.txt')), 'the worktree holds the project files');
  assert.equal(env.spawned[0].cwd, mark.worktree.path);
  assert.equal(git(mark.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), mark.worktree.branch);
  assert.match(fs.readFileSync(path.join(env.repo, '.git', 'info', 'exclude'), 'utf8'), /\.swttch\//);
  assert.equal(git(env.repo, 'status', '--porcelain').trim(), '', 'the project stays clean');
});

test('the branch prefix comes from the setting', async () => {
  const env = setup();
  await env.settings.set_setting({ key: 'branch_prefix', value: 'bot' });
  const out = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name: 'w' }));
  assert.match(env.store().marks.find(out.session_id).worktree.branch, /^bot\/w-/);
});

test('without use_worktree the session shares the folder, and a caller that works in a worktree gets a new worktree of its own', async () => {
  const plain = setup();
  const shared = await plain.session.start_session(brief({ cwd: plain.repo }));
  assert.equal(plain.store().marks.find(shared.session_id).worktree ?? null, null);
  assert.equal(plain.spawned[0].cwd, plain.repo);

  const env = setup();
  const first = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name: 'first' }));
  const firstMark = env.store().marks.find(first.session_id);
  // the caller is now a session that lives in a worktree
  const store = env.store(); const callerMark = store.marks.find('caller') ?? new (store.marks.entityClass)({ sessionUid: 'caller' });
  callerMark.worktree = firstMark.worktree; callerMark.cwd = firstMark.worktree.path; store.marks.save(callerMark);
  env.transcript('caller', firstMark.worktree.path);
  const child = await env.session.start_session(brief({ name: 'child' }));
  const childMark = env.store().marks.find(child.session_id);
  assert.ok(childMark.worktree && childMark.worktree.path !== firstMark.worktree.path, 'a caller in a worktree gets a different worktree for the new session');
  const stay = await env.session.start_session(brief({ name: 'stay', use_worktree: false }));
  assert.equal(env.store().marks.find(stay.session_id).worktree ?? null, null, 'use_worktree false shares the caller folder');
});

test('use_worktree in a folder that is not a git repository is refused with a reason', async () => {
  const env = setup();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-nogit-'));
  await assert.rejects(env.session.start_session(brief({ cwd: plain, use_worktree: true })), /git repository/);
});

test('archive removes a clean worktree and keeps the branch; unarchive and the next message bring the worktree back', async () => {
  const env = setup();
  const out = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name: 'a' }));
  const wt = env.store().marks.find(out.session_id).worktree;
  env.transcript(out.session_id, wt.path);
  const answer = await env.mgmt.archive_session({ session_id: out.session_id });
  assert.match(answer, /worktree removed/i);
  assert.equal(fs.existsSync(wt.path), false);
  assert.match(git(env.repo, 'branch', '--list', wt.branch), new RegExp(wt.branch.replace('/', '\\/')));
  await env.mgmt.unarchive_session({ session_id: out.session_id });
  env.spawned.length = 0;
  await env.mgmt.send_message({ session_id: out.session_id, message: 'back' });
  assert.ok(fs.existsSync(path.join(wt.path, 'a.txt')), 'the worktree was recreated before the session resumed');
  assert.equal(env.spawned[0].cwd, wt.path);
});

test('archive keeps a worktree that holds uncommitted changes and says so; discard_kept_worktree removes it for good', async () => {
  const env = setup();
  const out = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name: 'd' }));
  const wt = env.store().marks.find(out.session_id).worktree;
  env.transcript(out.session_id, wt.path);
  fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'x');
  assert.match(await env.mgmt.archive_session({ session_id: out.session_id }), /kept.*uncommitted/i);
  assert.ok(fs.existsSync(wt.path));
  const usage = await env.host.get_storage_usage({});
  assert.equal(usage.worktrees.count, 1);
  assert.equal(usage.worktrees.kept_after_archive, 1);
  assert.ok(usage.worktrees.bytes > 0);
  assert.match(await env.host.discard_kept_worktree({ session_id: out.session_id }), /discarded/i);
  assert.equal(fs.existsSync(wt.path), false);
  await assert.rejects(env.host.discard_kept_worktree({ session_id: out.session_id }), /nothing/i);
});

test('delete_session removes the worktree and the branch when nothing would be lost, and skips one with uncommitted changes unless forced', async () => {
  const env = setup();
  const a = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name: 'del-a' }));
  const b = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name: 'del-b' }));
  const wa = env.store().marks.find(a.session_id).worktree, wb = env.store().marks.find(b.session_id).worktree;
  env.transcript(a.session_id, wa.path); env.transcript(b.session_id, wb.path);
  fs.writeFileSync(path.join(wb.path, 'dirty.txt'), 'x');
  const result = await env.mgmt.delete_session({ session_ids: [a.session_id, b.session_id] });
  assert.deepEqual(result.deleted, [a.session_id]);
  assert.match(result.skipped[0].reason, /uncommitted/);
  assert.equal(fs.existsSync(wa.path), false);
  assert.equal(git(env.repo, 'branch', '--list', wa.branch).trim(), '', 'the branch with no commits of its own is deleted');
  const forced = await env.mgmt.delete_session({ session_ids: [b.session_id], force_worktree_cleanup: true });
  assert.deepEqual(forced.deleted, [b.session_id]);
  assert.equal(fs.existsSync(wb.path), false);
});

test('clean_up_worktrees removes worktrees of idle sessions only, never one with uncommitted changes unless asked', async () => {
  const env = setup();
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const make = async (name) => { const o = await env.session.start_session(brief({ cwd: env.repo, use_worktree: true, name })); const w = env.store().marks.find(o.session_id).worktree; return { id: o.session_id, w }; };
  const idleClean = await make('idle-clean'), idleDirty = await make('idle-dirty'), fresh = await make('fresh');
  env.transcript(idleClean.id, idleClean.w.path, old); env.transcript(idleDirty.id, idleDirty.w.path, old); env.transcript(fresh.id, fresh.w.path);
  fs.writeFileSync(path.join(idleDirty.w.path, 'dirty.txt'), 'x');
  const first = await env.host.clean_up_worktrees({ older_than_days: 30 });
  assert.deepEqual(first.removed, [idleClean.id]);
  assert.equal(fs.existsSync(idleClean.w.path), false);
  assert.ok(fs.existsSync(idleDirty.w.path)); assert.ok(fs.existsSync(fresh.w.path));
  const second = await env.host.clean_up_worktrees({ older_than_days: 30, include_uncommitted: true });
  assert.deepEqual(second.removed, [idleDirty.id]);
  assert.ok(fs.existsSync(fresh.w.path));
  await assert.rejects(env.host.clean_up_worktrees({ older_than_days: 45 }), /30, 60 or 90/);
});

test('settings report where worktrees are made', async () => {
  const { settings } = setup();
  const out = await settings.get_settings({});
  assert.match(out.read_only.find((r) => r.name === 'worktree_location').value, /\.swttch\/worktrees/);
});
