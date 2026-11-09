import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWindowTools } from '../src/tools/window.js';
import { createViewTools } from '../src/tools/view.js';
import { openStore } from '../src/store/entities.js';
import { makeEnv } from './helpers.js';

// The desktop's workspace record: two panels side by side, the left showing session aaaa, the right a terminal.
const workspace = (selfSession) => ({
  version: 1, revision: 5, activePanel: 'p2', focusHistory: [],
  layout: { kind: 'split', id: 's1', direction: 'columns', ratio: 0.5, children: [
    { kind: 'panel', id: 'p1', tabs: [{ id: 't1', kind: 'chat', projectId: 1, title: 'Caller', sessionId: selfSession }], activeTabId: 't1', focusHistory: ['t1'] },
    { kind: 'panel', id: 'p2', tabs: [{ id: 't2', kind: 'terminal', projectId: 1, title: 'zsh' }, { id: 't3', kind: 'chat', projectId: 1, title: 'Other', sessionId: 'aaaa' }], activeTabId: 't3', focusHistory: ['t3'] },
  ] },
});
function withDesktop(env, selfSession) {
  fs.writeFileSync(`${env.dataDir}/workspace.json`, JSON.stringify(workspace(selfSession)));
  return env;
}
const commands = (env) => openStore({ dataDir: env.dataDir }).uiCommands.all();

test('get_window_layout lists the panels with where each sits and which session it shows, and where the calling session is', async () => {
  const env = withDesktop(makeEnv(), 'cccc');
  const layout = await env.tools(createWindowTools).get_window_layout({});
  assert.deepEqual(layout.main_window.panes.map((p) => [p.index, p.col, p.row, p.session_id, p.focused]), [[0, 0, 0, 'cccc', false], [1, 1, 0, 'aaaa', true]]);
  assert.deepEqual(layout.this_session, { session_id: 'cccc', on_screen: true, shown_in: 'main window, pane 0' });
});

test('without a desktop workspace record the layout says the session is not on screen', async () => {
  const layout = await makeEnv().tools(createWindowTools).get_window_layout({});
  assert.equal(layout.this_session.on_screen, false);
  assert.deepEqual(layout.main_window.panes, []);
});

test('view get_layout reports where the calling session is shown and the panes open beside it', async () => {
  const env = withDesktop(makeEnv(), 'cccc');
  const layout = await env.tools(createViewTools).get_layout({});
  assert.equal(layout.views.length, 1);
  assert.equal(layout.views[0].where, 'main window, pane 0');
  assert.deepEqual(layout.open_panes, []);
});

test('window changes are queued for the desktop as commands, with the arguments checked first', async () => {
  const env = withDesktop(makeEnv(), 'cccc');
  const win = env.tools(createWindowTools);
  assert.match(await win.set_sidebar_collapsed({ collapsed: true }), /queued/i);
  assert.match(await win.open_session_in({ session_id: 'self', target: 'split' }), /queued/i);
  await assert.rejects(win.open_session_in({ session_id: 'self', target: 'fullscreen' }), /target/);
  await assert.rejects(win.open_session_in({ session_id: 'aaaa', target: 'split' }), /started|sidebar/i);
  assert.match(await win.close_split({}), /queued/i);
  assert.deepEqual(commands(env).map((c) => c.type), ['set_sidebar_collapsed', 'open_session_in', 'close_split']);
  assert.deepEqual(commands(env)[0].args, { collapsed: true });
  assert.equal(commands(env)[0].requestedBy, 'cccc');
});

test('view changes validate the pane and view names, then queue', async () => {
  const env = withDesktop(makeEnv(), 'cccc');
  const view = env.tools(createViewTools);
  assert.match(await view.show_pane({ pane: 'diff', path: 'src/a.js', diff_scope: 'uncommitted' }), /queued/i);
  assert.match(await view.close_pane({ pane: 'terminal' }), /queued/i);
  assert.match(await view.set_transcript_view({ view: 'verbose' }), /queued/i);
  await assert.rejects(view.show_pane({ pane: 'sidebar' }), /pane/);
  await assert.rejects(view.set_transcript_view({ view: 'loud' }), /view/);
  assert.deepEqual(commands(env).map((c) => c.type), ['show_pane', 'close_pane', 'set_transcript_view']);
});

test('a window or view change with no desktop to receive it says so instead of queueing into the void', async () => {
  const env = makeEnv(); // no workspace.json: no desktop has ever run here
  await assert.rejects(env.tools(createWindowTools).set_sidebar_collapsed({ collapsed: true }), /unavailable.*desktop/i);
  assert.equal(commands(env).length, 0);
});
