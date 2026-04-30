// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { BranchIcon } from './NodeIcons';

export function ConditionNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  return (
    <div className="workflow-node">
      <div className="node-header">
        <span className="icon">
          <BranchIcon />
        </span>{' '}
        Condition
      </div>
      <div className="node-body">{(d.config?.expression as string) || 'value > threshold'}</div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="input_data"
        label="input"
        dataType="tensor"
      />
      <LabeledHandle
        type="source"
        position={Position.Right}
        id="true_branch"
        label="true"
        dataType="branch"
        top="35%"
      />
      <LabeledHandle
        type="source"
        position={Position.Right}
        id="false_branch"
        label="false"
        dataType="branch"
        top="75%"
      />
    </div>
  );
}
