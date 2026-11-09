import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHostTools } from '../src/tools/host.js';
import { makeEnv } from './helpers.js';

test('open_in_editor opens the file at a line and column in the only installed editor', async () => {
  const { tools, calls } = makeEnv({ cwd: '/tmp/demo' });
  const host = tools(createHostTools);
  // two editors are installed in the fake system (code, cursor): the caller must choose
  await assert.rejects(host.open_in_editor({ path: 'src/a.js' }), /code|cursor|vscode/i);
  const answer = await host.open_in_editor({ path: 'src/a.js', line: 3, column: 5, editor: 'cursor' });
  assert.match(answer, /cursor/i);
  assert.deepEqual(calls.programs, [{ cmd: 'cursor', args: ['-g', `${path.resolve('/tmp/demo', 'src/a.js')}:3:5`] }]);
});

test('open_in_editor refuses a path outside the calling session\'s folder', async () => {
  const { tools } = makeEnv({ cwd: '/tmp/demo' });
  await assert.rejects(tools(createHostTools).open_in_editor({ path: '/etc/passwd', editor: 'cursor' }), /inside/);
  await assert.rejects(tools(createHostTools).open_in_editor({ path: '../outside.txt', editor: 'cursor' }), /inside/);
});

test('reveal_path shows the item in the system file manager', async () => {
  const mac = makeEnv({ cwd: '/tmp/demo' });
  await mac.tools(createHostTools).reveal_path({ path: 'dist' });
  assert.deepEqual(mac.calls.programs, [{ cmd: 'open', args: ['-R', path.resolve('/tmp/demo', 'dist')] }]);
  const linux = makeEnv({ cwd: '/tmp/demo' });
  linux.ctx.runtime.platform = 'linux';
  await linux.tools(createHostTools).reveal_path({ path: 'dist/a.txt' });
  assert.deepEqual(linux.calls.programs, [{ cmd: 'xdg-open', args: [path.dirname(path.resolve('/tmp/demo', 'dist/a.txt'))] }]);
});

test('request_keep_awake holds the machine awake with caffeinate on macOS and says unavailable elsewhere', async () => {
  const mac = makeEnv();
  assert.match(await mac.tools(createHostTools).request_keep_awake({ until: 'turn_end', reason: 'long build' }), /awake/i);
  assert.equal(mac.calls.programs[0].cmd, 'caffeinate');
  const win = makeEnv();
  win.ctx.runtime.platform = 'win32';
  await assert.rejects(win.tools(createHostTools).request_keep_awake({ until: 'turn_end', reason: 'x' }), /^Error: unavailable: /);
  await assert.rejects(mac.tools(createHostTools).request_keep_awake({ until: 'later', reason: 'x' }), /until/);
});

test('get_storage_usage reports the size of the conversation history and the free space', async () => {
  const { tools } = makeEnv();
  const usage = await tools(createHostTools).get_storage_usage({});
  assert.ok(usage.conversation_history_bytes > 0);
  assert.equal(usage.session_count, 2);
  assert.ok(usage.free_bytes > 0);
  assert.deepEqual(usage.worktrees, { count: 0, bytes: 0, kept_after_archive: 0 });
});


// sync_with_base_branch runs real git against throwaway repositories.
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-git-'));
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), other = path.join(root, 'other');
  git(root, 'init', '--bare', '-b', 'main', origin);
  for (const dir of [work, other]) { git(root, 'clone', origin, dir); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); }
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'init'); git(work, 'push', 'origin', 'main');
  git(other, 'pull', 'origin', 'main');
  git(work, 'checkout', '-b', 'feature');
  return { root, work, other };
}
function hostFor(cwd) {
  const env = makeEnv({ cwd });
  env.ctx.runtime.exec = async (cmd, args, opts) => {
    try { return { code: 0, stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
    catch (error) { return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }; }
  };
  return env.tools(createHostTools);
}

test('sync_with_base_branch merges the base branch into the session\'s branch, and says when nothing was needed', async () => {
  const { work, other } = repos();
  fs.writeFileSync(path.join(other, 'b.txt'), 'new on main\n'); git(other, 'add', '.'); git(other, 'commit', '-m', 'main moves'); git(other, 'push', 'origin', 'main');
  const host = hostFor(work);
  assert.match(await host.sync_with_base_branch({ base: 'main' }), /^merged/);
  assert.ok(fs.existsSync(path.join(work, 'b.txt')));
  assert.match(await host.sync_with_base_branch({ base: 'main' }), /up to date/);
});

test('sync_with_base_branch reports conflicts, leaves the merge in progress, and abort undoes it', async () => {
  const { work, other } = repos();
  fs.writeFileSync(path.join(other, 'a.txt'), 'main change\n'); git(other, 'commit', '-am', 'main edits a'); git(other, 'push', 'origin', 'main');
  fs.writeFileSync(path.join(work, 'a.txt'), 'feature change\n'); git(work, 'commit', '-am', 'feature edits a');
  const host = hostFor(work);
  const answer = await host.sync_with_base_branch({ base: 'main' });
  assert.match(answer, /conflict/i);
  assert.match(answer, /a\.txt/);
  assert.match(await host.sync_with_base_branch({ abort: true }), /abort/i);
  assert.equal(git(work, 'status', '--porcelain').trim(), '');
});

test('sync_with_base_branch refuses to touch uncommitted changes', async () => {
  const { work } = repos();
  fs.writeFileSync(path.join(work, 'a.txt'), 'dirty\n');
  await assert.rejects(hostFor(work).sync_with_base_branch({ base: 'main' }), /uncommitted/i);
});
