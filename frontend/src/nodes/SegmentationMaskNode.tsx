// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { MosaicIcon } from './NodeIcons';

export function SegmentationMaskNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const w = String(d.config?.width || '224');
  const h = String(d.config?.height || '224');

  return (
    <div className="workflow-node node-output">
      <div className="node-header">
        <span className="icon">
          <MosaicIcon />
        </span>{' '}
        Segmentation Mask
      </div>
      <div className="node-body">
        <div style={{ fontSize: '0.85em', color: '#aaa' }}>
          {w}×{h} pixels
        </div>
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="input_data"
        label="logits"
        dataType="tensor"
      />
      <LabeledHandle
        type="source"
        position={Position.Right}
        id="mask_data"
        label="mask"
        dataType="image"
      />
    </div>
  );
}
