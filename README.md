# WorkflowUI — Inference Workbench

[中文 / Chinese](./README.zh-CN.md)

A visual, programmable workbench for orchestrating inference pipelines. Build pipelines by dragging nodes on a graph canvas, step through them, set breakpoints, and inspect tensor data in real time.

## Features

- **Node-graph driven development.** Compose pipelines of data loading, inference, post-processing and output nodes on a React Flow canvas powered by `@xyflow/react`.
- **Full-stack debugging.** Set breakpoints on Debug nodes; the backend scheduler pauses execution and streams node status / paused frames back to the UI over WebSocket for inspection.
- **Browser + desktop.** Runs as a Vite dev server in the browser or as a Tauri v2 native desktop application sharing the same frontend.
- **Pluggable inference vendor layer.** The backend defines an abstract `InferenceEngine` interface in `backend/src/vendor/`. An NCNN implementation is shipped; a built-in `StubEngine` (echo) is used when NCNN is disabled at build time so the rest of the system remains fully exercised.
- **Undo / redo, console, properties & palette panels.** The frontend ships NodePalette, PropertiesPanel, and ConsolePanel (which hosts the toolbar controls and debug log), with Zustand + `zundo` for time-travel.

## Architecture

```
┌──────────────┐  WebSocket   ┌──────────────────┐        ┌──────────────┐
│   Frontend   │◄────────────►│  Backend Wrapper │◄──────►│ Vendor Layer │
│  React Flow  │  JSON-RPC 2  │   C++ / uWS      │        │ NCNN / Stub  │
└──────────────┘              └──────────────────┘        └──────────────┘
```

Three decoupled layers:

- **Frontend** — React 19 + `@xyflow/react` + Zustand. Graph editor, transport client, execution coordinator (`WorkflowRunner`).
- **Backend Wrapper** — C++17 WebSocket service built on uWebSockets. Hosts the workflow scheduler/executor, debug controller, file-access security policy, and per-node handlers.
- **Vendor Layer** — Pure-virtual `InferenceEngine` base class. NCNN is the first real implementation; a stub engine is linked in when `-DENABLE_NCNN=OFF`.

### Wire protocol

WebSocket endpoint at `/*`. Messages are JSON-RPC 2.0.

Client → Server (requests):

| Method | Purpose |
|---|---|
| `vendor.getConfigSchema` | Returns config fields supported by a vendor |
| `nodes.list` | Returns the handler catalog (type, label, category, ports) as the single source of truth for what this backend can execute |
| `workflow.execute` | Starts workflow execution on a background thread; reply `{ status: "started", run_id }` |
| `workflow.cancel` | Stops the currently-running workflow at the next node boundary; reply `{ cancelled: true, run_id }` naming the interrupted run |
| `debug.add_breakpoint` | Adds a breakpoint on a node |
| `debug.remove_breakpoint` | Removes a breakpoint |

Client → Server (notifications): `workflow.stop` (legacy alias of `workflow.cancel`; no reply), `debug.continue`, `debug.step_over`.

Server → Client (push): `node.status`, `workflow.complete`, `debug.paused`. Every push carries the `run_id` of the run that produced it so clients can discard events from a superseded/cancelled run.

#### Run IDs and cancellation

Each call to `workflow.execute` launches a single background run and returns a `run_id` of the form `run-<seq>-<ms>` (`<seq>` is a process-local counter, `<ms>` is steady-clock milliseconds since process start). The backend stamps the same `run_id` onto every `node.status` / `debug.paused` / `workflow.complete` event it emits for that run.

Starting a second run with a previous one still active implicitly cancels the first (the worker is stopped at the next node boundary and joined before the new run launches). Clients should treat any event whose `run_id` does not match the most recently returned id as stale and drop it — `frontend/src/engine/WorkflowRunner.ts` does exactly this via `setActiveRunId`. Events missing `run_id` entirely (older backends, tests) are accepted verbatim so the filter is strictly additive.

`workflow.cancel` and `workflow.stop` both interrupt between nodes, not mid-handler: a node running a long inference will finish first, then the cancel takes effect. `workflow.cancel` is a request that returns the interrupted `run_id`; `workflow.stop` is a fire-and-forget notification kept for backward compatibility.

#### JSON-RPC error codes

| Code | Meaning | When |
|---|---|---|
| `-32700` | Parse error | Malformed JSON |
| `-32601` | Method not found | Unknown RPC method |
| `-32602` | Invalid params | Shape-level validation at the RPC boundary (missing fields, wrong types, empty arrays, ...) — a caller bug |
| `-32000` | Server error | Any other handler exception — a server-side fault |

Graph-level validation (unknown node types, dangling edges, port/type mismatches) happens *after* `workflow.execute` has been accepted and is reported via a single `__workflow__` / `validation_failed` push event with an `errors[]` array, then a `workflow.complete`. This is deliberate: `-32602` is reserved for problems a client can diagnose without seeing the handler catalog.

## Quick Start

### System dependencies

```bash
# Ubuntu / Debian
sudo apt install cmake make g++ nodejs npm zlib1g-dev

# macOS
brew install cmake node
```

### One-shot launch (Stub mode, no NCNN required)

```bash
./setup.sh
```

The script:

1. Builds the C++ backend with the stub engine.
2. Installs frontend dependencies and builds.
3. Starts the backend (default port `9090`) and the Vite dev server (`5173`).
4. Opens `http://localhost:5173`.

### Enable real NCNN inference

```bash
./setup.sh --ncnn
```

This clones and builds NCNN from source under `/tmp/ncnn` (CPU only, no Vulkan, ~2 min), installs it to `/tmp/ncnn-install`, then rebuilds the backend with `-DENABLE_NCNN=ON`.

### Other setup.sh commands

```bash
./setup.sh --dev                    # skip build, just launch pre-built binaries
./setup.sh --test                   # full test suite (gtest + vitest + integration + playwright)
BACKEND_PORT=8080 ./setup.sh        # custom backend port
FRONTEND_PORT=5174 ./setup.sh       # custom frontend dev-server port
./setup.sh --help
```

## Manual build

### Backend

```bash
cd backend

# Stub mode
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

# NCNN mode (requires a prebuilt NCNN install)
cmake -S . -B build -DENABLE_NCNN=ON -Dncnn_DIR=/path/to/ncnn/lib/cmake/ncnn
cmake --build build -j$(nproc)

# Run (default port 9090)
./build/workflow_backend                              # defaults everywhere
./build/workflow_backend --port 9090
./build/workflow_backend --port 9090 --shared-dir /srv/share
./build/workflow_backend --allow-origin http://my-host:5173
./build/workflow_backend --help
```

### Cross-compiling the backend

Toolchain files live in `backend/cmake/toolchains/`. The CI pipeline
(`.github/workflows/ci.yml`) builds the full matrix; the same invocations
reproduce each target locally:

| Target | Host prerequisites | Invocation |
|---|---|---|
| `x86_64-linux` | gcc/clang | `cmake -S backend -B backend/build -DENABLE_NCNN=OFF` |
| `aarch64-linux` | `gcc-aarch64-linux-gnu`, `qemu-user-static` (for tests) | `cmake -S backend -B backend/build-aarch64 -DCMAKE_TOOLCHAIN_FILE=backend/cmake/toolchains/aarch64-linux.cmake -DENABLE_NCNN=OFF` |
| `aarch64-macos` | Xcode CLT on Apple silicon | same as x86_64-linux, but run on `macos-14` |
| `x86_64-windows` (MinGW) | `mingw-w64` | `cmake -S backend -B backend/build-win -DCMAKE_TOOLCHAIN_FILE=backend/cmake/toolchains/x86_64-windows-mingw.cmake -DENABLE_NCNN=OFF` |

The MinGW target is currently marked experimental in CI (uSockets on
Windows is unvalidated in this tree). If you successfully run
`workflow_test.exe` under wine or on a Windows host, flip
`experimental: true` in the CI matrix.

### Frontend

```bash
cd frontend
npm install
npm run dev          # development server on :5173
npm run build        # production build (tsc -b + vite build)
npm run preview
```

The frontend derives the WebSocket URL from the current page host, defaulting to port `9090`. Override via env var:

```bash
VITE_WS_URL=ws://localhost:8080 npm run dev
```

#### Security knobs

Two opt-in policies run server-side; both default to permissive so local
dev and the Tauri shell work out of the box:

- `--shared-dir <path>` enables a filesystem sandbox. Every path passed
  to `inputImage`, `saveText`, `saveImage`, and `createNet` is
  canonicalised and rejected if it escapes the directory (absolute
  paths outside the root or `..` traversal throw a runtime error). With
  no `--shared-dir` the backend falls back to resolving paths against
  the process CWD, preserving pre-Phase-6 behaviour.
- `--allow-origin <url>` (repeatable) restricts the WebSocket Origin
  allow-list. Defaults cover `http://localhost:5173`,
  `http://localhost:1420`, their 127.0.0.1 variants, and
  `tauri://localhost`. Requests without an `Origin` header (native
  clients, curl) are always accepted so CLI tooling keeps working;
  browser requests from un-listed origins get a 403 during the upgrade.


### Tauri desktop app

```bash
cd frontend
npx tauri dev        # development mode
npx tauri build      # package a native binary
```

Tauri v2.10 config lives in `frontend/src-tauri/`. The window is `1280×800`, identifier `com.workflowui.app`, and `beforeDevCommand` is wired to `npm run dev` so the Vite server starts automatically.

## Node Types

The frontend palette (`frontend/src/nodes/index.ts`) exposes 11 node components:

| Node | Category | Description |
|---|---|---|
| Input Image | input | Load an image file from disk |
| Input Tensor | input | Manually provide tensor data |
| Create Net | inference | Load a model (`.param` + `.bin`) |
| Inference | inference | Run a forward pass |
| Benchmark | inference | Micro-benchmark a loaded net |
| Postprocess | inference | Built-in post-processing (e.g. softmax / top-k) |
| Save Text | output | Persist textual results |
| Save Image | output | Persist image results |
| Output | output | Display output data in the UI |
| Condition | control | Branching logic |
| Debug | debug | Breakpoint / data inspection |

## Debugging

- Attach a Debug node anywhere in the graph and toggle its breakpoint.
- When execution reaches the breakpoint, the backend emits `debug.paused`, the UI surfaces the node's inputs/outputs.
- Resume with **Continue** or advance one node with **Step Over** (sent as `debug.continue` / `debug.step_over` notifications).

## Testing

### C++ unit tests (googletest)

```bash
cd backend
cmake --build build --target workflow_test
./build/workflow_test
```

### Frontend unit tests (Vitest)

```bash
cd frontend
npm run test:unit
npm run test:unit:watch
```

### E2E tests (Playwright)

```bash
cd frontend
npm run test:e2e          # headless
npm run test:e2e:headed   # headed
```

The E2E suite in `frontend/e2e/workflow.spec.ts` contains 11 tests across Canvas, Node CRUD, Workflow execution, Save/Load, and WebSocket disconnection scenarios. It runs against a mock WebSocket backend at `frontend/e2e/mock-backend.mjs`, so no C++ build is required. A second spec, `ncnn-demo.spec.ts`, boots the real C++ backend (if `backend/build/workflow_backend` exists) and replays the bundled NCNN demo workflow end-to-end.

### Integration test

`test_integration.mjs` at the repo root drives a running backend over raw WebSocket for a smoke check. `setup.sh --test` invokes it automatically.

## Project Layout

```
workflowUI/
├── setup.sh                     # One-shot build & launch script
├── test_integration.mjs         # Root WebSocket integration smoke test
├── backend/
│   ├── CMakeLists.txt           # C++ build config (FetchContent: uWS, nlohmann/json, gtest)
│   ├── src/
│   │   ├── main.cpp             # Entry point; CLI, RPC routing, engine bootstrap
│   │   ├── server/              # ws_server + rpc_handler (uWS + JSON-RPC 2.0)
│   │   ├── workflow/            # executor, scheduler, debug_controller, handlers/
│   │   ├── model/               # node + workflow_graph data models
│   │   ├── security/            # file_access policy (shared-dir sandbox)
│   │   └── vendor/
│   │       ├── inference_engine.h    # Abstract engine interface
│   │       └── ncnn/                 # NCNN implementation
│   └── tests/                   # googletest suites
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # React Flow canvas
│   │   ├── nodes/               # 11 custom node components (+ tests)
│   │   ├── panels/              # NodePalette, PropertiesPanel, ConsolePanel
│   │   ├── transport/           # WsClient (JSON-RPC 2.0 + auto-reconnect)
│   │   ├── engine/              # WorkflowRunner (frontend execution coordinator)
│   │   ├── store/               # Zustand stores (workflow/debug/toast) with zundo history
│   │   ├── components/, hooks/, utils/
│   ├── e2e/                     # Playwright specs + mock-backend.mjs
│   ├── src-tauri/               # Tauri v2 desktop shell (Rust)
│   └── playwright.config.ts
└── demo/                        # Example workflows (bundled NCNN demo)
```

## Tech Stack

- **Frontend:** React 19.2, `@xyflow/react` 12, Zustand 5 (+ `zundo` for history), dagre, Vite 8, TypeScript 6
- **Backend:** C++17, uWebSockets 20.70, uSockets 0.8.8, nlohmann/json 3.11.3, ZLIB, pthreads, googletest
- **Desktop:** Tauri v2.10 (Rust edition 2021, rustc ≥ 1.77.2)
- **Inference:** NCNN (optional, compile-time toggle) + built-in Stub engine
- **Testing:** Playwright 1.59, Vitest 4.1, googletest
- **Transport:** WebSocket + JSON-RPC 2.0
