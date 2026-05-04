# WorkflowUI — Inference Workbench

[中文 / Chinese](./README.zh-CN.md)

A visual, programmable workbench for orchestrating inference pipelines. Build pipelines by dragging nodes on a graph canvas, step through them, set breakpoints, and inspect tensor data in real time.

## Features

- **Node-graph driven development.** Compose pipelines of data loading, inference, post-processing and output nodes on a React Flow canvas powered by `@xyflow/react`. The palette has incremental search and collapsible categories; the canvas highlights cyclic edges before you ever press RUN.
- **Full-stack debugging.** Set breakpoints on any node (not just Debug); the backend scheduler pauses execution and streams `node.status` / `debug.paused` frames back to the UI over WebSocket. The properties panel surfaces the paused node's live inputs so you can inspect tensors before resuming.
- **Model Inspector.** Vendor-aware nodes (currently `createNet` with `vendor: ncnn`) expose a *View Model* button that opens a side drawer parsing the actual `.param` file: format magic, layer count, layer table, input/output shapes, and a bidirectional canvas/table sync — all read-only and over a separate `model.inspect` RPC that never touches the run path.
- **Browser + desktop.** Runs as a Vite dev server in the browser or as a Tauri v2 native desktop application sharing the same frontend.
- **Pluggable inference vendor layer.** The backend defines an abstract `InferenceEngine` interface in `backend/src/vendor/`. An NCNN implementation is shipped; a built-in `StubEngine` (echo) is used when NCNN is disabled at build time so the rest of the system remains fully exercised.
- **Reconnect-safe execution.** Every event carries a `run_id`; the frontend filters stale frames after a re-launch and reconciles canvas state from a `workflow.state` snapshot whenever the WebSocket recovers mid-run.
- **Undo / redo, console, properties & palette panels.** Zustand + `zundo` for time-travel; Toasts surface validation errors and runtime faults inline. Keyboard shortcuts cover the common loop (R run, Esc cancel, B toggle breakpoint, Ctrl/⌘+Z undo, …).

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
| `model.inspect` | Read-only structural preview of a vendor model (format magic, layers, ports). Decoupled from the run path — invoked from the *View Model* drawer |
| `workflow.execute` | Starts workflow execution on a background thread; reply `{ status: "started", run_id }` |
| `workflow.cancel` | Stops the currently-running workflow at the next node boundary; reply `{ cancelled: true, run_id }` naming the interrupted run |
| `workflow.state` | Snapshot of the executor for reconnect reconciliation; reply `{ run_id, statuses: { id → status }, paused_at? }`. See "Reconnect reconciliation" below |
| `debug.add_breakpoint` | Adds a breakpoint on a node |
| `debug.remove_breakpoint` | Removes a breakpoint |

Client → Server (notifications): `workflow.stop` (legacy alias of `workflow.cancel`; no reply), `debug.continue`, `debug.step_over`.

Server → Client (push): `node.status`, `workflow.complete`, `debug.paused`. Every push carries the `run_id` of the run that produced it so clients can discard events from a superseded/cancelled run.

#### Run IDs and cancellation

Each call to `workflow.execute` launches a single background run and returns a `run_id` of the form `run-<seq>-<ms>` (`<seq>` is a process-local counter, `<ms>` is steady-clock milliseconds since process start). The backend stamps the same `run_id` onto every `node.status` / `debug.paused` / `workflow.complete` event it emits for that run.

Starting a second run with a previous one still active implicitly cancels the first (the worker is stopped at the next node boundary and joined before the new run launches). Clients should treat any event whose `run_id` does not match the most recently returned id as stale and drop it — `frontend/src/engine/WorkflowRunner.ts` does exactly this via `setActiveRunId`. Events missing `run_id` entirely (older backends, tests) are accepted verbatim so the filter is strictly additive.

`workflow.cancel` and `workflow.stop` both interrupt between nodes, not mid-handler: a node running a long inference will finish first, then the cancel takes effect. `workflow.cancel` is a request that returns the interrupted `run_id`; `workflow.stop` is a fire-and-forget notification kept for backward compatibility.

#### Reconnect reconciliation

Push events (`node.status`, `debug.paused`, `workflow.complete`) are not buffered server-side: if the WebSocket drops while a run is in progress, every event emitted during the outage is lost. Without correction, a node that transitioned `running → done` while the client was offline would stay pinned on `running` on the canvas forever.

`workflow.state` closes this hole. The frontend calls it automatically on every reconnect (not on the initial connect) via `WsClient.onReconnect` → `WorkflowRunner.reconcileFromSnapshot`. The reply carries a `statuses` map with the last-known status of every node in the current/most recent run plus an optional `paused_at` naming the node currently blocked on a breakpoint. The client merges these into its local store and realigns its `run_id` filter so any events still in flight from that run match and are processed.

`statuses` is scoped to a single run — it is cleared at the start of every `execute()` — so reconnecting after a completed run still returns that run's terminal statuses until a new run starts. Backends older than this RPC reject it with `-32601`; clients degrade to pre-reconnect behavior.

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

### Check backend capabilities

After starting the backend, verify it supports a given workflow's node types and ports (catches stale binaries):

```bash
node scripts/check_backend_capabilities.mjs demo/NCNN_demo/image_classification.json
```

Headless workflow verification:

```bash
node scripts/verify_image_workflow.mjs demo/NCNN_demo/image_classification.json
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

The palette exposes 17 node types across five categories. Every type is
registered in both the backend handler catalog (`nodes.list` RPC) and the
frontend manifest (`frontend/src/nodes/manifest.tsx`).

### Input

| Node | Icon | Description | Config |
|---|---|---|---|
| **Input Image** | image | Load an image file from disk. Shows a live preview thumbnail in the Properties panel via the `image.preview` RPC. | `filePath` — absolute or sandbox-relative path to a PNG/JPEG |
| **Input Tensor** | grid | Provide tensor data manually for testing. Two modes: fill a fixed shape with a constant value, or type raw float values as text. | `fillMode` (`manual` / `auto`), `tensorText`, `shape`, `fillValue` |

### Inference

| Node | Icon | Description | Config |
|---|---|---|---|
| **Create Net** | brain | Load an inference model. Opens a *View Model* button that parses the vendor `.param` file into a read-only drawer (layers, ports, shapes). | `vendor`, `paramPath`, `modelPath`, `inputName`, `outputName`, `inputW`, `inputH`, `inputC`, `numThreads`, `emptyWeights` |
| **Inference** | zap | Run a single forward pass. Accepts a tensor *or* an image (automatic RGBA→CHW float coercion at runtime). | *none* — all model params come from CreateNet |
| **Benchmark** | trending-up | Micro-benchmark a loaded model. Runs inference repeatedly for the configured duration, then emits average-ms, total runs, and a sample output tensor. | `duration` — seconds (default 10) |
| **Postprocess** | wrench | Built-in post-processing. **NMS** (non-max suppression for detection boxes) or **Top-K** (select highest-scoring classes). | `op` (`nms` / `topk`), `iouThreshold` (NMS), `k` (Top-K) |

### Output — data

| Node | Icon | Description | Config |
|---|---|---|---|
| **Save Text** | file-down | Persist a tensor or string to a text file on disk. | `filePath` |
| **Save Image** | image + download | Persist an RGBA image to disk as PNG (or JPEG by extension). Shows a preview thumbnail in the Properties panel after the node completes. | `filePath` |
| **Output** | upload | Display output data inline in the canvas (number summary, tensor stats). | *none* |

### Output — image processing

| Node | Icon | Description | Config |
|---|---|---|---|
| **Tensor To Image** | heatmap | Render a 1-D tensor as a heatmap strip (viridis or grayscale). With an *original_image* input, resizes to match and composites the heatmap over it (overlay mode). | `width`, `height`, `colormap` (`viridis` / `gray`), `normalize` (`auto` / `none`), `overlayOpacity` |
| **Annotate Image** | tag | Overlay top-K class labels on an image. Reads a `[idx, score, …]` tensor and an optional labels file; renders a translucent panel with class names and scores. | `labelsPath`, `maxLines`, `fontScale` |
| **Draw Boxes** | box | Render bounding boxes on an image. Reads an NMS-format `[x1,y1,x2,y2,score,…]` tensor and draws colored rectangles with score labels. Per-class coloring cycles through 12 distinct hues. | `confidenceThreshold`, `lineWidth`, `fontScale`, `maxBoxes`, `normalizedCoords`, `labelsPath` |
| **Segmentation Mask** | mosaic | Convert per-pixel logits into a color-coded RGBA mask. Performs argmax across classes and maps each class to a viridis-derived color. | `width`, `height` — spatial dimensions of the logits tensor |
| **Composite** | layers | Alpha-blend a foreground image over a background image at a configurable opacity. Nearest-neighbour resizes the foreground if dimensions differ. | `opacity` (0–1) |

### Control

| Node | Icon | Description | Config |
|---|---|---|---|
| **Condition** | branch | Branching logic. Evaluates an expression against the input tensor; only the taken branch's downstream nodes execute; the other branch is *skipped*. | `expression` — `<selector> <op> <number>` (selectors: `max`, `min`, `mean`, `sum`, `first`, `[i]`; ops: `>`, `<`, `>=`, `<=`, `==`, `!=`) |

### Debug

| Node | Icon | Description | Config |
|---|---|---|---|
| **Inspect** | search | Unconditional inspection point. Passes input through to output so you can view it in the Properties panel and debug drawer. | *none* |

Breakpoints can also be toggled on **any** node with **B** — you don't need an Inspect node to pause.

## Debugging

- Select any node and press **B** (or use the right-click context menu) to toggle a breakpoint — this is no longer limited to Debug nodes.
- When execution reaches the breakpoint, the backend emits `debug.paused`, the properties panel surfaces the node's *live* inputs (the actual upstream tensors / images that will feed the handler), and the Toast row lights up with the paused-at id.
- Resume with **Continue** or advance one node with **Step Over** (sent as `debug.continue` / `debug.step_over` notifications). The breakpoint stays armed; clear it from the same B / context-menu toggle.
- A separate Debug node is still available for inserting an unconditional inspection point that does not require selecting an existing node.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `R` | Run the workflow |
| `Esc` | Cancel the running workflow / close drawers |
| `B` | Toggle breakpoint on the selected node |
| `F` | Fit the canvas to the current graph |
| `Ctrl/⌘ + Z` / `Ctrl/⌘ + Shift + Z` | Undo / redo |
| `Delete` / `Backspace` | Delete selected nodes / edges |

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

The E2E suite spans two specs. `frontend/e2e/workflow.spec.ts` contains 11 tests across Canvas, Node CRUD, Workflow execution, Save/Load, and WebSocket disconnection scenarios — it runs against a mock WebSocket backend at `frontend/e2e/mock-backend.mjs`, so no C++ build is required. `frontend/e2e/ncnn-demo.spec.ts` adds 3 end-to-end tests that boot the real C++ backend (if `backend/build/workflow_backend` exists) and replay the bundled NCNN demo workflow: a full-graph run with PNG round-trip assertion, the *View Model* drawer round-trip on a `createNet` node, and a debug-mode breakpoint / step-over round-trip on `infer`.

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
│   │   ├── nodes/               # 17 custom node components (+ tests)
│   │   ├── panels/              # NodePalette, PropertiesPanel, ConsolePanel
│   │   ├── transport/           # WsClient (JSON-RPC 2.0 + auto-reconnect)
│   │   ├── engine/              # WorkflowRunner (frontend execution coordinator)
│   │   ├── store/               # Zustand stores (workflow/debug/toast) with zundo history
│   │   ├── components/, hooks/, utils/
│   ├── e2e/                     # Playwright specs + mock-backend.mjs
│   ├── src-tauri/               # Tauri v2 desktop shell (Rust)
│   └── playwright.config.ts
└── demo/                        # Example workflows (NCNN ShuffleNet, MobileNetV2 image classification)
```

## Tech Stack

- **Frontend:** React 19.2, `@xyflow/react` 12, Zustand 5 (+ `zundo` for history), dagre, Vite 8, TypeScript 6
- **Backend:** C++17, uWebSockets 20.70, uSockets 0.8.8, nlohmann/json 3.11.3, ZLIB, pthreads, googletest
- **Desktop:** Tauri v2.10 (Rust edition 2021, rustc ≥ 1.77.2)
- **Inference:** NCNN (optional, compile-time toggle) + built-in Stub engine
- **Testing:** Playwright 1.59, Vitest 4.1, googletest
- **Transport:** WebSocket + JSON-RPC 2.0
