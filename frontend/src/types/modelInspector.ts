// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Frontend twin of backend/src/vendor/model_inspector.h — types
 * carried over JSON-RPC `model.inspect`. Field names mirror the
 * backend wire shape exactly (snake_case for the on-the-wire
 * payload, camelCase only on the request side because the request
 * shape is a frontend-defined ergonomic wrapper before the hook
 * translates it).
 *
 * If you change anything here, update:
 *   - backend/src/vendor/model_inspector.h (`to_json` output)
 *   - backend/tests/test_model_inspector_ir.cpp (wire-shape pin)
 *   - backend/tests/test_model_inspect_rpc.cpp (RPC happy-path)
 *
 * That triad is the contract; this file is the consumer side.
 */

export interface ModelLayer {
  id: string;
  type: string;
  input_blobs: string[];
  output_blobs: string[];
  /** Engine-specific k=v map. ncnn uses string keys for int param
   *  ids (e.g. "0" → num_output for Convolution). Values are
   *  number | string | boolean | array of those. Free-form JSON. */
  params: Record<string, unknown>;
}

export interface ModelBlob {
  name: string;
  /** Empty when the engine emits no shape hint for this blob. */
  shape: number[];
  /** Layer id producing this blob; empty string for graph inputs. */
  producer: string;
  /** Layer ids reading this blob. Empty for graph outputs. */
  consumers: string[];
}

export interface ModelGraph {
  vendor: string;
  format_version: string;
  layers: ModelLayer[];
  blobs: ModelBlob[];
  param_bytes: number;
  bin_bytes: number;
  input_blob_names: string[];
  output_blob_names: string[];
  /** Reserved: always false in this iteration. The drawer toggles
   *  any future "Edit" affordance on this flag — wired now to avoid
   *  a schema bump when edit support lands. */
  editable: boolean;
}

/**
 * Request shape used by the React hook. The hook converts these
 * camelCase fields into snake_case before sending to the backend
 * (the backend rejects camelCase per the project-wide RPC convention).
 */
export interface ModelInspectRequest {
  vendor: string;
  paramPath: string;
  /** Optional .bin path. Empty / undefined → backend reports
   *  bin_bytes = 0 and skips bin metadata. */
  modelPath?: string;
}

/**
 * Unified error envelope for both RPC errors (negative `code`,
 * matches JSON-RPC 2.0 codes: -32602 invalid params, -32000 server
 * error from a malformed model file) and transport failures (code
 * 0, e.g. WS disconnected mid-call). The drawer can branch:
 *   - code < 0 && code !== -32602 → "model file looks broken"
 *   - code === -32602            → "tell the user the request was bad"
 *   - code === 0                 → "transport / timeout"
 */
export interface ModelInspectError {
  code: number;
  message: string;
}
