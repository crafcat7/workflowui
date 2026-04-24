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
    nodesById: new Map(),
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

describe('workflowStore removeNode / duplicateNode', () => {
  beforeEach(resetStore);

  function seedTwoConnectedNodes() {
    const s = useWorkflowStore.getState();
    s.addNode({
      id: 'a',
      type: 'inputImage',
      position: { x: 0, y: 0 },
      data: { label: 'a', type: 'inputImage', status: 'idle', config: {} } as WorkflowNodeData,
    });
    s.addNode({
      id: 'b',
      type: 'output',
      position: { x: 100, y: 0 },
      data: { label: 'b', type: 'output', status: 'idle', config: {} } as WorkflowNodeData,
    });
    useWorkflowStore.setState({
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    });
  }

  it('removeNode also removes edges touching the node', () => {
    seedTwoConnectedNodes();
    useWorkflowStore.getState().removeNode('a');
    const { nodes, edges } = useWorkflowStore.getState();
    expect(nodes.map((n) => n.id)).toEqual(['b']);
    expect(edges).toHaveLength(0);
  });

  it('removeNode clears selection if the removed node was selected', () => {
    seedTwoConnectedNodes();
    useWorkflowStore.getState().setSelectedNode('a');
    useWorkflowStore.getState().removeNode('a');
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull();
  });

  it('duplicateNode offsets position and strips runtime fields', () => {
    const s = useWorkflowStore.getState();
    s.addNode({
      id: 'a',
      type: 'inputImage',
      position: { x: 10, y: 20 },
      data: {
        label: 'a',
        type: 'inputImage',
        status: 'done',
        config: { filePath: '/x.jpg' },
        elapsedMs: 42,
        output: [1, 2, 3],
      } as WorkflowNodeData,
    });
    const newId = s.duplicateNode('a');
    expect(newId).toBeTruthy();
    const clone = useWorkflowStore.getState().getNodeById(newId!)!;
    expect(clone.position).toEqual({ x: 50, y: 60 });
    const d = clone.data as WorkflowNodeData;
    expect(d.status).toBe('idle');
    expect(d.elapsedMs).toBeUndefined();
    expect(d.output).toBeUndefined();
    expect(d.config).toEqual({ filePath: '/x.jpg' });
  });

  it('duplicateNode returns null for unknown id', () => {
    expect(useWorkflowStore.getState().duplicateNode('nope')).toBeNull();
  });
});

describe('workflowStore nodesById cache', () => {
  beforeEach(resetStore);

  // Shared factory for the trio of tests below — cache correctness
  // is a cross-cutting invariant, not something one scenario owns.
  const seedNode = (id: string): void => {
    useWorkflowStore.getState().addNode({
      id,
      type: 'inputImage',
      position: { x: 0, y: 0 },
      data: { label: id, type: 'inputImage', status: 'idle', config: {} } as WorkflowNodeData,
    });
  };

  it('getNodeById returns the node after addNode and undefined for unknown ids', () => {
    // The whole point of the F1 cache is to replace an O(n) `.find`
    // with an O(1) Map lookup; verify the selector actually resolves
    // the seeded node and reports `undefined` (not `null`) for misses.
    seedNode('a');
    const s = useWorkflowStore.getState();
    expect(s.getNodeById('a')?.id).toBe('a');
    expect(s.getNodeById('missing')).toBeUndefined();
  });

  it('keeps nodesById in sync across addNode / updateNodeStatus / removeNode', () => {
    // Every mutator is supposed to rebuild nodesById; this test
    // pins that invariant across the three shapes of mutation
    // (append, mutate-in-place, delete) so a future refactor that
    // forgets one path fails loudly instead of silently returning
    // stale references.
    seedNode('a');
    seedNode('b');
    useWorkflowStore.getState().updateNodeStatus('a', 'running');

    const afterUpdate = useWorkflowStore.getState();
    expect(afterUpdate.getNodeById('a')?.data.status).toBe('running');
    // Cache entry must be the same object reference as the array
    // element — otherwise selectors would tear against the canvas.
    expect(afterUpdate.getNodeById('a')).toBe(
      afterUpdate.nodes.find((n) => n.id === 'a'),
    );

    useWorkflowStore.getState().removeNode('a');
    const afterRemove = useWorkflowStore.getState();
    expect(afterRemove.getNodeById('a')).toBeUndefined();
    expect(afterRemove.getNodeById('b')?.id).toBe('b');
    expect(afterRemove.nodesById.size).toBe(afterRemove.nodes.length);
  });

  it('rebuilds nodesById after importWorkflow', () => {
    // importWorkflow replaces the whole array; the cache must be
    // regenerated from the imported nodes, not merged with the old
    // state (which would resurrect dead ids).
    seedNode('stale');
    const payload = JSON.stringify({
      version: 1,
      nodes: [
        {
          id: 'fresh',
          type: 'inputImage',
          position: { x: 1, y: 2 },
          data: { label: 'fresh', type: 'inputImage', status: 'idle', config: {} },
        },
      ],
      edges: [],
    });
    useWorkflowStore.getState().importWorkflow(payload);
    const s = useWorkflowStore.getState();
    expect(s.getNodeById('stale')).toBeUndefined();
    expect(s.getNodeById('fresh')?.id).toBe('fresh');
    expect(s.nodesById.size).toBe(1);
  });
});
