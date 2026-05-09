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

### ENABLE_NCNN flag
`backend/CMakeLists.txt` declares `option(ENABLE_NCNN "Enable NCNN vendor backend" OFF)`.
With the flag ON, `backend/src/vendor/ncnn/ncnn_engine.{h,cpp}` is compiled and
linked against a prebuilt `ncnn::ncnn` CMake target (point `ncnn_DIR` at the
install's `lib/cmake/ncnn`). Historically this file was missing from the repo
because `.gitignore` contained an unanchored `ncnn/` rule that also matched
`backend/src/vendor/ncnn/`; the rule is now anchored to `/ncnn/` so only the
top-level vendor sibling directory is ignored.

```
cmake -S backend -B backend/build -DENABLE_NCNN=ON \
      -Dncnn_DIR=/path/to/ncnn-install/lib/cmake/ncnn
```

If the Extractor API in your NCNN build differs (`set_num_threads` was
removed from Extractor in recent versions), threading is driven via
`Net::opt.num_threads`, which `NcnnEngine` already sets from `NetConfig`.

## Tauri desktop shell (`frontend/src-tauri/`)
- Dev: `npm run tauri dev` from `frontend/`
- Release: `npm run tauri build` from `frontend/`

## CI backend targets
CI lives at `.github/workflows/ci.yml` and follows the supported runtime
environments: Linux and macOS. It covers three backend targets:
- `x86_64-linux` — native on `ubuntu-latest`.
- `aarch64-linux` — cross-compiled with `g++-aarch64-linux-gnu`, tests
  run via `qemu-user-static`. Toolchain file:
  `backend/cmake/toolchains/aarch64-linux.cmake`.
- `aarch64-macos` — native on `macos-14`.

CMake uses `Threads::Threads` instead of direct `pthread` linker flags so
macOS and Linux choose their platform-native thread linkage. uWebSockets is
built with `UWS_NO_ZLIB` because server compression is disabled in code;
this avoids requiring target-architecture zlib dev packages in cross builds.
`ENABLE_NCNN` stays OFF across every matrix target.

The Windows toolchain file remains in `backend/cmake/toolchains/` for local
experiments, but Windows is not part of community CI.
