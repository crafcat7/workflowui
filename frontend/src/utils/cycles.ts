// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Cycle detection for workflow graphs.
 *
 * The backend rejects cyclic graphs at `workflow.run` time with a
 * flat "Cycle detected in workflow graph" error — unhelpful for the
 * user, who gets no visual indication of *which* edges form the
 * cycle. This helper runs a DFS over the edge list and returns the
 * ids of every edge that participates in at least one cycle, so the
 * renderer can paint them red the moment the offending edge is
 * added, without waiting for a run attempt.
 *
 * Algorithm: classic three-colour DFS. White = unvisited, gray =
 * currently on the recursion stack, black = fully explored. An edge
 * from a gray-current-path node back into another gray node is a
 * *back edge*; every edge on the gray stack between the target and
 * the source is part of at least one cycle.
 *
 * Complexity: O(V + E). No allocation in the steady state beyond
 * the output Set. Safe to run on every edges[] change — the graphs
 * in scope here are hand-built workflows with at most a few hundred
 * nodes, not arbitrary industrial topologies.
 */
export interface CycleEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Returns the set of edge ids that are part of at least one cycle.
 * Edges not in the set are guaranteed not to participate in any
 * cycle. Self-loops (source === target) are always considered
 * cyclic — they can't appear in a DAG by definition.
 */
export function findCyclicEdges<E extends CycleEdge>(edges: readonly E[]): Set<string> {
  const cyclic = new Set<string>();

  // Adjacency list keyed by source node id. Each entry is a list of
  // (target, edgeId) pairs so the DFS can report back *which* edge
  // closed a cycle, not just which node pair it connected (two
  // parallel edges between the same pair need to be distinguishable).
  const adj = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const e of edges) {
    if (e.source === e.target) {
      // Self-loop: no point running DFS, it's cyclic by construction.
      cyclic.add(e.id);
      continue;
    }
    let list = adj.get(e.source);
    if (!list) {
      list = [];
      adj.set(e.source, list);
    }
    list.push({ target: e.target, edgeId: e.id });
  }

  // Three-colour DFS state keyed by node id. Absent = white.
  const GRAY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();

  // Track the path as (node, edgeIdThatLedHere) pairs so that when a
  // back edge is discovered we can walk the stack backward and mark
  // every edge between the back-edge's target and source as cyclic.
  // Iterative DFS (not recursive) to avoid blowing the JS stack on
  // pathological graphs — React-Flow will happily hand us 10k nodes
  // if the user imports a gnarly workflow file.
  type Frame = {
    node: string;
    iter: Iterator<{ target: string; edgeId: string }>;
    /** edgeId that led to this frame from its parent, or null for a root. */
    incomingEdge: string | null;
  };

  // Seed the walk from every node so disconnected components are
  // visited. The gray/black bookkeeping makes re-visits cheap (O(1))
  // so this is effectively linear across all starts.
  const allNodes = new Set<string>();
  for (const e of edges) {
    allNodes.add(e.source);
    allNodes.add(e.target);
  }

  for (const start of allNodes) {
    if (colour.get(start) === BLACK) continue;

    const stack: Frame[] = [
      { node: start, iter: (adj.get(start) ?? [])[Symbol.iterator](), incomingEdge: null },
    ];
    colour.set(start, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.iter.next();
      if (next.done) {
        colour.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const { target, edgeId } = next.value;
      const c = colour.get(target);
      if (c === GRAY) {
        // Back edge → cycle closing. Mark this edge and every edge on
        // the current DFS path from `target` down to the frame that
        // owns this iteration.
        cyclic.add(edgeId);
        // Walk the stack backward from the top until we hit `target`,
        // collecting each frame's incomingEdge. Those edges form the
        // cycle. The frame for `target` itself has incomingEdge from
        // *above* it, which is not part of the cycle — stop before
        // including it.
        for (let i = stack.length - 1; i >= 0; i--) {
          const f = stack[i];
          if (f.node === target) break;
          if (f.incomingEdge) cyclic.add(f.incomingEdge);
        }
      } else if (c === undefined) {
        // White → recurse.
        colour.set(target, GRAY);
        stack.push({
          node: target,
          iter: (adj.get(target) ?? [])[Symbol.iterator](),
          incomingEdge: edgeId,
        });
      }
      // BLACK → already fully explored, ignore. (Cannot be on current
      // path, so no cycle can run through it from here.)
    }
  }

  return cyclic;
}
