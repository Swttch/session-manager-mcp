// Suggested sessions waiting for the user. A proposal is only data until someone starts it.

import { randomUUID } from 'node:crypto';
import { StartProposal } from './store/entities.js';
import { launchSession, rejectUnsupported, validateBrief, validateTitle } from './launch.js';

export function listProposals(ctx) {
  return ctx.store.proposals.all();
}

export function createProposal(ctx, initiation, args) {
  rejectUnsupported(args);
  if (initiation === 'own_initiative') validateBrief(args); else validateTitle(args);
  const { initiation: _ignored, proposal_id: _also, ...brief } = args;
  const proposal = new StartProposal({ id: `task_${randomUUID().slice(0, 8)}`, initiation, title: args.title, brief, requestedBy: ctx.selfSessionId ?? null });
  ctx.store.proposals.save(proposal);
  return proposal;
}

function load(ctx, id) {
  const proposal = ctx.store.proposals.find(id);
  if (!proposal) throw new Error(`No proposal with id: ${id}`);
  return proposal;
}

export async function startProposal(ctx, id, extra = {}) {
  const proposal = load(ctx, id);
  if (proposal.state === 'started') throw new Error(`Proposal ${id} was already started.`);
  if (proposal.state === 'dismissed') throw new Error(`Proposal ${id} was dismissed.`);
  if (proposal.expiresAt < Date.now()) throw new Error(`Proposal ${id} expired; propose it again.`);
  const started = await launchSession(ctx, { ...proposal.brief, ...extra }, { parentSessionId: proposal.requestedBy });
  proposal.state = 'started';
  proposal.sessionId = started.session_id;
  ctx.store.proposals.save(proposal);
  return started;
}

export function dismissProposal(ctx, id, reason) {
  const proposal = load(ctx, id);
  if (proposal.state === 'started') throw new Error(`Proposal ${id} was already started and cannot be dismissed.`);
  proposal.state = 'dismissed';
  proposal.dismissReason = reason ?? null;
  ctx.store.proposals.save(proposal);
  return proposal;
}
