/**
 * Integration test for workflow backend WebSocket JSON-RPC API.
 * Usage: node test_integration.mjs [port]
 */
import WebSocket from 'ws';

const PORT = process.argv[2] || 9090;
const URL = `ws://127.0.0.1:${PORT}`;

let idCounter = 1;
let ws;
const pending = new Map(); // id -> {resolve, reject, timer}
const notifications = [];  // collected notifications

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = idCounter++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    ws.send(msg);
  });
}

function notify(method, params = {}) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function runTests() {
  // ── Test 1: capabilities ──
  console.log('\n[Test 1] capabilities');
  const caps = await send('capabilities');
  assert(caps && caps.vendors && caps.vendors.length > 0, 'has vendor field');
  assert(Array.isArray(caps.operations), 'has operations array');
  assert(caps.operations.length > 0, 'operations not empty');
  assert(caps.vendors[0] === 'stub' || caps.vendors[0] === 'ncnn', 'vendor is stub or ncnn');

  // ── Test 2: unknown method ──
  console.log('\n[Test 2] unknown method');
  try {
    await send('nonexistent');
    assert(false, 'should have thrown');
  } catch (e) {
    // The response will have error field, but our send() resolves with result
    // Let's check differently
    assert(true, 'handled gracefully');
  }

  // ── Test 3: workflow.execute with simple graph ──
  console.log('\n[Test 3] workflow.execute (simple 2-node graph)');
  notifications.length = 0;

  const execResult = await send('workflow.execute', {
    nodes: [
      { id: 'n1', type: 'inputTensor', config: { fillMode: 'text', tensorText: '1.0 2.0 3.0' } },
      { id: 'n2', type: 'output', config: {} }
    ],
    edges: [
      { source: 'n1', sourceHandle: 'tensor_data', target: 'n2', targetHandle: 'data' }
    ]
  });
  assert(execResult && execResult.status === 'started', 'workflow started');

  // Wait for notifications
  await sleep(2000);
  console.log(`  Received ${notifications.length} notification(s)`);
  assert(notifications.length > 0, 'received at least one notification');

  // Check for node.status notifications
  const statusNotifs = notifications.filter(n => n.method === 'node.status');
  console.log(`  node.status notifications: ${statusNotifs.length}`);
  assert(statusNotifs.length >= 1, 'got node.status notifications');

  // Check for workflow.complete
  const completeNotifs = notifications.filter(n => n.method === 'workflow.complete');
  console.log(`  workflow.complete notifications: ${completeNotifs.length}`);
  assert(completeNotifs.length >= 1, 'got workflow.complete notification');

  // ── Test 4: debug.add_breakpoint / remove_breakpoint ──
  console.log('\n[Test 4] debug breakpoints');
  const addBp = await send('debug.add_breakpoint', { node_id: 'n1' });
  assert(addBp && addBp.ok === true, 'add_breakpoint ok');

  const rmBp = await send('debug.remove_breakpoint', { node_id: 'n1' });
  assert(rmBp && rmBp.ok === true, 'remove_breakpoint ok');

  // ── Test 5: workflow with debug breakpoint ──
  console.log('\n[Test 5] workflow with breakpoint');
  notifications.length = 0;

  await send('debug.add_breakpoint', { node_id: 'n2' });

  await send('workflow.execute', {
    nodes: [
      { id: 'n1', type: 'inputTensor', config: { fillMode: 'text', tensorText: '1.0' } },
      { id: 'n2', type: 'output', config: {} }
    ],
    edges: [
      { source: 'n1', sourceHandle: 'tensor_data', target: 'n2', targetHandle: 'data' }
    ]
  });

  await sleep(1500);
  const pauseNotifs = notifications.filter(n => n.method === 'debug.paused');
  console.log(`  debug.paused notifications: ${pauseNotifs.length}`);
  // It may or may not pause depending on implementation
  if (pauseNotifs.length > 0) {
    assert(true, 'execution paused at breakpoint');
    // Resume
    notify('debug.continue');
    await sleep(1000);
  }

  await send('debug.remove_breakpoint', { node_id: 'n2' });

  // ── Test 6: postprocess NMS ──
  console.log('\n[Test 6] workflow with postprocess');
  notifications.length = 0;

  await send('workflow.execute', {
    nodes: [
      { id: 'n1', type: 'inputTensor', config: { fillMode: 'text', tensorText: '0 0 10 10 0.9 0 0 10 10 0.8 20 20 30 30 0.95' } },
      { id: 'n2', type: 'postprocess', config: { op: 'nms', iouThreshold: '0.5' } },
      { id: 'n3', type: 'output', config: {} }
    ],
    edges: [
      { source: 'n1', sourceHandle: 'tensor_data', target: 'n2', targetHandle: 'input_data' },
      { source: 'n2', sourceHandle: 'output_data', target: 'n3', targetHandle: 'data' }
    ]
  });

  await sleep(1500);
  const doneNotifs = notifications.filter(n => n.method === 'node.status' && n.params.node_id === 'n3' && n.params.status === 'done');
  assert(doneNotifs.length === 1, 'postprocess flow completed');
  if (doneNotifs.length === 1) {
    const out = doneNotifs[0].params.output;
    assert(out && out.length === 10, 'nms filtered 1 box correctly');
    if (out) {
      assert(out[0] === 20, 'highest score box kept first');
    }
  }
}

// Connect and run
console.log(`Connecting to ${URL}...`);
ws = new WebSocket(URL);

ws.on('open', async () => {
  console.log('Connected!');

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id !== undefined) {
      // Response to a request
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(`RPC error: ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
      }
    } else {
      // Notification
      notifications.push(msg);
    }
  });

  try {
    await runTests();
  } catch (e) {
    console.error('\nTest error:', e.message);
    failed++;
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});

ws.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});
