import { useRef, useEffect, useState } from 'react';
import { useWorkflowStore, type WorkflowNodeData } from '../store/workflowStore';
import { useDebugStore } from '../store/debugStore';
import { wsClient } from '../transport/WsClient';
import { showToast } from '../store/toastStore';

export function ConsolePanel() {
  const { isRunning, setRunning, nodes, edges, exportWorkflow, importWorkflow } = useWorkflowStore();
  const { logs, clearLogs, pausedAtNodeId, setPausedAt } = useDebugStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [wsConnected, setWsConnected] = useState(wsClient.connected);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    return wsClient.onConnection(setWsConnected);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

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

    // Filter out isolated nodes (nodes with absolutely no connections)
    // Keep nodes that have at least one incoming or outgoing edge, plus 
    // keep nodes if the entire graph only has 1 node (just to allow a single run)
    const connectedNodeIds = new Set<string>();
    edges.forEach((e) => {
      connectedNodeIds.add(e.source);
      connectedNodeIds.add(e.target);
    });

    const activeNodes = nodes.length === 1 
      ? nodes 
      : nodes.filter((n) => connectedNodeIds.has(n.id));

    if (activeNodes.length === 0) {
      showToast('No connected nodes to execute', 'warn');
      setRunning(false);
      return;
    }

    // Only include debug nodes that are properly connected (have both input and output edges)
    const debugNodeIds = activeNodes
      .filter((n) => n.type === 'debug')
      .filter((n) => {
        const hasInput = edges.some((e) => e.target === n.id);
        const hasOutput = edges.some((e) => e.source === n.id);
        return hasInput && hasOutput;
      })
      .map((n) => n.id);

    try {
      await wsClient.call('workflow.execute', {
        nodes: activeNodes.map((n) => ({
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
        breakpoints: debugNodeIds,
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

  const handleContinue = () => {
    wsClient.notify('debug.continue');
    setPausedAt(null);
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
    <div className={`console-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="console-toolbar">
        <div className="console-toolbar-left">
          <button className="console-btn run" onClick={handleRun} disabled={isRunning} title="Run workflow">
            <span className="btn-icon">▶</span> RUN
          </button>
          <button
            className="console-btn continue"
            onClick={handleContinue}
            disabled={!pausedAtNodeId}
            title="Continue execution"
          >
            <span className="btn-icon">⏵</span> CONTINUE
          </button>
          <button className="console-btn stop" onClick={handleStop} disabled={!isRunning} title="Stop workflow">
            <span className="btn-icon">■</span> STOP
          </button>
          <div className="console-separator" />
          <button className="console-btn file-op" onClick={handleSave} title="Save workflow">
            SAVE
          </button>
          <button className="console-btn file-op" onClick={handleLoad} title="Load workflow">
            LOAD
          </button>
          <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileChange} />
        </div>
        <div className="console-toolbar-right">
          {pausedAtNodeId && (
            <span className="console-paused-badge">PAUSED @ {pausedAtNodeId}</span>
          )}
          {(() => {
            const armed = nodes
              .filter((n) => n.type === 'debug')
              .filter((n) => {
                const hasIn = edges.some((e) => e.target === n.id);
                const hasOut = edges.some((e) => e.source === n.id);
                return hasIn && hasOut;
              }).length;
            return armed > 0 ? (
              <span className="console-bp-count">{armed} BP</span>
            ) : null;
          })()}
          <div className="console-ws-status" title={wsConnected ? 'Connected' : 'Disconnected'}>
            <span className={`ws-dot ${wsConnected ? 'connected' : 'disconnected'}`} />
            {wsConnected ? 'ONLINE' : 'OFFLINE'}
          </div>
          <button className="console-toggle" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? '▲' : '▼'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="console-log-area">
          {logs.length === 0 ? (
            <div className="console-empty">Ready. Press RUN to execute workflow.</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className={`console-log-entry level-${log.level}`}>
                <span className="log-time">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                <span className="log-node">{log.nodeId}</span>{' '}
                <span className="log-msg">{log.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
