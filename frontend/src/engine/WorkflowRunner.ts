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
  /** Set by backend R1 contract; events from a superseded run carry the prior id and must be dropped. */
  run_id?: string;
}

interface DebugPausedEvent {
  node_id: string;
  data: Record<string, unknown>;
  /** Mirrors NodeStatusUpdate.run_id — same filtering rule applies to paused events. */
  run_id?: string;
}

/**
 * Response shape for the `workflow.state` RPC. Used after a WS
 * reconnect to reconcile the local canvas with whatever the backend
 * observed while we were offline. `run_id` may be empty if the
 * backend has never executed anything.
 */
interface WorkflowStateSnapshot {
  run_id?: string;
  statuses?: Record<string, string>;
  paused_at?: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['idle', 'running', 'done', 'error', 'paused', 'skipped']);

function coerceStatus(raw: string): NodeStatus {
  return (VALID_STATUSES.has(raw) ? raw : 'idle') as NodeStatus;
}

// The run_id returned by the most recent successful `workflow.execute`
// RPC. Events whose `run_id` doesn't match this value belong to a
// run the user has already cancelled or superseded — dropping them
// prevents a stale 'running' badge from landing on top of a fresh run.
// Events missing run_id entirely (legacy backends / tests) are kept:
// we can't filter what isn't tagged, and the old behavior is still
// strictly better than nothing.
let currentRunId: string | null = null;

/**
 * Record the run_id returned by `workflow.execute` so the notification
 * handlers below can filter stale events from a superseded run.
 * Pass `null` to stop filtering (e.g. after workflow.cancel when no
 * follow-up run is expected).
 */
export function setActiveRunId(id: string | null) {
  currentRunId = id;
}

// Test-only: current id without exporting the mutable binding.
export function _getActiveRunIdForTest(): string | null {
  return currentRunId;
}

/** Returns true if the event should be processed; false if it's from a stale run and should be dropped. */
function isFreshEvent(evRunId: string | undefined): boolean {
  if (!evRunId) return true;              // legacy/untagged: always accept
  if (currentRunId == null) return true;  // no active filter yet
  return evRunId === currentRunId;
}

/**
 * Reconcile local canvas with the backend's view of the executor after
 * a WebSocket reconnect. Events emitted while the socket was down are
 * gone for good — without this, any node that transitioned while we
 * were offline would stay stuck on whatever stale status we had last.
 *
 * Exported for tests; wired from `initWorkflowRunner()` on every
 * reconnect (not the initial connect).
 */
export async function reconcileFromSnapshot(): Promise<void> {
  let snap: WorkflowStateSnapshot;
  try {
    snap = await wsClient.call<WorkflowStateSnapshot>('workflow.state');
  } catch (err) {
    // `workflow.state` is new (W1). Older backends will reply with
    // method-not-found (-32601); that's fine — just skip reconcile
    // and carry on with the pre-W1 behavior.
    console.warn('[WorkflowRunner] workflow.state failed, skipping reconcile:', err);
    return;
  }

  // Re-align our stale-event filter with the backend's view. If the
  // backend has no run, clear; otherwise take its run_id so any
  // in-flight events from that run we missed still match.
  setActiveRunId(snap.run_id && snap.run_id.length > 0 ? snap.run_id : null);

  const store = useWorkflowStore.getState();
  if (snap.statuses) {
    for (const [nodeId, status] of Object.entries(snap.statuses)) {
      // Only touch nodes we know about; the backend can't rename
      // a node out from under us, but it *can* report a node that
      // was removed locally in an unsaved edit.
      if (store.nodesById.has(nodeId)) {
        store.updateNodeStatus(nodeId, coerceStatus(status));
      }
    }
  }

  const debug = useDebugStore.getState();
  if (snap.paused_at) {
    debug.setPausedAt(snap.paused_at);
  } else {
    debug.setPausedAt(null);
  }
}

/**
 * Initialize notification handlers. Call once at app startup.
 */
export function initWorkflowRunner() {
  wsClient.onReconnect(() => {
    void reconcileFromSnapshot();
  });
  wsClient.onNotification((method, params) => {
    switch (method) {
      case 'node.status': {
        const update = params as NodeStatusUpdate;
        // Drop events from a run the user has already cancelled or
        // superseded — otherwise a late 'done' from the previous run
        // overwrites the fresh run's 'running' badge.
        if (!isFreshEvent(update.run_id)) break;
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
        // Same stale-run filter as node.status: a debug.paused from
        // the previous run would lock the UI into a paused state for
        // a run that no longer exists.
        if (!isFreshEvent(event.run_id)) break;
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
