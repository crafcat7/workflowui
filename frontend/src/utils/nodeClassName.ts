// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors

/**
 * Pure className builder used by the styledNodes memo. Exported for
 * unit-test coverage so the cache key in `styledNodes` and the
 * resulting className stay in sync — a regression in either side
 * would silently degrade the badge styling without any test catching
 * it (the visual diff is too small for snapshot tests, the bug is
 * cache-correctness not visual).
 *
 * The output deliberately preserves token order so existing CSS
 * selectors that key on adjacency (`.inference.node-running`) keep
 * matching, and skips empty tokens so the className doesn't gain
 * trailing whitespace as conditions toggle off.
 */
export function computeNodeClassName(args: {
  category: string;
  status: string | undefined;
  selected: boolean;
  hasBp: boolean;
  bpEnabled: boolean;
}): string {
  const { category, status, selected, hasBp, bpEnabled } = args;
  return [
    category,
    selected ? 'selected' : '',
    status === 'running' ? 'node-running' : '',
    status === 'paused' ? 'node-paused' : '',
    hasBp ? (bpEnabled ? 'node-bp-armed' : 'node-bp-disabled') : '',
  ]
    .filter(Boolean)
    .join(' ');
}
