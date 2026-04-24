// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * WorkflowRunner - handles notification events from the backend
 * during workflow execution, updating node states accordingly.
 */

import { wsClient } from '../transport/WsClient';
import { useWorkflowStore, type NodeStatus } from '../store/workflowStore';
import { useDebugStore } from '../store/debugStore';
import { showToast } from '../store/toastStore';

interface NodeStatusUpdate {
  node_id: string;
  status: string;
  elapsed_ms?: number;
  output?: unknown;
  error?: string;
  /** Typed error kind from backend NodeError (missing_input, invalid_config, runtime, upstream_failed). */
  kind?: string;
  /** For status=='skipped': why. Either 'branch_pruned' or 'upstream_failed'. */
  reason?: string;
  /** For status=='skipped' with reason=='upstream_failed': which node failed. */
  upstream?: string;
  runs_count?: number;
  avg_ms?: number;
}

interface DebugPausedEvent {
  node_id: string;
  data: Record<string, unknown>;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['idle', 'running', 'done', 'error', 'paused', 'skipped']);

function coerceStatus(raw: string): NodeStatus {
  return (VALID_STATUSES.has(raw) ? raw : 'idle') as NodeStatus;
}

/**
 * Initialize notification handlers. Call once at app startup.
 */
export function initWorkflowRunner() {
  wsClient.onNotification((method, params) => {
    switch (method) {
      case 'node.status': {
        const update = params as NodeStatusUpdate;
        const store = useWorkflowStore.getState();
        store.updateNodeStatus(update.node_id, coerceStatus(update.status));

        const dataUpdate: Record<string, unknown> = {};
        if (update.elapsed_ms !== undefined) dataUpdate.elapsedMs = update.elapsed_ms;
        if (update.output !== undefined) dataUpdate.output = update.output;
        if (update.runs_count !== undefined) dataUpdate.runsCount = update.runs_count;
        if (update.avg_ms !== undefined) dataUpdate.avgMs = update.avg_ms;

        if (Object.keys(dataUpdate).length > 0) {
          store.updateNodeData(update.node_id, dataUpdate);
        }

        useDebugStore.getState().addLog({
          nodeId: update.node_id,
          message: buildLogMessage(update),
          level: update.error ? 'error' : update.status === 'skipped' ? 'warn' : 'info',
          data: update.output,
        });

        // Surface errors prominently — the bottom console is often collapsed.
        // Skipped nodes are *consequences* of an upstream error that already
        // toasted, so don't double-notify.
        if (update.error) {
          const prefix = update.kind ? `${update.kind}: ` : '';
          showToast(`[${update.node_id}] ${prefix}${update.error}`, 'error');
        }
        break;
      }

      case 'debug.paused': {
        const event = params as DebugPausedEvent;
        useDebugStore.getState().setPausedAt(event.node_id);
        useDebugStore.getState().setInspectData(event.data);
        useWorkflowStore.getState().updateNodeStatus(event.node_id, 'paused');
        useDebugStore.getState().addLog({
          nodeId: event.node_id,
          message: 'Breakpoint hit - execution paused',
          level: 'warn',
        });
        break;
      }

      case 'workflow.complete': {
        useWorkflowStore.getState().setRunning(false);
        useDebugStore.getState().addLog({
          nodeId: 'system',
          message: 'Workflow execution complete',
          level: 'info',
        });
        break;
      }
    }
  });
}

/**
 * Compose the console-log line for a status update. Errors show the
 * typed kind when available; `skipped` nodes explain whether they were
 * branch-pruned or sacrificed to an upstream failure.
 */
function buildLogMessage(u: NodeStatusUpdate): string {
  if (u.error) {
    return u.kind ? `[${u.kind}] ${u.error}` : u.error;
  }
  if (u.status === 'skipped') {
    if (u.reason === 'upstream_failed' && u.upstream) {
      return `Skipped (upstream '${u.upstream}' failed)`;
    }
    if (u.reason === 'branch_pruned') {
      return 'Skipped (branch not taken)';
    }
    return 'Skipped';
  }
  return `Status: ${u.status}`;
}
