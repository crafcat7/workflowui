// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { create } from 'zustand';
import { temporal } from 'zundo';
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';

export type NodeStatus = 'idle' | 'running' | 'done' | 'error' | 'paused';

/**
 * Fields that represent *runtime* execution state (as opposed to user-authored
 * workflow definition). These are excluded from undo snapshots and from export
 * JSON so that pressing Ctrl+Z after a run undoes the last *edit* rather than
 * the last status tick.
 */
const RUNTIME_DATA_KEYS = ['status', 'elapsedMs', 'output', 'runsCount', 'avgMs'] as const;

export interface WorkflowNodeData {
  label: string;
  type: string;
  status: NodeStatus;
  config: Record<string, unknown>;
  elapsedMs?: number;
  output?: unknown;
  runsCount?: number;
  avgMs?: number;
  [key: string]: unknown;
}

function stripRuntimeFields(data: WorkflowNodeData): WorkflowNodeData {
  const out: Record<string, unknown> = { ...data };
  for (const k of RUNTIME_DATA_KEYS) delete out[k];
  // status is required by the type, so put a neutral value back
  return { ...(out as WorkflowNodeData), status: 'idle' };
}

function stripNodesForSnapshot(nodes: Node<WorkflowNodeData>[]): Node<WorkflowNodeData>[] {
  return nodes.map((n) => ({ ...n, data: stripRuntimeFields(n.data) }));
}

interface WorkflowState {
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;
  isRunning: boolean;

  onNodesChange: OnNodesChange<Node<WorkflowNodeData>>;
  onEdgesChange: OnEdgesChange;
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void;
  setNodes: (nodes: Node<WorkflowNodeData>[]) => void;
  setSelectedNode: (id: string | null) => void;
  addNode: (node: Node<WorkflowNodeData>) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => string | null;
  updateNodeData: (id: string, data: Partial<WorkflowNodeData>) => void;
  updateNodeStatus: (id: string, status: NodeStatus) => void;
  setRunning: (running: boolean) => void;
  exportWorkflow: () => string;
  importWorkflow: (json: string) => void;
}

let nodeIdCounter = 0;
export const generateNodeId = () => `node_${++nodeIdCounter}`;

export const useWorkflowStore = create<WorkflowState>()(
  temporal(
    (set, get) => ({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      isRunning: false,

      onNodesChange: (changes) => {
        set({ nodes: applyNodeChanges(changes, get().nodes) as Node<WorkflowNodeData>[] });
      },

      onEdgesChange: (changes) => {
        set({ edges: applyEdgeChanges(changes, get().edges) });
      },

      setEdges: (updater) => {
        set({ edges: updater(get().edges) });
      },

      setNodes: (nodes) => {
        set({ nodes });
      },

      setSelectedNode: (id) => set({ selectedNodeId: id }),

      addNode: (node) => set({ nodes: [...get().nodes, node] }),

      removeNode: (id) => {
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          edges: get().edges.filter((e) => e.source !== id && e.target !== id),
          selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
        });
      },

      duplicateNode: (id) => {
        const src = get().nodes.find((n) => n.id === id);
        if (!src) return null;
        const newId = generateNodeId();
        const clone: Node<WorkflowNodeData> = {
          ...src,
          id: newId,
          position: { x: src.position.x + 40, y: src.position.y + 40 },
          selected: false,
          // Deep-copy data and strip runtime fields so the clone starts idle.
          data: stripRuntimeFields({ ...(src.data as WorkflowNodeData) }),
        };
        set({ nodes: [...get().nodes, clone], selectedNodeId: newId });
        return newId;
      },

      updateNodeData: (id, data) => {
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...data } } : n,
          ),
        });
      },

      updateNodeStatus: (id, status) => {
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, status } } : n,
          ),
        });
      },

      setRunning: (running) => set({ isRunning: running }),

      exportWorkflow: () => {
        const { nodes, edges } = get();
        const workflow = {
          version: 1,
          nodes: nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data,
          })),
          edges: edges.map((e) => ({
            id: e.id,
            source: e.source,
            sourceHandle: e.sourceHandle,
            target: e.target,
            targetHandle: e.targetHandle,
          })),
        };
        return JSON.stringify(workflow, null, 2);
      },

      importWorkflow: (jsonStr: string) => {
        let workflow: { version?: unknown; nodes?: unknown; edges?: unknown };
        try {
          workflow = JSON.parse(jsonStr);
        } catch (e) {
          throw new Error(`Invalid JSON: ${(e as Error).message}`);
        }
        if (typeof workflow !== 'object' || workflow === null) {
          throw new Error('Workflow root must be an object');
        }
        if (workflow.version !== 1) {
          console.warn('Unknown workflow version:', workflow.version);
        }
        if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
          throw new Error('Workflow must contain `nodes` and `edges` arrays');
        }

        const nodes = (workflow.nodes as Array<Record<string, unknown>>).map((n) => ({
          ...n,
          data: { ...(n.data as WorkflowNodeData), status: 'idle' as NodeStatus },
        })) as Node<WorkflowNodeData>[];

        const edges = workflow.edges as Edge[];

        // Update nodeIdCounter to avoid collisions
        for (const n of nodes) {
          const match = n.id.match(/node_(\d+)/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num >= nodeIdCounter) nodeIdCounter = num + 1;
          }
        }

        set({ nodes, edges, selectedNodeId: null, isRunning: false });
      },
    }),
    {
      partialize: (state) => {
        // Undo/redo only captures the *authored* workflow (nodes + edges with
        // runtime fields stripped) so status ticks during a run do not pollute
        // the history stack.
        return {
          nodes: stripNodesForSnapshot(state.nodes),
          edges: state.edges,
        };
      },
      // Skip snapshot if the authored graph is structurally unchanged (e.g.
      // during runtime status updates, or while a drag is paused).
      equality: (a, b) => {
        const an = a.nodes;
        const bn = b.nodes;
        if (an.length !== bn.length || a.edges.length !== b.edges.length) return false;
        for (let i = 0; i < an.length; i++) {
          const x = an[i];
          const y = bn[i];
          if (x.id !== y.id || x.type !== y.type) return false;
          if (x.position.x !== y.position.x || x.position.y !== y.position.y) return false;
          const xd = x.data as WorkflowNodeData;
          const yd = y.data as WorkflowNodeData;
          if (xd.label !== yd.label) return false;
          if (JSON.stringify(xd.config) !== JSON.stringify(yd.config)) return false;
        }
        for (let i = 0; i < a.edges.length; i++) {
          const x = a.edges[i];
          const y = b.edges[i];
          if (
            x.id !== y.id ||
            x.source !== y.source ||
            x.target !== y.target ||
            x.sourceHandle !== y.sourceHandle ||
            x.targetHandle !== y.targetHandle
          ) {
            return false;
          }
        }
        return true;
      },
      limit: 50,
    }
  )
);

/**
 * Pause undo recording — call on drag start so the whole drag registers as a
 * single history entry rather than one per pointer move.
 */
export function pauseHistory() {
  useWorkflowStore.temporal.getState().pause();
}

/**
 * Resume undo recording. Any subsequent state change will trigger a fresh
 * snapshot via zundo's normal equality-guarded subscription, so the
 * partialized set is consistent with what the user sees.
 */
export function resumeHistory() {
  const t = useWorkflowStore.temporal.getState();
  t.resume();
}
