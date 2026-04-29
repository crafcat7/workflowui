// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { SaveTextIcon } from './NodeIcons';

export function SaveTextNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon"><SaveTextIcon /></span> Save Text</div>
      <div className="node-body">
        {(d.config?.filePath as string) || 'output.txt'}
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle type="target" position={Position.Left} id="data" label="data" dataType="generic" />
    </div>
  );
}
