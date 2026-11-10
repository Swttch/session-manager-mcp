import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';
import { createSessionTools } from '../src/tools/session.js';

// A session that starts another one is its parent until it lets go: detach_session makes the
// started session a top-level one, no longer in the starter's family and no longer reporting to it.

const BACKGROUND = 'The overall goal and decisions so far, long enough to pass the minimum length of eighty characters.';

function setup({ self = 'cccc' } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const id of ['aaaa', 'cccc', 'dddd']) {
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: `p ${id}` } }) + '\n');
  }
  const spawned = [];
  const sent = [];
  const runtime = { listLive: async () => [], spawnDetached: async (args, cwd, options) => { spawned.push({ args, cwd, options }); } };
  const owners = { find: async () => ({ pid: 1, control: { port: 1, token: 't' } }), control: async (owner, body) => { sent.push(body); return {}; } };
  const toolsFor = (sessionId) => {
    const ctx = { configDir, dataDir, selfSessionId: sessionId, runtime, owners };
    const toMap = (tools) => Object.fromEntries(tools.map((t) => [t.name, t.handler]));
    return { mgmt: toMap(createSessionMgmtTools(ctx)), session: toMap(createSessionTools(ctx)) };
  };
  const start = (tools, extra = {}) => tools.session.start_session({ initiation: 'user_asked', title: 'Next manager', prompt: 'Manage the next version', background: BACKGROUND, cwd: '/tmp/demo', name: 'manager', ...extra });
  const writeTranscript = (sessionId) => fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd: '/tmp/demo', message: { role: 'user', content: 'brief' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
  ].join('\n') + '\n');
  return { toolsFor, start, spawned, sent, writeTranscript, self: toolsFor(self) };
}

test('detach_session moves a session the caller started to the top level and names it in the answer', async () => {
  const { self, start } = setup();
  const started = await start(self);
  assert.deepEqual((await self.mgmt.list_sessions({ linked: true })).map((r) => r.sessionId), [started.session_id]);
  const out = await self.mgmt.detach_session({ session_id: started.session_id });
  assert.equal(out.session_id, started.session_id);
  assert.equal(out.title, 'Next manager');
  assert.equal(out.detached, true);
  assert.deepEqual(await self.mgmt.list_sessions({ linked: true }), [], 'it is no longer in the caller\'s family');
  const row = (await self.mgmt.list_sessions({})).find((r) => r.sessionId === started.session_id);
  assert.equal(row.startedBy, undefined, 'and no longer says who started it');
});

test('a detached session no longer reports the end of its turn to the session that started it', async () => {
  const { self, start, spawned, sent, writeTranscript } = setup();
  const started = await start(self);
  await self.mgmt.detach_session({ session_id: started.session_id });
  writeTranscript(started.session_id);
  await spawned[0].options.onExit(0);
  assert.equal(sent.length, 0);
});

test('detach_session refuses the calling session and a session that another session started', async () => {
  const { self, toolsFor, start } = setup();
  await assert.rejects(self.mgmt.detach_session({ session_id: 'self' }), /calling session/);
  const other = toolsFor('dddd');
  const theirs = await start(other);
  await assert.rejects(self.mgmt.detach_session({ session_id: theirs.session_id }), /started by another session/);
  assert.equal((await other.mgmt.list_sessions({ linked: true })).length, 1, 'the other family is untouched');
});

test('detach_session on a session nobody started says it is already at the top level, and changes nothing', async () => {
  const { self } = setup();
  const out = await self.mgmt.detach_session({ session_id: 'aaaa' });
  assert.equal(out.detached, false);
  assert.match(out.message, /already/);
});

test('detach_session on a session that does not exist is an error', async () => {
  const { self } = setup();
  await assert.rejects(self.mgmt.detach_session({ session_id: 'zzzz' }));
});

test('start_session answers with the folder the new session runs in, so a screen can open it', async () => {
  const { self, start } = setup();
  const out = await start(self);
  assert.equal(path.resolve(out.cwd), path.resolve('/tmp/demo'));
});
