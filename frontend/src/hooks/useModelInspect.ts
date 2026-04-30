// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * useModelInspect - request a structural ModelGraph for an inference
 * model file and surface the loading / error / data triple as React
 * state.
 *
 * The hook is intentionally split out from any UI component so:
 *   - The drawer (commit 4b) and any future surface (e.g. a model
 *     diff view, a CLI dev-tool) share the same wire-shape decoder
 *     and error-handling rules.
 *   - Tests can cover the success / network-error / parser-error
 *     branches without mounting React Flow.
 *
 * Lifecycle: the hook does NOT auto-fetch. Callers invoke
 * `inspect({ vendor, paramPath, modelPath })` explicitly when the
 * user opens the drawer. We avoid useEffect-on-mount because the
 * paramPath comes from the selected node's config, which can change
 * mid-session — fire on user intent, not on data churn.
 *
 * Cancellation: WsClient.call is not cancellable, but each invocation
 * stamps a monotonic request id; only the latest result is committed
 * to state. This prevents the drawer flashing stale data when a user
 * rapidly switches between inference nodes.
 */

import { useCallback, useRef, useState } from 'react';
import { wsClient } from '../transport/WsClient';
import type { ModelGraph, ModelInspectError, ModelInspectRequest } from '../types/modelInspector';

export interface UseModelInspectResult {
  /** Latest successful graph, or null until the first successful call. */
  graph: ModelGraph | null;
  /** True while a request is in flight. */
  loading: boolean;
  /** Latest failure; cleared on the next successful call. */
  error: ModelInspectError | null;
  /** Issue a new model.inspect call. Stale results are dropped. */
  inspect: (req: ModelInspectRequest) => Promise<void>;
  /** Reset all state — drawer close handler calls this. */
  reset: () => void;
}

export function useModelInspect(): UseModelInspectResult {
  const [graph, setGraph] = useState<ModelGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ModelInspectError | null>(null);
  // Request id is incremented on every call; only the most recent
  // request commits its outcome. Using a ref (not state) so the
  // increment doesn't trigger a render.
  const seqRef = useRef(0);

  const inspect = useCallback(async (req: ModelInspectRequest) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = (await wsClient.call('model.inspect', {
        vendor: req.vendor,
        param_path: req.paramPath,
        model_path: req.modelPath ?? '',
      })) as ModelGraph;
      if (seq !== seqRef.current) return; // stale
      setGraph(result);
    } catch (e: unknown) {
      if (seq !== seqRef.current) return;
      // WsClient.call rejects with a value carrying { code, message }
      // for JSON-RPC errors and a plain Error for transport failures.
      // We unify both into ModelInspectError so consumers branch on
      // .code without instanceof checks.
      const err = toInspectError(e);
      setError(err);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    seqRef.current++; // invalidate any in-flight call
    setGraph(null);
    setError(null);
    setLoading(false);
  }, []);

  return { graph, loading, error, inspect, reset };
}

/**
 * Normalize WsClient rejection values into ModelInspectError.
 *
 * JSON-RPC errors arrive as plain objects with shape `{code, message}`;
 * the WS transport layer rejects with an Error for connection drops
 * and timeouts. The drawer needs to render both — we keep the code
 * field truthful (negative for RPC errors, 0 for non-RPC failures)
 * so the UI can decide whether to show "model file is malformed" vs
 * "lost connection".
 */
export function toInspectError(e: unknown): ModelInspectError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const obj = e as { code: unknown; message: unknown };
    if (typeof obj.code === 'number' && typeof obj.message === 'string') {
      return { code: obj.code, message: obj.message };
    }
  }
  if (e instanceof Error) return { code: 0, message: e.message };
  return { code: 0, message: String(e) };
}
