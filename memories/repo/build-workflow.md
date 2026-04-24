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
- Run server: `./backend/build/workflow_backend [--host 127.0.0.1] [--port 8787] [--shared-dir PATH]`

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

## Cross-compile requirement (pending)
User expects builds on 4 architectures; infra does not yet exist. Likely targets:
x86_64-linux, aarch64-linux, x86_64-windows, aarch64-macos. Planned via a `ci/` directory
with GitHub Actions + cross-rs / cmake toolchain files. Not yet implemented.
