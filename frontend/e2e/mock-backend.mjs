/**
 * Mock WebSocket backend for E2E tests.
 * Implements JSON-RPC 2.0 over WebSocket, mimicking the C++ backend.
 * Usage: node e2e/mock-backend.mjs [port]
 */
import { WebSocketServer } from 'ws';

const port = parseInt(process.argv[2] || '9099', 10);
const wss = new WebSocketServer({ port });

/** Simulated net handles */
let nextHandle = 1;
const nets = new Map();

function broadcast(ws, method, params) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function handleRpc(ws, msg) {
  let req;
  try {
    req = JSON.parse(msg);
  } catch {
    ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
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
  if (method === 'capabilities') {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id,
      result: {
        vendor: 'stub',
        operations: [
          { id: 'init_net', inputs: ['model_path', 'config'], outputs: ['net_handle'], description: 'Initialize neural network' },
          { id: 'execute', inputs: ['net_handle', 'input_data'], outputs: ['output_data'], description: 'Run inference' },
          { id: 'benchmark', inputs: ['net_handle', 'input_data', 'duration_sec'], outputs: ['runs', 'avg_ms'], description: 'Benchmark inference' },
          { id: 'postprocess', inputs: ['input_data', 'op', 'iouThreshold', 'k'], outputs: ['output_data'], description: 'Postprocess outputs' },
        ],
      },
    }));
    return;
  }

  if (method === 'vendor.getConfigSchema') {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id,
      result: {
        vendor: 'stub',
        fields: []
      }
    }));
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
        const h = nextHandle++;
        nets.set(h, node.config || {});
        setTimeout(() => broadcast(ws, 'node.status', { node_id: nid, status: 'done', elapsed_ms: 0.1 }), delay);
      } else if (node.type === 'inference') {
        setTimeout(() => broadcast(ws, 'node.status', { node_id: nid, status: 'done', elapsed_ms: 1.0 }), delay);
      } else if (node.type === 'debug') {
        // Check if breakpoint — simulate pause
        setTimeout(() => broadcast(ws, 'debug.paused', { node_id: nid, data: {} }), delay);
        // Will resume on debug.continue
      } else {
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
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }));
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => handleRpc(ws, data.toString()));
});

console.log(`Mock WS backend listening on ws://localhost:${port}`);
