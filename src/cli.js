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
import { setSessionParent } from './set-parent.js';

function areaFromArgs(argv) {
  const at = argv.indexOf('--area');
  return at === -1 ? undefined : argv[at + 1];
}

// swttch-session-manager-mcp set-parent <sessionId> [<parentSessionId>|none]
// Changes by hand which session another one is under and prints the answer as JSON. It is the same
// edit as the set_session_parent tool, for a program that is not a model (a settings screen).
if (process.argv[2] === 'set-parent') {
  const sessionId = process.argv[3];
  const parentArg = process.argv[4];
  try {
    if (!sessionId) throw new Error('Usage: set-parent <sessionId> [<parentSessionId>|none]');
    const parent = parentArg && parentArg !== 'none' ? parentArg : null;
    const answer = setSessionParent(resolveContext({}), sessionId, parent);
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
