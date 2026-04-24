# Review Pass 2026-04-24: Readability & Debug-Removal Rules

Context: after Phase 8 completion + the NCNN demo crash fix, the user
requested a full review pass across the repo. These are the ground rules
that govern the review, recorded so the work can be paused and resumed
deterministically.

## Invariants (must hold)

- Do NOT modify unrelated code. Every edit must serve readability or
  dead-branch removal; refactors that change public API are out of
  scope for this pass.
- Keep existing code style. Match the surrounding file, not a global
  "preferred" style.
- SPDX headers: every touched file keeps (or gains, if missing) the
  two-line SPDX header exactly as documented in `code-conventions.md`.
- The current test suite must stay green at every commit:
  - Backend: `cmake --build backend/build && ./backend/build/workflow_test`
  - Frontend unit: `cd frontend && npx vitest run`
  - Frontend e2e: `cd frontend && npx playwright test ncnn-demo`
- Commit per module (not one mega-commit). Use the project's
  `[type] scope: description` format; prefer `[refactor]` when behavior
  is unchanged, `[chore]` when removing debug logging only.

## In-scope targets

1. Dead branches left from iterative development (guard clauses that
   can never trigger, `if (false)`, commented-out code, half-finished
   alternate code paths).
2. `std::cout` / `printf` / `console.log` debug prints that were never
   cleaned up. Distinguish intentional operator logs (keep) from
   leftover `[DEBUG]` traces (remove).
3. Unused locals, parameters, imports.
4. Over-long functions that can be split only when the split genuinely
   aids reading — no splitting for its own sake.
5. Comments that describe *what* rather than *why*, or that have
   drifted from the code.
6. Naming that actively misleads (e.g. a function named `init` that
   also returns a value and mutates state).

## Out-of-scope (defer to later passes)

- Any algorithmic change.
- Public API renames.
- Threading / concurrency fixes (including the known
  `WsServer::publish_fn_` race).
- New features, new tests beyond what's needed to prove a refactor
  is behavior-preserving.

## Process

1. Parallel audit: one explore agent per major module produces a
   prioritized "readability findings" list.
2. Consolidate into a tracked checklist (this file, plus a companion
   `review-findings.md` kept for the duration of the pass).
3. Execute each module's cleanup as its own commit. After each
   commit, run the three test suites above.
4. Update `code-conventions.md` if a convention is formalized or
   revised during the pass.

## Verified commands (2026-04-24)

- Backend build with ncnn: `cmake -DENABLE_NCNN=ON -Dncnn_DIR=/tmp/ncnn-install/lib/cmake/ncnn -S backend -B backend/build && cmake --build backend/build -j`
- Backend test: `./backend/build/workflow_test` → 34 passed
- Frontend unit: `cd frontend && npx vitest run` (previous count 44,
  re-verify after each touch)
- Frontend e2e: `cd frontend && npx playwright test ncnn-demo --reporter=line`
  → 1 passed (~34s)
