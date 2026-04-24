// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkflowStore, type WorkflowNodeData } from './workflowStore';

/**
 * Regression tests for Phase 1 store changes:
 *   - runtime fields stripped from undo snapshots
 *   - importWorkflow throws on malformed input
 *   - equality dedupes history entries on runtime-only changes
 */

function resetStore() {
  useWorkflowStore.setState({
    nodes: [],
    edges: [],
    selectedNodeId: null,
    isRunning: false,
  });
  useWorkflowStore.temporal.getState().clear();
}

describe('workflowStore undo snapshots', () => {
  beforeEach(resetStore);

  it('does not push a new history entry when only node status changes', () => {
    const state = useWorkflowStore.getState();
    state.addNode({
      id: 'node_1',
      type: 'inputImage',
      position: { x: 0, y: 0 },
      data: { label: 'img', type: 'inputImage', status: 'idle', config: {} } as WorkflowNodeData,
    });
    const before = useWorkflowStore.temporal.getState().pastStates.length;

    // Simulate backend status ticks
    state.updateNodeStatus('node_1', 'running');
    state.updateNodeStatus('node_1', 'done');
    state.updateNodeData('node_1', { elapsedMs: 42 });

    const after = useWorkflowStore.temporal.getState().pastStates.length;
    expect(after).toBe(before);
  });

  it('pushes a history entry when the user edits config', () => {
    const state = useWorkflowStore.getState();
    state.addNode({
      id: 'node_1',
      type: 'inputImage',
      position: { x: 0, y: 0 },
      data: { label: 'img', type: 'inputImage', status: 'idle', config: {} } as WorkflowNodeData,
    });
    const before = useWorkflowStore.temporal.getState().pastStates.length;

    state.updateNodeData('node_1', { config: { filePath: '/tmp/x.jpg' } });

    const after = useWorkflowStore.temporal.getState().pastStates.length;
    expect(after).toBeGreaterThan(before);
  });
});

describe('workflowStore importWorkflow', () => {
  beforeEach(resetStore);

  it('throws on invalid JSON', () => {
    expect(() => useWorkflowStore.getState().importWorkflow('{not json')).toThrow(/Invalid JSON/);
  });

  it('throws when nodes/edges are missing', () => {
    expect(() => useWorkflowStore.getState().importWorkflow('{"version":1}')).toThrow(
      /nodes.*edges/i,
    );
  });

  it('accepts a well-formed workflow', () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        {
          id: 'node_99',
          type: 'inputImage',
          position: { x: 10, y: 20 },
          data: { label: 'img', type: 'inputImage', status: 'idle', config: {} },
        },
      ],
      edges: [],
    });
    useWorkflowStore.getState().importWorkflow(json);
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    expect(useWorkflowStore.getState().nodes[0].id).toBe('node_99');
  });
});
