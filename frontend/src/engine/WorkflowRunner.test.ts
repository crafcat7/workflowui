// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';

// Capture the notification handler the runner registers so the test
// can play events through it synchronously without a real WebSocket.
let capturedHandler: ((method: string, params: unknown) => void) | null = null;
const callMock = vi.fn();
vi.mock('../transport/WsClient', () => ({
  wsClient: {
    onNotification: vi.fn((cb: (method: string, params: unknown) => void) => {
      capturedHandler = cb;
      return () => {
        capturedHandler = null;
      };
    }),
    // Reconnect subscription isn't exercised here — we call
    // reconcileFromSnapshot directly instead of firing through the
    // hook — but the runner still registers on init, so the mock
    // needs to exist. Returns a no-op unsubscribe.
    onReconnect: vi.fn(() => () => {}),
    call: (...args: unknown[]) => callMock(...args),
  },
}));

vi.mock('../store/toastStore', () => ({ showToast: vi.fn() }));

// Import AFTER mocks so the runner picks them up.
import {
  initWorkflowRunner,
  setActiveRunId,
  _getActiveRunIdForTest,
  reconcileFromSnapshot,
} from './WorkflowRunner';
import { useDebugStore } from '../store/debugStore';
import { showToast } from '../store/toastStore';

function emit(method: string, params: unknown) {
  if (!capturedHandler) throw new Error('runner not initialised');
  capturedHandler(method, params);
}

function seedNode(id: string) {
  // F1 contract: nodes + nodesById must be seeded together. Without
  // the cache entry, reconcileFromSnapshot skips this node (it can't
  // tell a real unknown id from a test that forgot to wire things up).
  const node = {
    id,
    type: 'debug',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'debug', status: 'idle', config: {} },
  };
  useWorkflowStore.setState({
    nodes: [node] as never,
    nodesById: new Map([[id, node]]) as never,
    edges: [],
  });
}

describe('WorkflowRunner run_id filter', () => {
  beforeEach(() => {
    capturedHandler = null;
    callMock.mockReset();
    seedNode('n1');
    initWorkflowRunner();
    setActiveRunId(null);
  });

  it('accepts events that carry no run_id (legacy backend)', () => {
    // Untagged events must still flow through — the R1 filter is
    // strictly additive; older/test backends remain supported.
    emit('node.status', { node_id: 'n1', status: 'running' });
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('running');
  });

  it('accepts events whose run_id matches the active run', () => {
    setActiveRunId('run-42-100');
    emit('node.status', { node_id: 'n1', status: 'done', run_id: 'run-42-100' });
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('done');
  });

  it('drops events whose run_id differs from the active run', () => {
    // A late 'done' from the previous run must not overwrite the
    // fresh run's state. Node should remain at 'idle'.
    setActiveRunId('run-99-200');
    emit('node.status', { node_id: 'n1', status: 'done', run_id: 'run-42-100' });
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('idle');
  });

  it('drops stale debug.paused events', () => {
    // A paused event from a cancelled run would otherwise lock the
    // debug controller onto a node that is no longer running.
    setActiveRunId('run-99-200');
    emit('debug.paused', { node_id: 'n1', data: {}, run_id: 'run-42-100' });
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('idle');
  });

  it('captures flat debug.paused payload as inspectData', () => {
    // Regression: backend executor.cpp broadcasts the pause metadata
    // (type, inputs, run_id) flat on the root rather than nested under
    // a `data` key. Without this branch, DebugInputsPanel never sees
    // the inputs and silently renders nothing while the node label
    // says "PAUSED".
    setActiveRunId('run-7-1');
    const inputs = [
      {
        handle: 'input_data',
        source: 'n_src:output_data',
        value: { type: 'tensor', length: 3, preview: [0.1, 0.2, 0.3] },
      },
    ];
    emit('debug.paused', {
      node_id: 'n1',
      type: 'inference',
      inputs,
      run_id: 'run-7-1',
    });
    expect(useDebugStore.getState().pausedAtNodeId).toBe('n1');
    const insp = useDebugStore.getState().inspectData;
    expect(insp).toBeTruthy();
    expect((insp as { inputs?: unknown[] }).inputs).toEqual(inputs);
  });

  it('still accepts legacy nested debug.paused payload', () => {
    // Forward-compat: if the wire schema later wraps everything under
    // a `data` key, the runner should still light up DebugInputsPanel.
    setActiveRunId('run-8-2');
    const nested = {
      type: 'inference',
      inputs: [{ handle: 'x', source: 'a:b', value: { type: 'empty' } }],
    };
    emit('debug.paused', { node_id: 'n1', data: nested, run_id: 'run-8-2' });
    expect(useDebugStore.getState().inspectData).toEqual(nested);
  });
});

describe('WorkflowRunner reconcileFromSnapshot', () => {
  beforeEach(() => {
    capturedHandler = null;
    callMock.mockReset();
    seedNode('n1');
    useDebugStore.setState({ pausedAtNodeId: null });
    initWorkflowRunner();
    setActiveRunId(null);
  });

  it('merges backend snapshot into store and realigns run_id filter', async () => {
    // Simulate backend that finished running while we were offline —
    // a `done` landed that we never saw. Without reconcile, n1 would
    // stay at `idle` forever.
    callMock.mockResolvedValueOnce({
      run_id: 'run-reconnect-1',
      statuses: { n1: 'done' },
    });

    await reconcileFromSnapshot();

    expect(callMock).toHaveBeenCalledWith('workflow.state');
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('done');
    // Snapshot is now the source of truth for the run_id filter —
    // any trailing in-flight events from this run still match.
    expect(_getActiveRunIdForTest()).toBe('run-reconnect-1');
  });

  it('registers paused_at so the debug UI anchors at the right node on reconnect', async () => {
    callMock.mockResolvedValueOnce({
      run_id: 'run-paused',
      statuses: { n1: 'paused' },
      paused_at: 'n1',
    });

    await reconcileFromSnapshot();

    expect(useDebugStore.getState().pausedAtNodeId).toBe('n1');
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('paused');
  });

  it('swallows method-not-found from pre-W1 backends without throwing', async () => {
    // Legacy backends reject `workflow.state` with -32601. The hook
    // must degrade gracefully so reconnecting to an older backend
    // doesn't break the normal event stream.
    callMock.mockRejectedValueOnce(new Error('-32601: Method not found'));

    await expect(reconcileFromSnapshot()).resolves.toBeUndefined();
    // State untouched.
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('idle');
  });
});

describe('WorkflowRunner validation_failed', () => {
  beforeEach(() => {
    capturedHandler = null;
    callMock.mockReset();
    vi.mocked(showToast).mockReset();
    seedNode('n1');
    // Clear log buffer so assertions see only this test's entries.
    useDebugStore.setState({ logs: [] });
    initWorkflowRunner();
    setActiveRunId(null);
  });

  it('paints offending node red, logs each error, and toasts a single summary', () => {
    // Two errors: one scoped to n1 (should paint the canvas red and
    // populate data.error), one scoped to an edge (no node paint,
    // but still must land in the console log).
    emit('node.status', {
      node_id: '__workflow__',
      status: 'validation_failed',
      errors: [
        { kind: 'type_mismatch', message: 'port int != string', node_id: 'n1' },
        {
          kind: 'dangling_edge',
          message: 'edge points at removed node',
          edge: 'n1:out -> ghost:in',
        },
      ],
    });

    const node = useWorkflowStore.getState().nodes[0];
    expect(node.data.status).toBe('error');
    expect(node.data.error).toBe('port int != string');

    const logs = useDebugStore.getState().logs;
    expect(logs).toHaveLength(2);
    expect(logs[0].level).toBe('error');
    expect(logs[0].message).toContain('[type_mismatch]');
    expect(logs[0].message).toContain('(n1)');
    expect(logs[1].message).toContain('[dangling_edge]');
    expect(logs[1].message).toContain('edge n1:out -> ghost:in');

    // One summary toast for the batch — not two.
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast).mock.calls[0][0]).toContain('2 errors');
    expect(vi.mocked(showToast).mock.calls[0][1]).toBe('error');
  });

  it('uses the single error message in the toast when there is exactly one error', () => {
    // A concrete message is more useful than "1 errors"; the
    // console has the detail, but the toast should carry signal too.
    emit('node.status', {
      node_id: '__workflow__',
      status: 'validation_failed',
      errors: [
        { kind: 'unknown_node_type', message: 'no handler for type=bogus', node_id: 'ghost' },
      ],
    });

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('no handler for type=bogus'),
      'error',
    );
    // Node id 'ghost' isn't in the store (unknown_node_type) — must
    // not throw, must not create a phantom entry.
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    expect(useWorkflowStore.getState().nodes[0].id).toBe('n1');
  });

  it('does not touch regular node pipeline — __workflow__ is not a real node id', () => {
    // Regression: if the validation branch ever falls through to the
    // default path, coerceStatus('validation_failed') → 'idle' would
    // silently try to update a non-existent node. We want a clean
    // short-circuit instead.
    emit('node.status', {
      node_id: '__workflow__',
      status: 'validation_failed',
      errors: [],
    });

    // n1 stays idle, no phantom __workflow__ node created.
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe('idle');
    // Empty errors still produces a summary toast so the user sees
    // *something* went wrong (backend emitted the event for a reason).
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});
