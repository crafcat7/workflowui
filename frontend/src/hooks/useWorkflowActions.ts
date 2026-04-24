// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * useWorkflowActions - central registry of user-invocable workflow actions.
 *
 * Extracted so the toolbar (ConsolePanel) and the global keyboard shortcut
 * hook can share the exact same code paths. Every action here is tolerant
 * of being invoked in "wrong" states (e.g. deselect when nothing selected,
 * continue when not paused); they surface a toast or no-op rather than
 * throwing, which matters because keyboard shortcuts fire without the
 * guards that disable toolbar buttons.
 */

import { useCallback } from 'react';
import {
  useWorkflowStore,
  type WorkflowNodeData,
} from '../store/workflowStore';
import { useDebugStore, type Breakpoint } from '../store/debugStore';
import { wsClient } from '../transport/WsClient';
import { showToast } from '../store/toastStore';

export interface WorkflowActions {
  run: () => Promise<void>;
  stop: () => void;
  continueExec: () => void;
  stepOver: () => void;
  save: () => void;
  /** Triggers the hidden file picker owned by ConsolePanel. */
  load: () => void;
  duplicateSelected: () => void;
  deleteSelected: () => void;
  deselect: () => void;
  selectAll: () => void;
  toggleBreakpointOnSelected: () => void;
}

/**
 * @param triggerLoad callback wired to a hidden <input type=file> in the
 *                    toolbar; passing undefined makes `load` a no-op.
 */
export function useWorkflowActions(triggerLoad?: () => void): WorkflowActions {
  const run = useCallback(async () => {
    const store = useWorkflowStore.getState();
    const debug = useDebugStore.getState();

    if (store.isRunning) return; // idempotent: already running
    if (!wsClient.connected) {
      showToast('Backend not connected', 'error');
      return;
    }
    if (store.nodes.length === 0) {
      showToast('Add some nodes first', 'warn');
      return;
    }

    store.setRunning(true);
    debug.clearLogs();

    const connected = new Set<string>();
    store.edges.forEach((e) => {
      connected.add(e.source);
      connected.add(e.target);
    });
    const activeNodes =
      store.nodes.length === 1
        ? store.nodes
        : store.nodes.filter((n) => connected.has(n.id));

    if (activeNodes.length === 0) {
      showToast('No connected nodes to execute', 'warn');
      store.setRunning(false);
      return;
    }

    const activeIds = new Set(activeNodes.map((n) => n.id));
    const breakpointIds = debug.breakpoints
      .filter((b: Breakpoint) => b.enabled && activeIds.has(b.nodeId))
      .map((b: Breakpoint) => b.nodeId);

    try {
      await wsClient.call('workflow.execute', {
        nodes: activeNodes.map((n) => ({
          id: n.id,
          type: n.type,
          config: (n.data as unknown as WorkflowNodeData).config,
        })),
        edges: store.edges.map((e) => ({
          source: e.source,
          sourceHandle: e.sourceHandle,
          target: e.target,
          targetHandle: e.targetHandle,
        })),
        breakpoints: breakpointIds,
      });
    } catch (err) {
      showToast(`Execution error: ${(err as Error).message}`, 'error');
      useWorkflowStore.getState().setRunning(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (!useWorkflowStore.getState().isRunning) return;
    wsClient.notify('workflow.stop');
    useWorkflowStore.getState().setRunning(false);
  }, []);

  const continueExec = useCallback(() => {
    const { pausedAtNodeId, setPausedAt } = useDebugStore.getState();
    if (!pausedAtNodeId) return;
    wsClient.notify('debug.continue');
    setPausedAt(null);
  }, []);

  const stepOver = useCallback(() => {
    const { pausedAtNodeId, setPausedAt } = useDebugStore.getState();
    if (!pausedAtNodeId) return;
    wsClient.notify('debug.step_over');
    setPausedAt(null);
  }, []);

  /** Dual-purpose shortcut handler: run if idle, resume if paused. */
  const runOrResume = useCallback(async () => {
    const pausedAt = useDebugStore.getState().pausedAtNodeId;
    if (pausedAt) {
      continueExec();
      return;
    }
    await run();
  }, [run, continueExec]);

  const save = useCallback(() => {
    const json = useWorkflowStore.getState().exportWorkflow();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workflow.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Workflow saved', 'success');
  }, []);

  const load = useCallback(() => {
    if (triggerLoad) triggerLoad();
  }, [triggerLoad]);

  const duplicateSelected = useCallback(() => {
    const { selectedNodeId, duplicateNode } = useWorkflowStore.getState();
    if (!selectedNodeId) return;
    duplicateNode(selectedNodeId);
  }, []);

  const deleteSelected = useCallback(() => {
    const { selectedNodeId, removeNode } = useWorkflowStore.getState();
    if (!selectedNodeId) return;
    removeNode(selectedNodeId);
  }, []);

  const deselect = useCallback(() => {
    useWorkflowStore.getState().setSelectedNode(null);
  }, []);

  const selectAll = useCallback(() => {
    // React Flow tracks selection via node.selected; set them all selected.
    const { nodes, setNodes } = useWorkflowStore.getState();
    if (nodes.length === 0) return;
    setNodes(nodes.map((n) => ({ ...n, selected: true })));
  }, []);

  const toggleBreakpointOnSelected = useCallback(() => {
    const { selectedNodeId, isRunning } = useWorkflowStore.getState();
    if (!selectedNodeId) return;
    const { breakpoints, addBreakpoint, removeBreakpoint } =
      useDebugStore.getState();
    const existing = breakpoints.find((b) => b.nodeId === selectedNodeId);
    if (existing) {
      removeBreakpoint(selectedNodeId);
      if (isRunning) {
        wsClient.notify('debug.remove_breakpoint', { nodeId: selectedNodeId });
      }
    } else {
      addBreakpoint(selectedNodeId);
      if (isRunning) {
        wsClient.notify('debug.add_breakpoint', { nodeId: selectedNodeId });
      }
    }
  }, []);

  return {
    run: runOrResume,
    stop,
    continueExec,
    stepOver,
    save,
    load,
    duplicateSelected,
    deleteSelected,
    deselect,
    selectAll,
    toggleBreakpointOnSelected,
  };
}
