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

export interface WorkflowNodeData {
  label: string;
  type: string;
  status: NodeStatus;
  config: Record<string, unknown>;
  elapsedMs?: number;
  output?: unknown;
  [key: string]: unknown;
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
  updateNodeData: (id: string, data: Partial<WorkflowNodeData>) => void;
  updateNodeStatus: (id: string, status: NodeStatus) => void;
  setRunning: (running: boolean) => void;
  clearAll: () => void;
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

      clearAll: () => set({ nodes: [], edges: [], selectedNodeId: null, isRunning: false }),

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
        try {
          const workflow = JSON.parse(jsonStr);
          if (workflow.version !== 1) {
            console.warn('Unknown workflow version:', workflow.version);
          }
          const nodes = (workflow.nodes || []).map((n: Record<string, unknown>) => ({
            ...n,
            data: { ...(n.data as WorkflowNodeData), status: 'idle' as NodeStatus },
          })) as Node<WorkflowNodeData>[];

          const edges = (workflow.edges || []) as Edge[];

          // Update nodeIdCounter to avoid collisions
          for (const n of nodes) {
            const match = n.id.match(/node_(\d+)/);
            if (match) {
              const num = parseInt(match[1], 10);
              if (num >= nodeIdCounter) nodeIdCounter = num + 1;
            }
          }

          set({ nodes, edges, selectedNodeId: null, isRunning: false });
        } catch (e) {
          console.error('Failed to import workflow:', e);
        }
      },
    }),
    {
      partialize: (state) => {
        // Only undo/redo nodes and edges, not isRunning or selectedNodeId
        const { nodes, edges } = state;
        return { nodes, edges };
      },
      limit: 50,
    }
  )
);
