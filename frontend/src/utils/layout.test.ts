// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import { getLayoutedElements, type MeasureNodeHeight } from './layout';

// Typing shim: the layout helper accepts the bare React Flow Node
// type and ignores the `data` payload, so tests only need `id`.
function mkNode(id: string): Node {
  return { id, position: { x: 0, y: 0 }, data: {} } as Node;
}

describe('getLayoutedElements height measurement', () => {
  const nodes = [mkNode('a'), mkNode('b'), mkNode('c')];
  const edges: Edge[] = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'a', target: 'c' },
  ];

  it('uses the 350px default when no measurer is supplied (backward compat)', () => {
    // Pre-#4 behavior: dagre sees every node as 350px tall and
    // positions are centered around that. b and c, siblings of a,
    // should end up vertically separated by at least 350px.
    const { nodes: out } = getLayoutedElements(nodes, edges);
    const b = out.find((n) => n.id === 'b')!;
    const c = out.find((n) => n.id === 'c')!;
    expect(Math.abs(b.position.y - c.position.y)).toBeGreaterThanOrEqual(350);
  });

  it('spaces tall nodes further apart when measured', () => {
    // Simulate: `a` is a short 120px utility node, but `b` and `c`
    // are 600px inference cards. Dagre must route them such that
    // the vertical gap between b and c scales with their real
    // heights, not the old 350px constant.
    const measure: MeasureNodeHeight = (id) => (id === 'a' ? 120 : 600);
    const { nodes: tallOut } = getLayoutedElements(nodes, edges, 'LR', measure);
    const bTall = tallOut.find((n) => n.id === 'b')!;
    const cTall = tallOut.find((n) => n.id === 'c')!;
    const tallGap = Math.abs(bTall.position.y - cTall.position.y);
    expect(tallGap).toBeGreaterThanOrEqual(600);

    // And the short scenario should give back a smaller gap, proving
    // the measure actually flows through to dagre.
    const shortMeasure: MeasureNodeHeight = () => 120;
    const { nodes: shortOut } = getLayoutedElements(nodes, edges, 'LR', shortMeasure);
    const bShort = shortOut.find((n) => n.id === 'b')!;
    const cShort = shortOut.find((n) => n.id === 'c')!;
    const shortGap = Math.abs(bShort.position.y - cShort.position.y);
    expect(shortGap).toBeLessThan(tallGap);
  });

  it('falls back to default when measurer returns undefined for a node', () => {
    // A node added in the same frame as the layout call won't have
    // a mounted DOM element yet. The measurer returns undefined for
    // that node; layout should still produce a valid position
    // rather than throwing or placing it at NaN.
    const measure: MeasureNodeHeight = (id) => (id === 'a' ? undefined : 200);
    const { nodes: out } = getLayoutedElements(nodes, edges, 'LR', measure);
    for (const n of out) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it('y-centering uses the same height that was fed to dagre', () => {
    // Regression: the original bug bucket was mixing measured height
    // for placement inside dagre but using the default height in the
    // centering offset (`y - nodeHeight/2`), producing cards that
    // drifted by (measured - default)/2 pixels. Verify that passing
    // a measurer produces y values consistent with `h/2` centering.
    const H = 480;
    const measure: MeasureNodeHeight = () => H;
    const { nodes: out } = getLayoutedElements([mkNode('solo')], [], 'LR', measure);
    const solo = out[0];
    // dagre centers a single isolated node at (w/2, h/2), which
    // after our subtraction of (w/2, h/2) lands at (0, 0).
    expect(solo.position.x).toBeCloseTo(0, 0);
    expect(solo.position.y).toBeCloseTo(0, 0);
  });
});
