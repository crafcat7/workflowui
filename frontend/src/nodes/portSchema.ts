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
 *     branch  →  any              (Condition routes payload through;
 *                                   branch targets still only take branch)
 *
 * Adding a new node type: register its handles here and the canvas
 * validator will pick them up automatically; no App.tsx changes needed.
 */

import type { HandleDataType } from '../components/LabeledHandle';
import { NODE_MANIFEST } from './manifest';

export interface PortDef {
  id: string;
  direction: 'source' | 'target';
  dataType: HandleDataType;
}

/** Registry of ports per node type. Derived from `NODE_MANIFEST` so there
 *  is a single source of truth; adding a node type only requires an entry
 *  in the manifest. */
export const NODE_PORTS: Record<string, PortDef[]> = Object.fromEntries(
  NODE_MANIFEST.map((e) => [e.type, e.ports]),
);

export function getPort(
  nodeType: string | undefined,
  handleId: string | null | undefined,
): PortDef | null {
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

  // 'branch' targets may only receive other branches. Checked before the
  // generic wildcard so a 'generic' target cannot silently accept a
  // non-branch source when both sides claim to be strict.
  if (targetType === 'branch') {
    return {
      ok: false,
      reason: `'branch' target can only accept a 'branch' source (got ${sourceType} → ${targetType})`,
    };
  }

  // 'branch' sources carry the Condition node's payload through to the
  // taken branch (see ConditionHandler::execute). They may feed any
  // non-branch target — this matches the backend port-type validator
  // in `backend/src/workflow/executor.cpp`.
  if (sourceType === 'branch') return { ok: true };

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
    return {
      ok: false,
      reason: `${srcNode?.type}:${connection.sourceHandle} is not a source port`,
    };
  }
  if (tgtPort && tgtPort.direction !== 'target') {
    return {
      ok: false,
      reason: `${tgtNode?.type}:${connection.targetHandle} is not a target port`,
    };
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
