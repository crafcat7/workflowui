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

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
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
import { useTheme } from '../hooks/useTheme';

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
// the drawer is 600px wide. The custom LayerNode below stacks four
// rows: a coloured type header, an id sub-header, an optional key-
// param strip, and the output shape with axis names. We size for
// the worst case so dagre's row spacing stays uniform — Conv layers
// with key-params look identical in height to ReLU layers without.
const NODE_W = 190;
const NODE_H = 96;

/**
 * Format a numeric shape with axis names when the rank matches a
 * standard layout. ncnn / ONNX inference graphs are overwhelmingly
 * NCHW for 4-D activations and CHW for the rare 3-D blob, so we
 * label those cases. Other ranks (1-D bias, 5-D for video models)
 * fall back to a plain "a×b" so we never mislabel.
 */
function fmtShape(shape: number[]): string {
  if (!shape || shape.length === 0) return '?';
  if (shape.length === 4) {
    const [n, c, h, w] = shape;
    return `N${n}·C${c}·H${h}·W${w}`;
  }
  if (shape.length === 3) {
    const [c, h, w] = shape;
    return `C${c}·H${h}·W${w}`;
  }
  return shape.join('×');
}

/**
 * Background colour by layer family. Two palettes: dark (default) and
 * light — selected via the `light` flag so the same grouping logic
 * serves both themes without duplicating the type-matching chain.
 */
function headerBgFor(type: string, light: boolean): string {
  if (light) {
    if (type === 'Input') return '#d4edee';
    if (type === 'Convolution' || type === 'ConvolutionDepthWise' || type === 'InnerProduct' || type === 'Deconvolution')
      return '#dbe5f6';
    if (type === 'ReLU' || type === 'Sigmoid' || type === 'PReLU' || type === 'HardSwish' || type === 'Mish' || type === 'Swish')
      return '#e8ddf5';
    if (type === 'Pooling' || type === 'PoolingV2' || type === 'GlobalPooling')
      return '#ddf0e0';
    if (type === 'BatchNorm' || type === 'Scale' || type === 'Concat' || type === 'Split' || type === 'Eltwise' || type === 'Reshape' || type === 'Permute' || type === 'Crop' || type === 'Flatten')
      return '#f0ead6';
    return '#e8e8ef';
  }
  if (type === 'Input') return '#1a3a3a';
  if (type === 'Convolution' || type === 'ConvolutionDepthWise' || type === 'InnerProduct' || type === 'Deconvolution')
    return '#2a3a5a';
  if (type === 'ReLU' || type === 'Sigmoid' || type === 'PReLU' || type === 'HardSwish' || type === 'Mish' || type === 'Swish')
    return '#3a2a4a';
  if (type === 'Pooling' || type === 'PoolingV2' || type === 'GlobalPooling')
    return '#2a4a3a';
  if (type === 'BatchNorm' || type === 'Scale' || type === 'Concat' || type === 'Split' || type === 'Eltwise' || type === 'Reshape' || type === 'Permute' || type === 'Crop' || type === 'Flatten')
    return '#3a3a2a';
  return '#1a1a3a';
}

/**
 * Pull the few highest-signal params out of a layer's free-form
 * params bag. ncnn keys are stringified ints (e.g. Convolution: "0"
 * = num_output, "1" = kernel_w, "3" = stride_w); we hand-decode the
 * subset that drives a model's behaviour (kernel / stride / dilation
 * / padding / groups for Conv-like, kernel / stride for Pooling,
 * num_output for InnerProduct). Other layer types contribute no
 * row — better an empty strip than a wall of "0=…  1=…" gibberish.
 */
function fmtKeyParams(type: string, params: Record<string, unknown>): string {
  const num = (key: string): number | undefined => {
    const v = params[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
    return undefined;
  };
  if (
    type === 'Convolution' ||
    type === 'ConvolutionDepthWise' ||
    type === 'Deconvolution'
  ) {
    const out = num('0');
    const k = num('1');
    const s = num('3');
    const p = num('4');
    const g = num('7');
    const parts: string[] = [];
    if (out !== undefined) parts.push(`out=${out}`);
    if (k !== undefined) parts.push(`k=${k}`);
    if (s !== undefined && s !== 1) parts.push(`s=${s}`);
    if (p !== undefined && p !== 0) parts.push(`p=${p}`);
    if (g !== undefined && g !== 1) parts.push(`g=${g}`);
    return parts.join(' ');
  }
  if (type === 'Pooling' || type === 'PoolingV2') {
    const k = num('1');
    const s = num('2');
    const op = num('0');
    const parts: string[] = [];
    if (op === 0) parts.push('max');
    else if (op === 1) parts.push('avg');
    if (k !== undefined) parts.push(`k=${k}`);
    if (s !== undefined && s !== 1) parts.push(`s=${s}`);
    return parts.join(' ');
  }
  if (type === 'InnerProduct') {
    const out = num('0');
    return out !== undefined ? `out=${out}` : '';
  }
  return '';
}

interface LayerNodeData extends Record<string, unknown> {
  type: string;
  id: string;
  outShape: string;
  keyParams: string;
  headerBg: string;
  selected: boolean;
  light: boolean;
}

/**
 * Custom layer-node renderer. Default ReactFlow nodes only accept a
 * `label: string`; we need a four-row layout (type bar, id, key-
 * params, output shape) so we register a custom node type. Input
 * shape is intentionally omitted because in a TB graph the upstream
 * node sits directly above and its output_shape *is* this node's
 * input — duplicating it doubles the noise. Source/Target handles
 * pin to top/bottom so edges anchor at the rank boundary.
 */
function LayerNode({ data }: NodeProps<Node<LayerNodeData>>): ReactElement {
  const { type, id, outShape, keyParams, headerBg, selected, light } = data;
  const bg = light ? '#ffffff' : '#0e0e22';
  const borderColor = selected
    ? (light ? '#9b59b6' : '#c39be0')
    : (light ? '#d0d0d7' : '#2a2a4a');
  const textColor = light ? '#1d1d1f' : '#d0d0e8';
  const idColor = light ? '#6e6e73' : '#9090b0';
  const paramColor = light ? '#424245' : '#a0a0c0';
  const shapeColor = light ? '#0058b0' : '#7ab8ff';
  const handleBg = light ? '#a0a0a8' : '#555';
  return (
    <div
      style={{
        width: NODE_W,
        height: NODE_H,
        background: bg,
        border: `1px solid ${borderColor}`,
        boxShadow: selected
          ? (light ? '0 0 0 2px rgba(155, 89, 182, 0.25)' : '0 0 0 2px rgba(155, 89, 182, 0.35)')
          : 'none',
        color: textColor,
        borderRadius: 5,
        fontSize: 11,
        lineHeight: 1.25,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: handleBg }} />
      <div
        style={{
          background: headerBg,
          padding: '4px 8px',
          fontWeight: 700,
          fontSize: 12,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: light ? '#1d1d1f' : undefined,
        }}
        title={type}
      >
        {type}
      </div>
      <div
        style={{
          padding: '2px 8px',
          color: idColor,
          fontSize: 10,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={id}
      >
        {id}
      </div>
      <div
        style={{
          padding: '2px 8px',
          color: paramColor,
          fontSize: 10,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: 'monospace',
        }}
        title={keyParams || undefined}
      >
        {keyParams || '\u00A0'}
      </div>
      <div
        style={{
          padding: '2px 8px',
          color: shapeColor,
          fontSize: 11,
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginTop: 'auto',
        }}
        title={outShape}
      >
        ↓ {outShape}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: handleBg }} />
    </div>
  );
}

const nodeTypes: NodeTypes = { layer: LayerNode };

/**
 * Inner ReactFlow host — must live inside <ReactFlowProvider> so
 * `useReactFlow` resolves to the *drawer's* store rather than the
 * main App canvas store. Centring on selection change is delegated
 * here because doing it from the parent would require either
 * lifting the ReactFlow instance ref or duplicating the provider
 * lookup; both are uglier than this small inner component.
 */
function InspectorCanvas({
  styledNodes,
  edges,
  selectedLayer,
  onSelect,
  theme,
}: {
  styledNodes: Node[];
  edges: Edge[];
  selectedLayer: string | null;
  onSelect: (id: string) => void;
  theme: 'dark' | 'light';
}): ReactElement {
  const rf = useReactFlow();
  useEffect(() => {
    if (!selectedLayer) return;
    const n = styledNodes.find((node) => node.id === selectedLayer);
    if (!n) return;
    rf.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, {
      zoom: rf.getZoom(),
      duration: 250,
    });
  }, [selectedLayer, styledNodes, rf]);

  return (
    <ReactFlow
      nodes={styledNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, minZoom: 0.4, maxZoom: 1.5 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={false}
      edgesFocusable={false}
      onNodeClick={(_e, n) => onSelect(n.id)}
      colorMode={theme}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function layoutGraph(graph: ModelGraph, light: boolean): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 70, edgesep: 10 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const layer of graph.layers) {
    g.setNode(layer.id, { width: NODE_W, height: NODE_H });
  }

  const edgeKey = new Set<string>();
  const edges: Edge[] = [];
  const edgeLabelFill = light ? '#1d1d1f' : '#d0d0e8';
  const edgeLabelBg = light ? '#ffffff' : '#12122a';
  const edgeLabelBgOpacity = light ? 0.85 : 0.9;
  for (const blob of graph.blobs) {
    if (!blob.producer) continue;
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
        labelStyle: { fill: edgeLabelFill, fontSize: 11 },
        labelBgStyle: { fill: edgeLabelBg, fillOpacity: edgeLabelBgOpacity },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 2,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
  }

  dagre.layout(g);

  const blobShape = new Map<string, number[]>();
  for (const b of graph.blobs) blobShape.set(b.name, b.shape);

  const nodes: Node[] = graph.layers.map((layer) => {
    const pos = g.node(layer.id);
    const firstOut = layer.output_blobs[0];
    const outShape = fmtShape(firstOut ? (blobShape.get(firstOut) ?? []) : []);
    return {
      id: layer.id,
      type: 'layer',
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: {
        type: layer.type,
        id: layer.id,
        outShape,
        keyParams: fmtKeyParams(layer.type, layer.params),
        headerBg: headerBgFor(layer.type, light),
        selected: false,
        light,
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
  const theme = useTheme();
  const light = theme === 'light';
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement | null>());

  useEffect(() => {
    if (open && request && request.paramPath) {
      inspect(request);
    }
    if (!open) {
      reset();
      setSelectedLayer(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request?.vendor, request?.paramPath, request?.modelPath]);

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
    return layoutGraph(graph, light);
  }, [graph, light]);

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

  // Scroll the selected row into view inside the layers list. We
  // use `nearest` block alignment so an already-visible row doesn't
  // jump, and only re-trigger when the id transitions — without
  // this guard typing into the canvas would also retrigger the
  // smooth-scroll on every render. The typeof check keeps jsdom
  // (which omits scrollIntoView) from blowing up unit tests.
  useEffect(() => {
    if (!selectedLayer) return;
    const row = rowRefs.current.get(selectedLayer);
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedLayer]);

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
              <InspectorCanvas
                styledNodes={styledNodes}
                edges={edges}
                selectedLayer={selectedLayer}
                onSelect={setSelectedLayer}
                theme={theme}
              />
            </ReactFlowProvider>
          </section>

          <section
            className="model-inspector-layers"
            data-testid="model-inspector-layers"
          >
            <table>
              <thead>
                {/* Column meanings:
                    #In / #Out — count of input/output blobs (graph
                      degree). Most layers in sequential nets are
                      1/1; Split fans out (1/N), Eltwise/Concat fan
                      in (N/1).
                    Output shape — first output blob's NCHW (or CHW)
                      dimensions. Mirrors the canvas node footer so
                      the table reads consistently with the graph. */}
                <tr><th>#</th><th>Type</th><th>Name</th><th>#In</th><th>#Out</th><th>Output shape</th></tr>
              </thead>
              <tbody>
                {graph.layers.map((l, i) => {
                  // Resolve the first output blob's shape for the
                  // table cell. The same lookup happens in
                  // layoutGraph; duplicating it here is cheaper
                  // than threading the formatted string through
                  // node.data and back out for the table render.
                  const firstOut = l.output_blobs[0];
                  const blob = firstOut
                    ? graph.blobs.find((b) => b.name === firstOut)
                    : undefined;
                  const outShape = fmtShape(blob?.shape ?? []);
                  return (
                  <tr
                    key={l.id}
                    ref={(el) => {
                      // Register/deregister row ref so the
                      // selectedLayer effect can scroll it into
                      // view. We must set null on unmount to avoid
                      // pinning detached DOM in the Map.
                      if (el) rowRefs.current.set(l.id, el);
                      else rowRefs.current.delete(l.id);
                    }}
                    className={l.id === selectedLayer ? 'selected' : undefined}
                    onClick={() => setSelectedLayer(l.id)}
                  >
                    <td>{i}</td>
                    <td>{l.type}</td>
                    <td>{l.id}</td>
                    <td>{l.input_blobs.length}</td>
                    <td>{l.output_blobs.length}</td>
                    <td style={{ fontFamily: 'monospace', color: light ? '#0058b0' : '#7ab8ff' }}>{outShape}</td>
                  </tr>
                  );
                })}
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
