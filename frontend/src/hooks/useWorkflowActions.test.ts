// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { useWorkflowActions } from './useWorkflowActions';
import { useWorkflowStore, type WorkflowNodeData } from '../store/workflowStore';
import { useDebugStore } from '../store/debugStore';

vi.mock('../transport/WsClient', () => ({
  wsClient: {
    get connected() {
      return true;
    },
    call: vi.fn().mockResolvedValue({}),
    notify: vi.fn(),
    onConnection: vi.fn(() => () => {}),
  },
}));

vi.mock('../store/toastStore', () => ({
  showToast: vi.fn(),
}));

function makeNode(id: string): Node<WorkflowNodeData> {
  return {
    id,
    type: 'debug',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'debug', status: 'idle', config: {} } as WorkflowNodeData,
  };
}

describe('useWorkflowActions', () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      isRunning: false,
    });
    useDebugStore.setState({
      breakpoints: [],
      pausedAtNodeId: null,
      inspectData: null,
      logs: [],
    });
  });

  it('duplicateSelected no-ops when nothing selected', () => {
    useWorkflowStore.setState({ nodes: [makeNode('a')] });
    const { result } = renderHook(() => useWorkflowActions());
    act(() => result.current.duplicateSelected());
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
  });

  it('duplicateSelected clones the selected node', () => {
    useWorkflowStore.setState({
      nodes: [makeNode('a')],
      selectedNodeId: 'a',
    });
    const { result } = renderHook(() => useWorkflowActions());
    act(() => result.current.duplicateSelected());
    expect(useWorkflowStore.getState().nodes.length).toBe(2);
  });

  it('toggleBreakpointOnSelected adds and removes a breakpoint', () => {
    useWorkflowStore.setState({
      nodes: [makeNode('a')],
      selectedNodeId: 'a',
    });
    const { result } = renderHook(() => useWorkflowActions());
    act(() => result.current.toggleBreakpointOnSelected());
    expect(useDebugStore.getState().breakpoints).toHaveLength(1);
    act(() => result.current.toggleBreakpointOnSelected());
    expect(useDebugStore.getState().breakpoints).toHaveLength(0);
  });

  it('deselect clears selectedNodeId', () => {
    useWorkflowStore.setState({ selectedNodeId: 'a' });
    const { result } = renderHook(() => useWorkflowActions());
    act(() => result.current.deselect());
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull();
  });

  it('selectAll marks all nodes selected', () => {
    useWorkflowStore.setState({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
    });
    const { result } = renderHook(() => useWorkflowActions());
    act(() => result.current.selectAll());
    expect(useWorkflowStore.getState().nodes.every((n) => n.selected)).toBe(true);
  });

  it('run no-ops when already running', async () => {
    useWorkflowStore.setState({ isRunning: true, nodes: [makeNode('a')] });
    const { result } = renderHook(() => useWorkflowActions());
    await act(async () => {
      await result.current.run();
    });
    // Still running, nothing changed
    expect(useWorkflowStore.getState().isRunning).toBe(true);
  });

  it('stop clears isRunning when active', () => {
    useWorkflowStore.setState({ isRunning: true });
    const { result } = renderHook(() => useWorkflowActions());
    act(() => result.current.stop());
    expect(useWorkflowStore.getState().isRunning).toBe(false);
  });

  it('load triggers the provided picker callback', () => {
    const trigger = vi.fn();
    const { result } = renderHook(() => useWorkflowActions(trigger));
    act(() => result.current.load());
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
