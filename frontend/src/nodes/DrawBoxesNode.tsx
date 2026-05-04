// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { BoxIcon } from './NodeIcons';

export function DrawBoxesNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const thresh = String(d.config?.confidenceThreshold || '0.25');

  return (
    <div className="workflow-node node-output">
      <div className="node-header">
        <span className="icon">
          <BoxIcon />
        </span>{' '}
        Draw Boxes
      </div>
      <div className="node-body">
        <div style={{ fontSize: '0.85em', color: '#aaa' }}>conf ≥ {thresh}</div>
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
        id="boxes_data"
        label="boxes"
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
