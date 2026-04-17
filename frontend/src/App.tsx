import { useCallback, useRef } from 'react';
import {
  ReactFlow,
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

import { useWorkflowStore, type WorkflowNodeData, generateNodeId } from './store/workflowStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { nodeTypes } from './nodes';
import { NodePalette } from './panels/NodePalette';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { ConsolePanel } from './panels/ConsolePanel';
import { ToastContainer } from './components/ToastContainer';
import { getLayoutedElements } from './utils/layout';
import './App.css';

function App() {
  useKeyboardShortcuts();
  
  const { nodes, edges, isRunning, onNodesChange, onEdgesChange, setEdges, setNodes, setSelectedNode, addNode } = useWorkflowStore();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
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
  }, [setSelectedNode]);

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

      const bounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;

      const position = {
        x: e.clientX - bounds.left - 80,
        y: e.clientY - bounds.top - 20,
      };

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
    [addNode],
  );

  // Add animated class to edges when running, make them smoothstep
  const styledEdges = edges.map((e) => ({
    ...e,
    type: 'smoothstep',
    animated: isRunning,
    style: isRunning ? { stroke: '#60a0ff', strokeWidth: 2 } : { stroke: '#444', strokeWidth: 1.5 },
  }));

  // Add selected + category class to nodes
  const selectedId = useWorkflowStore((s) => s.selectedNodeId);
  const styledNodes = nodes.map((n) => {
    const data = n.data as unknown as WorkflowNodeData;
    const isSelected = n.id === selectedId;
    const isNodeRunning = data.status === 'running';
    const category = getCategoryClass(n.type ?? '');
    return {
      ...n,
      className: [category, isSelected ? 'selected' : '', isNodeRunning ? 'node-running' : ''].filter(Boolean).join(' '),
    };
  });

  const onLayout = useCallback(() => {
    const layouted = getLayoutedElements(nodes, edges);
    setNodes(layouted.nodes as Node<WorkflowNodeData>[]);
    setEdges(() => layouted.edges);
  }, [nodes, edges, setNodes, setEdges]);

  return (
    <div className="app-layout">
      <ToastContainer />
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
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
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
        <ConsolePanel />
      </footer>
    </div>
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
