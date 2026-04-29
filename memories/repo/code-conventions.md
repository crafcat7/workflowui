# Code Conventions

Quick reference for contributors and future agents. Verified against
current `main` as of UI optimization pass (2026-04-29).

## File header

Every hand-written source file starts with:

```
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
```

Applies to `.ts`, `.tsx`, `.cpp`, `.h`. Generated files (CMake-generated,
build outputs) are exempt.

## Commit format

`[type] scope: short description` on the subject line, then blank, then:

```
Summary
One or two sentences describing *why* the change is needed.

Changes
1. Concrete change #1 naming files/functions.
2. Concrete change #2.
…
```

Enforced by the `commit-format-standard` skill. Types used so far:
`[feat]`, `[refactor]`, `[fix]`.

## Frontend (React 19 + Zustand 5 + zundo 2 + @xyflow/react 12)

- State lives in Zustand stores under `src/store/*`; selectors use the
  `useStore(s => s.field)` pattern when possible to avoid rerender storms.
- Runtime execution state (`status`, `elapsedMs`, `output`, `runsCount`,
  `avgMs`) is excluded from undo snapshots and export JSON via
  `RUNTIME_DATA_KEYS` + `stripRuntimeFields` in `workflowStore.ts`.
- Shared user-invokable actions live in `src/hooks/useWorkflowActions.ts`
  and are used by both the toolbar and keyboard shortcuts — do NOT
  duplicate action logic in UI components.
- Node types are registered in `src/nodes/index.ts` (the `nodeTypes`
  map + `nodeTypeList` palette entries).
- Node icons are SVG components in `src/nodes/NodeIcons.tsx` (24×24,
  stroke-based, `currentColor`). The manifest (`src/nodes/manifest.tsx`)
  references them as JSX. **Do NOT use emoji characters as icons.**
- `manifest.tsx` is a `.tsx` file because it contains JSX for icon
  components. Keep it as `.tsx` when adding new node types.
- Node config editor fields are declared in `src/nodes/configSchemas.ts`;
  adding a new node type's config is a schema entry, not a PropertiesPanel
  edit.
- Node port semantics are declared in `src/nodes/portSchema.ts`; every
  `<Handle id=.../>` in a node component must have a matching entry.
- Toasts: `import { showToast } from './store/toastStore'`; levels are
  `error` (10s TTL), `warn` (6s), `info` (4s), `success` (3s).
- Logging: `useDebugStore` keeps a ring buffer of 2000 entries.
- WebSocket client: `src/transport/WsClient.ts` — `onConnectionState()`
  emits `connecting | open | retrying | closed`; retries use exponential
  backoff with full jitter between 500ms and 15s.

## Backend (C++17 + uWebSockets 20.70 + nlohmann/json + gtest)

- Handlers live in `src/workflow/handlers/*.cpp`, registered in
  `main.cpp` via `server.on("method.name", handler)`.
- Executor owns a `DebugController`; breakpoints are explicit per-node,
  armed via `workflow.execute` params or `debug.add_breakpoint` /
  `debug.remove_breakpoint` RPCs mid-run.
- `DebugController::reset()` preserves the breakpoint set across runs.
- Tests live in `backend/tests/*.cpp`, built into `workflow_test`.

## Forbidden / deprecated

- Do NOT enable `ENABLE_NCNN` — the vendor source is not in the repo.
  See `build-workflow.md`.
- Do NOT add per-agent memory for repo-level facts; record them here.
- Do NOT duplicate run/save/load logic between components — use
  `useWorkflowActions`.
- Do NOT hard-code a node type in `PropertiesPanel.tsx`; use
  `configSchemas.ts`.

## Test counts (verify before/after any non-trivial change)

- Frontend: `cd frontend && npx vitest run` → 161 tests across 21 files
  (as of 2026-04-29). `npx tsc -b --noEmit` must be clean; `npx vite build`
  must succeed.
- Backend: `cmake -DENABLE_NCNN=OFF -S backend -B backend/build &&
  cmake --build backend/build && ./backend/build/workflow_test` → 9
  gtests across 3 suites (ExecutorTest, DebugControllerTest, baseline).

## UI conventions

- **No emoji icons.** Use SVG components from `NodeIcons.tsx` or inline
  SVG (24×24, stroke-based). Emojis render inconsistently across platforms.
- **No layout-shifting hover.** Use `box-shadow` or `border-color` changes
  for hover feedback. Never `transform: translate*()` on hover.
- **Font: Silkscreen is branding only.** Use it for `.palette-title`,
  `.props-title` only. All other UI text uses `var(--font-mono)`.
- **CSS variables for edge colours.** Edge stroke colors use
  `--edge-net`, `--edge-image`, `--edge-tensor`, `--edge-branch`,
  `--edge-generic`, `--edge-cyclic`. Defined in `:root` and
  `[data-theme="light"]`.
- **Dark theme: deep navy, not pure black.** Base is `#0B0F19`.
