// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { TrendingUpIcon } from './NodeIcons';

export function BenchmarkNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const runs = d.runsCount as number | undefined;
  const avgMs = d.avgMs as number | undefined;
  /* Surface the configured stress-test window so the body label
     mirrors what the engine will actually do. Falls back to the
     manifest default (10 s) when the field is empty / missing. A
     non-finite or non-positive duration is treated as "not yet
     configured" and we render the placeholder rather than a
     misleading "0s". */
  const rawDuration = d.config?.duration as number | string | undefined;
  const parsedDuration = typeof rawDuration === 'string' ? Number(rawDuration) : rawDuration;
  const durationSec = Number.isFinite(parsedDuration) && (parsedDuration as number) > 0
    ? (parsedDuration as number)
    : 10;
  return (
    <div className="workflow-node">
      <div className="node-header"><span className="icon"><TrendingUpIcon /></span> Benchmark</div>
      <div className="node-body">{durationSec}s stress test</div>
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
