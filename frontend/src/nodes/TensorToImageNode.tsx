// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { HeatmapIcon } from './NodeIcons';

export function TensorToImageNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const colormap = (d.config?.colormap as string) || 'viridis';
  const w = String(d.config?.width || '256');
  const h = String(d.config?.height || '64');
  const overlayOpacity = d.config?.overlayOpacity;

  return (
    <div className="workflow-node node-output">
      <div className="node-header">
        <span className="icon">
          <HeatmapIcon />
        </span>{' '}
        Tensor To Image
      </div>
      <div className="node-body">
        <div style={{ fontSize: '0.85em', color: '#aaa' }}>
          {colormap} · {w}×{h}
          {overlayOpacity ? ` · overlay ${overlayOpacity}` : ''}
        </div>
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="input_data"
        label="tensor"
        dataType="tensor"
      />
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="original_image"
        label="original"
        dataType="image"
      />
      <LabeledHandle
        type="source"
        position={Position.Right}
        id="image_data"
        label="image"
        dataType="image"
      />
    </div>
  );
}
