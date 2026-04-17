import { Position, type NodeProps, useEdges } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';

export function DebugNode({ id, data }: NodeProps) {
  const d = data as unknown as WorkflowNodeData;
  const edges = useEdges();

  // Check if this breakpoint node is actually connected (has both input and output edges)
  const hasInput = edges.some((e) => e.target === id);
  const hasOutput = edges.some((e) => e.source === id);
  const isConnected = hasInput && hasOutput;

  const getStatusText = () => {
    if (d.status === 'paused') return 'PAUSED - inspect data';
    if (d.status === 'running') return 'Executing...';
    if (d.status === 'done') return 'Passed through';
    if (!isConnected) return 'Not connected - will not block';
    return 'Armed - will pause when reached';
  };

  return (
    <div className="workflow-node">
      <div className="node-header">
        <span className="icon">{isConnected ? '🔴' : '⚪'}</span> Breakpoint
      </div>
      <div className="node-body">
        <div>{getStatusText()}</div>
        {!isConnected && (
          <div style={{ fontSize: 9, color: '#4a4a6a', marginTop: 2 }}>
            Connect input &amp; output to enable
          </div>
        )}
      </div>
      {d.status === 'paused' && d.output !== undefined && (
        <pre className="node-output-pre" style={{ color: '#e0c080' }}>
          {typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}
        </pre>
      )}
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
        {isConnected && d.status === 'idle' && (
          <span className="breakpoint-armed-dot" />
        )}
      </div>
      <LabeledHandle type="target" position={Position.Left} id="data_in" label="in" dataType="generic" />
      <LabeledHandle type="source" position={Position.Right} id="data_out" label="out" dataType="generic" />
    </div>
  );
}
