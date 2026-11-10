import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionMgmtTools } from '../src/tools/session-mgmt.js';

// A session's name lives where the CLI keeps it (the transcript's custom-title entry), so every
// client that lists sessions shows it. set_session_title never writes that file itself: it asks the
// program that holds the session, or runs the CLI's own /rename.

function setup({ self = 'cccc', holder = null, live = [], reply = (name) => `Session renamed to: ${name}\n`, holderKnowsRename = true } = {}) {
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
  const asked = [];
  // What the CLI does with /rename: it writes the name into the transcript and says so.
  const runClaude = async (args, options) => {
    ran.push({ args, ...options });
    const id = args[args.indexOf('--resume') + 1];
    const name = options.input.replace(/^\/rename /, '').trim();
    const out = reply(name, args);
    if (out.startsWith('Session renamed to:')) fs.appendFileSync(file(id), JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: id }) + '\n');
    return { code: 0, stdout: out, stderr: '' };
  };
  const runtime = { listLive: async () => live, spawnDetached: async () => {}, runClaude };
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
  return { mgmt, ran, asked };
}

test('a session nobody is running is renamed with the CLI\'s own /rename, started as lightly as the CLI allows', async () => {
  const { mgmt, ran, asked } = setup();
  const answer = await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(asked.length, 0);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].args, ['-p', '--resume', 'aaaa', '--output-format', 'text', '--restricted', '--strict-mcp-config']);
  assert.equal(ran[0].input, '/rename Billing refactor\n', 'the name goes in on stdin, so it needs no quoting');
  assert.equal(path.resolve(ran[0].cwd), path.resolve('/tmp/demo'), 'in the folder the session runs in, where the CLI finds it');
  assert.match(answer, /Billing refactor/);
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
  const { mgmt, ran } = setup({ holder: { sessions: ['aaaa'] }, holderKnowsRename: false });
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(ran.length, 1);
});

test('a CLI too old for the light start is asked again without it', async () => {
  const { mgmt, ran } = setup({ reply: (name, args) => (args.includes('--restricted') ? 'error: unknown option --restricted\n' : `Session renamed to: ${name}\n`) });
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(ran.length, 2);
  assert.deepEqual(ran[1].args, ['-p', '--resume', 'aaaa', '--output-format', 'text']);
});

test('a rename the CLI did not confirm is an error that carries the CLI\'s own words', async () => {
  const { mgmt } = setup({ reply: () => '/rename isn\'t available in this environment.\n' });
  await assert.rejects(mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' }), /isn't available in this environment/);
});

test('a session running in a program that cannot be asked is still renamed, and the answer says the name may be written back', async () => {
  const { mgmt, ran } = setup({ live: [{ pid: 9, cwd: '/tmp/demo', kind: 'interactive', sessionId: 'aaaa', name: 'aaaa', status: 'idle' }] });
  const answer = await mgmt.set_session_title({ session_id: 'aaaa', title: 'Billing refactor' });
  assert.equal(ran.length, 1);
  assert.match(answer, /may write (its own|that) name back/);
});

test('the name is kept as the CLI keeps it: one line, at most 200 characters, and never empty', async () => {
  const { mgmt, ran } = setup();
  await mgmt.set_session_title({ session_id: 'aaaa', title: '  two\nlines  ' });
  assert.equal(ran[0].input, '/rename two lines\n');
  await mgmt.set_session_title({ session_id: 'aaaa', title: 'x'.repeat(300) });
  assert.equal(ran[1].input, `/rename ${'x'.repeat(200)}\n`);
  await assert.rejects(mgmt.set_session_title({ session_id: 'aaaa', title: '   ' }), /empty/);
});

test('a session that does not exist is an error, and nothing is run', async () => {
  const { mgmt, ran } = setup();
  await assert.rejects(mgmt.set_session_title({ session_id: 'zzzz', title: 'Name' }));
  assert.equal(ran.length, 0);
});
