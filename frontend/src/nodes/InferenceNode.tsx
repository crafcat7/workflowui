import { Position, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';

export function InferenceNode({ data }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;
  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon">⚡</span> Inference</div>
      <div className="node-body">Execute inference</div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
        {d.elapsedMs !== undefined && (
          <span className="elapsed-footer">{d.elapsedMs.toFixed(1)}ms</span>
        )}
      </div>
      <LabeledHandle type="target" position={Position.Left} id="net_handle" label="net" dataType="net" />
      <LabeledHandle type="target" position={Position.Left} id="input_data" label="input" dataType="tensor" top="75%" />
      <LabeledHandle type="source" position={Position.Right} id="output_data" label="output" dataType="tensor" />
    </div>
  );
}
