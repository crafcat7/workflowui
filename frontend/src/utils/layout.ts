// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import dagre from 'dagre';
import { type Node, type Edge } from '@xyflow/react';

// Horizontal extent is driven by CSS (`.react-flow__node` has a
// fixed min-width), so a static approximation is fine here; dagre
// only needs the width accurate enough to space ranks apart.
const DEFAULT_NODE_WIDTH = 250;

// Used for any node whose actual rendered height the caller
// couldn't (or chose not to) measure. The old pre-measurement
// code used this same 350 globally, which caused tall inference /
// postprocess cards to overlap their vertical neighbors because
// dagre was routing as if every node occupied 350px even when some
// occupied 520px. Keeping 350 as the fallback preserves behavior
// for callers that don't pass a measurer (tests, initial load
// before refs settle).
const DEFAULT_NODE_HEIGHT = 350;

/**
 * Optional per-node height measurer. Return `undefined` to fall
 * back to the default — useful when a node hasn't mounted yet (new
 * node added in the same frame as the layout call) or is outside
 * the viewport and has no reliable rect.
 */
export type MeasureNodeHeight = (nodeId: string) => number | undefined;

/**
 * Query a mounted React Flow node's rendered height in CSS pixels.
 * Returns undefined when no element matches or the rect is zero —
 * rects are zero for detached/hidden nodes and dagre handles the
 * fallback better than a bogus 0.
 *
 * Caveats:
 *   - Height is returned in *screen* pixels; if the user has zoomed
 *     the canvas, the value is pre-multiplied by the zoom factor.
 *     That's fine for LR layout because only relative vertical
 *     spacing matters and every node is measured under the same
 *     transform.
 *   - Only the inner `.react-flow__node` wrapper is queried; we
 *     deliberately don't sum margins, because React Flow positions
 *     nodes by their top-left with no external margin.
 */
export function domNodeHeightMeasurer(): MeasureNodeHeight {
  return (nodeId: string) => {
    const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    if (!(el instanceof HTMLElement)) return undefined;
    const h = el.getBoundingClientRect().height;
    return h > 0 ? h : undefined;
  };
}

export const getLayoutedElements = (
  nodes: Node[],
  edges: Edge[],
  direction = 'LR',
  measure?: MeasureNodeHeight,
) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({ rankdir: direction });

  // Record each node's height so we can re-apply it during the
  // position shift below (dagre.node() loses it otherwise if we
  // ever want the true value back).
  const heightUsed = new Map<string, number>();

  nodes.forEach((node) => {
    const measured = measure?.(node.id);
    const h = measured ?? DEFAULT_NODE_HEIGHT;
    heightUsed.set(node.id, h);
    dagreGraph.setNode(node.id, { width: DEFAULT_NODE_WIDTH, height: h });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const h = heightUsed.get(node.id) ?? DEFAULT_NODE_HEIGHT;
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - DEFAULT_NODE_WIDTH / 2,
        // Use the *same* height we fed dagre — mixing measured
        // height in vs. fallback in the centering offset is what
        // used to cause the overlap in the first place.
        y: nodeWithPosition.y - h / 2,
      },
    };
  });

  return { nodes: newNodes, edges };
};
