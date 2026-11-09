// The turn area: the calling session's task list and end-of-turn recap. They are recorded in the
// session_plans table so a screen that mirrors it can draw them; this server draws nothing itself.

import { resolveContext, resolveSessionId } from './context.js';
import { SessionPlan } from '../store/entities.js';

const STATUSES = ['pending', 'in_progress', 'completed'];

export function createTurnTools(options = {}) {
  const ctx = resolveContext(options);
  const planOf = () => {
    const id = resolveSessionId(ctx, 'self');
    return ctx.store.plans.find(id) ?? new SessionPlan({ sessionUid: id });
  };
  const save = (plan) => { plan.updatedAt = Date.now(); ctx.store.plans.save(plan); };

  return [
    {
      name: 'update_plan',
      description: 'Keep the task list shown for this session. Pass `items` (the whole plan, 1-12 steps) to replace it; afterwards pass {advance: true} to complete the step in progress and start the next, or {done: [2], start: 4} (1-based) to move steps out of order.',
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: STATUSES }, session: { type: 'string' } }, required: ['content', 'status'] } },
          scope: { type: 'string', enum: ['first_task', 'continuation', 'new_task'] },
          advance: { type: 'boolean' },
          done: { type: 'array', items: { type: 'number' } },
          start: { type: 'number' },
        },
      },
      handler: async ({ items, advance, done, start }) => {
        const plan = planOf();
        if (items !== undefined) {
          if (!Array.isArray(items) || items.length < 1 || items.length > 12) throw new Error('items must hold 1 to 12 steps.');
          for (const item of items) {
            if (typeof item?.content !== 'string' || !STATUSES.includes(item.status)) throw new Error('every step needs content and a status of pending, in_progress or completed.');
          }
          plan.items = items.map(({ content, status, session }) => ({ content, status, ...(session ? { session } : {}) }));
          save(plan);
          return `Plan shown (${items.length} steps).`;
        }
        if (plan.items.length === 0) throw new Error('There is no plan yet; pass items first.');
        if (advance) {
          const at = plan.items.findIndex((i) => i.status === 'in_progress');
          if (at !== -1) plan.items[at].status = 'completed';
          const next = plan.items.findIndex((i) => i.status === 'pending');
          if (next !== -1) plan.items[next].status = 'in_progress';
        }
        for (const n of done ?? []) if (plan.items[n - 1]) plan.items[n - 1].status = 'completed';
        if (start !== undefined && plan.items[start - 1]) plan.items[start - 1].status = 'in_progress';
        save(plan);
        const left = plan.items.filter((i) => i.status !== 'completed').length;
        return `Plan updated (${left} of ${plan.items.length} steps left).`;
      },
    },
    {
      name: 'wrap_up',
      description: 'Record the end-of-turn recap (two or three sentences: what is now true and where it stands) and, when the user must decide something, one short question with the buttons that answer it. Call it once when the turn\'s work is done, before the closing message.',
      inputSchema: {
        type: 'object',
        properties: {
          recap: { type: 'string' },
          ask: { type: 'string', description: 'One short question, the decision alone.' },
          actions: { type: 'array', items: { type: 'object' } },
          blocked: { type: 'boolean' },
        },
        required: ['recap'],
      },
      handler: async ({ recap, ask, actions, blocked }) => {
        if (typeof recap !== 'string' || recap.trim() === '') throw new Error('recap is required.');
        const plan = planOf();
        plan.wrapUp = { recap, ...(ask ? { ask } : {}), ...(actions ? { actions } : {}), ...(blocked ? { blocked: true } : {}) };
        save(plan);
        return 'Recorded the recap' + (ask ? ' and the question.' : '.');
      },
    },
  ];
}
