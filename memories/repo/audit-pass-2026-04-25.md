# Audit Pass 2026-04-25: Five High-ROI Bugs Closed

Context: after the F1+CI hardening burst this audit pass ran an explore
agent over `backend/`, `frontend/`, and the wire protocol contract to
find P0/P1/P2 issues missed by the prior round. Five candidates were
ranked by `(user-impact / fix-cost)` and all five were fixed in
sequence with full test coverage. Recorded so a future agent can see
which paths were already audited and which assumptions are now pinned
by tests.

## Audit Method

- One general-purpose agent invocation, instructed to skip the items
  fixed in the prior burst (cycle crash, App.tsx atomic selectors,
  benchmark cancel, WsClient timeout, DebugController epoch model,
  Toast/Console/NodeContextMenu a11y).
- Returned a ranked top-5 with `file:line`, LOC estimate, severity,
  one-line root cause, one-line fix sketch.
- All five items were investigated concretely (open the file, follow
  call paths) before committing.

## Five Fixes Landed

| # | Commit    | Severity        | Module                              | LOC | Tests |
|---|-----------|-----------------|-------------------------------------|-----|-------|
| 1 | `263d84f` | P0 functional   | backend wire routing                | ~10 | (existing FE coverage activated) |
| 2 | `2501df2` | P1 functional   | frontend hooks                      | ~6  | +2 vitest |
| 3 | `f3a81d7` | P1 data integ.  | frontend store                      | ~30 | +3 vitest |
| 4 | `38002a0` | P2 race         | backend executor + run_session      | ~20 | +3 gtest |
| 5 | `7ee7c46` | P2 perf         | frontend App.tsx                    | ~50 | +4 vitest |

### #1 — `validation_failed` UI routing (P0)

`backend/src/main.cpp:337` routed every `__workflow__` event over
`workflow.complete`, but the frontend `WorkflowRunner` dispatches
`validation_failed` from inside its `node.status` switch case. The
two halves disagreed about the wire method, so every graph-validation
error (cycle, unknown node type, mismatched ports) was silently
dropped — the user saw a green "complete" with no red nodes, no
console error, no toast. Fixed by branching the status callback on
the `__workflow__` event's `status` field (`validation_failed` →
`node.status`, everything else → `workflow.complete`) and adding the
missing `node_id="__workflow__"` field on both validation paths in
`executor.cpp` so the FE switch's discriminator finds the synthetic
event. The cycle/unknown-node guards added in the previous burst
were already correct on the backend; this fix made them actually
visible to users.

### #2 — Mid-run breakpoint RPC reaches the executor (P1)

`useWorkflowActions.ts:185,190` used
`wsClient.notify('debug.add_breakpoint', { nodeId })`. Two
independent bugs combined:
- The backend registers `debug.add_breakpoint`/`remove_breakpoint`
  via `register_method` (request/response, `main.cpp:315/324`), but
  `RpcHandler::handle_message` routes id-less messages to
  `notifiers_` and silently drops anything not registered there with
  no error response.
- Even after switching to `call`, the backend validates
  `params.node_id` (snake_case) and would reject `nodeId` with
  -32602 InvalidParams.

Fixed both: `wsClient.call('debug.{add,remove}_breakpoint',
{ node_id })`. Pinned with two regression tests asserting the wire
shape (one mid-run, one off-run no-traffic check).

### #3 — `nodesById` cache drifts after zundo undo/redo (P1)

`workflowStore.ts` uses `temporal()` from zundo with a `partialize`
that returns `{nodes, edges}`. zundo's `undo()`/`redo()` apply
restored history entries by calling the raw zustand `setState` with
that partialized snapshot, which bypasses our mutators and leaves
`nodesById` frozen at the pre-undo value. `getNodeById` (used by
`validateConnection`, useKeyboardShortcuts copy/paste, and
`WorkflowRunner.handleValidationFailed`/`reconcileFromSnapshot`
membership checks) returned phantom or missing nodes silently.

zundo's `handleSet` only fires on the *save* phase, not on
restoration, so the fix is a top-level
`useWorkflowStore.subscribe` that compares cache `(size,
sampled-id)` against the new `nodes` reference and rebuilds when
they disagree. Mutator writes short-circuit on identity (the cache
they just rebuilt is the cache in state); the only path that
actually re-runs `rebuildNodesById` is the zundo restoration path.

### #4 — `RunSession::start` snapshot race (P2)

`RunSession::start` assigned `last_run_id_`, launched the worker
thread, and returned. `Executor::execute` wrote `current_run_id_`
and cleared `node_statuses_` from the worker's own thread, so a
`workflow.state` RPC arriving in the gap observed the *previous*
run's id+statuses. The frontend's `reconcileFromSnapshot` would
then call `setActiveRunId` with a stale id and `isFreshEvent`
silently dropped fresh `node.status` events from the new run for
an unbounded window. Added `Executor::begin_run(run_id)` that takes
`state_mutex_` and atomically publishes the id + clears statuses.
`RunSession::start` calls it on the WS thread before launching
the worker. `Executor::execute` is idempotent: when the same id was
already published it skips the redundant clear, preserving legacy
in-thread initialization for embeds and tests that drive
`execute()` directly.

### #5 — `styledNodes` cache eliminates per-tick rebuild (P2 perf)

The `styledNodes` `useMemo` recomputed an N-element array of
className strings on every store write because zustand mutators
always produce a fresh `nodes` reference. On graphs with >100 nodes
the 5-piece `array.filter().join(' ')` and per-call breakpoint
`Map` allocation dominated frame time during runs, even though only
the one node whose status actually changed needed a new className.

Cached className per node id keyed on the small tuple that drives it
`(category, status, selected, hasBp, bpEnabled)`. Status ticks for
one node now reuse N-1 cached strings instead of rebuilding N.
Cache entries for removed nodes are purged in the same pass to keep
the map bounded. Extracted `computeNodeClassName` as a pure helper
so cache key + output stay testable in isolation.

## Lessons / Patterns

- **Wire-protocol bugs hide best.** Both #1 and #2 were silent on the
  network — no error response, no console log, just dropped messages.
  When adding RPC methods, prefer `call` (visible failure modes) over
  `notify` (silent drop) and add a wire-shape regression test that
  asserts both the *method type* (call vs notify) and *param keys*.
- **History/restoration paths bypass mutators.** Any zustand store
  using middleware that owns `setState` (zundo, persist, devtools
  rehydration) needs a derivation-cache check at the subscriber
  level, not just in mutators. The `(size, sampled-id)` short-circuit
  pattern from #3 is reusable.
- **Race fixes belong on the caller's thread.** Anywhere a worker
  thread is launched after a value is published, prefer publishing
  the value synchronously before the launch. Snapshot RPCs and the
  worker share a mutex, so there's no extra cost — the bug only
  exists because the publish was on the wrong side of the launch.
- **Per-tick recomputes are the silent perf killer.** Atomic
  selectors limit re-render *fanout* but not *cost per render*. When
  the memo's dependency identity changes every tick (a fresh array
  from `.map`), key the inner work on a value-equal tuple.

## Already-Audited Paths (don't re-flag)

- `WorkflowRunner` dispatch, `WsClient` timeout & close handling,
  DebugController epoch model, App.tsx selector granularity,
  benchmark cancel propagation, validate_graph cycle detection,
  zundo `partialize`/`equality`, `nodesById` rebuild path,
  RunSession start/shutdown sequence, RPC method registration
  shape, styledNodes className path, computeNodeClassName helper.

## Test Counts at HEAD

After all five fixes: vitest 122 / gtest 70 / Playwright 12. tsc
clean. Was vitest 113 / gtest 67 before this audit pass.
