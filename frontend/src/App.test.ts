// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect } from 'vitest';
import { computeNodeClassName } from './utils/nodeClassName';

// Sanity coverage for the className helper that drives ReactFlow node
// visuals. The styledNodes memo keys its per-node cache on the same
// 5-tuple this function depends on; if either side drifts the cache
// can return stale className strings (correct id, wrong badge state)
// and the visual diff is too small for snapshot tests to catch.
describe('computeNodeClassName', () => {
  it('joins tokens with single spaces and skips empty branches', () => {
    expect(
      computeNodeClassName({
        category: 'inference',
        status: undefined,
        selected: false,
        hasBp: false,
        bpEnabled: false,
      }),
    ).toBe('inference');
  });

  it('emits running and paused badges only for the matching status', () => {
    expect(
      computeNodeClassName({
        category: 'cat',
        status: 'running',
        selected: false,
        hasBp: false,
        bpEnabled: false,
      }),
    ).toBe('cat node-running');
    expect(
      computeNodeClassName({
        category: 'cat',
        status: 'paused',
        selected: false,
        hasBp: false,
        bpEnabled: false,
      }),
    ).toBe('cat node-paused');
    // 'idle'/'done'/'error'/etc must not produce a status token.
    expect(
      computeNodeClassName({
        category: 'cat',
        status: 'done',
        selected: false,
        hasBp: false,
        bpEnabled: false,
      }),
    ).toBe('cat');
  });

  it('breakpoint armed vs disabled toggles the matching token', () => {
    expect(
      computeNodeClassName({
        category: 'cat',
        status: undefined,
        selected: false,
        hasBp: true,
        bpEnabled: true,
      }),
    ).toBe('cat node-bp-armed');
    expect(
      computeNodeClassName({
        category: 'cat',
        status: undefined,
        selected: false,
        hasBp: true,
        bpEnabled: false,
      }),
    ).toBe('cat node-bp-disabled');
    // hasBp=false must skip the breakpoint token regardless of bpEnabled.
    expect(
      computeNodeClassName({
        category: 'cat',
        status: undefined,
        selected: false,
        hasBp: false,
        bpEnabled: true,
      }),
    ).toBe('cat');
  });

  it('preserves the documented token order across all flags', () => {
    // Order matters: existing CSS selectors key on adjacency, e.g.
    // `.inference.node-running` for the running glow on inference
    // nodes. Reordering tokens here would silently break those rules.
    expect(
      computeNodeClassName({
        category: 'inference',
        status: 'running',
        selected: true,
        hasBp: true,
        bpEnabled: true,
      }),
    ).toBe('inference selected node-running node-bp-armed');
  });
});
