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
      return () => { capturedHandler = null; };
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
import { initWorkflowRunner, setActiveRunId, _getActiveRunIdForTest, reconcileFromSnapshot } from './WorkflowRunner';
import { useDebugStore } from '../store/debugStore';

function emit(method: string, params: unknown) {
  if (!capturedHandler) throw new Error('runner not initialised');
  capturedHandler(method, params);
}

function seedNode(id: string) {
  // F1 contract: nodes + nodesById must be seeded together. Without
  // the cache entry, reconcileFromSnapshot skips this node (it can't
  // tell a real unknown id from a test that forgot to wire things up).
  const node = {
    id, type: 'debug', position: { x: 0, y: 0 },
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
