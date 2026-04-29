// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { BrainIcon } from './NodeIcons';

export function CreateNetNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const emptyWeights = d.config?.emptyWeights === 'true' || d.config?.emptyWeights === true;
  const vendor = (d.config?.vendor as string) || '';
  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon"><BrainIcon /></span> Create Net</div>
      <div className="node-body">
        {vendor && <span className="node-vendor-tag">{vendor.toUpperCase()}</span>}
        {(d.config?.paramPath as string) || (d.config?.modelPath as string) || 'No model path'}
        {emptyWeights && <div className="badge">empty weights</div>}
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
        {d.elapsedMs !== undefined && (
          <span className="elapsed-footer">{d.elapsedMs.toFixed(1)}ms</span>
        )}
      </div>
      <LabeledHandle type="source" position={Position.Right} id="net_handle" label="net" dataType="net" />
    </div>
  );
}
