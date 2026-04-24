# Build & Test Workflow

## Frontend (`frontend/`)
- Install: `npm install`
- Typecheck: `npx tsc -b --noEmit`
- Unit tests (Vitest, jsdom): `npx vitest run`
- E2E tests (Playwright): `npx playwright test`
- Dev server: `npm run dev` (Vite on :5173)
- Production build: `npm run build` (runs `tsc -b && vite build`)

Stack: React 19 + `@xyflow/react` 12 + Zustand 5 + zundo 2 + Vite 8 + TS 6.

## Backend (`backend/`)
- Configure: `cmake -S . -B build` (from `backend/`)
- Build: `cmake --build backend/build`
- Run tests: `./backend/build/workflow_test` (gtest)
- Run server: `./backend/build/workflow_backend [--port 9090] [--shared-dir PATH] [--allow-origin URL]...`
  - Legacy positional port (`workflow_backend 9091`) is still accepted.
  - `--help` prints the flag list.
  - When `--shared-dir` is unset the sandbox is disabled; when `--allow-origin`
    is not passed a default set (localhost:5173/1420 + `tauri://localhost`) is
    installed. Clients without an Origin header always pass.

### ENABLE_NCNN flag — DO NOT enable without the vendor source
`backend/CMakeLists.txt` declares `option(ENABLE_NCNN "Enable NCNN vendor backend" OFF)` and, when ON,
adds `src/vendor/ncnn/ncnn_engine.cpp`. **That file is not in the repository** and has no git history,
so turning the flag on breaks configure with a confusing `No SOURCES given to target` error. Always
configure with `-DENABLE_NCNN=OFF` (the default) until the vendor implementation is committed.

If you hit this on an inherited build tree, reset the cache:
```
cmake -DENABLE_NCNN=OFF -S backend -B backend/build
```

## Tauri desktop shell (`frontend/src-tauri/`)
- Dev: `npm run tauri dev` from `frontend/`
- Release: `npm run tauri build` from `frontend/`

## Cross-compile (Phase 8)
CI lives at `.github/workflows/ci.yml` and covers four targets:
- `x86_64-linux` — native on `ubuntu-latest`.
- `aarch64-linux` — cross-compiled with `g++-aarch64-linux-gnu`, tests
  run via `qemu-user-static`. Toolchain file:
  `backend/cmake/toolchains/aarch64-linux.cmake`.
- `aarch64-macos` — native on `macos-14`.
- `x86_64-windows` — MinGW cross-compile via `mingw-w64`. Marked
  `continue-on-error: true` because uSockets/uWS on MinGW is
  unvalidated; the job still builds to catch regressions.
  Toolchain file: `backend/cmake/toolchains/x86_64-windows-mingw.cmake`.

CMake now gates `pthread`/`z` linkage on `NOT WIN32`; the MinGW branch
links `ws2_32` and static-links the MinGW runtime. `ENABLE_NCNN` stays
OFF across every matrix target.
