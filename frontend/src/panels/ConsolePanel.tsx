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

const btnIconProps = {
  width: 12,
  height: 12,
  viewBox: '0 0 24 24',
  fill: 'currentColor',
  stroke: 'none',
  'aria-hidden': 'true' as const,
};

interface Props {
  actions: WorkflowActions;
}

// How many pixels from the bottom still counts as "the user is
// following the tail". Anything larger means they have intentionally
// scrolled up to read something; we then freeze autoscroll so we
// don't yank the scrollbar out from under them on the next log.
const AUTOSCROLL_STICK_PX = 32;

export function ConsolePanel({ actions }: Props) {
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const logs = useDebugStore((s) => s.logs);
  const pausedAtNodeId = useDebugStore((s) => s.pausedAtNodeId);
  const breakpoints = useDebugStore((s) => s.breakpoints);

  const logAreaRef = useRef<HTMLDivElement>(null);
  const [wsConnected, setWsConnected] = useState(wsClient.connected);
  const [collapsed, setCollapsed] = useState(false);
  // Whether to keep snapping to the tail on new logs. Flipped false
  // when the user scrolls up by more than AUTOSCROLL_STICK_PX, and
  // back to true when they scroll back down into the stick zone.
  const [autoscroll, setAutoscroll] = useState(true);

  useEffect(() => wsClient.onConnection(setWsConnected), []);

  // Autoscroll effect: jump to bottom whenever logs grow, BUT only
  // if the user is still anchored to the bottom. `behavior: 'auto'`
  // (instant) replaces the old smooth scroll, which visibly lagged
  // behind the log stream during bursts and produced a laggy feel.
  useEffect(() => {
    if (!autoscroll) return;
    const el = logAreaRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs.length, autoscroll]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const anchored = distanceFromBottom <= AUTOSCROLL_STICK_PX;
    // Only flip state when the observable condition changes to avoid
    // causing a re-render on every wheel event.
    setAutoscroll((prev) => (prev === anchored ? prev : anchored));
  };

  const armedBpCount = breakpoints.filter((b) => b.enabled).length;

  return (
    <div className={`console-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="console-toolbar" role="toolbar" aria-label="Workflow execution controls">
        <div className="console-toolbar-left">
          <button
            className="console-btn run"
            onClick={() => void actions.run()}
            disabled={isRunning && !pausedAtNodeId}
            aria-label={pausedAtNodeId ? 'Resume workflow' : 'Run workflow'}
            title="Run workflow (R) / Resume if paused"
          >
            <svg {...btnIconProps}>
              <polygon points="5 3 19 12 5 21" />
            </svg>{' '}
            {pausedAtNodeId ? 'RESUME' : 'RUN'}
          </button>
          <button
            className="console-btn continue"
            onClick={actions.continueExec}
            disabled={!pausedAtNodeId}
            aria-label="Continue until next breakpoint"
            title="Continue execution (until next breakpoint)"
          >
            <svg {...btnIconProps}>
              <polygon points="5 4 15 12 5 20" />
              <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" />
            </svg>{' '}
            CONTINUE
          </button>
          <button
            className="console-btn step"
            onClick={actions.stepOver}
            disabled={!pausedAtNodeId}
            aria-label="Step over to next node"
            title="Step over (run next node then pause)"
          >
            <svg {...btnIconProps}>
              <polygon points="5 4 15 12 5 20" />
              <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" />
            </svg>{' '}
            STEP
          </button>
          <button
            className="console-btn stop"
            onClick={actions.stop}
            disabled={!isRunning}
            aria-label="Stop workflow"
            title="Stop workflow"
          >
            <svg {...btnIconProps}>
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>{' '}
            STOP
          </button>
          <div className="console-separator" aria-hidden="true" />
          <button
            className="console-btn file-op"
            onClick={actions.save}
            aria-label="Save workflow"
            title="Save workflow (Cmd/Ctrl+S)"
          >
            <svg {...btnIconProps}>
              <path
                d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points="7 10 12 15 17 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" strokeWidth="2" />
            </svg>{' '}
            SAVE
          </button>
          <button
            className="console-btn file-op"
            onClick={actions.load}
            aria-label="Load workflow"
            title="Load workflow (Cmd/Ctrl+O)"
          >
            <svg {...btnIconProps}>
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>{' '}
            LOAD
          </button>
        </div>
        <div className="console-toolbar-right">
          {pausedAtNodeId && (
            <span className="console-paused-badge" role="status">
              PAUSED @ {pausedAtNodeId}
            </span>
          )}
          {armedBpCount > 0 && (
            <span className="console-bp-count" title="Armed breakpoints">
              {armedBpCount} BP
            </span>
          )}
          {/* Connection / pause state cluster. Identity tag (build
              version) was previously here; removed because it added
              visual noise without supporting any user task. */}
          <span className="console-status-label" aria-hidden="true">
            STATUS
          </span>
          <span
            className={`console-status-value ${isRunning ? 'running' : pausedAtNodeId ? 'paused' : 'ready'}`}
          >
            {isRunning && !pausedAtNodeId ? 'RUNNING' : pausedAtNodeId ? 'PAUSED' : 'READY'}
          </span>
          <div
            className="console-ws-status"
            role="status"
            aria-label={wsConnected ? 'Backend connected' : 'Backend disconnected'}
            title={wsConnected ? 'Connected' : 'Disconnected'}
          >
            <span
              className={`ws-dot ${wsConnected ? 'connected' : 'disconnected'}`}
              aria-hidden="true"
            />
            {wsConnected ? 'ONLINE' : 'OFFLINE'}
          </div>
          <button
            className="console-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand console log area' : 'Collapse console log area'}
            aria-expanded={!collapsed}
          >
            <span aria-hidden="true">{collapsed ? '▲' : '▼'}</span>
          </button>
        </div>
      </div>
      {!collapsed && (
        <div
          ref={logAreaRef}
          className="console-log-area"
          onScroll={handleScroll}
          // role=log + polite lets screen readers announce new lines
          // without interrupting. aria-atomic=false means each new
          // addition announces alone rather than re-reading the
          // whole log on every append.
          role="log"
          aria-live="polite"
          aria-atomic="false"
          aria-label="Execution log"
        >
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
        </div>
      )}
      {!collapsed && !autoscroll && logs.length > 0 && (
        // Surfaced when the user has scrolled up. Clicking snaps
        // back to tail AND re-arms autoscroll. Mirrors the classic
        // chat-app "Jump to latest" affordance.
        <button
          type="button"
          className="console-autoscroll-resume"
          onClick={() => {
            const el = logAreaRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setAutoscroll(true);
          }}
          aria-label="Resume autoscroll and jump to latest log"
        >
          ↓ JUMP TO LATEST
        </button>
      )}
    </div>
  );
}
