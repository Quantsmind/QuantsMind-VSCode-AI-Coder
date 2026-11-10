/**
 * Fixture MCP server for tests (plain Node, newline-delimited JSON-RPC 2.0).
 * Modes:
 *   node mcp-server.cjs            — normal server (initialize, tools/list, tools/call)
 *   node mcp-server.cjs silent     — never responds to requests (timeout path)
 *   node mcp-server.cjs crash      — exits immediately (connect/closed path)
 *   node mcp-server.cjs env        — echoes process.env in an env tool (leak check)
 */
const mode = process.argv[2] ?? 'normal';

if (mode === 'crash') {
  process.exit(3);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) {
      return;
    }
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw.length === 0) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    handle(message);
  }
});

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the provided text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'fail',
    description: 'Always returns an error result.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'large',
    description: 'Returns a large payload.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'env',
    description: 'Returns the server environment (test-only inspection).',
    inputSchema: { type: 'object', properties: {} },
  },
];

function handle(message) {
  if (mode === 'silent') {
    return; // never respond: exercises the timeout path
  }
  if (message.method === 'notifications/initialized') {
    return; // notifications carry no response
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fixture-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: String(args.text ?? '') }] },
      });
      return;
    }
    if (name === 'fail') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'deliberate fixture failure' }] },
      });
      return;
    }
    if (name === 'large') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'x'.repeat(40_000) }] },
      });
      return;
    }
    if (name === 'env') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify(process.env) }] },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Unknown tool: ${String(name)}` },
    });
    return;
  }
  send({
    jsonrpc: '2.0',
    id: message.id ?? null,
    error: { code: -32601, message: `Unknown method: ${String(message.method)}` },
  });
}
