import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionTools } from '../src/tools/session.js';

// A session that starts another one is told when that one ends its turn. The server that started
// it is the one watching, so this only happens while the calling session is still running.

const BACKGROUND = 'The overall goal and decisions so far, long enough to pass the minimum length of eighty characters.';

function setup({ self = 'cccc', holder = { pid: 4242, control: { port: 1, token: 't' } }, refuse = false } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${self}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u-self', sessionId: self, cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'p' } }) + '\n');
  const spawned = [];
  const sent = [];
  const runtime = {
    listLive: async () => [],
    spawnDetached: async (args, cwd, options) => { spawned.push({ args, cwd, options }); },
  };
  const owners = {
    find: async (sessionId) => (holder && sessionId === self ? holder : null),
    control: async (owner, body) => {
      if (refuse) throw new Error('The holding program answered 409.');
      sent.push({ owner, body });
      return {};
    },
  };
  const ctx = { configDir, dataDir, selfSessionId: self, runtime, owners };
  const session = Object.fromEntries(createSessionTools(ctx).map((t) => [t.name, t.handler]));
  const start = (extra = {}) => session.start_session({ initiation: 'user_asked', title: 'Add up the numbers', prompt: 'Add 1 to 5', background: BACKGROUND, cwd: '/tmp/demo', name: 'sum', ...extra });
  // What the started session leaves behind: its transcript, with these assistant replies in order.
  const transcript = (sessionId, replies) => {
    const lines = [{ type: 'user', uuid: 'u1', sessionId, cwd: '/tmp/demo', message: { role: 'user', content: 'brief' } }];
    replies.forEach((text, i) => lines.push({ type: 'assistant', uuid: `a${i}`, sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } }));
    fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  return { start, spawned, sent, transcript };
}

test('the calling session is sent the started session\'s last reply when its turn ends', async () => {
  const { start, spawned, sent, transcript } = setup();
  const out = await start();
  assert.equal(sent.length, 0, 'nothing is sent while the session is still running');
  transcript(out.session_id, ['Working on it.', 'The answer is 15.']);
  await spawned[0].options.onExit(0);
  assert.equal(sent.length, 1);
  const { owner, body } = sent[0];
  assert.equal(owner.pid, 4242);
  assert.equal(body.sessionId, 'cccc');
  assert.equal(body.action, 'send_message');
  assert.ok(body.text.startsWith(`From Add up the numbers (session ${out.session_id}):\n`), 'its first line names the session by its title and id, the way send_message does');
  assert.ok(body.text.includes('The answer is 15.'));
  assert.ok(!body.text.includes('Working on it.'), 'only the last reply is quoted');
});

test('a long reply is cut to its first 400 characters and says that it was cut', async () => {
  const { start, spawned, sent, transcript } = setup();
  const out = await start();
  transcript(out.session_id, ['x'.repeat(400) + 'TAIL']);
  await spawned[0].options.onExit(0);
  assert.ok(sent[0].body.text.includes('x'.repeat(400)));
  assert.ok(!sent[0].body.text.includes('TAIL'));
  assert.match(sent[0].body.text, /first 400 characters/);
});

test('a session that ended without a reply is reported as such, with how it exited', async () => {
  const { start, spawned, sent, transcript } = setup();
  const out = await start();
  transcript(out.session_id, []);
  await spawned[0].options.onExit(1);
  assert.match(sent[0].body.text, /without a reply/);
  assert.match(sent[0].body.text, /exit code 1/);
});

test('nothing is sent, and nothing throws, when no program holds the calling session any more', async () => {
  const { start, spawned, sent, transcript } = setup({ holder: null });
  const out = await start();
  transcript(out.session_id, ['Done.']);
  await spawned[0].options.onExit(0);
  assert.equal(sent.length, 0);
});

test('a holder that refuses the message does not crash the server', async () => {
  const { start, spawned, transcript } = setup({ refuse: true });
  const out = await start();
  transcript(out.session_id, ['Done.']);
  // Nobody is waiting for this report, so whatever goes wrong in it must stay inside it.
  await assert.doesNotReject(async () => spawned[0].options.onExit(0));
});

test('a started session whose transcript cannot be found is still reported, without a quote', async () => {
  const { start, spawned, sent } = setup();
  await start();
  await spawned[0].options.onExit(0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /without a reply/);
});

test('wake_when_done: false starts the session without watching it', async () => {
  const { start, spawned } = setup();
  const out = await start({ wake_when_done: false });
  assert.equal(out.wake_when_done, false);
  assert.equal(spawned[0].options?.onExit, undefined);
});

test('start_session says in its answer that the caller will be told, so the caller can say so truthfully', async () => {
  const { start } = setup();
  const out = await start();
  assert.equal(out.wake_when_done, true);
});

test('the runtime reports how a detached program ended', async () => {
  const { createCliRuntime } = await import('../src/cli-runtime.js');
  const runtime = createCliRuntime({ claudeBin: process.execPath });
  // The started program does not keep this process alive (that is what detached means here), so the
  // test holds the event loop open the way the server's open stdin does.
  const hold = setInterval(() => {}, 1000);
  try {
    const code = await new Promise((resolve, reject) => {
      runtime.spawnDetached(['-e', 'process.exit(3)'], os.tmpdir(), { onExit: resolve }).catch(reject);
    });
    assert.equal(code, 3);
  } finally {
    clearInterval(hold);
  }
});

test('a server that does not know its own session has nobody to tell', async () => {
  const { start, spawned } = setup({ self: null });
  const out = await start();
  assert.equal(out.wake_when_done, false);
  assert.equal(spawned[0].options?.onExit, undefined);
});
