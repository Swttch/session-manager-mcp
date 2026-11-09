// MCP servers as the Claude CLI reports them (`claude mcp list`, the documented command).

import { notYet } from './common.js';
import { resolveContext } from './context.js';

const LINE = /^([^:]+):\s*(.*?)\s+-\s+(✓|✗|⚠)\s*(.*)$/u;

export function parseMcpList(text) {
  const servers = [];
  for (const line of text.split('\n')) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    const [, name, target, mark, rest] = match;
    const status = mark === '✓' ? 'connected' : mark === '⚠' ? 'needs_auth' : 'failed';
    servers.push({ name: name.trim(), target, status, detail: rest.trim() });
  }
  return servers;
}

export function createConnectorsTools(options = {}) {
  const ctx = resolveContext(options);
  return [
    {
      name: 'session_connectors_status',
      description: 'List the MCP servers the Claude CLI knows (`claude mcp list`) and their state: connected, failed or needs_auth.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const res = await ctx.runtime.exec(ctx.runtime.claudeBin, ['mcp', 'list'], { timeoutMs: 120000 });
        if (res.code !== 0) throw new Error(`claude mcp list failed: ${res.stderr.trim()}`);
        return { servers: parseMcpList(res.stdout) };
      },
    },
    notYet('reconnect_session_connector', { server: { type: 'string' } }, ['server'], 'Re-dial a failed connector.', 'reconnecting is a switch of the program that runs the session'),
    notYet('set_session_connector_enabled', { connector: { type: 'string' }, enabled: { type: 'boolean' } }, ['connector', 'enabled'], 'Turn a connector on or off for this session.', 'it is a switch of the program that runs the session'),
  ];
}
