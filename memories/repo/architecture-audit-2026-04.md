# Architecture Audit — 2026-04-24

Structural / design-level issues after the Batch 1–10 readability
pass. Evidence cited as `file:line`. Research-only snapshot.

## Top 10 architectural concerns

| # | Concern | Severity | Effort |
|---|---|---|---|
| 1 | Detached-thread run model with unsynchronized shared Executor state | Critical | M |
| 2 | `WsServer::loop_` / `publish_fn_` cross-thread access without synchronization | Critical | S |
| 3 | Node extensibility requires coordinated edits across 7+ files | High | L |
| 4 | `CapabilityRegistry` is decorative; not a source of truth | High | S–M |
| 5 | Ad-hoc stringly-typed error model end-to-end | High | M |
| 6 | RPC layer lacks cancellation, versioning, input validation, per-run isolation | High | M |
| 7 | No backend enforcement of port types; FE-only `portSchema.ts` | High | M |
| 8 | Resource lifetime: net handles never destroyed, port outputs pinned for whole run | Medium | M |
| 9 | Zustand store O(N) per tick + `JSON.stringify` in zundo equality | Medium | M |
| 10 | No RPC-layer or WS-layer tests; protocol duplicated in 3 places | Medium | S |

## 1. Concurrency & threading

### C1. Detached worker thread owns shared Executor — Critical
- Every `workflow.execute` spawns `std::thread(...).detach()` that
  mutates `Executor`'s shared maps with no lock, while the uWS
  thread concurrently mutates the attached `DebugController`.
- `main.cpp:236-238` — `std::thread([executor, graph = std::move(graph)]() mutable { executor->execute(graph); }).detach();`
- `executor.h:66-74` — `port_data_`, `dead_ports_`, `handlers_`
  plain maps.
- `main.cpp:256,261` — WS thread touches `executor->debug_controller().add_breakpoint(...)` while worker runs.
- Symptom: second `workflow.execute` before first finishes clobbers
  `port_data_`; shutdown tears down detached threads mid-execute,
  leaking NCNN `Net` handles; signal handler (`main.cpp:34`) calls
  `backtrace_symbols_fd` which mallocs (async-signal-unsafe).
- Fix: per-run `RunSession` owning state; serialize submissions
  through a single worker or reject concurrent `workflow.execute`
  with typed error; join on shutdown. *Effort: M*.

### C2. `WsServer::loop_` + `publish_fn_` race — Critical
- `ws_server.h:29-30` — plain members.
- `ws_server.cpp:70,72` — assigned in listen callback.
- `ws_server.cpp:77-78` — reset on shutdown.
- `ws_server.cpp:81-96` — `broadcast()` reads both unguarded.
- Already flagged (`review-findings.md:125`).
- Symptom: harmless today because shutdown is `SIGKILL`, but any
  graceful stop path or destructor-in-test races and delivers torn
  pointers.
- Fix: `std::atomic<std::shared_ptr<...>>` or mutex; snapshot in
  `broadcast()`. *Effort: S*.

### C3. DebugController atomic+mutex mix — Medium
- `debug_controller.cpp:38-42` — `paused_.store(true)` then
  separately locks and notifies. CV predicate reads atomics.
- Symptom: works today; any future refactor moving state under lock
  silently breaks predicate ordering.
- Fix: move flags under the mutex; atomics only for fast-path
  queries. *Effort: S*.

## 2. Error model

### E1. `std::runtime_error("message")` all the way to toast — High
- `executor.cpp:68-72` — catch-all: `status="error"` with
  `e.what()`.
- `rpc_handler.cpp:55-56` — all exceptions → code `-32000`.
- `core_handlers.cpp:46,103,118,220-221` — exceptions as primary
  error channel.
- `WorkflowRunner.ts:57-65` — `update.error` → toast.
- Symptom: `createNet` failure → one toast; downstream `inference`
  throws "Missing net_handle" → second toast, same root cause, two
  unrelated-looking messages. No recoverability signal.
- Fix: `struct NodeError { code, message, details, recoverable }`;
  propagate in status notifications; decide fail-fast vs fail-soft
  policy. *Effort: M*.

### E2. Node failure policy is emergent — Medium
- `executor.cpp:36-72` — loop continues after throw; `dead_ports_`
  only populated by condition-branch pruning, not by handler throws.
- Symptom: cascade of spurious "Missing input" errors for one
  upstream failure.
- Fix: on throw, mark all downstream-reachable ports as
  `dead_ports_` with reason. *Effort: S*.

## 3. Extensibility

### X1. Adding a node touches 7+ files — High
- `core_handlers.cpp:370-383` — backend registration.
- `nodes/index.ts:16-28,37-49` — `nodeTypes` + `nodeTypeList`.
- `portSchema.ts:33-63` — `NODE_PORTS`.
- `configSchemas.ts:54-223` — `NODE_SCHEMAS`.
- `App.tsx:349-360` — `NODE_CATEGORIES` coloring.
- `main.cpp:169-176` — `CapabilityRegistry` manual entries.
- Plus the `.tsx` component.
- Drift already present: `inputImage` FE schema has only `filePath`
  but `ImageData` carries width/height/channels; `read_image` is in
  `CapabilityRegistry` but handler key is `inputImage`.
- Fix: single declarative node manifest; handler self-registration
  with ports + config schema; expose via `nodes.list` RPC; FE
  consumes manifest. *Effort: L*.

### X2. `CapabilityRegistry` is decorative — High
- `capability/registry.cpp:15-30` — hand-populated.
- `main.cpp:184-186` — registration.
- `grep -r capabilities frontend/src` → 0 consumers.
- Symptom: dead surface; duplicated cognitive load; drift from real
  handler list.
- Fix: delete, or unify with handler self-registration (X1).
  *Effort: S delete / M unify*.

### X3. `Scheduler` is a one-line wrapper — Low
- `scheduler.cpp:7-9` forwards to `graph.topological_sort()`.
- Symptom: implies pluggability that does not exist.
- Fix: inline & delete, or move skip/prune into Scheduler.
  *Effort: S*.

## 4. Schema & typing

### S1. Port types only validated on FE — High
- `portSchema.ts:107` — FE coercion rules.
- `core_handlers.cpp:224,246` — unchecked `std::get<TensorData>`.
- `node.h:23-30` — `PortValue` variant.
- Symptom: graphs from older FEs or other clients cause
  `bad_variant_access` caught as generic error.
- Fix: ship port types generated from manifest (X1); Executor
  validates before dispatch. *Effort: M*.

### S2. Node config is `unordered_map<string, string>` — Medium
- `node.h:35`; `core_handlers.cpp:58,88,141,151` — `std::stoi` /
  `std::stof` with silent defaults on throw.
- Symptom: typos silently become defaults; schema drift undetectable.
- Fix: validate `node.config` against per-node schema at RPC
  ingress; use `json` values. *Effort: M*.

### S3. `NetConfig` leaks NCNN fields — Medium
- `vendor/inference_engine.h:14-27` — `input_w/h/c`,
  `input_name="data"`, `output_name`, `empty_weights`,
  `num_threads`.
- Symptom: non-NCNN engines must re-interpret; `StubEngine`
  (`main.cpp:59-79`) ignores most.
- Fix: `map<string, json>` keyed on engine's `config_schema()`;
  kill special-case `vendorSchema` in `PropertiesPanel.tsx:44-74`.
  *Effort: M*.

## 5. Frontend state management

### F1. O(N) rebuilds per tick + JSON.stringify in zundo equality — Medium
- `workflowStore.ts:131-137` — `updateNodeStatus` maps all nodes.
- `workflowStore.ts:219-223` — `JSON.stringify(xd.config) !== JSON.stringify(yd.config)`.
- `App.tsx:218-241` — `styledNodes` memo rebuilds Map every tick.
- Symptom: 50-node run × ~5 ticks/node ≈ 250 full config
  serializations. Lag at 200+ nodes.
- Fix: normalize to `nodesById` + `order: string[]`; per-node
  selectors; drop JSON.stringify in equality. *Effort: M*.

### F2. `PropertiesPanel.tsx` is 614 lines with module-global vendor cache — Low/Medium
- `PropertiesPanel.tsx:44-74` — `let cachedSchema`; no invalidation
  on reconnect.
- Symptom: restarting backend with different engine shows stale
  schema until page reload.
- Fix: split into `<PropertiesPanel>`/`<SchemaRenderer>`/
  `<VendorSchemaRenderer>`; move cache into zustand slice keyed by
  connection generation. *Effort: S*.

### F3. Breakpoint toggle duplicated — Low
- `useWorkflowActions.ts:171-188` and `NodeContextMenu.tsx`.
- Fix: shared `debugActions` module. *Effort: S*.

## 6. Graph model

### G1. `inputs_for` is O(E) per call, called per node — Medium
- `workflow_graph.cpp:63-71` — linear scan.
- `executor.cpp:108-122`, `:36` — per-node calls.
- Symptom: fine at 1k nodes; quadratic at 10k+.
- Fix: adjacency + reverse-adjacency indices on `add_edge`.
  *Effort: S*.

### G2. No DAG-cycle UX — Medium
- `workflow_graph.cpp:57` — cycles rejected only at execute time.
- `portSchema.ts:140` — FE only blocks self-loops.
- Symptom: toast "Cycle detected" with no visual indication of
  offending edges.
- Fix: `graph.validate` RPC (or FE-side) and highlight cycle edges.
  *Effort: S*.

### G3. No subgraph / loop primitives — Low
- Entire `workflow_graph.{h,cpp}` + scheduler path.
- Symptom: real ML workloads (batching, dataset iteration)
  inexpressible.
- Fix: Scheduler rewrite + node-type extensions. *Effort: L*.

## 7. RPC layer

### R1. No cancellation, versioning, per-run isolation — High
- `rpc_handler.cpp:16-60` — thin `method → handler` map.
- `ws_server.cpp:47` — `broadcast` hits every client.
- Symptom: two tabs share status; `debug.stop` acts on the single
  global Executor with no run-id scoping.
- Fix: `run_id` / `session_id` throughout; per-run subscribe topic;
  `protocol_version` negotiation. *Effort: M*.

### R2. No input validation beyond 16 MiB frame cap — High
- `ws_server.cpp:26` — only limit.
- `main.cpp:202,214,256,261` — blind `params[...]` dereferences.
- Symptom: 100k-node payload within 16 MiB pegs topo sort; numeric
  `node_id` causes noisy type throw.
- Fix: validator gate at `RpcHandler::handle_message` entry;
  enforce max nodes/edges/config-value-length/breakpoints.
  *Effort: S–M*.

### R3. No rate limiting — Medium
- No token bucket / counters in `rpc_handler.cpp`.
- Symptom: hostile client can CPU-starve via cheap RPC spam.
- Fix: per-connection token bucket keyed on method class.
  *Effort: S*.

## 8. Capability registry
Covered as X2 above.

## 9. Testing

### T1. No RPC-layer or WS-layer tests — Medium
- Only `test_executor.cpp`, `test_condition.cpp`,
  `test_security_config.cpp` in `backend/tests/`.
- Symptom: RPC payload shape defined in `main.cpp:202-221`,
  `useWorkflowActions.ts:82-95`, and `mock-backend.mjs` — three
  places that silently drift.
- Fix: `test_rpc_handler.cpp` (pure JSON→JSON); JSON schema for
  envelope to validate both sides. *Effort: S*.

### T2. No frontend-store ↔ backend-contract test — Medium
- `mock-backend.mjs` re-implements `workflow.execute` response
  shape.
- Symptom: E2E green on mock but broken on real BE, or vice versa.
- Fix: derive mock from shared schema; or subset of E2E against
  real BE in CI. *Effort: M*.

## 10. Build / dependencies

### B1. Vendor abstraction leaks NCNN concepts
Covered as S3.

### B2. Handler registration is linker-fragile — Low
- `core_handlers.cpp:370-383` — free function called from
  `main.cpp:178-182`.
- Symptom: none today; future plugin-pack concern.
- Fix: `REGISTER_NODE(...)` macro populating global registry at
  static-init (guarded for test isolation). *Effort: S*.

## 11. Configuration

### K1. Config sprawl across CLI, singleton, Vite env, window override, constants — Medium
- `main.cpp:94-150`; `security_config.h:35`;
  `WsClient.ts:74-77`.
- Symptom: hard to answer "what is the running config?"; no hot
  reload.
- Fix: single config struct loaded once; serialize into
  `config.current` RPC for FE. *Effort: M*.

### K2. `SecurityConfig` is process-wide singleton — Medium
- `security_config.h:30-35` — "set once at startup" contract
  impedes testing.
- Fix: pass `SecurityConfig` into Executor/handlers via
  constructor. *Effort: M*.

## 12. Logging & observability

### L1. No trace/run IDs, plain stdout/stderr — Medium
- `ws_server.cpp:46,56,62,64`; `rpc_handler.cpp:37`;
  `debugStore.ts:64` (MAX_LOG_ENTRIES=2000).
- Symptom: correlating FE flake with BE logs requires timestamp
  guessing.
- Fix: `run_id` at execute time in every notification and log
  line; structured key=value logging. *Effort: S*.

### L2. No metrics surface — Low
- No metrics module.
- Fix: minimal `/metrics` endpoint. *Effort: S*.

## 13. Frontend transport

### W1. Reconnect drops in-flight calls without reconciliation — Medium
- `WsClient.ts:116-118,173-175` — pending promises reject with
  "WebSocket closed" on close; reconnect does not replay.
- `useWorkflowActions.ts:97-99` — on reject sets
  `isRunning=false` without cancelling BE.
- Symptom: orphaned backend run; next Run creates second
  overlapping run (feeds C1).
- Fix: idempotent execute keyed on client-generated `run_id`; BE
  rejects duplicates; on reconnect FE calls `workflow.status` to
  reconcile. *Effort: M*.

### W2. No offline queue — Low
- `WsClient.ts:173-175` — `call()` rejects immediately while
  disconnected.
- Fix: bounded queue with per-method TTL. *Effort: S*.

## 14. Memory & resource lifetime

### M1. Net handles never destroyed — Medium
- `inference_engine.h:89` declares `destroy_net`; no callers in
  tree.
- Symptom: each run creating a net leaks engine state.
- Fix: `RunSession` owns net handles and destroys at run end.
  *Effort: S*.

### M2. Port data pinned for whole run — Medium
- `executor.h:66`; `executor.cpp:20` — only cleared on next
  `execute()` entry.
- Symptom: peak memory = sum over all intermediates, not max live
  working set.
- Fix: refcount outputs against remaining consumers; drop after
  last read. *Effort: M*.

### M3. FE `data.output` kept forever — Low
- `workflowStore.ts:36-45` — runtime fields stripped for history
  but kept live.
- Symptom: memory grows across runs; persisted graphs leak
  run-scoped data.
- Fix: move `output` to separate `runResultsStore` keyed by
  `run_id`. *Effort: S*.

## 15. Security

### Sec1. No RPC input schema validation
Covered as R2.

### Sec2. No auth token — Medium
- `security_config.h:35` — origin allow-list is the only gate.
- Symptom: any page on an allowed origin = admin; browser extension
  on allowed origin can drive backend.
- Fix: optional bearer-token gate via CLI flag. *Effort: S*.

### Sec3. Sandbox scope is filesystem-only — Medium
- `security_config.h`; `core_handlers.cpp` — no timeouts.
- Symptom: malicious graph ties up worker indefinitely.
- Fix: per-node wall-clock timeout; per-run memory/time budget.
  *Effort: M*.

## Recommended first moves

1. **C1 + W1**: stop detached threads, introduce `RunSession`, add
   client-generated `run_id`. Unblocks E1, L1, M1, R1, Sec3.
2. **X1 + X2 + S1**: unify node manifest across stack. Eliminates
   drift across 7 files and every future node.
3. **T1**: add `test_rpc_handler.cpp` before protocol changes.
   Cheap insurance for the above refactors.
4. **C2**: tiny lock fix; removes a known latent bug before the
   shutdown path is exercised.
