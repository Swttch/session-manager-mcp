import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';

const fakeRuntime = { listLive: async () => [], spawnDetached: async () => {} };
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-mcp-tools-'));
  const proj = path.join(dir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  const line = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(proj, 'aaaa.jsonl'), [
    line({ type: 'user', uuid: 'u1', sessionId: 'aaaa', cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'deploy the app' } }),
    line({ type: 'assistant', uuid: 'a1', sessionId: 'aaaa', timestamp: '2026-11-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done deploying' }] } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(proj, 'bbbb.jsonl'), line({ type: 'user', uuid: 'u2', sessionId: 'bbbb', cwd: '/tmp/demo', timestamp: '2026-11-02T00:00:00Z', message: { role: 'user', content: 'other work' } }) + '\n');
  return dir;
}

const byName = (tools, name) => tools.find((t) => t.name === name);

test('the area exposes the twenty session_mgmt tools of the reference, plus set_session_parent', () => {
  const tools = createSessionMgmtTools({ configDir: fixture(), dataDir: fixture(), runtime: fakeRuntime });
  assert.equal(tools.length, 21);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['archive_session', 'clear_session', 'delete_session', 'detach_session', 'export_transcript', 'get_session', 'get_usage', 'list_events', 'list_sessions', 'search_session_transcripts', 'send_message', 'set_remote_control', 'set_session_effort', 'set_session_fast_mode', 'set_session_model', 'set_session_output_style', 'set_session_parent', 'set_session_permission_mode', 'set_session_title', 'stop_session', 'unarchive_session'].sort());
  assert.deepEqual(byName(tools, 'get_session').inputSchema.required, ['session_id']);
  assert.deepEqual(byName(tools, 'search_session_transcripts').inputSchema.required, ['query']);
});

test('list_sessions returns the session rows and drops the calling session when it is known', async () => {
  const dir = fixture();
  const all = await byName(createSessionMgmtTools({ configDir: dir, dataDir: fixture(), runtime: fakeRuntime }), 'list_sessions').handler({});
  assert.equal(all.length, 2);
  assert.equal(all[0].isArchived, false);
  const others = await byName(createSessionMgmtTools({ configDir: dir, dataDir: fixture(), runtime: fakeRuntime, selfSessionId: 'bbbb' }), 'list_sessions').handler({});
  assert.deepEqual(others.map((s) => s.sessionId), ['aaaa']);
});

test('get_session accepts "self" through the calling session id', async () => {
  const tools = createSessionMgmtTools({ configDir: fixture(), dataDir: fixture(), runtime: fakeRuntime, selfSessionId: 'aaaa' });
  const session = await byName(tools, 'get_session').handler({ session_id: 'self' });
  assert.equal(session.sessionId, 'aaaa');
  assert.equal(session.title, 'deploy the app');
});

test('"self" without a known calling session is a readable error', async () => {
  const tools = createSessionMgmtTools({ configDir: fixture(), dataDir: fixture(), runtime: fakeRuntime });
  await assert.rejects(byName(tools, 'get_session').handler({ session_id: 'self' }), /calling session/);
});

test('list_events refuses the calling session, like the reference tool', async () => {
  const tools = createSessionMgmtTools({ configDir: fixture(), dataDir: fixture(), runtime: fakeRuntime, selfSessionId: 'aaaa' });
  await assert.rejects(byName(tools, 'list_events').handler({ session_id: 'aaaa' }), /current session/);
  const other = await byName(tools, 'list_events').handler({ session_id: 'bbbb' });
  assert.match(other, /other work/);
});

test('search_session_transcripts finds the session by content', async () => {
  const tools = createSessionMgmtTools({ configDir: fixture(), dataDir: fixture(), runtime: fakeRuntime });
  const hits = await byName(tools, 'search_session_transcripts').handler({ query: 'deploy' });
  assert.deepEqual(hits.map((h) => h.sessionId), ['aaaa']);
});

function rpc(child, message) {
  return new Promise((resolve) => {
    child.stdout.once('data', (chunk) => resolve(JSON.parse(chunk.toString().split('\n')[0])));
    child.stdin.write(JSON.stringify(message) + '\n');
  });
}

test('the stdio command serves tools/list and tools/call for one area over newline-delimited JSON', async () => {
  const dir = fixture();
  const child = spawn(process.execPath, [cliPath, '--area', 'session_mgmt'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CCG_HOME: fixture(), SWTTCH_CLAUDE_BIN: '/nonexistent/claude', SWTTCH_SESSION_ID: 'bbbb' } });
  try {
    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'swttch_session_mgmt');
    assert.equal(init.result.serverInfo.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'the server reports the version of the package that is running');
    const list = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.result.tools.some((t) => t.name === 'list_sessions'));
    const call = await rpc(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
    assert.deepEqual(JSON.parse(call.result.content[0].text).map((s) => s.sessionId), ['aaaa']);
  } finally {
    child.kill();
  }
});

test('an unknown area exits with an error instead of serving nothing', async () => {
  const child = spawn(process.execPath, [cliPath, '--area', 'nope']);
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.notEqual(code, 0);
});
