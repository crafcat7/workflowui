// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * ConsolePanel - toolbar + log area at the bottom of the app.
 *
 * All command logic (run/stop/save/load/…) lives in useWorkflowActions and
 * is shared with the keyboard-shortcut layer. This component is now purely
 * presentational plus connection-state wiring.
 */

import { useEffect, useRef, useState } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { useDebugStore } from '../store/debugStore';
import { wsClient } from '../transport/WsClient';
import type { WorkflowActions } from '../hooks/useWorkflowActions';

interface Props {
  actions: WorkflowActions;
}

export function ConsolePanel({ actions }: Props) {
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const logs = useDebugStore((s) => s.logs);
  const pausedAtNodeId = useDebugStore((s) => s.pausedAtNodeId);
  const breakpoints = useDebugStore((s) => s.breakpoints);

  const logEndRef = useRef<HTMLDivElement>(null);
  const [wsConnected, setWsConnected] = useState(wsClient.connected);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => wsClient.onConnection(setWsConnected), []);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  const armedBpCount = breakpoints.filter((b) => b.enabled).length;

  return (
    <div className={`console-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="console-toolbar">
        <div className="console-toolbar-left">
          <button
            className="console-btn run"
            onClick={() => void actions.run()}
            disabled={isRunning && !pausedAtNodeId}
            title="Run workflow (R) / Resume if paused"
          >
            <span className="btn-icon">▶</span> {pausedAtNodeId ? 'RESUME' : 'RUN'}
          </button>
          <button
            className="console-btn continue"
            onClick={actions.continueExec}
            disabled={!pausedAtNodeId}
            title="Continue execution (until next breakpoint)"
          >
            <span className="btn-icon">⏵</span> CONTINUE
          </button>
          <button
            className="console-btn step"
            onClick={actions.stepOver}
            disabled={!pausedAtNodeId}
            title="Step over (run next node then pause)"
          >
            <span className="btn-icon">⤼</span> STEP
          </button>
          <button
            className="console-btn stop"
            onClick={actions.stop}
            disabled={!isRunning}
            title="Stop workflow"
          >
            <span className="btn-icon">■</span> STOP
          </button>
          <div className="console-separator" />
          <button
            className="console-btn file-op"
            onClick={actions.save}
            title="Save workflow (Cmd/Ctrl+S)"
          >
            SAVE
          </button>
          <button
            className="console-btn file-op"
            onClick={actions.load}
            title="Load workflow (Cmd/Ctrl+O)"
          >
            LOAD
          </button>
        </div>
        <div className="console-toolbar-right">
          {pausedAtNodeId && (
            <span className="console-paused-badge">PAUSED @ {pausedAtNodeId}</span>
          )}
          {armedBpCount > 0 && (
            <span className="console-bp-count" title="Armed breakpoints">
              {armedBpCount} BP
            </span>
          )}
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
