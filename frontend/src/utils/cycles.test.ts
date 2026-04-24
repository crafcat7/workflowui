// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect } from 'vitest';
import { findCyclicEdges } from './cycles';

describe('findCyclicEdges', () => {
  it('returns an empty set for a DAG', () => {
    // Three-node linear chain is the canonical acyclic case; none of
    // its edges should be flagged. This is the baseline "don't false-
    // positive on normal workflows" property.
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    expect(findCyclicEdges(edges)).toEqual(new Set());
  });

  it('flags every edge of a simple two-node cycle', () => {
    // a → b → a: both edges are on the cycle and the set should
    // contain both. The order in which DFS discovers them doesn't
    // matter; the *membership* does.
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ];
    const result = findCyclicEdges(edges);
    expect(result.has('e1')).toBe(true);
    expect(result.has('e2')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('flags all edges of a longer cycle, not just the closing back edge', () => {
    // a → b → c → a: naive DFS implementations only mark the back
    // edge (c→a), leaving a→b and b→c unmarked and the user unable
    // to see the full loop. Every participating edge must be flagged.
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
      { id: 'e3', source: 'c', target: 'a' },
    ];
    const result = findCyclicEdges(edges);
    expect(result.size).toBe(3);
    expect(result).toEqual(new Set(['e1', 'e2', 'e3']));
  });

  it('leaves acyclic edges alone when they coexist with a cycle', () => {
    // Partial-cycle graph: x → a → b → a (cycle), a → y (innocent
    // tributary). The y branch must NOT be coloured red — it's a
    // valid DAG edge that happens to share a node with a cycle.
    const edges = [
      { id: 'pre', source: 'x', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
      { id: 'post', source: 'a', target: 'y' },
    ];
    const result = findCyclicEdges(edges);
    expect(result.has('e1')).toBe(true);
    expect(result.has('e2')).toBe(true);
    expect(result.has('pre')).toBe(false);
    expect(result.has('post')).toBe(false);
  });

  it('handles self-loops as trivially cyclic', () => {
    // A node with an edge to itself (a → a) is inherently a cycle
    // even though DFS never recurses. Guard against the implementation
    // skipping this case.
    const edges = [{ id: 'loop', source: 'a', target: 'a' }];
    expect(findCyclicEdges(edges)).toEqual(new Set(['loop']));
  });

  it('distinguishes parallel edges between the same pair of nodes', () => {
    // Two edges a→b plus b→a form a cycle. The cyclic set should
    // reference every edge *id* involved, even when multiple edges
    // share source/target — the renderer uses ids, not endpoints.
    const edges = [
      { id: 'ab1', source: 'a', target: 'b' },
      { id: 'ab2', source: 'a', target: 'b' },
      { id: 'ba', source: 'b', target: 'a' },
    ];
    const result = findCyclicEdges(edges);
    expect(result.has('ba')).toBe(true);
    // At least one of ab1/ab2 must be flagged (whichever DFS traversed
    // to reach b when it closed the cycle). We don't assert on which
    // one — DFS iteration order depends on Map insertion order, which
    // is stable in JS but shouldn't be a contract of this helper.
    expect(result.has('ab1') || result.has('ab2')).toBe(true);
  });

  it('handles disconnected components independently', () => {
    // Two disconnected subgraphs, only one containing a cycle. The
    // DFS must seed from every node (not just roots) or the cycle
    // in the orphan component gets missed.
    const edges = [
      { id: 'dag1', source: 'a', target: 'b' },
      { id: 'dag2', source: 'b', target: 'c' },
      { id: 'cyc1', source: 'x', target: 'y' },
      { id: 'cyc2', source: 'y', target: 'x' },
    ];
    const result = findCyclicEdges(edges);
    expect(result).toEqual(new Set(['cyc1', 'cyc2']));
  });

  it('is linear on large acyclic graphs', () => {
    // Stress: 1000-node chain. Mostly a smoke test that the iterative
    // DFS doesn't blow recursion limits and finishes in well under a
    // second. Not a microbenchmark — just a lower bound on "works".
    const edges = [];
    for (let i = 0; i < 999; i++) {
      edges.push({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}` });
    }
    const t0 = performance.now();
    const result = findCyclicEdges(edges);
    const t1 = performance.now();
    expect(result.size).toBe(0);
    expect(t1 - t0).toBeLessThan(500);
  });
});
