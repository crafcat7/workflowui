// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Port schema + connection validation.
 *
 * The schema below is the single source of truth about every node type's
 * input/output ports and their semantic data types. It must be kept in
 * sync with the <Handle id=… /> elements rendered by each node component
 * in `src/nodes/*`. Validation here prevents nonsensical edges (e.g.,
 * plugging a `net` output into a `tensor` input) from being created in
 * the canvas, surfacing problems to users before a run rather than after.
 *
 * Type lattice:
 *     generic ←→ any              (wildcard — always accepted)
 *     image   →  tensor           (implicit preprocessing coercion)
 *     tensor  ≡  tensor           (strict equality)
 *     net     ≡  net
 *     branch  ≡  branch           (control-flow, isolated)
 *
 * Adding a new node type: register its handles here and the canvas
 * validator will pick them up automatically; no App.tsx changes needed.
 */

import type { HandleDataType } from '../components/LabeledHandle';

export interface PortDef {
  id: string;
  direction: 'source' | 'target';
  dataType: HandleDataType;
}

/** Registry of ports per node type. Empty array means no typed ports. */
export const NODE_PORTS: Record<string, PortDef[]> = {
  inputImage: [{ id: 'image_data', direction: 'source', dataType: 'image' }],
  inputTensor: [{ id: 'tensor_data', direction: 'source', dataType: 'tensor' }],
  createNet: [{ id: 'net_handle', direction: 'source', dataType: 'net' }],
  inference: [
    { id: 'net_handle', direction: 'target', dataType: 'net' },
    { id: 'input_data', direction: 'target', dataType: 'tensor' },
    { id: 'output_data', direction: 'source', dataType: 'tensor' },
  ],
  benchmark: [
    { id: 'net_handle', direction: 'target', dataType: 'net' },
    { id: 'input_data', direction: 'target', dataType: 'tensor' },
    { id: 'benchmark_result', direction: 'source', dataType: 'generic' },
  ],
  saveText: [{ id: 'data', direction: 'target', dataType: 'generic' }],
  condition: [
    { id: 'input_data', direction: 'target', dataType: 'tensor' },
    { id: 'true_branch', direction: 'source', dataType: 'branch' },
    { id: 'false_branch', direction: 'source', dataType: 'branch' },
  ],
  postprocess: [
    { id: 'input_data', direction: 'target', dataType: 'tensor' },
    { id: 'output_data', direction: 'source', dataType: 'tensor' },
  ],
  output: [{ id: 'data', direction: 'target', dataType: 'generic' }],
  debug: [
    { id: 'data_in', direction: 'target', dataType: 'generic' },
    { id: 'data_out', direction: 'source', dataType: 'generic' },
  ],
};

export function getPort(nodeType: string | undefined, handleId: string | null | undefined): PortDef | null {
  if (!nodeType || !handleId) return null;
  const ports = NODE_PORTS[nodeType];
  if (!ports) return null;
  return ports.find((p) => p.id === handleId) ?? null;
}

export interface CompatibilityResult {
  ok: boolean;
  /** Human-readable reason why a connection was rejected (only when !ok). */
  reason?: string;
}

/**
 * Determines whether a source port can feed a target port.
 * Lenient about unknown types (registry gap) to avoid breaking when a new
 * node type ships without a schema update — returns ok: true with a debug
 * reason so callers can log if desired.
 */
export function areTypesCompatible(
  sourceType: HandleDataType | undefined,
  targetType: HandleDataType | undefined,
): CompatibilityResult {
  if (!sourceType || !targetType) {
    return { ok: true, reason: 'port not in registry (allowing)' };
  }
  if (sourceType === targetType) return { ok: true };

  // Branch is a control-flow channel; it must connect only to branch.
  // Checked BEFORE the generic wildcard so a 'generic' target cannot
  // silently accept a branch source.
  if (sourceType === 'branch' || targetType === 'branch') {
    return {
      ok: false,
      reason: `'branch' ports can only connect to other 'branch' ports (got ${sourceType} → ${targetType})`,
    };
  }

  // Wildcard: generic bridges to / from any non-branch type.
  if (sourceType === 'generic' || targetType === 'generic') return { ok: true };

  // Implicit coercion: an image source can feed a tensor target.
  if (sourceType === 'image' && targetType === 'tensor') return { ok: true };

  return {
    ok: false,
    reason: `incompatible port types: ${sourceType} → ${targetType}`,
  };
}

export interface ConnectionLike {
  source: string | null;
  sourceHandle: string | null;
  target: string | null;
  targetHandle: string | null;
}

export interface NodeLike {
  id: string;
  type?: string;
}

/**
 * Validates a proposed connection against the registry. Additional rules:
 * - rejects self-loops,
 * - rejects connections missing source/target,
 * - delegates type checking to `areTypesCompatible`.
 */
export function validateConnection(
  connection: ConnectionLike,
  nodes: ReadonlyArray<NodeLike>,
): CompatibilityResult {
  if (!connection.source || !connection.target) {
    return { ok: false, reason: 'connection missing endpoints' };
  }
  if (connection.source === connection.target) {
    return { ok: false, reason: 'cannot connect a node to itself' };
  }

  const srcNode = nodes.find((n) => n.id === connection.source);
  const tgtNode = nodes.find((n) => n.id === connection.target);
  const srcPort = getPort(srcNode?.type, connection.sourceHandle);
  const tgtPort = getPort(tgtNode?.type, connection.targetHandle);

  // Direction sanity check when registry entries exist.
  if (srcPort && srcPort.direction !== 'source') {
    return { ok: false, reason: `${srcNode?.type}:${connection.sourceHandle} is not a source port` };
  }
  if (tgtPort && tgtPort.direction !== 'target') {
    return { ok: false, reason: `${tgtNode?.type}:${connection.targetHandle} is not a target port` };
  }

  return areTypesCompatible(srcPort?.dataType, tgtPort?.dataType);
}

/** Convenience for the React Flow `isValidConnection` prop. */
export function isConnectionValid(
  connection: ConnectionLike,
  nodes: ReadonlyArray<NodeLike>,
): boolean {
  return validateConnection(connection, nodes).ok;
}
