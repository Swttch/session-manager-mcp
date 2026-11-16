import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';

// A session's name lives where the CLI keeps it (the transcript's custom-title entry), so every
// client that lists sessions shows it. set_session_title never writes that file itself: it asks the
// program that holds the session, or asks the CLI. The CLI is asked quietly first (a request that records the
// name and adds nothing to the conversation), and with the CLI's own /rename when it does not answer that.

// quiet: how the CLI treats the quiet request: 'answers' it, is 'unknown' to it (exits without an answer),
// 'refuses' it with an error answer, or knows it only 'without-flags' (older CLI that refuses --restricted).
function setup({ self = 'cccc', holder = null, live = [], reply = (name) => `Session renamed to: ${name}\n`, holderKnowsRename = true, quiet = 'answers' } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-cfg-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swttch-data-'));
  const proj = path.join(configDir, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  const file = (id) => path.join(proj, `${id}.jsonl`);
  for (const id of ['aaaa', 'cccc']) {
    fs.writeFileSync(file(id), [
      JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: '/tmp/demo', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: `prompt ${id}` } }),
      JSON.stringify({ type: 'custom-title', customTitle: `Old ${id}`, sessionId: id }),
    ].join('\n') + '\n');
  }
  const ran = [];
  const quietRan = [];
  const asked = [];
  // The quiet request: the CLI records the name as a custom-title entry and says so on its output.
  const runClaudeUntil = async (args, options) => {
    quietRan.push({ args, ...options });
    const request = JSON.parse(options.input);
    const id = args[args.indexOf('--resume') + 1];
    const respond = (response) => options.until(JSON.stringify({ type: 'control_response', response: { request_id: request.request_id, ...response } }));
    if (quiet === 'unknown' || (quiet === 'without-flags' && args.includes('--restricted'))) return { code: 1, stdout: '', stderr: 'error: unknown option', matched: null };
    if (quiet === 'refuses') return { code: 0, stdout: '', stderr: '', matched: respond({ subtype: 'error', error: 'Unknown control request subtype: rename_session' }) };
    fs.appendFileSync(file(id), JSON.stringify({ type: 'custom-title', customTitle: request.request.title, sessionId: id }) + '\n');
    return { code: 0, stdout: '', stderr: '', matched: respond({ subtype: 'success' }) };
  };
  // What the CLI does with /rename: it writes the name into the transcript and says so.
  const runClaude = async (args, options) => {
    ran.push({ args, ...options });
    const id = args[args.indexOf('--resume') + 1];
    const name = options.input.replace(/^\/rename /, '').trim();
    const out = reply(name, args);
    if (out.startsWith('Session renamed to:')) fs.appendFileSync(file(id), JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: id }) + '\n');
    return { code: 0, stdout: out, stderr: '' };
  };
  const runtime = { listLive: async () => live, spawnDetached: async () => {}, runClaude, runClaudeUntil };
  const owners = {
    find: async (sessionId) => (holder && holder.sessions.includes(sessionId) ? { pid: 4242, control: { port: 1, token: 't' } } : null),
    control: async (owner, body) => {
      asked.push(body);
      if (body.action === 'rename' && !holderKnowsRename) throw new Error('Unknown action: rename');
      return { ok: true };
    },
  };
  const ctx = { configDir, dataDir, selfSessionId: self, runtime, owners };
  const mgmt = Object.fromEntries(createSessionMgmtTools(ctx).map((t) => [t.name, t.handler]));
  return { mgmt, ran, quietRan, asked, file };
}

test('a session nobody is running is renamed by a quiet request: the name is recorded and the conversation gains nothing', async () => {
  const { mgmt, ran, quietRan, asked, file } = setup();
  const before = fs.readFileSync(file('aaaa'), 'utf8').split('\n').length;
  const answer = await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(asked.length, 0);
  assert.equal(ran.length, 0, '/rename is not run');
  assert.equal(quietRan.length, 1);
  assert.deepEqual(quietRan[0].args, ['-p', '--resume', 'aaaa', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config']);
  const request = JSON.parse(quietRan[0].input);
  assert.equal(request.type, 'control_request');
  assert.deepEqual(request.request, { subtype: 'rename_session', title: 'Billing refactor', source: 'host', session_id: 'aaaa' });
  assert.equal(path.resolve(quietRan[0].cwd), path.resolve('/tmp/demo'));
  const text = fs.readFileSync(file('aaaa'), 'utf8');
  assert.equal(text.includes('Session renamed to'), false);
  assert.equal(text.includes('/rename'), false);
  assert.equal(text.split('\n').length, before + 1, 'only the custom-title entry was added');
  assert.match(answer, /Billing refactor/);
});

test('a CLI that does not know the quiet request is renamed with its own /rename, started as lightly as it allows', async () => {
  const { mgmt, ran, quietRan, asked } = setup({ quiet: 'unknown' });
  assert.ok(quietRan.length === 0);
  const answer = await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(quietRan.length, 2, 'the quiet request was tried, with the light flags and without them');
  assert.equal(asked.length, 0);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].args, ['-p', '--resume', 'aaaa', '--output-format', 'text', '--restricted', '--strict-mcp-config']);
  assert.equal(ran[0].input, '/rename Billing refactor\n', 'the name goes in on stdin, so it needs no quoting');
  assert.equal(path.resolve(ran[0].cwd), path.resolve('/tmp/demo'), 'in the folder the session runs in, where the CLI finds it');
  assert.match(answer, /Billing refactor/);
});

test('a CLI that answers the quiet request with an error falls back to /rename without asking again', async () => {
  const { mgmt, ran, quietRan } = setup({ quiet: 'refuses' });
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(quietRan.length, 1, 'the CLI\'s own refusal is final');
  assert.equal(ran.length, 1);
});

test('a CLI too old for the light start is asked the quiet request again without the flags', async () => {
  const { mgmt, ran, quietRan } = setup({ quiet: 'without-flags' });
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(quietRan.length, 2);
  assert.equal(quietRan[1].args.includes('--restricted'), false);
  assert.equal(ran.length, 0, 'no fallback was needed');
});

test('the new name is the one every client reads: list_sessions shows it from the transcript', async () => {
  const { mgmt } = setup();
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  const rows = await mgmt.list_sessions({});
  assert.equal(rows.find((r) => r.sessionId === 'aaaa').title, 'Billing refactor');
});

test('a session a Swttch program holds is renamed by that program, not by a second CLI beside it', async () => {
  const { mgmt, ran, asked } = setup({ holder: { sessions: ['aaaa'] } });
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.deepEqual(asked, [{ sessionId: 'aaaa', action: 'rename', title: 'Billing refactor' }]);
  assert.equal(ran.length, 0);
});

test('the calling session renames itself the same way, through the program that holds it', async () => {
  const { mgmt, asked } = setup({ holder: { sessions: ['cccc'] } });
  await mgmt.set_session_title({ session_id: 'self', title: 'Manager' });
  assert.deepEqual(asked, [{ sessionId: 'cccc', action: 'rename', title: 'Manager' }]);
});

test('a holding program too old to know the request is not a dead end: the CLI\'s /rename is run instead', async () => {
  const { mgmt, ran } = setup({ holder: { sessions: ['aaaa'] }, holderKnowsRename: false, quiet: 'unknown' });
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(ran.length, 1);
});

test('a CLI too old for the light start is asked again without it', async () => {
  const { mgmt, ran } = setup({ quiet: 'unknown', reply: (name, args) => (args.includes('--restricted') ? 'error: unknown option --restricted\n' : `Session renamed to: ${name}\n`) });
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(ran.length, 2);
  assert.deepEqual(ran[1].args, ['-p', '--resume', 'aaaa', '--output-format', 'text']);
});

test('a rename the CLI did not confirm is an error that carries the CLI\'s own words', async () => {
  const { mgmt } = setup({ quiet: 'unknown', reply: () => '/rename isn\'t available in this environment.\n' });
  await assert.rejects(mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' }), /isn't available in this environment/);
});

test('a session running in a program that cannot be asked is still renamed, and the answer says the name may be written back', async () => {
  const { mgmt, ran } = setup({ quiet: 'unknown', live: [{ pid: 9, cwd: '/tmp/demo', kind: 'interactive', sessionId: 'aaaa', name: 'aaaa', status: 'idle' }] });
  const answer = await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(ran.length, 1);
  assert.match(answer, /may write (its own|that) name back/);
});

test('the name is kept as the CLI keeps it: one line, at most 200 characters, and never empty', async () => {
  const { mgmt, ran, quietRan } = setup({ quiet: 'unknown' });
  await mgmt.set_session_title({ session_id: 'aaaa', title: '  two\nlines  ' });
  assert.equal(ran[0].input, '/rename two lines\n');
  assert.equal(JSON.parse(quietRan[0].input).request.title, 'two lines');
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'x'.repeat(300) });
  assert.equal(ran[1].input, `/rename ${'x'.repeat(200)}\n`);
  await assert.rejects(mgmt.set_session_title({ session_id: 'aaaa', title: '   ' }), /empty/);
});

test('a session that does not exist is an error, and nothing is run', async () => {
  const { mgmt, ran, quietRan } = setup();
  await assert.rejects(mgmt.set_session_title({ session_id: 'zzzz', title: 'Name' }));
  assert.equal(ran.length + quietRan.length, 0);
});

test('the runtime keeps stdin open until the answer line is seen, then closes it so the program ends', async () => {
  const { createCliRuntime } = await import('../src/cli-runtime.js');
  const runtime = createCliRuntime({ claudeBin: process.execPath });
  // Answers the first input line, then waits for its input to close before it exits, as the CLI does.
  const program = "process.stdin.once('data', (d) => { console.log(JSON.stringify({ echo: d.toString().trim() })); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); });";
  const result = await runtime.runClaudeUntil(['-e', program], { input: 'hello\n', timeoutMs: 10000, until: (line) => (JSON.parse(line).echo === 'hello' ? { ok: true } : null) });
  assert.deepEqual(result.matched, { ok: true });
  assert.equal(result.code, 0, 'the program ended because its input was closed, not because it was killed');
});

test('the runtime reports no match, with the program\'s own words, when it ends before answering', async () => {
  const { createCliRuntime } = await import('../src/cli-runtime.js');
  const runtime = createCliRuntime({ claudeBin: process.execPath });
  const result = await runtime.runClaudeUntil(['-e', "console.error('unknown option'); process.exit(1)"], { input: 'x\n', timeoutMs: 10000, until: () => ({ ok: true }) });
  assert.equal(result.matched, null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown option/);
});
