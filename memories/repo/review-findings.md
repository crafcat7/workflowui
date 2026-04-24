# Review Findings — 2026-04-24 Pass

Consolidated, prioritized action list from four parallel audits
(backend, frontend src, tests, build/config/docs).

Legend: `[ ]` pending · `[x]` done · `[-]` skipped with reason

## Batch 1 — SPDX headers (mechanical, low risk)  [DONE]

Every hand-written source file under `backend/src/`, `backend/tests/`,
`frontend/src/`, and `frontend/e2e/` now starts with the canonical
two-line header:

```
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
```

Covered 47 files in one sweep: 41 that had no header at all, plus 6
that carried the older `// Copyright (c) 2026 workflowUI contributors`
second line (security_config.{cpp,h}, condition_expr.{cpp,h},
test_condition.cpp, test_security_config.cpp). The in-tree scan now
reports zero outliers. Verified: 33 backend tests + 43 vitest + 12
Playwright + tsc -b all pass on the edited tree.

## Batch 2 — Debug prints & noise (behavior-neutral)  [DONE @ 487a872]

- [x] backend/src/workflow/handlers/core_handlers.cpp:107  remove `[PostprocessHandler] Output size:` cout (and unused `<iostream>` if becomes unused).
- [x] backend/src/main.cpp:66  remove `[Stub] init_net called` trace inside StubEngine.
- [x] frontend/src/main.tsx:10  remove `console.log('Connected to backend')` (keep the warn on catch).
- [x] frontend/src/transport/WsClient.ts:96  remove `console.log('[WsClient] Connected to', …)`.
- [x] frontend/src/transport/WsClient.ts:142  remove `console.log('[WsClient] Reconnect attempt …')`.
- [x] frontend/src/engine/WorkflowRunner.ts:94  remove the TODO capabilities log + decide fate of that case (delete case or wire up — go with delete for now since nothing depends on it).

Keeps (operator logs, NOT findings): ws_server banners, crash backtrace, stub/ncnn engine startup announcement.

## Batch 3 — Dead code removal (backend)  [DONE @ b267b9e]

- [x] backend/src/server/ws_server.{h,cpp}  remove unused `running_` field + three writes; remove unused `stop()` method.
- [x] backend/src/model/workflow_graph.{h,cpp}  remove unused `clear()`.
- [x] backend/src/capability/registry.h  remove unused accessors `vendors()` and `operations()`.
- [x] backend/src/workflow/debug_controller.h  remove unused `is_stepping()`.
- [x] backend/src/server/rpc_handler.h  remove unused `SendCallback` alias.
- [x] backend/src/model/node.h  remove unused `PortDirection` enum and `PortDef` struct. (done in prior commit 487a872 during <memory> drop)
- [x] backend/src/vendor/inference_engine.h  remove unused `NetConfig::vendor` and `NetConfig::use_gpu` fields.

## Batch 4 — Dead code removal (frontend)  [DONE @ c20281c]

- [x] frontend/src/store/workflowStore.ts  remove unused `clearAll` action.
- [x] frontend/src/store/workflowStore.ts:22  drop `export` from `RUNTIME_DATA_KEYS`.
- [x] frontend/src/App.tsx:210  remove `className: \`edge-type-${dataType}\``.
- [x] frontend/src/store/workflowStore.ts:259-265  rewrite misleading `resumeHistory` comment.
- [-] frontend/src/engine/WorkflowRunner.ts  capabilities stub already removed in 487a872.

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

## Batch 7 — Type-safety clean-ups (frontend)  [DONE]

- [x] frontend/src/transport/WsClient.ts:66-83  replace `(window as unknown as …)` + `(import.meta as unknown as …)` double-cast with a `declare global { interface Window { __VITE_WS_URL_OVERRIDE__?: string } }` and a `/// <reference types="vite/client" />` at top. (Added new `frontend/src/vite-env.d.ts` carrying the triple-slash reference, `ImportMetaEnv`, and the `Window` augmentation.)
- [x] frontend/src/App.tsx:168  drop unneeded `as typeof nodes`. (Actual site was `useWorkflowActions.ts:168`.)
- [x] frontend/src/nodes/*Node.tsx (all 11 node components)  type `NodeProps<Node<WorkflowNodeData>>` and remove `data as unknown as WorkflowNodeData` casts.
- [x] frontend/src/App.tsx:289-352  extract a single `NODE_CATEGORIES` mapping + `nodeCategory()` helper shared by `MiniMap.nodeColor` and `getCategoryClass` (file-local).
- [x] frontend/src/panels/PropertiesPanel.tsx:262-276  collapse `filepath` case into `text` default.

## Batch 8 — Test hygiene  [DONE]

- [x] frontend/e2e/workflow.spec.ts:123-141  add real post-run assertions to the "runs a workflow" test. (Switched to single-node graph since the executor scopes multi-node runs to edge-connected sets and the test cannot draw edges; now polls on `workflow.complete` + `node.status=done` count.)
- [x] frontend/e2e/workflow.spec.ts:167-176  make "offline status" test actually test offline — injects `__VITE_WS_URL_OVERRIDE__=ws://127.0.0.1:1` via addInitScript and asserts `.ws-dot.disconnected` + `OFFLINE` text.
- [x] frontend/e2e/workflow.spec.ts:32,137,173  replace bare `waitForTimeout` with deterministic waits on `.console-ws-status .ws-dot.connected` and on captured WS frames.
- [x] frontend/e2e/workflow.spec.ts:20  drop the 2s silent fallback in the `beforeAll` handshake; rejects cleanly after 5s instead. Also added a test-file-wide beforeEach override so all specs pin the mock URL regardless of the dev server's VITE_WS_URL.
- [x] frontend/e2e/ncnn-demo.spec.ts:100  replace `waitForTimeout(800)` with a deterministic `.ws-dot.connected` wait.
- [x] frontend/e2e/ncnn-demo.spec.ts:120  env-gate the 40s extension: default 45s, `E2E_SLOW=1` → 90s.
- [x] backend/tests/main_test.cpp  deleted (dummy); dropped from `BACKEND_TEST_SOURCES`; gtest_main still provides the entry point.
- [x] frontend/src/App.test.tsx  deleted (dummy "renders Hello Vitest"); 43 unit tests remain.
- [x] Extract `MockEngine` to `backend/tests/mock_engine.h` (used by test_executor.cpp + test_condition.cpp); both files now `#include "mock_engine.h"` and drop their duplicate class.
- [x] frontend/e2e/mock-backend.mjs:11-13  removed unused `nextHandle` + `nets` map.
- [x] frontend/e2e/mock-backend.mjs:85-88  removed dead debug-resume branch; debug nodes now pass through as normal instead of emitting a paused event nothing ever resumed.

## Batch 9 — Build / config  [DONE @ c4ae0f0]

- [x] backend/CMakeLists.txt  removed the duplicate `include(FetchContent)` before the googletest block (top-of-file include already covers it).
- [-] backend/CMakeLists.txt  `FetchContent_Populate` → `MakeAvailable` deferred: usockets/uwebsockets ship no CMakeLists, so `MakeAvailable` would fail-configure. Populate is only soft-deprecated in CMake 4.0+, still works with CMP0169=OLD; revisit when upstream adds CMake support.
- [-] backend/CMakeLists.txt  `workflow_core` static-lib extraction deferred per review rules (flagged as borderline refactor).
- [x] frontend/tsconfig.node.json  extended `include` to cover `vitest.config.ts` and `playwright.config.ts`.
- [x] frontend/vitest.config.ts  switched `defineConfig` import from `vite` to `vitest/config` so `test` field type-checks under the widened project coverage.
- [x] .github/workflows/ci.yml:30  dropped `--noEmit` (tsc -b build mode ignores it anyway; every referenced tsconfig sets `noEmit: true`).
- [x] frontend/package.json:28  removed unused top-level `@testing-library/dom` devDep (kept as transitive dep of `@testing-library/react`).

## Batch 10 — Docs & demo  [DONE @ 9c9d5d6]

- [x] README.md:13  panels list — corrected to NodePalette/PropertiesPanel/ConsolePanel; noted ConsolePanel hosts toolbar + debug log.
- [x] README.md:146  dropped the `VITE_WS_PORT` example (never implemented); removed the field from `frontend/src/vite-env.d.ts`.
- [x] README.md:180-194  node count 10→11 + SaveImage row (both READMEs).
- [x] README.md:231  deleted the live-backend suite paragraph; replaced with a one-liner pointing at `ncnn-demo.spec.ts`.
- [x] README.md:268-270  removed the `shared/` tree entry; corrected the demo path to `demo/NCNN_demo/`.
- [x] README.md:86 + setup.sh  removed the `--shared-dir` example from setup.sh usage block (flag lives on the backend binary, not on setup.sh).
- [x] setup.sh  `--help` now documents `FRONTEND_PORT` alongside `BACKEND_PORT`.
- [x] README.zh-CN.md  mirrors every English fix; file-access-policy section rewritten to match real backend behavior (no `SHARED_DIR` env, no `./shared` default).
- [x] frontend/README.md  replaced default Vite-template boilerplate with a short description + pointer to root README.
- [x] demo/NCNN_demo/workflow.json  normalized: 1150→150 lines; every node status reset to `idle`; captured output/error/progress/duration_ms/logs stripped; every edge has a stable short id (e1..e6).

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
