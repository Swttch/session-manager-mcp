// The session area: starting sessions and discovering where they can start. Only local,
// fresh, user-requested starts exist so far; everything else answers "unavailable".

import { getCliSession, listCliSessions } from '../cli-sessions.js';
import { createProposal, dismissProposal, startProposal } from '../proposals.js';
import { launchSession } from '../launch.js';
import { EFFORTS, MIN_BACKGROUND, MODES } from '../launch.js';
import { notYet } from './common.js';
import { resolveContext } from './context.js';

export function createSessionTools(options = {}) {
  const ctx = resolveContext(options);
  const { configDir } = ctx;

  return [
    {
      name: 'start_session',
      description: 'Start a separate Claude Code session for a task while you stay with the user. Only a fresh local session started because the user asked ("user_asked") is supported; the brief is sent to the new session as its first message. The new session is linked to the calling session.',
      inputSchema: {
        type: 'object',
        properties: {
          initiation: { type: 'string', enum: ['user_asked', 'offer', 'own_initiative'], description: 'Only "user_asked" is supported.' },
          title: { type: 'string', description: 'Under 60 characters; names the task.' },
          prompt: { type: 'string', description: 'The brief: the task, the files or area, what done looks like.' },
          background: { type: 'string', description: `At least ${MIN_BACKGROUND} characters of overall goal, decisions and constraints, for someone who has not seen this conversation.` },
          context: { type: 'string', enum: ['fresh', 'fork'], description: 'Only "fresh" is supported.' },
          cwd: { type: 'string', description: 'The folder the session works in. Default: the calling session\'s folder.' },
          name: { type: 'string', description: 'Optional short handle ([a-z0-9-], at most 24).' },
          model: { type: 'string' },
          effort: { type: 'string', enum: EFFORTS },
          permission_mode: { type: 'string', enum: MODES },
          use_worktree: { type: 'boolean', description: 'true: work in a new git worktree on its own branch. false: share this folder. Omitted: a new worktree only when the calling session itself works in one.' },
          target: { type: 'string', enum: ['local', 'cloud', 'ssh'], description: 'Only "local" is supported.' },
          host: { type: 'string' },
          environment: { type: 'string' },
          repository: { type: 'string' },
          preset: { type: 'string' },
          proposal_id: { type: 'string' },
          branch_name: { type: 'string', description: 'A short slug for the new worktree\'s branch (the prefix setting and a suffix are added).' },
          source_branch: { type: 'string', description: 'The branch the new worktree is cut from. Default: the folder\'s current branch.' },
          wake_when_done: { type: 'boolean' },
        },
      },
      handler: async (args) => {
        if (args.proposal_id !== undefined) {
          const { proposal_id, initiation: _i, ...extra } = args;
          return startProposal(ctx, proposal_id, extra);
        }
        if (args.initiation === 'user_asked') return launchSession(ctx, args);
        if (args.initiation === 'own_initiative') {
          const proposal = createProposal(ctx, 'own_initiative', args);
          return { task_id: proposal.id, status: 'proposed', message: 'A card was added for the user. They start it by clicking it, or by telling you to; then call start_session again with just proposal_id. It lapses after seven days.' };
        }
        if (args.initiation === 'offer') {
          const proposal = createProposal(ctx, 'offer', args);
          return { task_id: proposal.id, status: 'offered', message: 'Waiting for the user to choose. If they choose a new session, call start_session with proposal_id and the brief (prompt, background).' };
        }
        throw new Error('initiation is required: "user_asked", "own_initiative" or "offer".');
      },
    },
    {
      name: 'list_start_targets',
      description: 'List where start_session can put a session: the folders sessions have run in on this computer. SSH hosts, cloud environments and presets are not supported.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const folders = [];
        for (const s of listCliSessions({ configDir, limit: 500 })) {
          if (s.cwd && !folders.includes(s.cwd)) folders.push(s.cwd);
        }
        return {
          thisComputer: { projectFolder: process.env.SWTTCH_CWD ?? null, recentFolders: folders, repositories: {} },
          ssh: [],
          cloud: { available: false, reason: 'not_supported' },
          presets: [],
        };
      },
    },
    notYet('hand_off_to_session', { title: { type: 'string' }, remaining_plan: { type: 'string' } }, ['title', 'remaining_plan'], 'Move the task in progress into its own session.', 'hand-off needs session forking, which is not built yet'),
    {
      name: 'dismiss_task',
      description: 'Withdraw a session proposal (made with start_session "own_initiative" or "offer") that the user has not started: it went stale, was done here after all, or you proposed a better one.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id'] },
      handler: async ({ task_id, reason }) => {
        dismissProposal(ctx, task_id, reason);
        return `Proposal ${task_id} dismissed.`;
      },
    },
    notYet('move_to_cloud', { summary: { type: 'string' } }, ['summary'], 'Continue this session as a cloud session.', 'cloud sessions are not supported'),
    notYet('mark_chapter', { title: { type: 'string' }, summary: { type: 'string' } }, ['title'], 'Mark the start of a new chapter in this session.', 'chapters need a screen that draws them'),
    notYet('read_widget_context', { tool_name: { type: 'string' } }, ['tool_name'], 'Read context from an embedded interactive widget.', 'there are no widgets'),
  ];
}
