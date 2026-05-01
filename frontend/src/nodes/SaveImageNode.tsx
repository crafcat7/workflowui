// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { useEffect, useRef, useState } from 'react';
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { LabeledHandle } from '../components/LabeledHandle';
import type { WorkflowNodeData } from '../store/workflowStore';
import { SaveImageIcon } from './NodeIcons';
import { wsClient } from '../transport/WsClient';

/**
 * Renders a Save Image sink. Matches the backend SaveImageHandler:
 * target handle `image_data` (typed as `image`, with implicit tensor
 * coercion handled by the port schema), config key `filePath`.
 *
 * The thumbnail preview is fetched lazily after a successful run — i.e. on
 * the `idle|running → done` status transition. We avoid eager fetches so
 * stale on-disk content from a prior run is never shown attached to the
 * current node state. Resetting back to `idle` clears the preview.
 */
export function SaveImageNode({ data: d }: NodeProps<Node<WorkflowNodeData>>) {
  const filePath = (d.config?.filePath as string) || 'output.png';
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const prevStatusRef = useRef(d.status);

  useEffect(() => {
    const becameDone = d.status === 'done' && prevStatusRef.current !== 'done';
    prevStatusRef.current = d.status;

    if (d.status === 'idle') {
      // Schedule the reset asynchronously so we never call setState
      // synchronously inside the effect body.
      const t = setTimeout(() => setPreview(null), 0);
      return () => clearTimeout(t);
    }

    if (!becameDone || !filePath.trim()) return;

    let cancelled = false;
    // setTimeout(0) defers the setLoading/RPC dispatch out of the effect's
    // synchronous body, satisfying react-hooks/set-state-in-effect while
    // preserving the "fetch preview when status flipped to done" semantics.
    const t = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      wsClient
        .call<{ dataUrl: string }>('image.preview', { path: filePath.trim() })
        .then((res) => {
          if (!cancelled) setPreview(res.dataUrl);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [d.status, filePath]);

  return (
    <div className="workflow-node">
      <div className="node-header">
        <span className="icon">
          <SaveImageIcon />
        </span>{' '}
        Save Image
      </div>
      <div className="node-body">
        {filePath}
        {loading && <div className="node-preview-loading">Loading preview…</div>}
        {preview && !loading && (
          <img src={preview} alt="Saved output" className="node-preview-thumb" />
        )}
      </div>
      <div className="node-footer">
        <span className={`node-status ${d.status}`}>{d.status}</span>
      </div>
      <LabeledHandle
        type="target"
        position={Position.Left}
        id="image_data"
        label="image"
        dataType="image"
      />
    </div>
  );
}
