#!/usr/bin/env node
// swttch-session-mcp --area <name>
// Serves one area of the session-management tools over MCP stdio.
// Environment: CLAUDE_CONFIG_DIR (where the CLI keeps transcripts) and
// SWTTCH_SESSION_ID (the calling session, what "self" means).

import fs from 'node:fs';
import { AREAS, serverNameFor } from './areas.js';
import { createMcpHandler } from './mcp-handler.js';
import { serveStdio } from './stdio.js';

function areaFromArgs(argv) {
  const at = argv.indexOf('--area');
  return at === -1 ? undefined : argv[at + 1];
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
