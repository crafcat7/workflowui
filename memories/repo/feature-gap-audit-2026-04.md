# Feature Gap Audit — 2026-04-24

Product / functional gaps after the Batch 1–10 readability pass.
Ranked high → low priority. Evidence cited as `file:line`.
Research-only snapshot; not a code-quality review.

## Top 10 priorities

1. **Variable inspector at breakpoint is a stub.** `debugStore.inspectData`
   is written but never rendered; backend pause payload doesn't carry
   tensor data.
2. **No loops / iteration / batch-over-list.** Executor does one
   topological pass; no `forEach` node, no dataset iteration.
3. **Only 11 node types, all NCNN-flavored.** No tensor
   reshape/concat/split/resize/normalize; no ONNX/TFLite; no extension
   API.
4. **No pre-run graph validation UI.** Type mismatch & missing-input
   checks happen at connect-time only; orphaned required inputs
   surface as `runtime_error` mid-run.
5. **No autosave / persistence / workflow history.** Closing the tab
   loses everything not manually downloaded.
6. **No per-node timing chart, memory, or profile view.** Elapsed ms
   is per-node text only; no aggregate Gantt/flame view.
7. **No CLI / headless runner.** Backend has no workflow-file CLI
   mode; all execution requires the React UI.
8. **No authentication or multi-user isolation.** WebSocket accepts
   any connection from allow-listed origin; single shared executor.
9. **Errors surface only as toasts + log entries.** No error panel,
   no stack traces, no "retry this node", no recovery.
10. **No multi-select / grouping / copy-paste between workflows.**
    Clipboard path is single-node only.

## Theme 1 — Workflow Authoring UX

- Undo/redo single-stack, 50 entries, no named checkpoints —
  `workflowStore.ts:239` `limit: 50`. *Effort: M* for checkpoints.
- No multi-node operations. `duplicateNode`, `removeNode`,
  `toggleBreakpointOnSelected` all take one id
  (`workflowStore.ts:107`, `useWorkflowActions.ts:148,154,171`).
  Ctrl+A selects all (`useWorkflowActions.ts:164`) but downstream
  actions ignore that selection. *Effort: M*.
- No copy/paste across workflows. `handleLegacyCopy`
  (`useKeyboardShortcuts.ts:138`) copies one node as JSON. *Effort: S*.
- No grouping / subgraphs. React Flow parent-node feature unused.
  *Effort: L*.
- No node search — palette is static grouped list
  (`NodePalette.tsx`). *Effort: S*.
- Auto-layout is dagre LR with fixed `nodeHeight=350`
  (`utils/layout.ts:7`); tall nodes overlap. *Effort: S*.
- No pre-run validation UI. Connection-time validation exists
  (`portSchema.ts:133`) but required-input presence is only checked
  inside handlers at run time (`core_handlers.cpp:220,242,…`).
  *Effort: M*.
- No templates / snippets library — only `demo/NCNN_demo/workflow.json`.
  *Effort: S*.

## Theme 2 — Execution Model

- No loops / iteration / foreach / batch. `Executor::execute` is
  single topological pass (`executor.cpp:18,25`). Blocks bench
  matrices and dataset iteration. *Effort: L*.
- No parallelism across independent branches. Scheduler returns
  plain `topological_sort` (`scheduler.cpp:7`); one thread runs
  everything. *Effort: M*.
- No retry / error recovery. Exception marks node `error` and keeps
  running downstream (`executor.cpp:36-72`); descendants hit
  spurious "Missing input" errors. Only Condition's dead-port pruning
  works (`executor.cpp:35`). *Effort: M*.
- No per-node timeout. Handlers can block forever; `workflow.stop`
  only checks atomic between nodes (`main.cpp:243`). *Effort: M*.
- No caching of outputs. `port_data_` cleared every execute
  (`executor.cpp:20`). *Effort: M*.
- Progress granularity is node-level only
  (`WorkflowRunner.ts:28`). *Effort: S*.
- Cancel mid-run is coarse. `DebugController::stop` atomic checked
  only between nodes (`executor.cpp:26,56`); UI freezes inside a
  10 s benchmark. *Effort: M*.

## Theme 3 — Debugging

- **Variable inspector unimplemented.** `debugStore.inspectData`
  populated from `debug.paused` payload (`WorkflowRunner.ts:71`) but
  0 components read it. Backend payload is `{node_id, type}` only
  (`executor.cpp:51-52`). README.md:10 and README.md:200 promise
  "inspect tensor data in real time" — biggest expectation gap.
  *Effort: M* (wire state into Properties panel + extend pause
  payload with port values).
- No step-into vs step-over distinction. Only `step_over` exists
  (`debug_controller.cpp:50`). *Effort: S* placeholder.
- No conditional breakpoints. `breakpoints_` is plain
  `unordered_set<string>` (`debug_controller.h:59`). *Effort: M*.
- No replay / time-travel. `port_data_` cleared on next run
  (`executor.cpp:20`); FE keeps only most recent `output`
  (`WorkflowRunner.ts:47`). *Effort: L*.
- Log filtering absent (`ConsolePanel.tsx:113`); 2000-cap FIFO
  (`debugStore.ts:19`). *Effort: S*.
- "Run to cursor" / pause-at-specific-node missing
  (`debug_controller.h:64`). *Effort: S*.

## Theme 4 — Data & I/O

- No file browser integration. `filepath` fields are text inputs;
  comment explicitly marks as future work
  (`PropertiesPanel.tsx:262-266`). *Effort: S* with Tauri dialog.
- No remote file support (`core_handlers.cpp:117`). *Effort: M*.
- No inline image preview. `OutputBarChart`
  (`PropertiesPanel.tsx:548`) renders numeric tensors but image
  pixels are dropped. *Effort: S*.
- No tensor shape/dtype display. `TensorData` shape inferred from
  `createNet` only. *Effort: M*.
- No streaming tensors — full arrays in each `node.status` push
  (`WorkflowRunner.ts:47`). *Effort: M*.
- No dataset iterator — requires Theme 2 loops. *Effort: M*.

## Theme 5 — Capability / Node Ecosystem

- 11 node types skewed toward "load → infer → save" (`nodes/index.ts:16-28`,
  `core_handlers.cpp:370-383`). Missing primitives:
  - Tensor ops: reshape, slice/split, concat, permute, cast,
    normalize, resize, crop, pad.
  - Math: elementwise, matmul, reduce.
  - Postprocess beyond `nms`/`topk`: sigmoid, softmax, argmax,
    threshold.
  - Image: decode/encode, colorspace.
  - Control: loop, foreach, merge, switch/case, delay.
  - I/O: HTTP, csv, stdin.
  - Comparator / golden-file assertion.
- No ONNX / TFLite / MNN / TensorRT engine — `inference_engine.h`
  pluggable but NCNN is the only impl (`main.cpp:168`). *Effort: L
  per engine*.
- No extension mechanism. Adding a node = TSX + port-schema +
  config-schema + backend handler + rebuild both sides. No dynamic
  plugin loading, Python nodes, or WASM nodes. *Effort: L*.
- Postprocess is hard-coded two-op (`core_handlers.cpp:49`).

## Theme 6 — Persistence & Collaboration

- No autosave. `localStorage`/`persist` grep → 0 hits in src/.
  *Effort: S*.
- No version history / named saves. Save = `Blob → <a download>`
  (`useWorkflowActions.ts:132-142`). *Effort: M*.
- No workflow diff. *Effort: M*.
- No import/export beyond JSON v1 (`workflowStore.ts:141`). No YAML,
  Python codegen, or DOT export. *Effort: S per format*.
- No share-link, node comments, or real-time collaboration.
  *Effort: L*.

## Theme 7 — Observability

- Timing is per-node scalar (`workflowStore.ts:29`,
  `PropertiesPanel.tsx:339`). No Gantt/flame view, no cross-run
  trend (Benchmark is the only exception). *Effort: M*.
- No memory usage reporting. *Effort: M*.
- No FLOPs / layer breakdown. NCNN's layer timing not exposed.
  *Effort: M*.
- No hardware target selection. `NetConfig::use_gpu` was removed as
  dead (`review-findings.md:45`). No CPU/GPU/Vulkan toggle, no
  vendor picker. *Effort: S* UI + *L* impl.
- No profiling view. *Effort: M*.

## Theme 8 — Security & Deployment

- No authentication. Grep of `auth|token|bearer|password|login`
  yields 0 functional matches. `--allow-origin` (`main.cpp:117-120`)
  is the only gate. *Effort: M*.
- No multi-user sessions / per-session executor. One global
  `Executor` (`main.cpp:179`) shared across clients. *Effort: L*.
- Sandbox opt-in. `--shared-dir` off by default
  (`main.cpp:114`); `createNet` bypasses with empty paths
  (`core_handlers.cpp:181-183`). *Effort: S* for default-on.
- No headless / server-mode run. Backend always starts WS
  (`main.cpp:266,282`); no `--run workflow.json --output result.json`.
  *Effort: M*.
- Crash reporter is self-printed backtrace (`main.cpp:34-52`).

## Theme 9 — Error Surfacing

- Errors are toast + log line only. `WorkflowRunner.ts:63` fires
  toast; `PropertiesPanel` does not render failed node's error
  message — only `STATUS: ERROR` badge
  (`PropertiesPanel.tsx:336`). *Effort: S*.
- No backend stack traces. Handlers throw `std::runtime_error`
  caught at `executor.cpp:68-72`, flattened to `e.what()`.
  `backtrace()` is linked but unused here (`main.cpp:43`).
  *Effort: S*.
- No "retry this node" / "resume from node X". *Effort: M*.
- Graph execution continues after error. `executor.cpp:68` catches
  + continues; descendants throw "Missing input" cascade. Contrast
  with Condition's pruning (`executor.cpp:35,104`). *Effort: S*.
- No "invalid workflow" diagnostic — missing required config
  throws only at handler run time.

## Theme 10 — Testing Coverage Gaps

- **Backend:** only `test_executor.cpp`, `test_condition.cpp`,
  `test_security_config.cpp`. Missing:
  - Scheduler cycles / disconnected subgraphs.
  - DebugController pause/resume races (known race
    `review-findings.md:125`).
  - RpcHandler malformed JSON, missing `jsonrpc`, method-not-found,
    notifications vs requests.
  - NCNN engine (`ENABLE_NCNN` gated).
- **Frontend E2E:** 11 workflow + 1 NCNN demo. Missing:
  - Undo/redo after a run (runtime field stripping
    `workflowStore.ts:36-45`).
  - Multi-tab behavior.
  - Auto-reconnect (`ReconnectBanner.tsx` exists, untested).
  - Full keyboard matrix (`useKeyboardShortcuts.ts`).
  - Palette drag-drop.
  - Malformed JSON import (`workflowStore.ts:162-196` error paths).
  - Breakpoint round-trip via context menu.
- No property / fuzz tests for `condition_expr` parser.
- No performance / stress tests for 2000-log cap
  (`debugStore.ts:19`).

## Abandoned / partial work evidence

| Area | Evidence | Status |
|---|---|---|
| Variable inspector | `setInspectData` written (`WorkflowRunner.ts:72`), no reader | started, never finished |
| File browse dialog | Comment "future: add a 'browse' button…" (`PropertiesPanel.tsx:265-266`) | documented future |
| GPU selector | `NetConfig::use_gpu` removed (`review-findings.md:45`) | abandoned |
| `capabilities` RPC | FE handler removed Batch 2; backend method + `CapabilityRegistry` deleted 2026-04 | ✅ removed |
| `SHARED_DIR` env | Docs removed Batch 10 (`review-findings.md:113`) | scoped down |
| `Scheduler` class | One-line wrapper (`scheduler.cpp:7`); inlining deferred (`review-findings.md:121`) | stub |
| Postprocess fallback | `if (op.empty()) op = "nms"` (`core_handlers.cpp:50`) | implies more planned |
| WsServer race | `publish_fn_/loop_` unsynchronized (`review-findings.md:125`) | known gap |

**Biggest expectation gap:** variable inspector at breakpoint.
README claims "inspect tensor data in real time"; actual UI just
flips status to "PAUSED" and logs "Breakpoint hit"
(`WorkflowRunner.ts:76`). Small work, closes largest promise.
