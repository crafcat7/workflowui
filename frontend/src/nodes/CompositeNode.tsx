// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { LayersIcon } from './NodeIcons';

export function CompositeNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const opacity = d.config?.opacity ?? '0.5';

  return (
    <div className="workflow-node node-output">
      <div className="node-header">
        <span className="icon">
          <LayersIcon />
        </span>{' '}
        Composite
      </div>
      <div className="node-body">
        <div style={{ fontSize: '0.85em', color: '#aaa' }}>opacity {opacity}</div>
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="foreground"
        label="foreground"
        dataType="image"
      />
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="background"
        label="background"
        dataType="image"
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
