// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { OutputIcon } from './NodeIcons';

export function OutputNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  return (
    <div className="workflow-node node-output">
      <div className="node-header">
        <span className="icon">
          <OutputIcon />
        </span>{' '}
        Output
      </div>
      <div className="node-body">
        {d.output !== undefined ? (
          <div className="output-summary-box">
            <OutputSummary output={d.output} />
          </div>
        ) : (
          'Waiting for data...'
        )}
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="data"
        label="data"
        dataType="generic"
      />
    </div>
  );
}

/** Compact summary for display inside the node. Full data is in PropertiesPanel. */
function OutputSummary({ output }: { output: unknown }) {
  if (typeof output === 'string') {
    const preview = output.length > 60 ? output.slice(0, 57) + '...' : output;
    return <div className="output-summary">{preview}</div>;
  }

  if (Array.isArray(output) && output.length > 0 && typeof output[0] === 'number') {
    const vals = output as number[];
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return (
      <div className="output-summary">
        <div className="output-summary-row">{vals.length} values</div>
        <div className="output-summary-row">
          [{min.toFixed(4)}, {max.toFixed(4)}]
        </div>
        <div className="output-summary-row">mean: {mean.toFixed(4)}</div>
      </div>
    );
  }

  // Fallback: show type/length
  if (Array.isArray(output)) {
    return <div className="output-summary">{output.length} items</div>;
  }

  return <div className="output-summary">{String(output).slice(0, 40)}</div>;
}
