import { useRef, useState, useEffect } from 'react';
import { useWorkflowStore, type WorkflowNodeData } from '../store/workflowStore';
import { nodeTypeList, type NodeTypeInfo } from '../nodes';
import { generateNodeId } from '../store/workflowStore';
import { wsClient } from '../transport/WsClient';
import { useDebugStore } from '../store/debugStore';
import { showToast } from '../store/toastStore';

const categories = ['input', 'inference', 'output', 'control', 'debug'] as const;
function groupByCategory(list: NodeTypeInfo[]) {
  const groups: Record<string, NodeTypeInfo[]> = {};
  for (const nt of list) {
    (groups[nt.category] ??= []).push(nt);
  }
  return groups;
}

export function Toolbar() {
  const { addNode, isRunning, setRunning, nodes, edges, exportWorkflow, importWorkflow } = useWorkflowStore();
  const { clearLogs } = useDebugStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [wsConnected, setWsConnected] = useState(wsClient.connected);

  useEffect(() => {
    return wsClient.onConnection(setWsConnected);
  }, []);

  const grouped = groupByCategory(nodeTypeList);

  const handleAddNode = (type: string, label: string) => {
    const id = generateNodeId();
    addNode({
      id,
      type,
      position: { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
      data: {
        label,
        type,
        status: 'idle',
        config: {},
      } as WorkflowNodeData,
    });
  };

  const handleRun = async () => {
    if (!wsClient.connected) {
      showToast('Backend not connected', 'error');
      return;
    }
    if (nodes.length === 0) {
      showToast('Add some nodes first', 'warn');
      return;
    }
    setRunning(true);
    clearLogs();
    try {
      await wsClient.call('workflow.execute', {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type,
          config: (n.data as unknown as WorkflowNodeData).config,
        })),
        edges: edges.map((e) => ({
          source: e.source,
          sourceHandle: e.sourceHandle,
          target: e.target,
          targetHandle: e.targetHandle,
        })),
      });
    } catch (err) {
      showToast(`Execution error: ${(err as Error).message}`, 'error');
      setRunning(false);
    }
  };

  const handleStop = () => {
    wsClient.notify('workflow.stop');
    setRunning(false);
  };

  const handleSave = () => {
    const json = exportWorkflow();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workflow.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Workflow saved', 'success');
  };

  const handleLoad = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (text) {
        try {
          importWorkflow(text);
          showToast('Workflow loaded', 'success');
        } catch {
          showToast('Failed to load workflow', 'error');
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="toolbar">
      {/* Node type groups */}
      {categories.map((cat) => {
        const items = grouped[cat];
        if (!items) return null;
        return (
          <div className="toolbar-group" key={cat}>
            {items.map((nt) => (
              <button
                key={nt.type}
                className={`cat-${nt.category}`}
                onClick={() => handleAddNode(nt.type, nt.label)}
                title={`Add ${nt.label} node`}
              >
                {nt.icon} {nt.label}
              </button>
            ))}
          </div>
        );
      })}

      <div className="toolbar-separator" />

      {/* Execution controls */}
      <div className="toolbar-group">
        <button className="run" onClick={handleRun} disabled={isRunning} title="Run workflow">
          ▶ Run
        </button>
        {isRunning && (
          <button className="stop" onClick={handleStop} title="Stop workflow">
            ■ Stop
          </button>
        )}
      </div>

      <div className="toolbar-separator" />

      {/* File operations */}
      <div className="toolbar-group">
        <button className="file-op" onClick={handleSave} title="Save workflow to JSON">
          💾 Save
        </button>
        <button className="file-op" onClick={handleLoad} title="Load workflow from JSON">
          📂 Load
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>

      <div className="toolbar-separator" />

      {/* WS Status */}
      <div className="ws-status" title={wsConnected ? 'Connected to backend' : 'Backend disconnected'}>
        <span className={`ws-dot ${wsConnected ? 'connected' : 'disconnected'}`} />
        {wsConnected ? 'Connected' : 'Offline'}
      </div>
    </div>
  );
}
