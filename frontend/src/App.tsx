// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Controls,
  ControlButton,
  MiniMap,
  Background,
  BackgroundVariant,
  addEdge,
  MarkerType,
  type Connection,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  useWorkflowStore,
  type WorkflowNodeData,
  generateNodeId,
  pauseHistory,
  resumeHistory,
} from './store/workflowStore';
import { useDebugStore } from './store/debugStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useWorkflowActions } from './hooks/useWorkflowActions';
import { nodeTypes } from './nodes';
import { validateConnection, getPort } from './nodes/portSchema';
import { CATEGORY_VISUALS, getManifestEntry } from './nodes/manifest';
import { NodePalette } from './panels/NodePalette';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { ConsolePanel } from './panels/ConsolePanel';
import { ToastContainer } from './components/ToastContainer';
import { ReconnectBanner } from './components/ReconnectBanner';
import { NodeContextMenu, type NodeContextMenuState } from './components/NodeContextMenu';
import { showToast } from './store/toastStore';
import { getLayoutedElements, domNodeHeightMeasurer } from './utils/layout';
import { findCyclicEdges } from './utils/cycles';
import './App.css';

function AppInner() {
  // Subscribe with atomic selectors instead of destructuring the whole
  // store. The previous form (`useWorkflowStore()` returning the entire
  // state object) re-rendered AppInner on EVERY store mutation —
  // status ticks during a run, every cursor-drag node-position update,
  // every log line append elsewhere — causing ReactFlow to receive
  // newly-built `styledNodes`/`styledEdges` arrays even when nothing
  // visible changed. Per-field selectors limit re-renders to the
  // exact fields this component actually reads.
  //
  // Action references (onNodesChange, setEdges, ...) are stable across
  // renders because they're created once inside zustand's `create()`
  // factory; selecting them individually is cheap and avoids the
  // identity churn of returning a fresh `{...}` per render.
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkflowStore((s) => s.onEdgesChange);
  const setEdges = useWorkflowStore((s) => s.setEdges);
  const setNodes = useWorkflowStore((s) => s.setNodes);
  const setSelectedNode = useWorkflowStore((s) => s.setSelectedNode);
  const addNode = useWorkflowStore((s) => s.addNode);
  const importWorkflow = useWorkflowStore((s) => s.importWorkflow);
  const selectedId = useWorkflowStore((s) => s.selectedNodeId);
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [contextMenu, setContextMenu] = useState<NodeContextMenuState | null>(null);

  // Hidden file input shared by toolbar Load button and Cmd+O shortcut.
  const triggerLoad = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        if (!text) return;
        try {
          importWorkflow(text);
          showToast('Workflow loaded', 'success');
        } catch (err) {
          showToast(`Failed to load workflow: ${(err as Error).message}`, 'error');
        }
      };
      reader.onerror = () => showToast('Could not read file', 'error');
      reader.readAsText(file);
    },
    [importWorkflow],
  );

  const actions = useWorkflowActions(triggerLoad);
  useKeyboardShortcuts({ actions, fitView: () => fitView({ duration: 300 }) });

  const lastRejectionRef = useRef<string | null>(null);

  const isValidConnection = useCallback(
    (c: Connection | { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      const conn = {
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle ?? null,
        targetHandle: c.targetHandle ?? null,
      };
      const result = validateConnection(conn, useWorkflowStore.getState().nodes);
      if (!result.ok) lastRejectionRef.current = result.reason ?? 'invalid connection';
      return result.ok;
    },
    [],
  );

  const onConnectStart = useCallback(() => {
    lastRejectionRef.current = null;
  }, []);

  const onConnectEnd = useCallback(() => {
    // Fires after both successful and failed drops. Only surface a toast
    // if the user actually attempted an invalid drop during this gesture.
    if (lastRejectionRef.current) {
      showToast(lastRejectionRef.current, 'warn');
      lastRejectionRef.current = null;
    }
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      // Tag each edge with its source data type so the stylesheet can color
      // it (and so backend can route metadata later).
      const srcNode = useWorkflowStore.getState().nodesById.get(connection.source ?? '');
      const srcPort = getPort(srcNode?.type, connection.sourceHandle);
      setEdges((eds) =>
        addEdge(
          { ...connection, data: { dataType: srcPort?.dataType ?? 'generic' } },
          eds,
        ),
      );
    },
    [setEdges],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNode(node.id);
    },
    [setSelectedNode],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setContextMenu(null);
  }, [setSelectedNode]);

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault();
      setSelectedNode(node.id);
      setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
    },
    [setSelectedNode],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('application/reactflow-type');
      const label = e.dataTransfer.getData('application/reactflow-label');
      if (!type) return;

      // Convert screen coordinates to flow coordinates so the drop point
      // remains accurate under zoom/pan.
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });

      const id = generateNodeId();
      addNode({
        id,
        type,
        position,
        data: {
          label,
          type,
          status: 'idle',
          config: {},
        } as WorkflowNodeData,
      });
    },
    [addNode, screenToFlowPosition],
  );

  // Pause undo history during drag so the entire drag is one history entry.
  const onNodeDragStart = useCallback(() => {
    pauseHistory();
  }, []);
  const onNodeDragStop = useCallback(() => {
    resumeHistory();
  }, []);

  // Memoize decorated arrays to keep ReactFlow's node/edge identities stable
  // across unrelated renders (status ticks, selection changes).
  const cyclicEdgeIds = useMemo(() => findCyclicEdges(edges), [edges]);
  const styledEdges = useMemo(
    () =>
      edges.map((e) => {
        const dataType =
          (e.data?.dataType as string | undefined) ?? 'generic';
        const isCyclic = cyclicEdgeIds.has(e.id);
        const baseStroke = isCyclic
          ? '#ff4040'
          : dataType === 'net'
            ? '#c080ff'
            : dataType === 'image'
            ? '#60c090'
            : dataType === 'tensor'
            ? '#60a0ff'
            : dataType === 'branch'
            ? '#e0c060'
            : '#808090';
        return {
          ...e,
          type: 'smoothstep',
          animated: isRunning,
          className: isCyclic ? 'edge-cyclic' : undefined,
          // Cyclic edges are visually emphatic regardless of run state
          // so the user can spot them before hitting Run: thicker
          // stroke, no opacity fade, and a short dash so the colour
          // doesn't blend with normal red error indicators elsewhere
          // in the UI.
          style: isCyclic
            ? { stroke: baseStroke, strokeWidth: 3, strokeDasharray: '6 3' }
            : isRunning
            ? { stroke: baseStroke, strokeWidth: 2.5 }
            : { stroke: baseStroke, strokeWidth: 1.5, opacity: 0.75 },
          // Arrow heads make data-flow direction unambiguous —
          // smoothstep paths can otherwise look bidirectional at a
          // glance, especially on tight loops. Colour matches the
          // stroke so the marker reads as a continuation of the
          // line, not a separate decoration. Slightly larger when
          // the run is in flight so the moving arrow is the eye's
          // first stop.
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: baseStroke,
            width: isRunning ? 18 : 14,
            height: isRunning ? 18 : 14,
          },
        };
      }),
    [edges, isRunning, cyclicEdgeIds],
  );

  // Per-node className cache. Recomputing the className string +
  // 5-piece array.filter().join(' ') for every node on every status
  // tick dominated frame time on graphs >100 nodes — every
  // updateNodeStatus rebuilds `nodes` (mutators map a fresh array),
  // which busted this memo and forced N rebuilds even though only
  // one node's status actually changed. Cache by node id keyed on
  // the small tuple that actually drives the className, and reuse
  // the prior string when the tuple is unchanged. The cached object
  // identity also lets ReactFlow skip per-node re-render work for
  // unchanged nodes.
  const styledNodeCacheRef = useRef(
    new Map<
      string,
      { key: string; className: string }
    >(),
  );

  const styledNodes = useMemo(() => {
    const bpMap = new Map(breakpoints.map((b) => [b.nodeId, b.enabled]));
    const cache = styledNodeCacheRef.current;
    const seen = new Set<string>();
    const out = nodes.map((n) => {
      const data = n.data as unknown as WorkflowNodeData;
      const isSelected = n.id === selectedId;
      const status = data.status;
      const hasBp = bpMap.has(n.id);
      const bpEnabled = bpMap.get(n.id) === true;
      const category = getCategoryClass(n.type ?? '');
      // Compact key: any change in this tuple changes the className
      // string. Cheap to compute (no allocs beyond the string concat
      // the JS engine inlines) and stable across status ticks that
      // don't touch this node.
      const key = `${category}|${status ?? ''}|${isSelected ? 1 : 0}|${
        hasBp ? (bpEnabled ? 'a' : 'd') : 'n'
      }`;
      seen.add(n.id);
      let cached = cache.get(n.id);
      if (!cached || cached.key !== key) {
        const className = computeNodeClassName({
          category,
          status,
          selected: isSelected,
          hasBp,
          bpEnabled,
        });
        cached = { key, className };
        cache.set(n.id, cached);
      }
      return { ...n, className: cached.className };
    });
    // Drop entries for nodes that no longer exist so the cache can't
    // grow without bound across imports/undo/redo cycles.
    if (seen.size !== cache.size) {
      for (const id of cache.keys()) {
        if (!seen.has(id)) cache.delete(id);
      }
    }
    return out;
  }, [nodes, selectedId, breakpoints]);

  const onLayout = useCallback(() => {
    // Measure each node's live rendered height so dagre can avoid
    // overlapping tall cards (inference, postprocess) with their
    // vertical neighbors. Falls back to the static 350px default
    // when a node isn't mounted yet (shouldn't normally happen on
    // user-triggered layout, but keeps the contract total).
    const layouted = getLayoutedElements(nodes, edges, 'LR', domNodeHeightMeasurer());
    setNodes(layouted.nodes as Node<WorkflowNodeData>[]);
    setEdges(() => layouted.edges);
  }, [nodes, edges, setNodes, setEdges]);

  return (
    <div className="app-layout">
      <ToastContainer />
      <ReconnectBanner />
      {/* Left Sidebar - Node Palette */}
      <aside className="left-sidebar">
        <NodePalette />
      </aside>

      {/* Center - ReactFlow Canvas */}
      <main className="canvas-area" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={styledNodes}
          edges={styledEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onNodeClick={onNodeClick}
          onNodeContextMenu={onNodeContextMenu}
          onPaneClick={onPaneClick}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeTypes={nodeTypes}
          fitView
          colorMode="dark"
        >
          <Controls position="bottom-left">
            <ControlButton onClick={onLayout} title="Auto Layout">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M4 4h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 10h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 16h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4z"/>
              </svg>
            </ControlButton>
          </Controls>
          <MiniMap
            nodeColor={(node) => nodeCategory(node.type).miniMapColor}
            maskColor="rgba(13, 21, 38, 0.8)"
            style={{ background: '#0d1526', borderRadius: 6, border: '1px solid #2a2a4a' }}
          />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#333" />
          {nodes.length === 0 && (
            <div className="empty-state">
              <h2>Workflow Canvas</h2>
              <p>Drag nodes from the left panel to build your inference pipeline</p>
            </div>
          )}
        </ReactFlow>
      </main>

      {/* Right Sidebar - Properties */}
      <aside className="right-sidebar">
        <PropertiesPanel />
      </aside>

      {/* Bottom - Console */}
      <footer className="bottom-console">
        <ConsolePanel actions={actions} />
      </footer>

      {/* Hidden file input driven by Cmd+O / toolbar Load */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />

      {contextMenu && (
        <NodeContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}

function App() {
  return (
    <ReactFlowProvider>
      <AppInner />
    </ReactFlowProvider>
  );
}

function getCategoryClass(type: string): string {
  return nodeCategory(type).cssClass;
}

/**
 * Pure className builder used by the styledNodes memo. Exported for
 * unit-test coverage so the cache key in `styledNodes` and the
 * resulting className stay in sync — a regression in either side
 * would silently degrade the badge styling without any test catching
 * it (the visual diff is too small for snapshot tests, the bug is
 * cache-correctness not visual).
 *
 * The output deliberately preserves token order so existing CSS
 * selectors that key on adjacency (`.inference.node-running`) keep
 * matching, and skips empty tokens so the className doesn't gain
 * trailing whitespace as conditions toggle off.
 */
export function computeNodeClassName(args: {
  category: string;
  status: string | undefined;
  selected: boolean;
  hasBp: boolean;
  bpEnabled: boolean;
}): string {
  const { category, status, selected, hasBp, bpEnabled } = args;
  return [
    category,
    selected ? 'selected' : '',
    status === 'running' ? 'node-running' : '',
    status === 'paused' ? 'node-paused' : '',
    hasBp ? (bpEnabled ? 'node-bp-armed' : 'node-bp-disabled') : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Node category visuals (minimap color + CSS class) come from the
 * single manifest in `nodes/manifest.ts`. Unknown / missing types fall
 * back to the default.
 */
interface NodeCategory {
  miniMapColor: string;
  cssClass: string;
}

const DEFAULT_NODE_CATEGORY: NodeCategory = { miniMapColor: '#444', cssClass: '' };

function nodeCategory(type: string | undefined): NodeCategory {
  const entry = getManifestEntry(type);
  if (!entry) return DEFAULT_NODE_CATEGORY;
  const visual = CATEGORY_VISUALS[entry.category];
  return { miniMapColor: visual.color, cssClass: visual.cssClass };
}

export default App;
