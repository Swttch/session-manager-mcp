import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '../src/mcp-handler.js';

const echoTool = {
  name: 'echo',
  description: 'Echo the text back.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: async ({ text }) => `said: ${text}`,
};
const boomTool = {
  name: 'boom',
  description: 'Always fails.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => { throw new Error('exploded'); },
};

function handler() {
  return createMcpHandler({ serverName: 'swttch_test', version: '0.0.1', tools: [echoTool, boomTool] });
}

test('initialize answers with the protocol version, tools capability and server info', async () => {
  const res = await handler().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.equal(res.result.serverInfo.name, 'swttch_test');
});

test('notifications get no response', async () => {
  const res = await handler().handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res, null);
});

test('tools/list exposes name, description and inputSchema without the handler', async () => {
  const res = await handler().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(res.result.tools.map((t) => t.name), ['echo', 'boom']);
  assert.equal(res.result.tools[0].inputSchema.required[0], 'text');
  assert.equal('handler' in res.result.tools[0], false);
});

test('tools/call returns the handler text as content', async () => {
  const res = await handler().handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
  assert.deepEqual(res.result, { content: [{ type: 'text', text: 'said: hi' }] });
});

test('an object result is serialized as JSON text', async () => {
  const h = createMcpHandler({ serverName: 's', version: '1', tools: [{ ...echoTool, name: 'obj', handler: async () => ({ a: 1 }) }] });
  const res = await h.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'obj', arguments: { text: 'x' } } });
  assert.equal(res.result.content[0].text, JSON.stringify({ a: 1 }, null, 2));
});

test('a failing handler becomes an isError result, not a protocol error', async () => {
  const res = await handler().handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /exploded/);
});

test('a missing required argument is reported as an isError result', async () => {
  const res = await handler().handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /text/);
});

test('an unknown tool is a JSON-RPC error', async () => {
  const res = await handler().handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(res.error.code, -32602);
});

test('an unknown method is a method-not-found error, ping succeeds', async () => {
  const bad = await handler().handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
  assert.equal(bad.error.code, -32601);
  const ping = await handler().handle({ jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.deepEqual(ping.result, {});
});
