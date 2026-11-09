import readline from 'node:readline';

// MCP stdio transport: one JSON-RPC message per line in each direction.
export function serveStdio(handler, { input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const response = await handler.handle(message);
    if (response) output.write(JSON.stringify(response) + '\n');
  });
  return lines;
}
