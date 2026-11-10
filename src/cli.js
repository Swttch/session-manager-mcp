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

const area = areaFromArgs(process.argv.slice(2));
const createTools = area ? AREAS[area] : undefined;
if (!createTools) {
  console.error(`Unknown or missing --area. Available: ${Object.keys(AREAS).join(', ')}`);
  process.exit(2);
}

const tools = createTools({ selfSessionId: process.env.SWTTCH_SESSION_ID || undefined });
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
serveStdio(createMcpHandler({ serverName: serverNameFor(area), version, tools }));
