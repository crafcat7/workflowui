// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * ModelInspectorDrawer — right-side drawer rendering a structural
 * preview of the inference model referenced by an inference node.
 *
 * Triple-zone layout (chosen so the user reads top → bottom in
 * decreasing density):
 *   1. Top metadata strip: vendor, format version, sizes, in/out
 *      blob names, layer/blob counts.
 *   2. Middle ReactFlow mini-canvas: each ModelLayer becomes a node;
 *      every (producer, output_blob → consumer) triple becomes an
 *      edge labeled with the blob name. Layout is dagre TB — top-
 *      down mirrors how Netron and most ncnn / ONNX visualizers
 *      render inference graphs (input at top, output at bottom),
 *      and reads naturally inside a tall right-side drawer.
 *   3. Bottom layer list: virtualization not used here; the largest
 *      ncnn model we ship in demos has 120 layers, comfortably
 *      under the threshold where naive rendering hurts.
 *
 * Data fetch: the drawer owns no state of its own — `useModelInspect`
 * holds graph/loading/error and is invoked when the drawer opens,
 * cancelled on close. Mounting the hook inside the drawer instead
 * of in PropertiesPanel means a stale tab in the background never
 * tries to refetch on prop changes.
 *
 * Layout cost: dagre runs O(V+E) per inspect result; for the 120-
 * layer demo this measures < 5ms. We layout once on graph arrival
 * and freeze the positions; dragging a node updates only the
 * canvas, not the underlying ModelGraph.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  Handle,
  Position,
  Background,
  Controls,
  MarkerType,
} from '@xyflow/react';
import dagre from 'dagre';
import type { ModelGraph, ModelInspectRequest } from '../types/modelInspector';
import { useModelInspect } from '../hooks/useModelInspect';

export interface ModelInspectorDrawerProps {
  /** When false the drawer slides off-screen and the inspect hook is reset. */
  open: boolean;
  /** Called when the user clicks the close button or hits Escape. */
  onClose: () => void;
  /** What to inspect. The drawer auto-fires on open if both fields are present. */
  request: ModelInspectRequest | null;
}

// ── layout ──────────────────────────────────────────────────────────
// Per-node footprint used by dagre. ReactFlow has no opinion on size;
// the drawer is 600px wide so we pick a width that fits "<type> · <id>"
// for typical ncnn names (e.g. "Convolution · conv1") inside that
// constraint without truncating, paired with a height tall enough to
// stack three lines: header (type · id), input shapes, output shapes.
// Engines that emit no shape hints fall back to dashes so the height
// stays uniform across layers (uniform rows make TB layout readable).
const NODE_W = 160;
const NODE_H = 76;

/** Format `[1, 3, 224, 224]` → `1×3×224×224`. Empty → `?`. */
function fmtShape(shape: number[]): string {
  if (!shape || shape.length === 0) return '?';
  return shape.join('×');
}

interface LayerNodeData extends Record<string, unknown> {
  type: string;
  id: string;
  inShapes: string[];
  outShapes: string[];
  selected: boolean;
}

/**
 * Custom layer-node renderer. Default ReactFlow nodes only accept a
 * `label: string`; we need three stacked lines (header + in shapes +
 * out shapes), so register a custom node type. Source/Target handles
 * are placed top/bottom to match the TB rank flow — without them
 * ReactFlow would still draw edges, but they'd anchor at floating
 * default positions, undermining the columnar look.
 */
function LayerNode({ data }: NodeProps<Node<LayerNodeData>>): ReactElement {
  const { type, id, inShapes, outShapes, selected } = data;
  return (
    <div
      style={{
        width: NODE_W,
        height: NODE_H,
        background: selected ? '#2a1a3a' : '#1a1a3a',
        border: `1px solid ${selected ? '#9b59b6' : '#2a2a4a'}`,
        color: '#d0d0e8',
        borderRadius: 4,
        padding: '4px 6px',
        fontSize: 11,
        lineHeight: 1.25,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#555' }} />
      <div
        style={{
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={`${type} · ${id}`}
      >
        {type} · {id}
      </div>
      <div style={{ color: '#8a8aa8', fontSize: 10 }} title={inShapes.join('  ')}>
        in: {inShapes.length === 0 ? '—' : inShapes.join(' ')}
      </div>
      <div style={{ color: '#8a8aa8', fontSize: 10 }} title={outShapes.join('  ')}>
        out: {outShapes.length === 0 ? '—' : outShapes.join(' ')}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#555' }} />
    </div>
  );
}

const nodeTypes: NodeTypes = { layer: LayerNode };

function layoutGraph(graph: ModelGraph): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  // TB layout: ranksep separates rows (vertical), nodesep separates
  // siblings sharing a rank (horizontal). 70px between rows leaves
  // room for the blob-name edge label that sits midway between
  // producer and consumer; 60px between siblings stops fan-outs
  // (e.g. Split → multiple consumers) from colliding.
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 70, edgesep: 10 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const layer of graph.layers) {
    g.setNode(layer.id, { width: NODE_W, height: NODE_H });
  }
  // Build edges from blob producer/consumers. A blob with N consumers
  // becomes N edges; multi-output layers like Split fan out
  // naturally because each output_blob has its own consumer set.
  const edgeKey = new Set<string>();
  const edges: Edge[] = [];
  for (const blob of graph.blobs) {
    if (!blob.producer) continue; // graph input, no incoming edge to draw
    for (const consumer of blob.consumers) {
      const key = `${blob.producer}->${consumer}::${blob.name}`;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      g.setEdge(blob.producer, consumer);
      edges.push({
        id: key,
        source: blob.producer,
        target: consumer,
        label: blob.name,
        // Pad a dark-themed background behind the blob name so labels
        // stay legible against both the canvas background and the
        // edge stroke when fan-outs cluster their labels close.
        labelStyle: { fill: '#d0d0e8', fontSize: 11 },
        labelBgStyle: { fill: '#12122a', fillOpacity: 0.9 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 2,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
  }

  dagre.layout(g);

  // Look up shapes by blob name. Indexed once per layoutGraph call
  // so the per-layer mapping below is O(in+out) and not O(n²).
  const blobShape = new Map<string, number[]>();
  for (const b of graph.blobs) blobShape.set(b.name, b.shape);

  const nodes: Node[] = graph.layers.map((layer) => {
    const pos = g.node(layer.id);
    // dagre returns the *center* point; ReactFlow wants the top-left.
    return {
      id: layer.id,
      type: 'layer',
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: {
        type: layer.type,
        id: layer.id,
        inShapes: layer.input_blobs.map((n) => fmtShape(blobShape.get(n) ?? [])),
        outShapes: layer.output_blobs.map((n) => fmtShape(blobShape.get(n) ?? [])),
        selected: false,
      } satisfies LayerNodeData,
    };
  });

  return { nodes, edges };
}

// ── component ───────────────────────────────────────────────────────
export function ModelInspectorDrawer({
  open,
  onClose,
  request,
}: ModelInspectorDrawerProps): ReactElement | null {
  const { graph, loading, error, inspect, reset } = useModelInspect();
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);

  // Auto-fire when the drawer opens with a valid request. We don't
  // refetch on every render — only when (open, request) flips into
  // an inspectable state.
  useEffect(() => {
    if (open && request && request.paramPath) {
      inspect(request);
    }
    if (!open) {
      reset();
      setSelectedLayer(null);
    }
    // We deliberately omit `inspect` and `reset` from deps — the hook
    // returns referentially-stable callbacks (useCallback with []),
    // but listing them would make refresh-on-rerender a bug source
    // if that contract ever loosens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request?.vendor, request?.paramPath, request?.modelPath]);

  // Escape closes. Listener only attaches while open so we don't
  // intercept Escape for the rest of the app.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [], edges: [] };
    return layoutGraph(graph);
  }, [graph]);

  // Highlight the selected layer in the canvas without recomputing
  // layout. Selection is pushed into the custom node's `data.selected`
  // flag so LayerNode can render the highlighted variant — we no
  // longer rely on inline style overrides since the node is custom.
  const styledNodes = useMemo(
    () =>
      nodes.map((n) =>
        n.id === selectedLayer
          ? { ...n, data: { ...(n.data as LayerNodeData), selected: true } }
          : n,
      ),
    [nodes, selectedLayer],
  );

  if (!open) return null;

  return (
    <aside
      className="model-inspector-drawer"
      role="dialog"
      aria-label="Model inspector"
      data-testid="model-inspector-drawer"
    >
      <header className="model-inspector-header">
        <h2>Model Inspector</h2>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>

      {loading && <div className="model-inspector-status">Loading…</div>}
      {error && (
        <div className="model-inspector-status model-inspector-error" data-testid="model-inspector-error">
          {/* code 0 → transport, -32602 → bad request, others → server/parser */}
          {error.code === 0
            ? `Network error: ${error.message}`
            : error.code === -32602
              ? `Invalid request: ${error.message}`
              : `Model error (${error.code}): ${error.message}`}
        </div>
      )}

      {graph && (
        <>
          <section className="model-inspector-meta">
            <Meta label="Vendor" value={graph.vendor} />
            <Meta label="Format" value={graph.format_version} />
            <Meta label="Layers" value={String(graph.layers.length)} />
            <Meta label="Blobs" value={String(graph.blobs.length)} />
            <Meta label="Param size" value={fmtBytes(graph.param_bytes)} />
            <Meta label="Bin size" value={fmtBytes(graph.bin_bytes)} />
            <Meta label="Inputs" value={graph.input_blob_names.join(', ') || '—'} />
            <Meta label="Outputs" value={graph.output_blob_names.join(', ') || '—'} />
          </section>

          <section className="model-inspector-canvas" data-testid="model-inspector-canvas">
            {/*
              Wrap in our own ReactFlowProvider. Without it the drawer
              ReactFlow inherits App's outer ReactFlowProvider store
              and the two canvases stomp each other's nodes / edges /
              viewport — opening or zooming the drawer would corrupt
              the main workflow canvas. A dedicated provider gives
              the inspector an isolated store keyed to this subtree.
            */}
            <ReactFlowProvider>
              <ReactFlow
                nodes={styledNodes}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                // Constrain the auto-fit zoom: tall TB graphs (e.g.
                // shufflenet ~120 layers) otherwise zoom out so far
                // the labels are unreadable; short graphs zoom in
                // past 1× and look pixel-soft. 0.4–1.5 keeps both
                // ends acceptable, with 15% padding so nodes never
                // touch the canvas edge.
                fitViewOptions={{ padding: 0.15, minZoom: 0.4, maxZoom: 1.5 }}
                minZoom={0.2}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
                nodesDraggable
                nodesConnectable={false}
                edgesFocusable={false}
                onNodeClick={(_e, n) => setSelectedLayer(n.id)}
              >
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            </ReactFlowProvider>
          </section>

          <section
            className="model-inspector-layers"
            data-testid="model-inspector-layers"
          >
            <table>
              <thead>
                <tr><th>#</th><th>Type</th><th>Name</th><th>In</th><th>Out</th></tr>
              </thead>
              <tbody>
                {graph.layers.map((l, i) => (
                  <tr
                    key={l.id}
                    className={l.id === selectedLayer ? 'selected' : undefined}
                    onClick={() => setSelectedLayer(l.id)}
                  >
                    <td>{i}</td>
                    <td>{l.type}</td>
                    <td>{l.id}</td>
                    <td>{l.input_blobs.length}</td>
                    <td>{l.output_blobs.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </aside>
  );
}

function Meta({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="model-inspector-meta-cell">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </div>
  );
}

// Mirrors the format conventions in ConsolePanel (KB/MB with one
// decimal). 0 collapses to "—" rather than "0 B" to flag "absent".
function fmtBytes(n: number): string {
  if (n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Exported for unit testing without instantiating ReactFlow.
export { layoutGraph as __layoutGraphForTest, fmtBytes as __fmtBytesForTest };
