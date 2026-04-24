// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkflowStore } from '../store/workflowStore';

// Capture the notification handler the runner registers so the test
// can play events through it synchronously without a real WebSocket.
let capturedHandler: ((method: string, params: unknown) => void) | null = null;
vi.mock('../transport/WsClient', () => ({
  wsClient: {
    onNotification: vi.fn((cb: (method: string, params: unknown) => void) => {
      capturedHandler = cb;
      return () => { capturedHandler = null; };
    }),
  },
}));

vi.mock('../store/toastStore', () => ({ showToast: vi.fn() }));

// Import AFTER mocks so the runner picks them up.
import { initWorkflowRunner, setActiveRunId } from './WorkflowRunner';

function emit(method: string, params: unknown) {
  if (!capturedHandler) throw new Error('runner not initialised');
  capturedHandler(method, params);
}

describe('WorkflowRunner run_id filter', () => {
  beforeEach(() => {
    capturedHandler = null;
    // Reset store so each test sees node 'n1' starting at 'idle'.
    useWorkflowStore.setState({
      nodes: [
        {
          id: 'n1', type: 'debug', position: { x: 0, y: 0 },
          data: { label: 'n1', type: 'debug', status: 'idle', config: {} },
        },
      ],
      edges: [],
    });
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
