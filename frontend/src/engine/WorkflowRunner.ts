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
import { logWarn } from '../utils/logger';

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
  /** For status=='validation_failed' on synthetic node_id='__workflow__': the list of graph problems detected before scheduling. */
  errors?: ValidationError[];
}

/**
 * One entry of the `errors[]` array the backend attaches to the
 * `__workflow__` / `validation_failed` push. `node_id` / `edge` are
 * populated when the problem is local enough to point at.
 */
interface ValidationError {
  kind: string; // unknown_node_type | dangling_edge | unknown_port | type_mismatch
  message: string;
  node_id?: string;
  edge?: string; // "source:handle -> target:handle"
}

interface DebugPausedEvent {
  node_id: string;
  /** Optional legacy nesting; flat `inputs`/`type` may also live on the root. */
  data?: Record<string, unknown>;
  /** Mirrors NodeStatusUpdate.run_id — same filtering rule applies to paused events. */
  run_id?: string;
  /** Flat fields the backend actually emits today (executor.cpp). */
  type?: string;
  inputs?: unknown[];
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

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'running',
  'done',
  'error',
  'paused',
  'skipped',
]);

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
  if (!evRunId) return true; // legacy/untagged: always accept
  if (currentRunId == null) return true; // no active filter yet
  return evRunId === currentRunId;
}

/**
 * React to a `__workflow__` / `validation_failed` push. Backend S1
 * guarantees this fires at most once per `workflow.execute`, before
 * `workflow.complete`, and precedes any real node events.
 *
 * Three surfaces are used so users notice regardless of which panel
 * they have open:
 *   - Canvas: every error with a `node_id` paints that node red via
 *     the normal error pipeline (status + data.error). No real
 *     execution happened, so this is the *only* signal the canvas
 *     will receive for those nodes.
 *   - Console (bottom panel): one `error`-level log per error, with
 *     `kind` prefix so the user can tell type mismatches from
 *     missing ports.
 *   - Toast: one summary for the batch, not one per error — a graph
 *     with a dozen problems would otherwise bury the UI in toasts.
 */
function handleValidationFailed(errors: ValidationError[]) {
  const store = useWorkflowStore.getState();
  const debug = useDebugStore.getState();

  for (const err of errors) {
    // Paint the offending node red on the canvas. Only touch nodes
    // we actually have — an `unknown_node_type` error may reference
    // an id the frontend already removed, or a `dangling_edge`
    // error's node id may be empty.
    if (err.node_id && store.nodesById.has(err.node_id)) {
      store.updateNodeStatus(err.node_id, 'error');
      store.updateNodeData(err.node_id, { error: err.message });
    }

    // Include the edge when present so users can match edge-scoped
    // errors (type_mismatch on an edge) to the wire they drew.
    const location = err.edge ? ` (edge ${err.edge})` : err.node_id ? ` (${err.node_id})` : '';
    debug.addLog({
      nodeId: err.node_id ?? 'system',
      message: `[${err.kind}]${location} ${err.message}`,
      level: 'error',
    });
  }

  const count = errors.length;
  showToast(
    count === 1
      ? `Validation failed: ${errors[0]?.message ?? 'unknown error'}`
      : `Validation failed: ${count} errors (see console)`,
    'error',
  );
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
    logWarn('[WorkflowRunner] workflow.state failed, skipping reconcile:', err);
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

        // Graph-level validation failures arrive as a synthetic
        // `__workflow__` status (S1). They are *not* regular node
        // updates: there is no node with id `__workflow__` to mark,
        // and each error in `errors[]` may point at a real node or
        // edge that the user needs surfaced. Handle them separately
        // and fall through without touching the store's node map.
        if (update.node_id === '__workflow__' && update.status === 'validation_failed') {
          handleValidationFailed(update.errors ?? []);
          break;
        }

        const store = useWorkflowStore.getState();
        store.updateNodeStatus(update.node_id, coerceStatus(update.status));

        const dataUpdate: Record<string, unknown> = {};
        if (update.elapsed_ms !== undefined) dataUpdate.elapsedMs = update.elapsed_ms;
        if (update.output !== undefined) dataUpdate.output = update.output;
        if (update.runs_count !== undefined) dataUpdate.runsCount = update.runs_count;
        if (update.avg_ms !== undefined) dataUpdate.avgMs = update.avg_ms;

        // Mirror the error string onto the node itself so PropertiesPanel
        // can surface it inline. The console log + toast still fire, but
        // a user who clicks on the red node afterwards shouldn't have to
        // hunt through a scrolled-away console to find *why* it failed.
        // Explicitly clear the field on a successful `done` status so a
        // subsequent re-run that succeeds doesn't leave stale red text
        // under a green badge.
        if (update.error) {
          dataUpdate.error = update.kind ? `[${update.kind}] ${update.error}` : update.error;
        } else if (update.status === 'done') {
          dataUpdate.error = undefined;
        }

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
        // The backend (executor.cpp) emits a FLAT payload — node_id,
        // type, inputs, run_id all on the root. An older draft of the
        // contract nested the metadata under a `data` key; we accept
        // both so the UI keeps working if the wire schema is later
        // tightened. DebugInputsPanel reads `.inputs` off whatever
        // record we hand it, so prefer the nested copy when present.
        const inspect =
          event.data && typeof event.data === 'object'
            ? event.data
            : (params as Record<string, unknown>);
        useDebugStore.getState().setInspectData(inspect);
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
