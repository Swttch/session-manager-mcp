import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrTools } from '../src/tools/pr.js';
import { makeEnv } from './helpers.js';

const prJson = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', baseRefName: 'main', headRefName: 'feat', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false,
  statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' }, { name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED' }, { name: 'e2e', status: 'IN_PROGRESS' }] };

test('get_status reads the pull request of the session\'s branch through gh and summarises the checks', async () => {
  const { tools, calls } = makeEnv({ exec: async () => ({ code: 0, stdout: JSON.stringify(prJson), stderr: '' }) });
  const status = await tools(createPrTools).get_status({});
  assert.equal(calls.exec[0].cmd, 'gh');
  assert.deepEqual(calls.exec[0].args.slice(0, 2), ['pr', 'view']);
  assert.equal(calls.exec[0].cwd, '/tmp/demo');
  assert.equal(status.bound, true);
  assert.equal(status.number, 7);
  assert.equal(status.review_decision, 'APPROVED');
  assert.deepEqual(status.checks, { total: 3, passing: 1, failing: ['lint'], pending: 1 });
});

test('get_status says no pull request is bound when gh finds none', async () => {
  const { tools } = makeEnv({ exec: async () => ({ code: 1, stdout: '', stderr: 'no pull requests found for branch "x"' }) });
  const status = await tools(createPrTools).get_status({});
  assert.equal(status.bound, false);
  assert.match(status.message, /no pull request/i);
});

test('bind_pr remembers the pull request for the session and get_status asks gh for exactly that one; unbind_pr dismisses it', async () => {
  const { tools, calls } = makeEnv({ exec: async () => ({ code: 0, stdout: JSON.stringify(prJson), stderr: '' }) });
  const pr = tools(createPrTools);
  await assert.rejects(pr.bind_pr({ url: 'https://example.com/x' }), /github/i);
  await pr.bind_pr({ url: 'https://github.com/o/r/pull/7' });
  await pr.get_status({});
  assert.ok(calls.exec.at(-1).args.includes('https://github.com/o/r/pull/7'));
  await pr.unbind_pr({ url: 'https://github.com/o/r/pull/7' });
  assert.equal((await pr.get_status({})).bound, false);
});

test('set_auto_merge enables or disables GitHub auto-merge through gh', async () => {
  const { tools, calls } = makeEnv();
  const pr = tools(createPrTools);
  await pr.set_auto_merge({ enabled: true, url: 'https://github.com/o/r/pull/7', merge_method: 'rebase' });
  assert.deepEqual(calls.exec[0].args, ['pr', 'merge', 'https://github.com/o/r/pull/7', '--auto', '--rebase']);
  await pr.set_auto_merge({ enabled: false, url: 'https://github.com/o/r/pull/7' });
  assert.deepEqual(calls.exec[1].args, ['pr', 'merge', 'https://github.com/o/r/pull/7', '--disable-auto']);
  await assert.rejects(pr.set_auto_merge({ enabled: true, url: 'https://github.com/o/r/pull/7', merge_method: 'fast' }), /merge_method/);
});

test('gh failing to merge is surfaced as the tool error', async () => {
  const { tools } = makeEnv({ exec: async () => ({ code: 1, stdout: '', stderr: 'auto-merge is not allowed for this repository' }) });
  await assert.rejects(tools(createPrTools).set_auto_merge({ enabled: true, url: 'https://github.com/o/r/pull/7' }), /not allowed/);
});

test('set_monitor answers unavailable: watching a pull request needs a program that keeps running', async () => {
  await assert.rejects(makeEnv().tools(createPrTools).set_monitor({ auto_fix: true, url: 'https://github.com/o/r/pull/7' }), /^Error: unavailable: /);
});
