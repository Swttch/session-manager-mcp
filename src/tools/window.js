import { resolveContext, resolveSessionId } from './context.js';
import { uiHelpers } from './ui.js';

const TARGETS = ['split', 'window', 'focus'];

export function createWindowTools(options = {}) {
  const ctx = resolveContext(options);
  const ui = uiHelpers(ctx);
  return [
    {
      name: 'get_window_layout',
      description: 'Describe the desktop window right now: its split-view panes (where each sits, which session it shows, which is focused) and where the calling session is showing, if anywhere. Read-only.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { panes, this_session } = ui.describe();
        return { main_window: { tab: 'code', sidebar_collapsed: null, panes }, popout_windows: { sessions: [], other_windows: 0 }, this_session };
      },
    },
    {
      name: 'open_session_in',
      description: 'Show another session next to this one: "split" adds a split-view pane, "window" opens a pop-out window, "focus" shows it in the main pane. Only this session or a session this session started; for any other, ask the user to open it from the sidebar. Layout only: nothing is sent to that session. The change is queued for the desktop.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'A session id, or "self".' }, target: { type: 'string', enum: TARGETS } },
        required: ['session_id', 'target'],
      },
      handler: async ({ session_id, target }) => {
        if (!TARGETS.includes(target)) throw new Error(`target must be one of: ${TARGETS.join(', ')}`);
        const sessionId = resolveSessionId(ctx, session_id);
        const mark = ctx.store.marks.find(sessionId);
        if (sessionId !== ctx.selfSessionId && mark?.parentSessionUid !== ctx.selfSessionId) {
          throw new Error('Only this session or a session it started can be opened here; ask the user to open the other one from the sidebar.');
        }
        return ui.queue('open_session_in', { session_id: sessionId, target });
      },
    },
    {
      name: 'close_split',
      description: 'Close a split-view pane that you opened with open_session_in; never a pane the user arranged. The session keeps running. The change is queued for the desktop.',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string' } } },
      handler: async ({ session_id } = {}) => ui.queue('close_split', session_id ? { session_id: resolveSessionId(ctx, session_id) } : {}),
    },
    {
      name: 'set_sidebar_collapsed',
      description: 'Collapse (true) or expand (false) the desktop\'s sidebar. The change is queued for the desktop.',
      inputSchema: { type: 'object', properties: { collapsed: { type: 'boolean' } }, required: ['collapsed'] },
      handler: async ({ collapsed }) => {
        if (typeof collapsed !== 'boolean') throw new Error('collapsed must be true or false.');
        return ui.queue('set_sidebar_collapsed', { collapsed });
      },
    },
  ];
}
