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
import { NodePalette } from './panels/NodePalette';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { ConsolePanel } from './panels/ConsolePanel';
import { ToastContainer } from './components/ToastContainer';
import { ReconnectBanner } from './components/ReconnectBanner';
import { NodeContextMenu, type NodeContextMenuState } from './components/NodeContextMenu';
import { showToast } from './store/toastStore';
import { getLayoutedElements } from './utils/layout';
import './App.css';

function AppInner() {
  const { nodes, edges, isRunning, onNodesChange, onEdgesChange, setEdges, setNodes, setSelectedNode, addNode, importWorkflow } =
    useWorkflowStore();
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
      const nodes = useWorkflowStore.getState().nodes;
      const srcNode = nodes.find((n) => n.id === connection.source);
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
  const styledEdges = useMemo(
    () =>
      edges.map((e) => {
        const dataType =
          (e.data?.dataType as string | undefined) ?? 'generic';
        const baseStroke =
          dataType === 'net'
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
          className: `edge-type-${dataType}`,
          style: isRunning
            ? { stroke: baseStroke, strokeWidth: 2.5 }
            : { stroke: baseStroke, strokeWidth: 1.5, opacity: 0.75 },
        };
      }),
    [edges, isRunning],
  );

  const styledNodes = useMemo(() => {
    const bpMap = new Map(breakpoints.map((b) => [b.nodeId, b.enabled]));
    return nodes.map((n) => {
      const data = n.data as unknown as WorkflowNodeData;
      const isSelected = n.id === selectedId;
      const isNodeRunning = data.status === 'running';
      const isPaused = data.status === 'paused';
      const hasBp = bpMap.has(n.id);
      const bpEnabled = bpMap.get(n.id) === true;
      const category = getCategoryClass(n.type ?? '');
      return {
        ...n,
        className: [
          category,
          isSelected ? 'selected' : '',
          isNodeRunning ? 'node-running' : '',
          isPaused ? 'node-paused' : '',
          hasBp ? (bpEnabled ? 'node-bp-armed' : 'node-bp-disabled') : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    });
  }, [nodes, selectedId, breakpoints]);

  const onLayout = useCallback(() => {
    const layouted = getLayoutedElements(nodes, edges);
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
            nodeColor={(node) => {
              const type = node.type ?? '';
              if (['inputImage', 'inputTensor'].includes(type)) return '#2a9d8f';
              if (['createNet', 'inference', 'benchmark'].includes(type)) return '#9b59b6';
              if (['saveText', 'saveImage', 'output'].includes(type)) return '#2ecc71';
              if (type === 'condition') return '#6080c0';
              if (type === 'debug') return '#e0c080';
              return '#444';
            }}
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
  if (['inputImage', 'inputTensor'].includes(type)) return 'node-input';
  if (['createNet', 'inference', 'benchmark'].includes(type)) return 'node-inference';
  if (['saveText', 'saveImage', 'output'].includes(type)) return 'node-output';
  if (type === 'condition') return 'node-control';
  if (type === 'debug') return 'node-debug';
  return '';
}

export default App;
