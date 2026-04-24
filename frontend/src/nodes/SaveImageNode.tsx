// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';

/**
 * Renders a Save Image sink. Matches the backend SaveImageHandler:
 * target handle `image_data` (typed as `image`, with implicit tensor
 * coercion handled by the port schema), config key `filePath`.
 */
export function SaveImageNode({ data }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;
  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon">🖼️</span> Save Image</div>
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
