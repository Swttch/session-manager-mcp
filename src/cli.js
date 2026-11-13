#!/usr/bin/env node
// swttch-session-mcp --area <name>
// Serves one area of the session-management tools over MCP stdio.
// Environment: CLAUDE_CONFIG_DIR (where the CLI keeps transcripts) and
// SWTTCH_SESSION_ID (the calling session, what "self" means).

import fs from 'node:fs';
import { AREAS, serverNameFor } from './areas.js';
import { createMcpHandler } from './mcp-handler.js';
import { serveStdio } from './stdio.js';
import { resolveContext } from './tools/context.js';
import { setSessionParent, INHERIT } from './set-parent.js';
import { setSessionArchived, INHERIT_ARCHIVE } from './set-archived.js';
import { findDesktopSession, readDesktopState, watchDesktopState } from './desktop-sessions.js';
import { startedBy } from './started-by.js';
import { watchMarks } from './marks-watch.js';

function areaFromArgs(argv) {
  const at = argv.indexOf('--area');
  return at === -1 ? undefined : argv[at + 1];
}

// swttch-session-manager-mcp set-parent <sessionId> [<parentSessionId>|none|inherit]
// Changes by hand which session another one is under and prints the answer as JSON. It is the same
// edit as the set_session_parent tool, for a program that is not a model (a settings screen).
// "none" takes the session to the top level on purpose; "inherit" forgets what was chosen by hand.
if (process.argv[2] === 'set-parent') {
  const sessionId = process.argv[3];
  const parentArg = process.argv[4];
  try {
    if (!sessionId) throw new Error('Usage: set-parent <sessionId> [<parentSessionId>|none|inherit]');
    const parent = parentArg === 'inherit' ? INHERIT : parentArg && parentArg !== 'none' ? parentArg : null;
    const answer = setSessionParent(resolveContext({}), sessionId, parent);
    process.stdout.write(JSON.stringify({ ok: true, ...answer }) + '\n');
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exit(1);
  }
}

// swttch-session-manager-mcp set-archived <sessionId> <archived|unarchived|inherit>
// Archives a session, brings it back on purpose, or forgets what was chosen (the Claude desktop app's record then
// shows again), and prints the answer as JSON. Only the record is edited.
if (process.argv[2] === 'set-archived') {
  const sessionId = process.argv[3];
  const stateArg = process.argv[4];
  try {
    if (!sessionId || !['archived', 'unarchived', 'inherit'].includes(stateArg)) throw new Error('Usage: set-archived <sessionId> <archived|unarchived|inherit>');
    const state = stateArg === 'archived' ? true : stateArg === 'unarchived' ? false : INHERIT_ARCHIVE;
    const answer = setSessionArchived(resolveContext({}), sessionId, state);
    process.stdout.write(JSON.stringify({ ok: true, ...answer }) + '\n');
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exit(1);
  }
}

// The commands below answer what the Claude desktop app records about its sessions, so that a program
// that shows sessions (a settings screen, a session list) never has to read the desktop app's files
// itself. Each prints JSON, one object per line.
//
// swttch-session-manager-mcp desktop-state
//   { ok, starters: {cliId: startedByCliId}, archived: [cliId], titles: {cliId: title}, running: [cliId] }
if (process.argv[2] === 'desktop-state') {
  try {
    process.stdout.write(JSON.stringify({ ok: true, ...readDesktopState() }) + '\n');
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exit(1);
  }
}

// swttch-session-manager-mcp desktop-session <desktopSessionId>
//   { ok, session: {title?, cliSessionId?, cwd?, isArchived, lastActivityAt, awaitingPerson?} | null }
if (process.argv[2] === 'desktop-session') {
  try {
    const id = process.argv[3];
    if (!id) throw new Error('Usage: desktop-session <desktopSessionId>');
    process.stdout.write(JSON.stringify({ ok: true, session: findDesktopSession(id) }) + '\n');
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exit(1);
  }
}

// swttch-session-manager-mcp started-by <sessionId>
//   { ok, startedBy: cliId | null, source: 'marks' | 'desktop' | null }
// The record kept here answers first; the desktop app's answers only when nothing was chosen here.
if (process.argv[2] === 'started-by') {
  try {
    const sessionId = process.argv[3];
    if (!sessionId) throw new Error('Usage: started-by <sessionId>');
    process.stdout.write(JSON.stringify({ ok: true, ...startedBy(resolveContext({}), sessionId) }) + '\n');
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exit(1);
  }
}

// swttch-session-manager-mcp desktop-watch
// Stays running and prints one line whenever what the desktop app records changes:
//   { ok, change: {list, running}, ...the desktop-state fields }
// What moves is the desktop app's records and this package's own marks (who a session was put under by hand,
// an archive by hand): a change to either one is a change of the list.
// A turn already running when it starts is announced at once; otherwise the first read is only the baseline,
// so a program asks desktop-state first. It ends when its input closes, so a program that goes away takes it along.
if (process.argv[2] === 'desktop-watch') {
  const stopDesktop = watchDesktopState((state, change) => {
    process.stdout.write(JSON.stringify({ ok: true, change, ...state }) + '\n');
  });
  const stopMarks = watchMarks(() => {
    process.stdout.write(JSON.stringify({ ok: true, change: { list: true, running: false }, ...readDesktopState() }) + '\n');
  });
  const end = () => {
    stopDesktop();
    stopMarks();
    process.exit(0);
  };
  process.stdin.on('end', end);
  process.stdin.on('close', end);
  process.stdin.resume();
  process.on('SIGTERM', end);
  process.on('SIGINT', end);
} else {
const area = areaFromArgs(process.argv.slice(2));
const createTools = area ? AREAS[area] : undefined;
if (!createTools) {
  console.error(`Unknown or missing --area. Available: ${Object.keys(AREAS).join(', ')}`);
  process.exit(2);
}

const tools = createTools({ selfSessionId: process.env.SWTTCH_SESSION_ID || undefined });
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
serveStdio(createMcpHandler({ serverName: serverNameFor(area), version, tools }));
}
