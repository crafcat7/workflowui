#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
#  WorkflowUI — 一键构建 & 启动脚本
#  用法:
#    ./setup.sh              # Stub 模式（无需 NCNN）
#    ./setup.sh --ncnn       # 启用 NCNN 推理后端
#    ./setup.sh --dev        # 仅启动开发服务器（需已构建后端）
#    ./setup.sh --test       # 运行 E2E 测试
# ─────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
NCNN_SRC_DIR="/tmp/ncnn"
NCNN_INSTALL_DIR="/tmp/ncnn-install"
BACKEND_PORT="${BACKEND_PORT:-9090}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── 参数解析 ──────────────────────────────────────────
ENABLE_NCNN=OFF
DEV_ONLY=false
TEST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --ncnn)  ENABLE_NCNN=ON ;;
    --dev)   DEV_ONLY=true ;;
    --test)  TEST_ONLY=true ;;
    --help|-h)
      echo "用法: $0 [--ncnn] [--dev] [--test]"
      echo ""
      echo "  (无参数)    构建后端 (Stub) + 前端，然后启动"
      echo "  --ncnn      从源码编译 NCNN 并启用真实推理后端"
      echo "  --dev       跳过构建，仅启动前端 dev server + 后端"
      echo "  --test      运行 Playwright E2E 测试"
      echo ""
      echo "环境变量:"
      echo "  BACKEND_PORT   后端 WebSocket 端口 (默认 9090)"
      exit 0
      ;;
    *) err "未知参数: $arg（使用 --help 查看帮助）" ;;
  esac
done

# ── 检查依赖 ──────────────────────────────────────────
check_deps() {
  local missing=()
  command -v cmake  >/dev/null || missing+=(cmake)
  command -v make   >/dev/null || missing+=(make)
  command -v node   >/dev/null || missing+=(node)
  command -v npm    >/dev/null || missing+=(npm)
  command -v g++    >/dev/null || missing+=(g++)

  if [ ${#missing[@]} -gt 0 ]; then
    err "缺少依赖: ${missing[*]}\n  请安装后重试: sudo apt install ${missing[*]}"
  fi
  ok "系统依赖检查通过"
}

# ── 编译 NCNN ─────────────────────────────────────────
build_ncnn() {
  if [ -f "$NCNN_INSTALL_DIR/lib/cmake/ncnn/ncnnConfig.cmake" ]; then
    ok "NCNN 已安装在 $NCNN_INSTALL_DIR，跳过编译"
    return
  fi

  info "从源码编译 NCNN..."

  if [ ! -d "$NCNN_SRC_DIR" ]; then
    info "克隆 ncnn 源码..."
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

  cmake --build "$NCNN_SRC_DIR/build" -j"$(nproc)" 2>&1 | tail -3
  cmake --install "$NCNN_SRC_DIR/build" 2>&1 | tail -3

  ok "NCNN 编译安装完成 → $NCNN_INSTALL_DIR"
}

# ── 构建 C++ 后端 ────────────────────────────────────
build_backend() {
  info "构建 C++ 后端 (ENABLE_NCNN=$ENABLE_NCNN)..."

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
  cmake --build "$BACKEND_DIR/build" -j"$(nproc)" 2>&1 | tail -3

  ok "后端构建完成 → $BACKEND_DIR/build/workflow_backend"
}

# ── 安装 & 构建前端 ──────────────────────────────────
build_frontend() {
  info "安装前端依赖..."
  (cd "$FRONTEND_DIR" && npm install --silent)

  info "构建前端..."
  (cd "$FRONTEND_DIR" && npm run build)

  ok "前端构建完成 → $FRONTEND_DIR/dist/"
}

# ── 启动服务 ──────────────────────────────────────────
start_services() {
  info "启动后端 (端口 $BACKEND_PORT)..."
  "$BACKEND_DIR/build/workflow_backend" "$BACKEND_PORT" &
  BACKEND_PID=$!

  # 等待后端就绪
  for i in $(seq 1 20); do
    if ss -tlnp 2>/dev/null | grep -q ":$BACKEND_PORT"; then
      break
    fi
    sleep 0.5
  done

  if ! ss -tlnp 2>/dev/null | grep -q ":$BACKEND_PORT"; then
    err "后端未能在端口 $BACKEND_PORT 上启动"
  fi
  ok "后端已启动 (PID=$BACKEND_PID, 端口=$BACKEND_PORT)"

  info "启动前端开发服务器..."
  (cd "$FRONTEND_DIR" && VITE_WS_URL="ws://localhost:$BACKEND_PORT" npx vite --host) &
  FRONTEND_PID=$!

  ok "前端开发服务器已启动 (PID=$FRONTEND_PID)"
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  WorkflowUI 已启动${NC}"
  echo -e "  前端:  ${CYAN}http://localhost:5173${NC}"
  echo -e "  后端:  ${CYAN}ws://localhost:$BACKEND_PORT${NC}"
  echo -e "  引擎:  ${YELLOW}$( [ "$ENABLE_NCNN" = "ON" ] && echo "NCNN" || echo "Stub" )${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo ""
  echo "按 Ctrl+C 停止所有服务"

  # 捕获退出信号
  trap "echo ''; info '正在停止服务...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; ok '已停止'; exit 0" INT TERM
  wait
}

# ── 测试 ──────────────────────────────────────────
run_tests() {
  info "运行 C++ 单元测试..."
  if [ -f "$BACKEND_DIR/build/workflow_test" ]; then
    "$BACKEND_DIR/build/workflow_test" || err "C++ 单元测试失败"
    ok "C++ 单元测试通过"
  else
    warn "未找到 C++ 测试可执行文件，请先构建后端"
    exit 1
  fi

  info "安装前端依赖..."
  (cd "$FRONTEND_DIR" && npm install --silent)

  info "运行前端单元测试..."
  (cd "$FRONTEND_DIR" && npm run test:unit) || err "前端单元测试失败"
  ok "前端单元测试通过"

  info "启动后端并运行集成测试..."
  if [ -f "$BACKEND_DIR/build/workflow_backend" ]; then
    "$BACKEND_DIR/build/workflow_backend" 9090 > /dev/null 2>&1 &
    local BACKEND_PID=$!
    sleep 1
    (cd "$ROOT_DIR" && node test_integration.mjs 9090) || {
      kill $BACKEND_PID 2>/dev/null
      err "集成测试失败"
    }
    kill $BACKEND_PID 2>/dev/null
    ok "集成测试通过"
  else
    warn "未找到后端可执行文件，请先构建后端"
    exit 1
  fi

  info "安装 Playwright 浏览器..."
  (cd "$FRONTEND_DIR" && npx playwright install chromium 2>&1 | tail -2)

  info "运行前端 E2E 测试..."
  (cd "$FRONTEND_DIR" && npm run test:e2e) || err "E2E 测试失败"
  ok "E2E 测试通过"

  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  所有测试运行完成并全部通过！${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
}

# ── 主流程 ────────────────────────────────────────────
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
      err "后端尚未构建，请先运行 $0 或 $0 --ncnn"
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
