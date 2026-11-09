// Minimal MCP (Model Context Protocol) request handler. The protocol is an open,
// documented JSON-RPC 2.0 dialect, so this file implements only the three things a
// tool server needs (initialize, tools/list, tools/call) instead of pulling in a
// client SDK. Transport (stdio, HTTP) lives elsewhere; this module is pure.

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function missingRequired(schema, args) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.filter((key) => args[key] === undefined || args[key] === null);
}

/**
 * @param {{serverName: string, version: string, tools: Array<{name: string, description: string, inputSchema: object, handler: (args: object) => Promise<unknown>|unknown}>}} options
 */
export function createMcpHandler({ serverName, version, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  async function callTool(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    const args = params.arguments ?? {};
    const missing = missingRequired(tool.inputSchema, args);
    if (missing.length > 0) {
      return ok(id, { isError: true, content: [{ type: 'text', text: `Missing required argument: ${missing.join(', ')}` }] });
    }
    try {
      const value = await tool.handler(args);
      return ok(id, { content: [{ type: 'text', text: toText(value) }] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return ok(id, { isError: true, content: [{ type: 'text', text: message }] });
    }
  }

  async function handle(message) {
    const { id, method, params } = message;
    // A message without an id is a notification: the protocol forbids answering it.
    if (id === undefined) return null;
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version },
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call':
        return callTool(id, params);
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  return { handle };
}
