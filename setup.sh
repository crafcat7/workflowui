#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
#  WorkflowUI — One-shot build & launch script
#  Usage:
#    ./setup.sh              # Stub mode (no NCNN required)
#    ./setup.sh --ncnn       # Enable NCNN inference backend
#    ./setup.sh --dev        # Launch dev servers only (backend must be pre-built)
#    ./setup.sh --test       # Run E2E tests
# ─────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
NCNN_SRC_DIR="/tmp/ncnn"
NCNN_INSTALL_DIR="/tmp/ncnn-install"
BACKEND_PORT="${BACKEND_PORT:-9090}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Cross-platform utility functions ──────────────────
cpu_count() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
    return
  fi
  if command -v getconf >/dev/null 2>&1; then
    getconf _NPROCESSORS_ONLN 2>/dev/null && return
  fi
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.ncpu 2>/dev/null && return
  fi
  echo 4
}

is_port_listening() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | grep -q ":$port "
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -E "[\.:]$port[[:space:]]" | grep -q LISTEN
    return
  fi

  return 1
}

# ── Argument parsing ──────────────────────────────────
ENABLE_NCNN=OFF
DEV_ONLY=false
TEST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --ncnn)  ENABLE_NCNN=ON ;;
    --dev)   DEV_ONLY=true ;;
    --test)  TEST_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--ncnn] [--dev] [--test]"
      echo ""
      echo "  (no args)   Build backend (Stub) + frontend, then launch"
      echo "  --ncnn      Build NCNN from source and enable real inference backend"
      echo "  --dev       Skip build, launch frontend dev server + backend only"
      echo "  --test      Run Playwright E2E tests"
      echo ""
      echo "Environment variables:"
      echo "  BACKEND_PORT    Backend WebSocket port (default: 9090)"
      echo "  FRONTEND_PORT   Frontend dev-server port (default: 5173)"
      exit 0
      ;;
    *) err "Unknown argument: $arg (use --help for usage)" ;;
  esac
done

# ── Check dependencies ────────────────────────────────
check_deps() {
  local missing=()
  command -v cmake  >/dev/null || missing+=(cmake)
  command -v make   >/dev/null || missing+=(make)
  command -v node   >/dev/null || missing+=(node)
  command -v npm    >/dev/null || missing+=(npm)
  command -v g++    >/dev/null || missing+=(g++)

  if [ ${#missing[@]} -gt 0 ]; then
    err "Missing dependencies: ${missing[*]}\n  Please install and retry: sudo apt install ${missing[*]}"
  fi
  ok "System dependencies check passed"
}

# ── Build NCNN ────────────────────────────────────────
build_ncnn() {
  if [ -f "$NCNN_INSTALL_DIR/lib/cmake/ncnn/ncnnConfig.cmake" ]; then
    ok "NCNN already installed at ${NCNN_INSTALL_DIR}, skipping build"
    return
  fi

  info "Building NCNN from source..."

  if [ ! -d "$NCNN_SRC_DIR" ]; then
    info "Cloning ncnn source..."
    git clone --depth 1 https://github.com/Tencent/ncnn.git "$NCNN_SRC_DIR"
  fi

  cmake -S "$NCNN_SRC_DIR" -B "$NCNN_SRC_DIR/build" \
    -DCMAKE_INSTALL_PREFIX="$NCNN_INSTALL_DIR" \
    -DNCNN_BUILD_EXAMPLES=OFF \
    -DNCNN_BUILD_TOOLS=OFF \
    -DNCNN_BUILD_BENCHMARK=OFF \
    -DNCNN_BUILD_TESTS=OFF \
    -DNCNN_VULKAN=OFF \
    -DCMAKE_BUILD_TYPE=Release \
    2>&1 | tail -3

  cmake --build "$NCNN_SRC_DIR/build" -j"$(cpu_count)" 2>&1 | tail -3
  cmake --install "$NCNN_SRC_DIR/build" 2>&1 | tail -3

  ok "NCNN build and install complete -> $NCNN_INSTALL_DIR"
}

# ── Build C++ backend ─────────────────────────────────
build_backend() {
  info "Building C++ backend (ENABLE_NCNN=$ENABLE_NCNN)..."

  local cmake_args=(
    -S "$BACKEND_DIR"
    -B "$BACKEND_DIR/build"
    -DENABLE_NCNN="$ENABLE_NCNN"
    -DCMAKE_BUILD_TYPE=Release
  )

  if [ "$ENABLE_NCNN" = "ON" ]; then
    cmake_args+=(-Dncnn_DIR="$NCNN_INSTALL_DIR/lib/cmake/ncnn")
  fi

  cmake "${cmake_args[@]}" 2>&1 | tail -3
  cmake --build "$BACKEND_DIR/build" -j"$(cpu_count)" 2>&1 | tail -3

  ok "Backend build complete -> $BACKEND_DIR/build/workflow_backend"
}

# ── Install & build frontend ──────────────────────────
build_frontend() {
  info "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm install --silent)

  info "Building frontend..."
  (cd "$FRONTEND_DIR" && npm run build)

  ok "Frontend build complete -> $FRONTEND_DIR/dist/"
}

# ── Start services ────────────────────────────────────
start_services() {
  if is_port_listening "$BACKEND_PORT"; then
    err "Backend port $BACKEND_PORT is already in use. Free it or set BACKEND_PORT to a different value."
  fi

  info "Starting backend (port $BACKEND_PORT)..."
  "$BACKEND_DIR/build/workflow_backend" "$BACKEND_PORT" &
  BACKEND_PID=$!

  # Wait for backend to become ready
  for i in $(seq 1 20); do
    if is_port_listening "$BACKEND_PORT"; then
      break
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done

  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    err "Backend process exited unexpectedly. Check port conflicts or backend logs."
  fi

  if ! is_port_listening "$BACKEND_PORT"; then
    err "Backend failed to start on port $BACKEND_PORT"
  fi
  ok "Backend started (PID=$BACKEND_PID, port=$BACKEND_PORT)"

  info "Starting frontend dev server (port $FRONTEND_PORT)..."
  # If $FRONTEND_PORT is already in use, fail immediately. Vite's automatic
  # port switching would cause the browser to use an unregistered origin,
  # which gets rejected by the backend's origin allow-list, resulting in a
  # "Backend disconnected — reconnecting" infinite loop.
  if is_port_listening "$FRONTEND_PORT"; then
    kill $BACKEND_PID 2>/dev/null
    err "Frontend port $FRONTEND_PORT is already in use. Free it or set FRONTEND_PORT to a different value."
  fi
  (cd "$FRONTEND_DIR" && \
    VITE_WS_URL="ws://localhost:$BACKEND_PORT" \
    npx vite --host --port "$FRONTEND_PORT" --strictPort) &
  FRONTEND_PID=$!

  ok "Frontend dev server started (PID=$FRONTEND_PID)"
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  WorkflowUI is running${NC}"
  echo -e "  Frontend: ${CYAN}http://localhost:$FRONTEND_PORT${NC}"
  echo -e "  Backend:  ${CYAN}ws://localhost:$BACKEND_PORT${NC}"
  echo -e "  Engine:   ${YELLOW}$( [ "$ENABLE_NCNN" = "ON" ] && echo "NCNN" || echo "Stub" )${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo ""
  echo "Press Ctrl+C to stop all services."

  # Trap exit signals
  trap "echo ''; info 'Stopping services...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; ok 'Stopped'; exit 0" INT TERM
  wait
}

# ── Tests ─────────────────────────────────────────────
run_tests() {
  info "Running C++ unit tests..."
  if [ -f "$BACKEND_DIR/build/workflow_test" ]; then
    "$BACKEND_DIR/build/workflow_test" || err "C++ unit tests failed"
    ok "C++ unit tests passed"
  else
    warn "C++ test executable not found. Build the backend first."
    exit 1
  fi

  info "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm install --silent)

  info "Running frontend unit tests..."
  (cd "$FRONTEND_DIR" && npm run test:unit) || err "Frontend unit tests failed"
  ok "Frontend unit tests passed"

  info "Starting backend and running integration tests..."
  if [ -f "$BACKEND_DIR/build/workflow_backend" ]; then
    "$BACKEND_DIR/build/workflow_backend" 9090 > /dev/null 2>&1 &
    local BACKEND_PID=$!
    sleep 1
    (cd "$ROOT_DIR" && node test_integration.mjs 9090) || {
      kill $BACKEND_PID 2>/dev/null
      err "Integration tests failed"
    }
    kill $BACKEND_PID 2>/dev/null
    ok "Integration tests passed"
  else
    warn "Backend executable not found. Build the backend first."
    exit 1
  fi

  info "Installing Playwright browsers..."
  (cd "$FRONTEND_DIR" && npx playwright install chromium 2>&1 | tail -2)

  info "Running frontend E2E tests..."
  (cd "$FRONTEND_DIR" && npm run test:e2e) || err "E2E tests failed"
  ok "E2E tests passed"

  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  All tests passed!${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
}

# ── Main flow ─────────────────────────────────────────
main() {
  echo ""
  echo -e "${CYAN}╔════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  WorkflowUI — Inference Workbench      ║${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════╝${NC}"
  echo ""

  if $TEST_ONLY; then
    check_deps
    run_tests
    exit 0
  fi

  if $DEV_ONLY; then
    if [ ! -f "$BACKEND_DIR/build/workflow_backend" ]; then
      err "Backend not built yet. Run $0 or $0 --ncnn first."
    fi
    start_services
    exit 0
  fi

  check_deps

  if [ "$ENABLE_NCNN" = "ON" ]; then
    build_ncnn
  fi

  build_backend
  build_frontend
  start_services
}

main
