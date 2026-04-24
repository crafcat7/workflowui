# Review Findings — 2026-04-24 Pass

Consolidated, prioritized action list from four parallel audits
(backend, frontend src, tests, build/config/docs).

Legend: `[ ]` pending · `[x]` done · `[-]` skipped with reason

## Batch 1 — SPDX headers (mechanical, low risk)

Target: bring every hand-written source file to the canonical
```
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
```

### Backend C++ — missing entirely
- [ ] backend/src/main.cpp
- [ ] backend/src/server/ws_server.cpp
- [ ] backend/src/server/ws_server.h
- [ ] backend/src/server/rpc_handler.cpp
- [ ] backend/src/server/rpc_handler.h
- [ ] backend/src/capability/registry.cpp
- [ ] backend/src/capability/registry.h
- [ ] backend/src/workflow/executor.cpp
- [ ] backend/src/workflow/executor.h
- [ ] backend/src/workflow/scheduler.cpp
- [ ] backend/src/workflow/scheduler.h
- [ ] backend/src/workflow/debug_controller.cpp
- [ ] backend/src/workflow/debug_controller.h
- [ ] backend/src/workflow/handlers/node_handler.h
- [ ] backend/src/workflow/handlers/core_handlers.cpp
- [ ] backend/src/workflow/handlers/core_handlers.h
- [ ] backend/src/model/node.cpp
- [ ] backend/src/model/node.h
- [ ] backend/src/model/workflow_graph.cpp
- [ ] backend/src/model/workflow_graph.h
- [ ] backend/src/vendor/inference_engine.h

### Backend C++ — non-canonical (replace `Copyright (c) …` with `SPDX-FileCopyrightText: …`)
- [ ] backend/src/server/security_config.cpp
- [ ] backend/src/server/security_config.h
- [ ] backend/src/workflow/handlers/condition_expr.cpp
- [ ] backend/src/workflow/handlers/condition_expr.h

### Backend tests
- [ ] backend/tests/test_executor.cpp  (missing)
- [ ] backend/tests/main_test.cpp  (missing — may delete instead, see Batch 5)
- [ ] backend/tests/test_condition.cpp  (non-canonical)
- [ ] backend/tests/test_security_config.cpp  (non-canonical)

### Frontend TS/TSX — missing entirely
- [ ] frontend/src/main.tsx
- [ ] frontend/src/components/LabeledHandle.tsx
- [ ] frontend/src/components/ToastContainer.tsx
- [ ] frontend/src/panels/NodePalette.tsx
- [ ] frontend/src/nodes/index.ts
- [ ] frontend/src/nodes/BenchmarkNode.tsx
- [ ] frontend/src/nodes/ConditionNode.tsx
- [ ] frontend/src/nodes/CreateNetNode.tsx
- [ ] frontend/src/nodes/InferenceNode.tsx
- [ ] frontend/src/nodes/InputImageNode.tsx
- [ ] frontend/src/nodes/InputTensorNode.tsx
- [ ] frontend/src/nodes/OutputNode.tsx
- [ ] frontend/src/nodes/PostprocessNode.tsx
- [ ] frontend/src/nodes/SaveTextNode.tsx
- [ ] frontend/src/utils/layout.ts
- [ ] frontend/e2e/ncnn-demo.spec.ts
- [ ] frontend/e2e/workflow.spec.ts
- [ ] frontend/e2e/mock-backend.mjs
- [ ] frontend/playwright.config.ts
- [ ] frontend/vite.config.ts
- [ ] frontend/vitest.config.ts
- [ ] frontend/vitest.setup.ts
- [ ] frontend/src/nodes/PostprocessNode.test.tsx
- [ ] frontend/src/App.test.tsx
- [ ] (possible others: SaveImageNode.tsx — check)

## Batch 2 — Debug prints & noise (behavior-neutral)  [DONE @ 487a872]

- [x] backend/src/workflow/handlers/core_handlers.cpp:107  remove `[PostprocessHandler] Output size:` cout (and unused `<iostream>` if becomes unused).
- [x] backend/src/main.cpp:66  remove `[Stub] init_net called` trace inside StubEngine.
- [x] frontend/src/main.tsx:10  remove `console.log('Connected to backend')` (keep the warn on catch).
- [x] frontend/src/transport/WsClient.ts:96  remove `console.log('[WsClient] Connected to', …)`.
- [x] frontend/src/transport/WsClient.ts:142  remove `console.log('[WsClient] Reconnect attempt …')`.
- [x] frontend/src/engine/WorkflowRunner.ts:94  remove the TODO capabilities log + decide fate of that case (delete case or wire up — go with delete for now since nothing depends on it).

Keeps (operator logs, NOT findings): ws_server banners, crash backtrace, stub/ncnn engine startup announcement.

## Batch 3 — Dead code removal (backend)

- [ ] backend/src/server/ws_server.{h,cpp}  remove unused `running_` field + three writes; remove unused `stop()` method.
- [ ] backend/src/model/workflow_graph.{h,cpp}  remove unused `clear()`.
- [ ] backend/src/capability/registry.h  remove unused accessors `vendors()` and `operations()`.
- [ ] backend/src/workflow/debug_controller.h  remove unused `is_stepping()`.
- [ ] backend/src/server/rpc_handler.h  remove unused `SendCallback` alias.
- [ ] backend/src/model/node.h  remove unused `PortDirection` enum and `PortDef` struct.
- [ ] backend/src/vendor/inference_engine.h  remove unused `NetConfig::vendor` and `NetConfig::use_gpu` fields. (Verify no writer anywhere.)

## Batch 4 — Dead code removal (frontend)

- [ ] frontend/src/store/workflowStore.ts  remove unused `clearAll` action (interface + impl).
- [ ] frontend/src/store/workflowStore.ts:22  drop `export` from `RUNTIME_DATA_KEYS` (file-local).
- [ ] frontend/src/App.tsx:210  remove `className: \`edge-type-${dataType}\`` (no matching CSS).
- [ ] frontend/src/store/workflowStore.ts:259-265  fix or remove the stale "nudge handleSet" comment in `resumeHistory`. Keep behavior; just drop misleading comment.
- [ ] frontend/src/engine/WorkflowRunner.ts  if capabilities stub is deleted above, also remove the unused helper if it becomes dead.

## Batch 5 — Unused includes (backend, mechanical, low risk)  [DONE @ 487a872]

- [x] backend/src/workflow/executor.cpp  drop `<chrono>`, `<fstream>`, `<sstream>`, `<iostream>`.
- [x] backend/src/workflow/handlers/core_handlers.cpp  drop duplicate `<numeric>` (line 9) and unused `<cmath>`; drop `<iostream>` after debug print removed.
- [x] backend/src/workflow/handlers/core_handlers.h  drop `<vector>`.
- [x] backend/src/capability/registry.h  drop `<functional>`.
- [x] backend/src/model/node.h  drop `<memory>` (add explicit `<cstdint>`).

## Batch 6 — Misleading / stale comments (low risk, high value)  [PARTIAL @ 487a872]

- [x] backend/src/workflow/executor.cpp:50-52  shorten Debug-type pause comment.
- [x] backend/src/workflow/debug_controller.h:32-33  update `should_pause` doc.
- [x] backend/src/workflow/handlers/core_handlers.cpp:21-23  clarify `resolve_path` comment.
- [x] backend/src/server/ws_server.cpp:69  replace the "Store loop and publish function…" what-comment with rationale.
- [x] backend/src/server/security_config.h:40-41  fix the stale "caller is responsible for creating it" claim.
- [-] frontend/src/hooks/useKeyboardShortcuts.ts:22,134-136  minor reword — SKIPPED (current wording already clear).
- [x] backend/src/workflow/handlers/core_handlers.cpp:263  rename `final_output` → `sample_output` and tighten comment.
- [x] backend/src/workflow/executor.cpp:134-138  drop redundant `if (!extra.empty())` guard.

## Batch 7 — Type-safety clean-ups (frontend)

- [ ] frontend/src/transport/WsClient.ts:66-83  replace `(window as unknown as …)` + `(import.meta as unknown as …)` double-cast with a `declare global { interface Window { __VITE_WS_URL_OVERRIDE__?: string } }` and a `/// <reference types="vite/client" />` at top.
- [ ] frontend/src/App.tsx:168  drop unneeded `as typeof nodes`.
- [ ] frontend/src/nodes/*Node.tsx (all 11 node components)  type `NodeProps<Node<WorkflowNodeData>>` and remove `data as unknown as WorkflowNodeData` casts.
- [ ] frontend/src/App.tsx:289-352  extract a single `NODE_CATEGORY` mapping shared by `MiniMap.nodeColor` and `getCategoryClass` (file-local).
- [ ] frontend/src/panels/PropertiesPanel.tsx:262-276  collapse `filepath` case into `text` default.

## Batch 8 — Test hygiene

- [ ] frontend/e2e/workflow.spec.ts:123-141  add real post-run assertions to the "runs a workflow" test (or delete).
- [ ] frontend/e2e/workflow.spec.ts:167-176  make "offline status" test actually test offline (bogus override) or delete.
- [ ] frontend/e2e/workflow.spec.ts:32,137,173  replace bare `waitForTimeout` with deterministic waits on `.console-ws-status` / node status class.
- [ ] frontend/e2e/workflow.spec.ts:20  drop the 2s fallback in the `beforeAll` handshake; rely solely on stdout banner with a bounded deadline.
- [ ] frontend/e2e/ncnn-demo.spec.ts:100  replace `waitForTimeout(800)` with a deterministic WS-connected wait.
- [ ] frontend/e2e/ncnn-demo.spec.ts:120  tighten poll timeout; gate 40s extension on an env flag.
- [ ] backend/tests/main_test.cpp  delete `EXPECT_EQ(1+1, 2)` body or the whole file.
- [ ] frontend/src/App.test.tsx  replace dummy test with a real App smoke test (render + find canvas container) or delete.
- [ ] Extract `MockEngine` to `backend/tests/mock_engine.h` (used by test_executor.cpp + test_condition.cpp).
- [ ] frontend/e2e/mock-backend.mjs:11-13  decide fate of unused `nets` map.
- [ ] frontend/e2e/mock-backend.mjs:85-88  remove or implement the debug-resume branch.

## Batch 9 — Build / config

- [ ] backend/CMakeLists.txt  replace the two `FetchContent_Populate` blocks with `FetchContent_MakeAvailable`; remove the duplicate `include(FetchContent)`.
- [ ] backend/CMakeLists.txt  factor backend sources into a `workflow_core` static lib to deduplicate include/link lists between `workflow_backend` and `workflow_test`. (This IS a refactor — consider carefully. Keep if behavior-neutral.)
- [ ] frontend/tsconfig.node.json  extend `include` to cover `vitest.config.ts` and `playwright.config.ts`.
- [ ] .github/workflows/ci.yml:30  drop `--noEmit` (tsconfig already sets it).
- [ ] frontend/package.json:28  remove unused `@testing-library/dom` devDep.

## Batch 10 — Docs & demo

- [ ] README.md:13  panels list — drop Toolbar/DebugPanel, use actual panel filenames.
- [ ] README.md:146  drop or implement `VITE_WS_PORT`.
- [ ] README.md:180-194  node count 10→11, add SaveImage row.
- [ ] README.md:231  delete live-backend suite paragraph (those files don't exist).
- [ ] README.md:268-270  fix `shared/` path claim.
- [ ] README.md:86 + setup.sh  either add `--shared-dir` to setup.sh or drop from README.
- [ ] setup.sh  sync `--help` with supported flags and `FRONTEND_PORT` env.
- [ ] README.zh-CN.md  mirror English fixes.
- [ ] frontend/README.md  delete Vite template boilerplate, replace with pointer to root README.
- [ ] demo/NCNN_demo/workflow.json  strip 1001-entry captured output from `out1.data.output`; normalize all `status` to idle; add ids to last two edges.

## Deferrals (flagged but NOT doing this pass)

- [-] `Scheduler` class inlining — borderline refactor; keep as-is.
- [-] Dedup breakpoint RPC logic between `useWorkflowActions.ts` and `NodeContextMenu.tsx` — cross-file refactor.
- [-] E2E port consolidation (9090/9098/9099) — useful but cross-file config work; follow-up.
- [-] Root `ws` dep collapse / delete `test_script.js` / delete `run.sh` — policy call, ask user first.
- [-] WsServer race (publish_fn_/loop_) — concurrency fix, separate pass.
- [-] `eslint-plugin-react-hooks` unused warning — ESLint config change, needs verification run.
- [-] vite.config/vitest.config merge via `mergeConfig` — refactor, could change test behavior.
- [-] `tsconfig.base.json` extraction — refactor, defer.

## Execution order

1. Batch 2 + 5 + 6 (small, touch-and-verify: debug prints, unused includes, comment fixes) — 1 commit `[chore]`.
2. Batch 3 + 4 (dead code removal, C++ and TS) — 1 commit each `[refactor]`.
3. Batch 7 (type-safety frontend) — 1 commit `[refactor]`.
4. Batch 8 (test hygiene) — 1 commit `[test]`.
5. Batch 9 (build/config) — 1 commit `[chore]` or `[build]`.
6. Batch 10 (docs & demo fixture) — 1 commit `[docs]` + 1 commit `[chore] demo`.
7. Batch 1 (SPDX headers) — LAST, single sweep `[chore] spdx:`, one commit touching every file (mechanical).

Rationale for SPDX last: every earlier batch already adds the header when touching a file, so Batch 1 only has to mop up files NOT touched by earlier batches, minimizing merge churn.

Between every commit run:
  - backend: `cmake --build backend/build && ./backend/build/workflow_test`
  - frontend unit: `cd frontend && npx vitest run --reporter=basic`
  - frontend type check: `cd frontend && npx tsc -b --noEmit`
  - e2e only at end: `cd frontend && npx playwright test ncnn-demo --reporter=line`
