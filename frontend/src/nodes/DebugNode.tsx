// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps, useEdges } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { InspectIcon } from './NodeIcons';

/**
 * DebugNode - a passthrough inspector. It forwards its `data_in` value to
 * `data_out` unchanged, so it can be spliced into any edge to observe
 * values on a run. Pausing is now a separate, explicit concept handled by
 * right-clicking any node and choosing "Add breakpoint".
 */
export function DebugNode({ id, data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const edges = useEdges();

  const hasInput = edges.some((e) => e.target === id);
  const hasOutput = edges.some((e) => e.source === id);
  const isConnected = hasInput && hasOutput;

  const getStatusText = () => {
    if (d.status === 'paused') return 'Paused - inspect data';
    if (d.status === 'running') return 'Inspecting…';
    if (d.status === 'done') return 'Passed through';
    if (!isConnected) return 'Connect input & output';
    return 'Idle';
  };

  return (
    <div className="workflow-node">
      <div className="node-header">
        <span className="icon">
          <InspectIcon />
        </span>{' '}
        Inspect
      </div>
      <div className="node-body">
        <div>{getStatusText()}</div>
        <div style={{ fontSize: 9, color: '#4a4a6a', marginTop: 2 }}>
          Right-click to add breakpoint
        </div>
      </div>
      {(d.status === 'paused' || d.status === 'done') && d.output !== undefined && (
        <pre className="node-output-pre" style={{ color: '#e0c080' }}>
          {typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}
        </pre>
      )}
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="data_in"
        label="in"
        dataType="generic"
      />
      <LabeledHandle
        type="source"
        position={Position.Right}
        id="data_out"
        label="out"
        dataType="generic"
      />
    </div>
  );
}
