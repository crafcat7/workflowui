// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { WrenchIcon } from './NodeIcons';

export function PostprocessNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const op = (d.config?.op as string) || 'nms';
  const paramText = op === 'nms' 
    ? `IoU: ${d.config?.iouThreshold || '0.45'}` 
    : `K: ${d.config?.k || '1'}`;

  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon"><WrenchIcon /></span> Postprocess</div>
      <div className="node-body">
        <div>{op.toUpperCase()}</div>
        <div style={{ fontSize: '0.8em', color: '#888' }}>{paramText}</div>
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle type="target" position={Position.Left} id="input_data" label="input" dataType="tensor" />
      <LabeledHandle type="source" position={Position.Right} id="output_data" label="output" dataType="tensor" />
    </div>
  );
}
