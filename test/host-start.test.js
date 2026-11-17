import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionTools } from '../src/tools/session.js';
import { readRunning } from '../src/running-sessions.js';

// When the session that starts another one is held by the plugin's backend, the backend runs the new session
// instead of this server: a CLI the backend runs has the channel through which it asks the person, and so has the
// question card (`--permission-prompt-tool stdio`); a CLI started here has neither. Whatever the backend cannot or
// will not do, the session is started here as before (see wake.test.js and running-sessions.test.js for that path).

const BACKGROUND = 'The overall goal and decisions so far, long enough to pass the minimum length of eighty characters.';
// A process that exists: a running record is read back only for a process that is alive.
const HOLDER = { pid: process.pid, control: { port: 1, token: 't' } };

/**
 * `host` decides what the backend does with each request: a function of the body, returning its answer or throwing.
 * Every request it was sent is kept, in order.
 */
function setup({ holder = HOLDER, host, capabilities = ['start_session', 'await_turn_end'] } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'cccc.jsonl'), JSON.stringify({ type: 'user', uuid: 'u-self', sessionId: 'cccc', cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'p' } }) + '\n');
  const spawned = [];
  const requests = [];
  const runtime = { listLive: async () => [], spawnDetached: async (args, cwd, options) => { spawned.push({ args, cwd, options }); return { pid: 31337 }; } };
  const owners = {
    find: async (sessionId) => (holder && sessionId === 'cccc' ? holder : null),
    control: async (owner, body, options) => {
      requests.push({ owner, body, options });
      if (body.action === 'capabilities' && capabilities !== undefined) {
        if (capabilities === null) throw new Error('Unknown action: capabilities');
        return { ok: true, actions: capabilities };
      }
      return host(body);
    },
  };
  const ctx = { configDir, dataDir, selfSessionId: 'cccc', runtime, owners };
  const tools = Object.fromEntries(createSessionTools(ctx).map((t) => [t.name, t.handler]));
  const start = (extra = {}) => tools.start_session({ initiation: 'user_asked', title: 'Lyricist', prompt: 'Write a verse', background: BACKGROUND, cwd: '/tmp/demo', name: 'lyr', ...extra });
  const transcript = (sessionId, replies) => {
    const lines = [{ type: 'user', uuid: 'u1', sessionId, cwd: '/tmp/demo', message: { role: 'user', content: 'brief' } }];
    replies.forEach((text, i) => lines.push({ type: 'assistant', uuid: `a${i}`, sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } }));
    fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  return { start, spawned, requests, transcript, dataDir, ctx };
}

// A backend that starts sessions and reports the end of their first turn when the test says so.
function workingHost() {
  let endTurn;
  const turn = new Promise((resolve) => { endTurn = resolve; });
  return {
    endTurn: () => endTurn(),
    handler: async (body) => {
      if (body.action === 'start_session') return { ok: true, turnEnds: 0 };
      if (body.action === 'await_turn_end') {
        await turn;
        return { ok: true, ended: true, turnEnds: 1 };
      }
      return {};
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('the backend that holds the calling session is asked to run the new session, and no program is started here', async () => {
  const host = workingHost();
  const { start, spawned, requests } = setup({ host: host.handler });
  const out = await start();

  assert.equal(spawned.length, 0, 'this server starts no program of its own');
  const ask = requests.find((r) => r.body.action === 'start_session');
  assert.equal(ask.owner.pid, HOLDER.pid);
  assert.equal(ask.body.sessionId, out.session_id);
  assert.equal(ask.body.workingDir, '/tmp/demo');
  assert.equal(ask.body.title, 'Lyricist');
  assert.ok(ask.body.text.startsWith('Background (from the session that started this one):\n'), 'the brief is framed the way a started session always gets it');
  assert.ok(ask.body.text.includes('Task:\nWrite a verse'));
  host.endTurn();
});

test('the model, the effort and the permission mode go with the request', async () => {
  const host = workingHost();
  const { start, requests } = setup({ host: host.handler });
  await start({ model: 'sonnet', effort: 'high', permission_mode: 'acceptEdits' });
  const ask = requests.find((r) => r.body.action === 'start_session');
  assert.equal(ask.body.model, 'sonnet');
  assert.equal(ask.body.effort, 'high');
  assert.equal(ask.body.permissionMode, 'acceptEdits');
  host.endTurn();
});

test('the request to start the session may take longer than an ordinary one, so that a slow start is not taken for a failed one', async () => {
  const host = workingHost();
  const { start, requests } = setup({ host: host.handler });
  await start();
  const ask = requests.find((r) => r.body.action === 'start_session');
  assert.ok(ask.options.timeoutMs >= 30_000);
  host.endTurn();
});

test('the session is listed as running while its first turn goes on, and the calling session is told when it ends', async () => {
  const host = workingHost();
  const { start, requests, transcript, dataDir } = setup({ host: host.handler });
  const out = await start();
  await settle();
  assert.deepEqual(readRunning({ dataDir }), [out.session_id], 'desktop-state lists it as running');

  transcript(out.session_id, ['A verse about staying.']);
  host.endTurn();
  await settle();

  assert.deepEqual(readRunning({ dataDir }), [], 'it stops being running once the turn ended');
  const wake = requests.find((r) => r.body.action === 'send_message');
  assert.equal(wake.body.sessionId, 'cccc');
  assert.ok(wake.body.text.startsWith(`From Lyricist (session ${out.session_id}):\n`));
  assert.ok(wake.body.text.includes('A verse about staying.'));
});

test('the wait for the end of the turn is asked again and again until the turn ends, naming the count it has seen', async () => {
  let polls = 0;
  const { start, requests } = setup({
    host: async (body) => {
      if (body.action === 'start_session') return { ok: true, turnEnds: 0 };
      if (body.action === 'await_turn_end') {
        polls += 1;
        return polls < 3 ? { ok: true, ended: false, turnEnds: 0 } : { ok: true, ended: true, turnEnds: 1 };
      }
      return {};
    },
  });
  await start();
  await settle();
  const waits = requests.filter((r) => r.body.action === 'await_turn_end');
  assert.equal(waits.length, 3);
  assert.ok(waits.every((w) => w.body.after === 0));
  assert.ok(waits.every((w) => w.options.timeoutMs > w.body.waitMs), 'the request outlasts the time the backend may hold it');
});

test('wake_when_done: false still runs the session in the backend, and nobody is told when it ends', async () => {
  const host = workingHost();
  const { start, spawned, requests } = setup({ host: host.handler });
  await start({ wake_when_done: false });
  host.endTurn();
  await settle();
  assert.equal(spawned.length, 0);
  assert.equal(requests.some((r) => r.body.action === 'send_message'), false);
});

test('the backend is asked what it can do before anything is asked of it, and a backend that cannot run sessions leaves the session to be started here', async () => {
  const { start, spawned, requests } = setup({ capabilities: ['send_message', 'rename'], host: async () => ({ ok: true }) });
  await start();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[0], '-p');
  assert.deepEqual(requests.map((r) => r.body.action), ['capabilities'], 'nothing else was asked of that backend');
});

test('an older backend, which does not know the question either, is answered as one that cannot, and the session is started here', async () => {
  const { start, spawned } = setup({ capabilities: null, host: async () => ({ ok: true }) });
  await start();
  assert.equal(spawned.length, 1);
});

test('a backend that said it can run sessions and then fails is an error of the start, and no second copy is started here', async () => {
  const { start, spawned } = setup({ host: async () => { throw new Error('The CLI did not start'); } });
  await assert.rejects(start(), /The CLI did not start/);
  assert.equal(spawned.length, 0);
});

test('a backend that answers a start without saying it ran the session is an error of the start, not a reason to start another', async () => {
  const { start, spawned } = setup({ host: async () => ({}) });
  await assert.rejects(start(), /did not start the session/);
  assert.equal(spawned.length, 0);
});

test('a calling session no backend holds (a terminal, the desktop app) is started here as before', async () => {
  const { start, spawned, requests } = setup({ holder: null, host: async () => ({ ok: true }) });
  await start();
  assert.equal(spawned.length, 1);
  assert.equal(requests.length, 0);
});

test('a backend that stops answering while the turn goes on ends the wait, and the running record goes', async () => {
  const { start, dataDir } = setup({
    host: async (body) => {
      if (body.action === 'start_session') return { ok: true, turnEnds: 0 };
      throw new Error('connect ECONNREFUSED');
    },
  });
  await start();
  await settle();
  assert.deepEqual(readRunning({ dataDir }), []);
});
