import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTools } from '../src/tools/session.js';
import { startProposal, dismissProposal, listProposals } from '../src/proposals.js';
import { resolveContext } from '../src/tools/context.js';
import { makeEnv } from './helpers.js';

const BG = 'The overall goal and decisions so far, long enough to pass the minimum length of eighty characters.';
const brief = (extra = {}) => ({ title: 'Fix the bug', prompt: 'Fix X', background: BG, cwd: '/tmp/demo', ...extra });

function setup() {
  const env = makeEnv();
  const spawned = [];
  env.ctx.runtime.spawnDetached = async (args, cwd) => { spawned.push({ args, cwd }); };
  return { env, spawned, session: env.tools(createSessionTools) };
}

test('own_initiative stores a proposal and starts nothing; the answer tells how the user starts it', async () => {
  const { session, spawned, env } = setup();
  const out = await session.start_session({ initiation: 'own_initiative', ...brief() });
  assert.ok(out.task_id);
  assert.equal(out.status, 'proposed');
  assert.equal(spawned.length, 0);
  const rows = listProposals(resolveContext(env.ctx));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'pending');
  assert.ok(rows[0].expiresAt - rows[0].createdAt >= 7 * 24 * 3600 * 1000 - 1000);
});

test('start_session with just the proposal_id starts it exactly as proposed', async () => {
  const { session, spawned } = setup();
  const { task_id } = await session.start_session({ initiation: 'own_initiative', ...brief() });
  const out = await session.start_session({ proposal_id: task_id });
  assert.ok(out.session_id);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args[spawned[0].args.length - 1].includes('Task:\nFix X'));
  await assert.rejects(session.start_session({ proposal_id: task_id }), /already/);
});

test('an offer is only a title until the user chooses: the brief arrives with the proposal_id', async () => {
  const { session, spawned } = setup();
  const offer = await session.start_session({ initiation: 'offer', title: 'Do the thing' });
  assert.equal(offer.status, 'offered');
  assert.equal(spawned.length, 0);
  await assert.rejects(session.start_session({ proposal_id: offer.task_id }), /prompt/);
  const out = await session.start_session({ proposal_id: offer.task_id, prompt: 'Do it', background: BG, cwd: '/tmp/demo' });
  assert.ok(out.session_id);
  assert.equal(spawned.length, 1);
});

test('dismiss_task withdraws a pending proposal, and a started or unknown one cannot be dismissed', async () => {
  const { session, spawned } = setup();
  const a = await session.start_session({ initiation: 'own_initiative', ...brief() });
  assert.match(await session.dismiss_task({ task_id: a.task_id, reason: 'done here' }), /dismissed/i);
  await assert.rejects(session.start_session({ proposal_id: a.task_id }), /dismissed/);
  const b = await session.start_session({ initiation: 'own_initiative', ...brief() });
  await session.start_session({ proposal_id: b.task_id });
  await assert.rejects(session.dismiss_task({ task_id: b.task_id }), /started/);
  await assert.rejects(session.dismiss_task({ task_id: 'nope' }), /nope/);
  assert.equal(spawned.length, 1);
});

test('an expired proposal cannot be started', async () => {
  const { session, env } = setup();
  const { task_id } = await session.start_session({ initiation: 'own_initiative', ...brief() });
  const ctx = resolveContext(env.ctx);
  const row = ctx.store.proposals.find(task_id);
  row.expiresAt = Date.now() - 1;
  ctx.store.proposals.save(row);
  await assert.rejects(session.start_session({ proposal_id: task_id }), /expired/);
});

test('the same start function serves a card the user clicks in the desktop', async () => {
  const { session, spawned, env } = setup();
  const { task_id } = await session.start_session({ initiation: 'own_initiative', ...brief() });
  const ctx = resolveContext(env.ctx);
  const out = await startProposal(ctx, task_id);
  assert.ok(out.session_id);
  assert.equal(spawned.length, 1);
  const again = setup();
  const second = await again.session.start_session({ initiation: 'own_initiative', ...brief() });
  assert.equal((await dismissProposal(resolveContext(again.env.ctx), second.task_id)).state, 'dismissed');
});
