// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { TagIcon } from './NodeIcons';

export function AnnotateImageNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const hasLabels = Boolean(d.config?.labelsPath);
  const maxLines = d.config?.maxLines || '5';

  return (
    <div className="workflow-node node-output">
      <div className="node-header">
        <span className="icon">
          <TagIcon />
        </span>{' '}
        Annotate Image
      </div>
      <div className="node-body">
        <div style={{ fontSize: '0.85em', color: '#aaa' }}>
          {hasLabels ? 'labels loaded' : 'show indices'} · top-{maxLines}
        </div>
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="image_data"
        label="image"
        dataType="image"
      />
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="topk_data"
        label="topk"
        dataType="tensor"
      />
      <LabeledHandle
        type="source"
        position={Position.Right}
        id="output_data"
        label="image"
        dataType="image"
      />
    </div>
  );
}
