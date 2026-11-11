/**
 * Deterministic in-repo fixture for MCP Streamable HTTP tests (WP7).
 * Not a third-party server; no network access required.
 *
 * Usage:
 *   node mcp-http-server.cjs [flags]
 *
 * Flags:
 *   --port <n>          Port to listen on (0 = ephemeral; default 0). The actual port is printed as `listening <port>` on stdout.
 *   --auth              Require `Authorization: Bearer <token>` (default token: test-token-123; override with --token <value>).
 *   --forbidden         Respond 403 to every POST.
 *   --sse-response      Answer tools/call with a text/event-stream (progress notification + server-initiated request + final response).
 *   --slow              Answer initialize and tools/list normally but never answer tools/call (timeout path).
 *   --expire-session    Invalidate the session after the first tools/call (session-expiration path).
 *   --destroy           Destroy the connection on tools/call without responding (network-drop path).
 *   --oversized         Answer tools/call with a >4 MiB JSON body (bounded-response path).
 *   --redirect          Answer every POST with a 302 redirect to a different path (client must refuse).
 *   --leak-token-on-500 Respond 500 to tools/call with a body echoing the supplied Authorization value (redaction path).
 *   --leak-token-on-401 Respond 401 to every POST with a body echoing the supplied Authorization value (redaction path).
 *   --spy <file>        Append an audit trail (method names, auth result, protocol-version header, delete calls, client error responses) to <file>. Token values are never logged.
 *
 * Behavior (default mode):
 *   initialize     -> creates a session, responds with Mcp-Session-Id header and JSON
 *   notifications/ initialized -> 202 Accepted, no body
 *   tools/list     -> JSON with echo/fail/large
 *   tools/call     -> JSON; echo echoes args.text; fail returns isError; large returns 40,000 'x'
 *   DELETE /mcp    -> 200 and removes the session (logs `delete`)
 *   GET /mcp       -> 405
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');

const argv = process.argv.slice(2);
function flag(name) {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 ? argv[at + 1] : undefined;
}
function hasFlag(name) {
  return argv.includes(`--${name}`);
}

const PORT = Number(flag('port') ?? '0');
const TOKEN = flag('token') ?? 'test-token-123';
const AUTH_REQUIRED = hasFlag('auth');
const FORBIDDEN = hasFlag('forbidden');
const SSE_RESPONSE = hasFlag('sse-response');
const SLOW = hasFlag('slow');
const EXPIRE_SESSION = hasFlag('expire-session');
const DESTROY = hasFlag('destroy');
const OVERSIZED = hasFlag('oversized');
const REDIRECT = hasFlag('redirect');
const LEAK_ON_500 = hasFlag('leak-token-on-500');
const LEAK_ON_401 = hasFlag('leak-token-on-401');
const SPY = flag('spy');

const MAX_BODY_BYTES = 1_000_000;
let sessionCounter = 0;
const sessions = new Map(); // sessionId -> true

function spy(line) {
  if (SPY) {
    try {
      fs.appendFileSync(SPY, `${line}\n`);
    } catch {
      // spy is best-effort
    }
  }
}

function checkAuth(req, res) {
  const header = req.headers['authorization'];
  const ok = typeof header === 'string' && header === `Bearer ${TOKEN}`;
  if (!AUTH_REQUIRED && !LEAK_ON_401) {
    return { ok: true, status: 'n/a' };
  }
  if (LEAK_ON_401) {
    const body = JSON.stringify({ error: 'unauthorized', echo: header ?? '(none)' });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(body);
    spy('auth fail');
    return { ok: false };
  }
  if (!ok) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    spy(header === undefined ? 'auth missing' : 'auth fail');
    return { ok: false };
  }
  if (AUTH_REQUIRED) {
    spy('auth ok');
  }
  return { ok: true, status: 'ok' };
}

function sendJson(res, status, message, sessionId) {
  const headers = { 'content-type': 'application/json' };
  if (sessionId !== undefined) {
    headers['mcp-session-id'] = sessionId;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(message));
}

function handleMessage(message, req, res, state) {
  const method = typeof message.method === 'string' ? message.method : undefined;

  if (message.id !== undefined && message.id !== null && method === undefined) {
    // Client -> server error response (e.g. answer to a server-initiated request).
    const code = message.error && typeof message.error.code === 'number' ? message.error.code : 'unknown';
    spy(`client-error ${code}`);
    res.writeHead(202);
    res.end();
    return;
  }

  if (method !== undefined) {
    spy(`method ${method}`);
  }

  if (method === 'initialize') {
    const sessionId = `sess-${++sessionCounter}-${Date.now()}`;
    sessions.set(sessionId, true);
    state.sessionValidated = false; // initialize itself carries no session
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fixture-mcp-http', version: '1.0.0' },
      },
    }, sessionId);
    return;
  }

  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) {
    res.writeHead(202);
    res.end();
    return;
  }

  // All other requests require the negotiated session.
  const sessionHeader = req.headers['mcp-session-id'];
  if (typeof sessionHeader !== 'string' || sessionHeader.length === 0) {
    sendJson(res, 400, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: 'missing mcp-session-id' } });
    return;
  }
  if (!sessions.get(sessionHeader)) {
    sendJson(res, 404, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32001, message: 'session not found' } });
    return;
  }
  state.currentSession = sessionHeader;

  if (method === 'tools/list') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echoes the provided text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
          { name: 'fail', description: 'Always returns an error result.', inputSchema: { type: 'object', properties: {} } },
          { name: 'large', description: 'Returns a large payload.', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};

    if (SLOW) {
      return; // never respond: exercises the client-side timeout path
    }
    if (DESTROY) {
      req.socket.destroy();
      return; // connection drops without a response: exercises the network-failure path
    }
    if (OVERSIZED) {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'x'.repeat(6_000_000) }] },
      });
      return;
    }
    if (LEAK_ON_500) {
      const echo = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '(none)';
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream failure', echo }));
      return;
    }
    if (name === 'echo') {
      const result = { content: [{ type: 'text', text: String(args.text ?? '') }] };
      if (SSE_RESPONSE) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"t","progress":1,"total":2}}\n\n');
        res.write('data: {"jsonrpc":"2.0","id":999999,"method":"sampling/createMessage","params":{}}\n\n');
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
        res.end();
        return;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result });
      if (EXPIRE_SESSION) {
        sessions.delete(sessionHeader);
      }
      return;
    }
    if (name === 'fail') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'deliberate fixture failure' }] },
      });
      return;
    }
    if (name === 'large') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'x'.repeat(40_000) }] },
      });
      return;
    }
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `unknown tool ${String(name)}` },
    });
    return;
  }

  sendJson(res, 200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'method not found' } });
}

const server = http.createServer((req, res) => {
  const protocolVersion = req.headers['mcp-protocol-version'];
  spy(`protocol-version ${typeof protocolVersion === 'string' ? protocolVersion : 'missing'}`);

  if (REDIRECT) {
    res.writeHead(302, { location: '/elsewhere' });
    res.end();
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (req.method === 'DELETE') {
    const sessionHeader = req.headers['mcp-session-id'];
    if (typeof sessionHeader === 'string' && sessions.delete(sessionHeader)) {
      spy('delete');
      res.writeHead(200);
      res.end();
      return;
    }
    spy('delete');
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const state = {};
  if (FORBIDDEN) {
    spy('auth fail');
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }
  const auth = checkAuth(req, res);
  if (auth.ok === false) {
    return;
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      res.writeHead(413);
      res.end();
      req.destroy();
    }
  });
  req.on('end', () => {
    if (body.length === 0) {
      res.writeHead(400);
      res.end();
      return;
    }
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    handleMessage(message, req, res, state);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  process.stdout.write(`listening ${port}\n`);
});
