import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';
import { createSessionTools } from '../src/tools/session.js';

function setup({ self = 'cccc', live = [] } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const [id, ts, title] of [['aaaa', '2026-11-01', 'Alpha'], ['bbbb', '2026-11-02', 'Beta'], ['cccc', '2026-11-03', 'Caller']]) {
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: `${ts}T00:00:00Z`, message: { role: 'user', content: `prompt ${id}` } }),
      JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }),
    ].join('\n') + '\n');
    fs.utimesSync(path.join(proj, `${id}.jsonl`), new Date(`${ts}T01:00:00Z`), new Date(`${ts}T01:00:00Z`));
  }
  const spawned = [];
  const runtime = {
    listLive: async () => live,
    spawnDetached: async (args, cwd) => { spawned.push({ args, cwd }); },
    // What the CLI does with /rename: it writes the name into the transcript and says so.
    runClaude: async (args, options) => {
      const id = args[args.indexOf('--resume') + 1];
      const name = options.input.replace(/^\/rename /, '').trim();
      fs.appendFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: id }) + '\n');
      return { code: 0, stdout: `Session renamed to: ${name}\n`, stderr: '' };
    },
  };
  // No program holds any of these sessions; a test that needs one passes its own.
  const owners = { find: async () => null, control: async () => ({}) };
  const ctx = { configDir, dataDir, selfSessionId: self, runtime, owners };
  const toMap = (tools) => Object.fromEntries(tools.map((t) => [t.name, t.handler]));
  return { ctx, spawned, mgmt: toMap(createSessionMgmtTools(ctx)), session: toMap(createSessionTools(ctx)), proj };
}

const liveRow = (sessionId, extra = {}) => ({ pid: 4242, cwd: '/tmp/demo', kind: 'interactive', sessionId, name: sessionId, status: 'idle', ...extra });

test('list_sessions marks a session running when the CLI lists it as live', async () => {
  const { mgmt } = setup({ live: [liveRow('aaaa')] });
  const rows = await mgmt.list_sessions({});
  assert.equal(rows.find((r) => r.sessionId === 'aaaa').isRunning, true);
  assert.equal(rows.find((r) => r.sessionId === 'bbbb').isRunning, false);
});

test('send_message to an idle session resumes it with -p and labels the sender', async () => {
  const { mgmt, spawned } = setup();
  const result = await mgmt.send_message({ session_id: 'aaaa', message: 'please continue' });
  assert.match(result, /^delivered/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cwd, '/tmp/demo');
  const args = spawned[0].args;
  assert.deepEqual(args.slice(0, 3), ['--resume', 'aaaa', '-p']);
  assert.match(args[args.length - 1], /^From Caller \(session cccc\):\n[\s\S]*please continue/);
});

test('send_message to a session another program is running says so and spawns nothing', async () => {
  const { mgmt, spawned } = setup({ live: [liveRow('aaaa', { pid: 777 })] });
  await assert.rejects(mgmt.send_message({ session_id: 'aaaa', message: 'hi' }), /another program.*777/);
  assert.equal(spawned.length, 0);
});

test('send_message refuses the calling session and unknown sessions', async () => {
  const { mgmt } = setup();
  await assert.rejects(mgmt.send_message({ session_id: 'cccc', message: 'hi' }), /calling session/);
  await assert.rejects(mgmt.send_message({ session_id: 'zzzz', message: 'hi' }), /zzzz/);
});

test('model, effort and permission mode are saved and passed at the next resume', async () => {
  const { mgmt, spawned } = setup();
  await mgmt.set_session_model({ session_id: 'aaaa', model: 'sonnet' });
  await mgmt.set_session_effort({ session_id: 'aaaa', effort: 'high' });
  await mgmt.set_session_permission_mode({ session_id: 'aaaa', mode: 'acceptEdits' });
  await mgmt.send_message({ session_id: 'aaaa', message: 'go' });
  const args = spawned[0].args;
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal((await mgmt.get_session({ session_id: 'aaaa' })).model, 'sonnet');
});

test('invalid effort and permission mode values are rejected', async () => {
  const { mgmt } = setup();
  await assert.rejects(mgmt.set_session_effort({ session_id: 'aaaa', effort: 'turbo' }), /effort/);
  await assert.rejects(mgmt.set_session_permission_mode({ session_id: 'aaaa', mode: 'yolo' }), /mode/);
});

test('changing a setting of a running session is saved and the answer says it applies at the next start', async () => {
  const { mgmt } = setup({ live: [liveRow('aaaa')] });
  const answer = await mgmt.set_session_model({ session_id: 'aaaa', model: 'opus' });
  assert.match(answer, /next start/);
});

test('set_session_title shows up in list_sessions', async () => {
  const { mgmt } = setup();
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Renamed' });
  assert.equal((await mgmt.list_sessions({})).find((r) => r.sessionId === 'aaaa').title, 'Renamed');
});

test('stop_session on an idle session says it is not running; on a live one it is unavailable', async () => {
  const idle = setup();
  assert.match(await idle.mgmt.stop_session({ session_id: 'aaaa' }), /not running/);
  const live = setup({ live: [liveRow('aaaa')] });
  await assert.rejects(live.mgmt.stop_session({ session_id: 'aaaa' }), /^Error: unavailable: /);
});

test('delete_session removes the transcript and the marks, and refuses live, calling and oversized requests', async () => {
  const { mgmt, proj } = setup({ live: [liveRow('bbbb')] });
  const result = await mgmt.delete_session({ session_ids: ['aaaa', 'bbbb', 'cccc', 'zzzz'] });
  assert.deepEqual(result.deleted, ['aaaa']);
  assert.equal(result.skipped.length, 3);
  assert.equal(fs.existsSync(path.join(proj, 'aaaa.jsonl')), false);
  assert.equal(fs.existsSync(path.join(proj, 'bbbb.jsonl')), true);
  await assert.rejects(mgmt.delete_session({ session_ids: Array.from({ length: 26 }, (_, i) => `s${i}`) }), /25/);
});

test('start_session spawns a fresh session with a preset id, a name, and the brief framed as background plus task', async () => {
  const { session, spawned, mgmt } = setup();
  const bg = 'The overall goal and decisions so far, long enough to pass the minimum length of eighty characters.';
  const out = await session.start_session({ initiation: 'user_asked', title: 'Do the thing', prompt: 'Do X', background: bg, cwd: '/tmp/demo', name: 'thing', permission_mode: 'plan' });
  assert.ok(out.session_id);
  assert.equal(out.name, 'thing');
  const { args, cwd } = spawned[0];
  assert.equal(cwd, '/tmp/demo');
  assert.equal(args[args.indexOf('--session-id') + 1], out.session_id);
  assert.equal(args[args.indexOf('--name') + 1], 'Do the thing');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  const prompt = args[args.length - 1];
  assert.ok(prompt.startsWith('Background (from the session that started this one):\n'));
  assert.ok(prompt.includes('\n\nTask:\nDo X'));
  const rows = await mgmt.list_sessions({ linked: true });
  assert.deepEqual(rows.map((r) => [r.sessionId, r.name, r.startedBy]), [[out.session_id, 'thing', 'cccc']]);
});

test('start_session refuses what is not built: worktrees, cloud, ssh, fork, presets, missing brief', async () => {
  const { session } = setup();
  const bg = 'x'.repeat(90);
  const ok = { initiation: 'user_asked', title: 'T', prompt: 'P', background: bg, cwd: '/tmp/demo' };
  await assert.rejects(session.start_session({ ...ok, preset: 'p' }), /^Error: unavailable: /);
  await assert.rejects(session.start_session({ proposal_id: 'p1' }), /No proposal/);
  await assert.rejects(session.start_session({ ...ok, target: 'cloud' }), /^Error: unavailable: /);
  await assert.rejects(session.start_session({ ...ok, target: 'ssh', host: 'h' }), /^Error: unavailable: /);
  await assert.rejects(session.start_session({ ...ok, context: 'fork' }), /unavailable.*fork/i);
  await assert.rejects(session.start_session({ ...ok, prompt: undefined }), /prompt/);
  await assert.rejects(session.start_session({ ...ok, background: 'short' }), /80/);
});

test('list_start_targets lists the folders sessions have run in', async () => {
  const { session } = setup();
  const targets = await session.list_start_targets({});
  assert.deepEqual(targets.thisComputer.recentFolders, ['/tmp/demo']);
  assert.deepEqual(targets.ssh, []);
  assert.equal(targets.cloud.available, false);
});

test('tools with nothing behind them yet answer unavailable instead of pretending', async () => {
  const { mgmt, session } = setup();
  for (const [name, args] of [['set_remote_control', { session_id: 'aaaa', enabled: true }], ['clear_session', { session_id: 'aaaa' }], ['export_transcript', { session_id: 'aaaa' }], ['set_session_fast_mode', { session_id: 'aaaa', enabled: true }], ['set_session_output_style', { session_id: 'aaaa', style: 'default' }]]) {
    await assert.rejects(mgmt[name](args), /^Error: unavailable: /, name);
  }
  for (const [name, args] of [['move_to_cloud', { summary: 's' }], ['hand_off_to_session', { title: 't', remaining_plan: 'p' }], ['mark_chapter', { title: 'c' }], ['read_widget_context', { tool_name: 'w' }]]) {
    await assert.rejects(session[name](args), /^Error: unavailable: /, name);
  }
});
