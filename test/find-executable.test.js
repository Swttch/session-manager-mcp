import test from 'node:test';
import assert from 'node:assert/strict';
import { findExecutable, quoteForCmd } from '../src/cli-runtime.js';

const exists = (files) => (p) => files.includes(p);

test('on POSIX a program is the first PATH entry that holds an executable of that name', () => {
  const found = findExecutable('code', { platform: 'darwin', pathEnv: '/a:/b', exists: exists(['/b/code']) });
  assert.equal(found, '/b/code');
  assert.equal(findExecutable('code', { platform: 'darwin', pathEnv: '/a:/b', exists: exists([]) }), null);
});

test('on Windows a program is looked for with the extensions the system runs, .exe before .cmd', () => {
  const env = { platform: 'win32', pathEnv: 'C:\\bin;D:\\tools', pathExt: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(findExecutable('code', { ...env, exists: exists(['D:\\tools\\code.cmd']) }), 'D:\\tools\\code.cmd');
  assert.equal(findExecutable('git', { ...env, exists: exists(['C:\\bin\\git.exe', 'D:\\tools\\git.cmd']) }), 'C:\\bin\\git.exe');
  assert.equal(findExecutable('claude', { ...env, exists: exists([]) }), null);
});

test('a name that already carries an extension is tried as it is on Windows', () => {
  assert.equal(findExecutable('code.cmd', { platform: 'win32', pathEnv: 'C:\\bin', pathExt: '.EXE;.CMD', exists: exists(['C:\\bin\\code.cmd']) }), 'C:\\bin\\code.cmd');
});

test('an argument for cmd.exe is wrapped in quotes with inner quotes doubled', () => {
  assert.equal(quoteForCmd('C:\\a b\\c.txt'), '"C:\\a b\\c.txt"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});

test('running a program that does not exist reports it by name in plain words instead of an operating-system message', async () => {
  const { createCliRuntime } = await import('../src/cli-runtime.js');
  const res = await createCliRuntime().exec('definitely-not-a-program-xyz', []);
  assert.equal(res.code, 127);
  assert.match(res.stderr, /definitely-not-a-program-xyz/);
});
