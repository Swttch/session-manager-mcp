import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createOwnerClient } from '../src/owner-control.js';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';

function registry(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-registry-'));
  for (const [name, entry] of Object.entries(entries)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(entry));
  return dir;
}
const entry = (sessionId, extra = {}) => ({ pid: process.pid, sessionId, workingDir: '/tmp/demo', startedAt: 'x', owner: { pid: 1, argv1: '' }, control: { port: 1, token: 't' }, ...extra });

test('finds the plugin backend that holds a session by reading the CLI registry', async () => {
  const dir = registry({ 100: entry('aaaa'), 101: entry('bbbb', { control: undefined }) });
  const client = createOwnerClient({ registryDirs: [dir] });
  assert.equal((await client.find('aaaa')).pid, process.pid);
  assert.equal(await client.find('bbbb'), null, 'an entry with no control block cannot be reached');
  assert.equal(await client.find('zzzz'), null);
});

test('an entry whose CLI process is gone is not an owner', async () => {
  const dir = registry({ 100: entry('aaaa', { pid: 2147480000 }) });
  assert.equal(await createOwnerClient({ registryDirs: [dir] }).find('aaaa'), null);
});

test('control posts the action to the backend with the token header and reports its answer', async () => {
  let seen;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { url: req.url, method: req.method, token: req.headers['x-ccg-token'], body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const owner = { pid: 1, control: { port: server.address().port, token: 'secret' } };
    const answer = await createOwnerClient({}).control(owner, { sessionId: 'aaaa', action: 'interrupt' });
    assert.deepEqual(answer, { ok: true });
    assert.deepEqual(seen, { url: '/internal/session-control', method: 'POST', token: 'secret', body: { sessionId: 'aaaa', action: 'interrupt' } });
  } finally { server.close(); }
});

test('control turns an error answer into a readable error', async () => {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"This backend holds no process for that session"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(createOwnerClient({}).control({ control: { port: server.address().port, token: 't' } }, { sessionId: 'a', action: 'interrupt' }), /holds no process/);
  } finally { server.close(); }
});

// The session tools use the owner client for sessions another program has running.
function setup(live, owners) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const id of ['aaaa', 'cccc']) fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: `p ${id}` } }) + '\n');
  const calls = [];
  const runtime = { listLive: async () => live, spawnDetached: async () => { throw new Error('must not spawn'); } };
  const ownerClient = { find: async (id) => owners[id] ?? null, control: async (owner, body) => { calls.push(body); return { ok: true }; } };
  const tools = Object.fromEntries(createSessionMgmtTools({ configDir, dataDir, selfSessionId: 'cccc', runtime, owners: ownerClient }).map((t) => [t.name, t.handler]));
  return { tools, calls };
}
const liveRow = (sessionId) => ({ pid: 4242, cwd: '/tmp/demo', kind: 'interactive', sessionId, name: sessionId, status: 'idle' });

test('send_message to a session a plugin backend holds goes through that backend', async () => {
  const { tools, calls } = setup([liveRow('aaaa')], { aaaa: { pid: 4242, control: { port: 1, token: 't' } } });
  const answer = await tools.send_message({ session_id: 'aaaa', message: 'hello' });
  assert.match(answer, /^delivered/);
  assert.equal(calls[0].action, 'send_message');
  assert.equal(calls[0].sessionId, 'aaaa');
  assert.match(calls[0].text, /^From .*:\nhello$/);
});

test('stop_session on such a session interrupts it through that backend', async () => {
  const { tools, calls } = setup([liveRow('aaaa')], { aaaa: { pid: 4242, control: {} } });
  assert.match(await tools.stop_session({ session_id: 'aaaa' }), /interrupt/i);
  assert.deepEqual(calls, [{ sessionId: 'aaaa', action: 'interrupt' }]);
});

test('model and permission mode reach the running CLI through that backend and are also saved; effort is saved only', async () => {
  const { tools, calls } = setup([liveRow('aaaa')], { aaaa: { pid: 4242, control: {} } });
  assert.match(await tools.set_session_model({ session_id: 'aaaa', model: 'opus' }), /running/);
  await tools.set_session_permission_mode({ session_id: 'aaaa', mode: 'plan' });
  const effort = await tools.set_session_effort({ session_id: 'aaaa', effort: 'high' });
  assert.deepEqual(calls.map((c) => c.action), ['set_model', 'set_permission_mode']);
  assert.match(effort, /next start/);
});

test('a live session with no reachable owner still says another program holds it', async () => {
  const { tools, calls } = setup([liveRow('aaaa')], {});
  await assert.rejects(tools.send_message({ session_id: 'aaaa', message: 'hi' }), /another program/);
  await assert.rejects(tools.stop_session({ session_id: 'aaaa' }), /unavailable/);
  assert.equal(calls.length, 0);
});
