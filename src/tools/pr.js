// The pr area, through the GitHub CLI (`gh`), the same tool a terminal user would run.

import { notYet, markOf, sessionFolder } from './common.js';
import { resolveContext, resolveSessionId } from './context.js';

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/;
const FIELDS = 'number,url,state,baseRefName,headRefName,reviewDecision,mergeable,isDraft,statusCheckRollup';
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function summarizeChecks(rollup = []) {
  const failing = [];
  let passing = 0;
  let pending = 0;
  for (const check of rollup) {
    const result = check.conclusion || check.state;
    if (PASSING.has(result)) passing++;
    else if (FAILING.has(result)) failing.push(check.name || check.context || 'check');
    else pending++;
  }
  return { total: rollup.length, passing, failing, pending };
}

function requirePrUrl(url) {
  if (typeof url !== 'string' || !PR_URL.test(url)) throw new Error('url must be a github.com pull request URL such as https://github.com/owner/repo/pull/123');
  return url;
}

export function createPrTools(options = {}) {
  const ctx = resolveContext(options);
  const { store, runtime } = ctx;

  return [
    {
      name: 'get_status',
      description: 'Read the pull request bound to a session ("self" by default), through gh: number, state, branches, review decision, mergeability and a summary of the checks.',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string', description: 'A sessionId or "self" (default).' } } },
      handler: async ({ session_id = 'self' } = {}) => {
        const sessionId = resolveSessionId(ctx, session_id);
        const mark = markOf(ctx, sessionId);
        const none = { bound: false, message: 'No pull request is bound to this session. Bind one with bind_pr, or push a branch that has an open pull request.', monitor: { auto_archive_on_close: false } };
        if (mark.prDismissed && !mark.prUrl) return none;
        const args = ['pr', 'view', ...(mark.prUrl ? [mark.prUrl] : []), '--json', FIELDS];
        const res = await runtime.exec('gh', args, { cwd: sessionFolder(ctx, sessionId) });
        if (res.code !== 0) {
          if (/no pull requests? found/i.test(res.stderr)) return none;
          throw new Error(`gh pr view failed: ${res.stderr.trim()}`);
        }
        const pr = JSON.parse(res.stdout);
        return {
          bound: true, url: pr.url, number: pr.number, state: pr.state, base: pr.baseRefName, head: pr.headRefName, draft: pr.isDraft,
          review_decision: pr.reviewDecision, mergeable: pr.mergeable, checks: summarizeChecks(pr.statusCheckRollup),
          monitor: { auto_archive_on_close: false },
        };
      },
    },
    {
      name: 'bind_pr',
      description: 'Bind the calling session to a pull request by its URL, for a pull request that was not picked up on its own. Restores one that was dismissed.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'https://github.com/owner/repo/pull/123' } }, required: ['url'] },
      handler: async ({ url }) => {
        requirePrUrl(url);
        const mark = markOf(ctx, resolveSessionId(ctx, 'self'));
        mark.prUrl = url;
        mark.prDismissed = false;
        store.marks.save(mark);
        return `Bound ${url} to this session.`;
      },
    },
    {
      name: 'unbind_pr',
      description: 'Dismiss the bound pull request from this session; bind_pr restores it.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      handler: async ({ url }) => {
        requirePrUrl(url);
        const mark = markOf(ctx, resolveSessionId(ctx, 'self'));
        mark.prUrl = null;
        mark.prDismissed = true;
        store.marks.save(mark);
        return `Dismissed ${url} from this session.`;
      },
    },
    {
      name: 'set_auto_merge',
      description: 'Enable or disable GitHub auto-merge on a pull request (github.com only). Enabling lands code without another look: only call it when the user asked for auto-merge.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' }, url: { type: 'string' }, merge_method: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'How GitHub merges when enabling. Default squash.' } },
        required: ['enabled', 'url'],
      },
      handler: async ({ enabled, url, merge_method = 'squash' }) => {
        requirePrUrl(url);
        if (!['squash', 'merge', 'rebase'].includes(merge_method)) throw new Error('merge_method must be one of: squash, merge, rebase');
        const args = enabled ? ['pr', 'merge', url, '--auto', `--${merge_method}`] : ['pr', 'merge', url, '--disable-auto'];
        const res = await runtime.exec('gh', args, { cwd: sessionFolder(ctx) });
        if (res.code !== 0) throw new Error(`gh pr merge failed: ${(res.stderr || res.stdout).trim()}`);
        return enabled ? `Auto-merge enabled (${merge_method}) on ${url}.` : `Auto-merge disabled on ${url}.`;
      },
    },
    notYet('set_monitor', { auto_fix: { type: 'boolean' }, auto_archive_on_close: { type: 'boolean' }, address_comments: { type: 'boolean' }, url: { type: 'string' } }, [], 'Watch the session\'s pull request and wake the session on CI failures, conflicts and review comments.', 'watching a pull request needs a program that keeps running, and this server only runs while a session calls it'),
  ];
}
