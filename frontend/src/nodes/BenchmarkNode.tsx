// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';

export function BenchmarkNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const runs = d.runsCount as number | undefined;
  const avgMs = d.avgMs as number | undefined;
  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon">📈</span> Benchmark</div>
      <div className="node-body">10s stress test</div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
        {runs !== undefined && avgMs !== undefined && (
          <span className="elapsed-footer">{runs} runs, {avgMs.toFixed(2)}ms avg</span>
        )}
      </div>
      <LabeledHandle type="target" position={Position.Left} id="net_handle" label="net" dataType="net" />
      <LabeledHandle type="target" position={Position.Left} id="input_data" label="input" dataType="tensor" top="75%" />
      <LabeledHandle type="source" position={Position.Right} id="benchmark_result" label="result" dataType="generic" />
    </div>
  );
}
