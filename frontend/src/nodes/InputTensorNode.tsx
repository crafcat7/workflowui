// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import { useWorkflowStore, type WorkflowNodeData } from '../store/workflowStore';
import { TensorIcon } from './NodeIcons';

export function InputTensorNode({ id, data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const isAuto = d.config?.fillMode === 'auto';
  
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    useWorkflowStore.getState().updateNodeData(id, {
      config: { ...d.config, tensorText: e.target.value }
    });
  };

  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon"><TensorIcon /></span> Input Tensor</div>
      <div className="node-body">
        {isAuto ? (
          <div className="tensor-auto-summary">
            Shape: {(d.config?.shape as string) || '1'}
            <br />
            Fill: {(d.config?.fillValue as string) || '0.0'}
          </div>
        ) : (
          <textarea
            className="node-textarea"
            rows={3}
            value={(d.config?.tensorText as string) || ''}
            onChange={handleTextChange}
            placeholder="Enter tensor values..."
            readOnly={d.status === 'running'}
          />
        )}
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle type="source" position={Position.Right} id="tensor_data" label="tensor" dataType="tensor" />
    </div>
  );
}
