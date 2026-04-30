// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Mock WebSocket backend for E2E tests.
 * Implements JSON-RPC 2.0 over WebSocket, mimicking the C++ backend.
 * Usage: node e2e/mock-backend.mjs [port]
 */
import { WebSocketServer } from 'ws';

const port = parseInt(process.argv[2] || '9099', 10);
const wss = new WebSocketServer({ port });

function broadcast(ws, method, params) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function handleRpc(ws, msg) {
  let req;
  try {
    req = JSON.parse(msg);
  } catch {
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }),
    );
    return;
  }

  const { id, method, params } = req;

  // Notifications (no id)
  if (id === undefined || id === null) {
    if (method === 'workflow.stop') {
      // no-op
    } else if (method === 'debug.continue' || method === 'debug.step_over') {
      // no-op
    }
    return;
  }

  // Methods
  if (method === 'vendor.getConfigSchema') {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          vendor: 'stub',
          fields: [],
        },
      }),
    );
    return;
  }

  if (method === 'workflow.execute') {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { status: 'started' } }));

    // Simulate async node execution
    const nodes = params?.nodes || [];
    let delay = 50;
    for (const node of nodes) {
      const nid = node.id;
      setTimeout(() => broadcast(ws, 'node.status', { node_id: nid, status: 'running' }), delay);
      delay += 50;

      if (node.type === 'createNet') {
        setTimeout(
          () => broadcast(ws, 'node.status', { node_id: nid, status: 'done', elapsed_ms: 0.1 }),
          delay,
        );
      } else if (node.type === 'inference') {
        setTimeout(
          () => broadcast(ws, 'node.status', { node_id: nid, status: 'done', elapsed_ms: 1.0 }),
          delay,
        );
      } else {
        // `debug` nodes used to emit debug.paused here, but nothing was wired
        // up to resume them (debug.continue is a no-op notification), so the
        // simulated run would deadlock. Treat them as a normal passthrough.
        setTimeout(() => broadcast(ws, 'node.status', { node_id: nid, status: 'done' }), delay);
      }
      delay += 50;
    }

    setTimeout(() => broadcast(ws, 'workflow.complete', { status: 'complete' }), delay + 50);
    return;
  }

  if (method === 'debug.add_breakpoint') {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    return;
  }

  if (method === 'debug.remove_breakpoint') {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    return;
  }

  if (method === 'workflow.save') {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    return;
  }

  if (method === 'workflow.load') {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { nodes: [], edges: [] } }));
    return;
  }

  // Unknown method
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }),
  );
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => handleRpc(ws, data.toString()));
});

console.log(`Mock WS backend listening on ws://localhost:${port}`);
