// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { ImageIcon } from './NodeIcons';
import { ImagePreviewView } from '../components/ImagePreview';
import { useImagePreview } from '../components/useImagePreview';

export function InputImageNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const filePath = (d.config?.filePath as string) || '';
  const previewState = useImagePreview(filePath);

  return (
    <div className="workflow-node">
      <div className="node-header">
        <span className="icon">
          <ImageIcon />
        </span>{' '}
        Input Image
      </div>
      <div className="node-body">
        {filePath || 'No file selected'}
        <ImagePreviewView state={previewState} alt="Preview" />
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
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
