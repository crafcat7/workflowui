/**
 * WorkflowRunner - handles notification events from the backend
 * during workflow execution, updating node states accordingly.
 */

import { wsClient } from '../transport/WsClient';
import { useWorkflowStore } from '../store/workflowStore';
import { useDebugStore } from '../store/debugStore';

interface NodeStatusUpdate {
  node_id: string;
  status: string;
  elapsed_ms?: number;
  output?: unknown;
  error?: string;
  runs_count?: number;
  avg_ms?: number;
}

interface DebugPausedEvent {
  node_id: string;
  data: Record<string, unknown>;
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
        store.updateNodeStatus(update.node_id, update.status as 'idle' | 'running' | 'done' | 'error');
        
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
          message: update.error || `Status: ${update.status}`,
          level: update.error ? 'error' : 'info',
          data: update.output,
        });
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

      case 'capabilities': {
        // TODO: dynamic node registration from backend capabilities
        console.log('[WorkflowRunner] Received capabilities:', params);
        break;
      }
    }
  });
}
