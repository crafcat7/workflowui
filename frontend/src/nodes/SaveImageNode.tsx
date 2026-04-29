// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { SaveImageIcon } from './NodeIcons';

/**
 * Renders a Save Image sink. Matches the backend SaveImageHandler:
 * target handle `image_data` (typed as `image`, with implicit tensor
 * coercion handled by the port schema), config key `filePath`.
 */
export function SaveImageNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon"><SaveImageIcon /></span> Save Image</div>
      <div className="node-body">
        {(d.config?.filePath as string) || 'output.png'}
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle type="target" position={Position.Left} id="image_data" label="image" dataType="image" />
    </div>
  );
}
