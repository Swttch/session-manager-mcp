import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsTools } from '../src/tools/settings.js';
import { createDirectoryTools } from '../src/tools/directory.js';
import { createConnectorsTools } from '../src/tools/connectors.js';
import { createTurnTools } from '../src/tools/turn.js';
import { openStore } from '../src/store/entities.js';
import { makeEnv } from './helpers.js';

const planOf = (env) => openStore({ dataDir: env.dataDir }).plans.find('cccc');

test('get_settings lists the thirteen preferences with value, allowed values and what each does', async () => {
  const out = await makeEnv().tools(createSettingsTools).get_settings({});
  assert.equal(out.settings.length, 13);
  const branch = out.settings.find((s) => s.key === 'branch_prefix');
  assert.equal(branch.value, 'swttch');
  assert.equal(branch.settable, true);
  assert.ok(branch.meaning && branch.allowed);
  assert.ok(out.read_only.some((r) => r.name === 'worktree_location'));
});

test('set_setting changes one value, persists it, and refuses wrong or unchanged values', async () => {
  const env = makeEnv();
  const settings = env.tools(createSettingsTools);
  assert.match(await settings.set_setting({ key: 'auto_archive_on_pr_close', value: true }), /true/);
  const again = env.tools(createSettingsTools);
  assert.equal((await again.get_settings({})).settings.find((s) => s.key === 'auto_archive_on_pr_close').value, true);
  await assert.rejects(settings.set_setting({ key: 'auto_archive_on_pr_close', value: true }), /already/);
  await assert.rejects(settings.set_setting({ key: 'auto_archive_inactive_days', value: 999 }), /365/);
  await assert.rejects(settings.set_setting({ key: 'notification_sound', value: 'loud' }), /system|none/);
  await assert.rejects(settings.set_setting({ key: 'branch_prefix', value: 'main' }), /protected|prefix/i);
  await assert.rejects(settings.set_setting({ key: 'nope', value: 1 }), /nope/);
});

test('directory tools answer unavailable: a session\'s folder is fixed once it starts, and no folder picker exists here', async () => {
  const dir = makeEnv().tools(createDirectoryTools);
  await assert.rejects(dir.change_directory({ path: '/tmp' }), /^Error: unavailable: /);
  await assert.rejects(dir.request_directory({}), /^Error: unavailable: /);
});

test('session_connectors_status lists the MCP servers `claude mcp list` reports with their state', async () => {
  const listing = 'Checking MCP server health...\n\nplaywright: npx @playwright/mcp - ✓ Connected\nslack: node slack.js - ✗ Failed to connect\nnotion: https://mcp.notion.com/mcp (HTTP) - ⚠ Needs authentication\n';
  const env = makeEnv({ exec: async () => ({ code: 0, stdout: listing, stderr: '' }) });
  const out = await env.tools(createConnectorsTools).session_connectors_status({});
  assert.deepEqual(out.servers.map((s) => [s.name, s.status]), [['playwright', 'connected'], ['slack', 'failed'], ['notion', 'needs_auth']]);
  assert.deepEqual(env.calls.exec[0].args, ['mcp', 'list']);
});

test('connector reconnect and enable answer unavailable: they are per-session switches of the program that runs the session', async () => {
  const c = makeEnv().tools(createConnectorsTools);
  await assert.rejects(c.reconnect_session_connector({ server: 'slack' }), /^Error: unavailable: /);
  await assert.rejects(c.set_session_connector_enabled({ connector: 'slack', enabled: true }), /^Error: unavailable: /);
});

test('update_plan keeps the calling session\'s task list: whole replace, advance, and done/start', async () => {
  const env = makeEnv();
  const turn = env.tools(createTurnTools);
  const r1 = await turn.update_plan({ items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }], scope: 'first_task' });
  assert.match(r1, /3/);
  await turn.update_plan({ advance: true });
  assert.deepEqual(planOf(env).items.map((i) => i.status), ['completed', 'in_progress', 'pending']);
  await turn.update_plan({ done: [2], start: 3 });
  assert.deepEqual(planOf(env).items.map((i) => i.status), ['completed', 'completed', 'in_progress']);
  await assert.rejects(turn.update_plan({ items: [] }), /1/);
});

test('wrap_up stores the recap and the question for the session', async () => {
  const env = makeEnv();
  const turn = env.tools(createTurnTools);
  await assert.rejects(turn.wrap_up({}), /recap/);
  assert.match(await turn.wrap_up({ recap: 'Did the thing.', ask: 'Ship it?', actions: [{ label: 'Yes' }] }), /recap/i);
  const stored = planOf(env);
  assert.equal(stored.wrapUp.recap, 'Did the thing.');
  assert.equal(stored.wrapUp.ask, 'Ship it?');
});

const USAGE = { five_hour: { utilization: 11, resets_at: '2026-11-09T21:49:59+00:00' }, seven_day: { utilization: 28, resets_at: '2026-11-13T15:59:59+00:00' }, seven_day_opus: null, seven_day_sonnet: { utilization: 5, resets_at: '2026-11-13T15:59:59+00:00' } };
const usageTool = async (exec) => {
  const { createSessionMgmtTools } = await import('../src/tools/session-mgmt.js');
  const env = makeEnv({ exec });
  return { env, get_usage: env.tools(createSessionMgmtTools).get_usage };
};

test('get_usage reads the plan limits through swttch-ext and leaves the context window unavailable', async () => {
  const { env, get_usage } = await usageTool(async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: USAGE }), stderr: '' }));
  const out = await get_usage({ session_id: 'aaaa' });
  assert.deepEqual(env.calls.exec.map((c) => [c.cmd, c.args]), [['swttch-ext', ['api', 'oauth', 'usage']]]);
  assert.equal(out.plan.status, 'ok');
  assert.deepEqual(out.plan.windows.map((w) => [w.label, w.percentUsed]), [['5-hour limit', 11], ['Weekly · all models', 28], ['Weekly · Sonnet', 5]]);
  assert.equal(out.context.status, 'unavailable');
});

test('get_usage falls back to the old ccb command when the installed extend-kit has no swttch-ext usage call', async () => {
  const { env, get_usage } = await usageTool(async (cmd) => (cmd === 'swttch-ext'
    ? { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'unknown_operation', message: 'no such call' } }), stderr: '' }
    : { code: 0, stdout: JSON.stringify(USAGE), stderr: '' }));
  const out = await get_usage({});
  assert.deepEqual(env.calls.exec.map((c) => c.cmd), ['swttch-ext', 'ccb']);
  assert.deepEqual(env.calls.exec[1].args, ['oauth', 'usage', '--json']);
  assert.equal(out.plan.status, 'ok');
});

test('get_usage says the plan limits are unavailable, naming extend-kit, when neither command works', async () => {
  const { get_usage } = await usageTool(async (cmd) => ({ code: 127, stdout: '', stderr: `${cmd} was not found on PATH.` }));
  const out = await get_usage({});
  assert.equal(out.plan.status, 'unavailable');
  assert.match(out.plan.note, /swttch-ext/);
  assert.match(out.plan.note, /extend-kit/);
});

test('a refusal from the account service is reported with its message, not mistaken for a missing command', async () => {
  const { env, get_usage } = await usageTool(async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'token_expired', message: 'The saved login is no longer accepted.', hint: 'Run `claude` once to refresh it.' } }), stderr: '' }));
  const out = await get_usage({});
  assert.equal(out.plan.status, 'unavailable');
  assert.match(out.plan.note, /no longer accepted/);
  assert.equal(env.calls.exec.length, 1, 'ccb is not tried after a real answer from swttch-ext');
});
