import { useState } from 'react';
import { useDebugStore } from '../store/debugStore';
import { wsClient } from '../transport/WsClient';

export function DebugPanel() {
  const { breakpoints, pausedAtNodeId, inspectData, logs, setPausedAt } = useDebugStore();
  const [collapsed, setCollapsed] = useState(false);

  const handleContinue = () => {
    wsClient.notify('debug.continue');
    setPausedAt(null);
  };

  const handleStepOver = () => {
    wsClient.notify('debug.step_over');
    setPausedAt(null);
  };

  return (
    <div className={`panel-container ${collapsed ? 'collapsed' : ''}`} style={{ maxWidth: 340 }}>
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <h3>
          Debug
          {pausedAtNodeId && <span style={{ color: '#e0c080', marginLeft: 6, fontSize: 10 }}>PAUSED</span>}
        </h3>
        <button className="collapse-btn">{collapsed ? '▸' : '▾'}</button>
      </div>
      <div className="panel-body">
        {pausedAtNodeId && (
          <div className="debug-paused-banner">
            <div className="paused-label">
              Paused at: {pausedAtNodeId}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="debug-btn continue" onClick={handleContinue}>
                ▶ Continue
              </button>
              <button className="debug-btn step" onClick={handleStepOver}>
                ⏭ Step Over
              </button>
            </div>
          </div>
        )}

        {inspectData && (
          <div className="debug-inspect">
            <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>Inspect Data:</div>
            <pre>{JSON.stringify(inspectData, null, 2)}</pre>
          </div>
        )}

        <div style={{ fontSize: 10, color: '#666', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
          <span>Breakpoints: {breakpoints.filter((b) => b.enabled).length}</span>
          <span>Logs: {logs.length}</span>
        </div>

        <div style={{ maxHeight: 180, overflow: 'auto' }}>
          {logs.slice(-30).map((log, i) => (
            <div key={i} className={`debug-log-entry level-${log.level}`}>
              <span className="log-time">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
              <span className="log-node">{log.nodeId}</span>: {log.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
