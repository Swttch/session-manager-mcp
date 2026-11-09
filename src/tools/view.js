import { resolveContext } from './context.js';
import { uiHelpers } from './ui.js';

const PANES = ['diff', 'file', 'terminal', 'pr', 'tasks', 'plan', 'artifact', 'preview'];
const VIEWS = ['normal', 'thinking', 'verbose'];

export function createViewTools(options = {}) {
  const ctx = resolveContext(options);
  const ui = uiHelpers(ctx);
  const checkPane = (pane) => { if (!PANES.includes(pane)) throw new Error(`pane must be one of: ${PANES.join(', ')}`); };
  return [
    {
      name: 'get_layout',
      description: 'Report where this session is on screen in the desktop (main window pane) and which side panes are open. An empty views list means the user does not have this session open anywhere right now.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { this_session } = ui.describe();
        return { views: this_session.on_screen ? [{ where: this_session.shown_in }] : [], open_panes: [] };
      },
    },
    {
      name: 'show_pane',
      description: 'Show one of this session\'s side panes beside the conversation: diff (optional path, diff_scope), file (path, line), terminal (tab_id), pr, tasks, plan, artifact or preview. The change is queued for the desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          pane: { type: 'string', enum: PANES }, path: { type: 'string' }, line: { type: 'number' }, diff_scope: { type: 'string' }, tab_id: { type: 'string' },
        },
        required: ['pane'],
      },
      handler: async ({ pane, ...rest }) => {
        checkPane(pane);
        return ui.queue('show_pane', { pane, ...rest });
      },
    },
    {
      name: 'close_pane',
      description: 'Close one of this session\'s side panes. No-op when it is not open. The change is queued for the desktop.',
      inputSchema: { type: 'object', properties: { pane: { type: 'string', enum: PANES } }, required: ['pane'] },
      handler: async ({ pane }) => {
        checkPane(pane);
        return ui.queue('close_pane', { pane });
      },
    },
    {
      name: 'set_transcript_view',
      description: 'Switch how a conversation is drawn: "normal" (tool calls collapsed), "thinking" (also shows thinking summaries) or "verbose" (everything expanded). Changes only the display. The change is queued for the desktop.',
      inputSchema: { type: 'object', properties: { view: { type: 'string', enum: VIEWS }, session_id: { type: 'string' } }, required: ['view'] },
      handler: async ({ view, session_id }) => {
        if (!VIEWS.includes(view)) throw new Error(`view must be one of: ${VIEWS.join(', ')}`);
        return ui.queue('set_transcript_view', { view, ...(session_id ? { session_id } : {}) });
      },
    },
  ];
}
