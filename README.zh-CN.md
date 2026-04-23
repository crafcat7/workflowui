# WorkflowUI — 推理工作台

[English version](./README.md)

可视化、可编程的推理流水线编排工作台。以节点图为核心范式，拖拽构建推理流水线，支持逐节点调试、断点与张量数据实时检查。

## 特性

- **节点图驱动的拖拽式开发。** 基于 `@xyflow/react` 的 React Flow 画布，组合数据加载、推理、后处理与输出节点。
- **全栈式调试。** 在 Debug 节点上设置断点后，后端调度器会暂停执行，并通过 WebSocket 把节点状态、暂停帧推回前端以供检查。
- **浏览器 + 桌面双形态。** 既可作为 Vite 开发服务器在浏览器中运行，也可以通过 Tauri v2 打包为原生桌面应用，共享同一套前端代码。
- **可插拔的推理 Vendor 层。** 后端 `backend/src/vendor/` 中定义了抽象 `InferenceEngine` 接口；已内置 NCNN 实现；当编译期关闭 NCNN 时会链接内置 `StubEngine`（回显引擎），保证上层链路仍可完整跑通。
- **完整的编辑体验。** 前端自带 Toolbar、节点面板 (NodePalette)、属性面板、调试面板和控制台面板；Zustand + `zundo` 提供撤销/重做。

## 架构

```
┌──────────────┐   WebSocket   ┌──────────────────┐        ┌──────────────┐
│   前端       │◄─────────────►│  后端封装层      │◄──────►│  Vendor 层   │
│  React Flow  │  JSON-RPC 2   │   C++ / uWS      │        │ NCNN / Stub  │
└──────────────┘               └──────────────────┘        └──────────────┘
```

三层解耦：

- **前端** — React 19 + `@xyflow/react` + Zustand。图编辑器、传输客户端、执行协调器 (`WorkflowRunner`)。
- **后端封装层** — 基于 uWebSockets 的 C++17 WebSocket 服务；负责能力注册、工作流调度与执行、调试控制、文件访问安全策略、节点 handler 调度。
- **Vendor 层** — 纯虚基类 `InferenceEngine`。NCNN 为首个真实实现；关闭 `-DENABLE_NCNN=ON` 时链接 Stub 引擎。

### 通信协议

WebSocket 监听路径为 `/*`，消息格式为 JSON-RPC 2.0。

客户端 → 服务端（请求）：

| 方法 | 作用 |
|---|---|
| `capabilities` | 返回已注册的 vendor 与 operation 列表 |
| `vendor.getConfigSchema` | 查询某 vendor 的配置字段 |
| `workflow.execute` | 在后台线程启动工作流执行 |
| `debug.add_breakpoint` | 为某节点添加断点 |
| `debug.remove_breakpoint` | 移除断点 |

客户端 → 服务端（通知）：`workflow.stop`、`debug.continue`、`debug.step_over`。

服务端 → 客户端（推送）：`node.status`、`workflow.complete`、`debug.paused`。

## 快速开始

### 系统依赖

```bash
# Ubuntu / Debian
sudo apt install cmake make g++ nodejs npm zlib1g-dev

# macOS
brew install cmake node
```

### 一键启动（Stub 模式，无需 NCNN）

```bash
./setup.sh
```

脚本会：

1. 使用 Stub 引擎构建 C++ 后端。
2. 安装前端依赖并完成一次构建。
3. 启动后端（默认端口 `9090`）与 Vite 开发服务器（`5173`）。
4. 打开 `http://localhost:5173`。

### 启用 NCNN 真实推理

```bash
./setup.sh --ncnn
```

脚本会从源码克隆 NCNN 到 `/tmp/ncnn`（仅 CPU，禁用 Vulkan，约 2 分钟），安装至 `/tmp/ncnn-install`，然后以 `-DENABLE_NCNN=ON` 重新构建后端。

### setup.sh 其他用法

```bash
./setup.sh --dev                    # 跳过构建，直接启动已构建产物
./setup.sh --test                   # 运行完整测试（gtest + vitest + 集成 + playwright）
./setup.sh --shared-dir /srv/share  # 指定共享根目录
BACKEND_PORT=8080 ./setup.sh        # 自定义后端端口
./setup.sh --help
```

## 手动构建

### 后端

```bash
cd backend

# Stub 模式
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

# NCNN 模式（需要已编译安装好的 NCNN）
cmake -S . -B build -DENABLE_NCNN=ON -Dncnn_DIR=/path/to/ncnn/lib/cmake/ncnn
cmake --build build -j$(nproc)

# 启动（默认端口 9090）
./build/workflow_backend 9090
./build/workflow_backend 9090 --shared-dir /srv/share
```

后端同时支持从环境变量 `SHARED_DIR` 读取共享根目录。

### 前端

```bash
cd frontend
npm install
npm run dev          # 开发服务器，端口 5173
npm run build        # 生产构建（tsc -b + vite build）
npm run preview
```

前端默认根据当前页面 host 推导 WebSocket 地址，默认端口为 `9090`。可通过环境变量覆盖：

```bash
VITE_WS_URL=ws://localhost:8080 npm run dev
VITE_WS_PORT=8080 npm run dev
```

#### 文件访问策略

当客户端来自非 loopback 地址时，后端会将所有文件读写限制在共享根目录（默认 `./shared`，可通过 `SHARED_DIR` 或 `--shared-dir` 修改）之内：

- 本机客户端可以访问后端进程权限范围内的任意路径。
- 远程客户端必须使用相对共享根目录的相对路径，例如 `demo/NCNN_demo/shufflenet.param`。
- 远程客户端不允许使用绝对路径。
- 内置 Demo 位于 `shared/demo/NCNN_demo/`。

### Tauri 桌面应用

```bash
cd frontend
npx tauri dev        # 开发模式
npx tauri build      # 打包原生应用
```

Tauri v2.10 的配置位于 `frontend/src-tauri/`，窗口尺寸 `1280×800`，标识符 `com.workflowui.app`；`beforeDevCommand` 已串接到 `npm run dev`，开发时 Vite 服务器会自动启动。

## 节点类型

前端调色板 (`frontend/src/nodes/index.ts`) 暴露 10 种节点组件：

| 节点 | 类别 | 说明 |
|---|---|---|
| Input Image | input | 从磁盘加载图片文件 |
| Input Tensor | input | 手动输入张量数据 |
| Create Net | inference | 加载模型（`.param` + `.bin`） |
| Inference | inference | 执行一次前向推理 |
| Benchmark | inference | 对已加载的网络做基准测试 |
| Postprocess | inference | 内置后处理（如 softmax / top-k） |
| Save Text | output | 保存文本结果 |
| Output | output | 在界面上显示输出数据 |
| Condition | control | 条件分支 |
| Debug | debug | 断点 / 数据检查 |

后端在启动时注册 8 个能力操作：`init_net`、`execute`、`benchmark`、`read_image`、`read_tensor`、`save_file`、`condition`、`postprocess`。

## 调试系统

- 在图中任意位置放置 Debug 节点并开启断点。
- 执行命中断点时，后端推送 `debug.paused`，前端展示该节点的输入/输出。
- 通过 **Continue** 继续执行，或通过 **Step Over** 单步前进（对应 `debug.continue` / `debug.step_over` 通知）。

## 测试

### C++ 单元测试（googletest）

```bash
cd backend
cmake --build build --target workflow_test
./build/workflow_test
```

### 前端单元测试（Vitest）

```bash
cd frontend
npm run test:unit
npm run test:unit:watch
```

### 端到端测试（Playwright）

```bash
cd frontend
npm run test:e2e          # 无头模式
npm run test:e2e:headed   # 有头模式
```

`frontend/e2e/workflow.spec.ts` 包含 11 个测试，覆盖画布、节点 CRUD、工作流执行、保存/加载、WebSocket 断连等场景。测试跑在 `frontend/e2e/mock-backend.mjs` 这个 mock WebSocket 后端之上，无需先编译 C++ 后端。

此外还提供面向真实后端的测试：`test:e2e:live`，以及 `frontend/e2e/` 下的 `live-checks.mjs`、`live-benchmark-check.mjs`、`live-timing-check.mjs`。

### 集成测试

仓库根目录下的 `test_integration.mjs` 以原始 WebSocket 连接已启动的后端做冒烟验证。`setup.sh --test` 会自动调用它。

## 项目结构

```
workflowUI/
├── setup.sh                     # 一键构建 & 启动脚本
├── test_integration.mjs         # 根目录的 WebSocket 集成冒烟测试
├── backend/
│   ├── CMakeLists.txt           # C++ 构建配置（FetchContent: uWS, nlohmann/json, gtest）
│   ├── src/
│   │   ├── main.cpp             # 入口：CLI、RPC 路由、引擎初始化
│   │   ├── server/              # ws_server + rpc_handler（uWS + JSON-RPC 2.0）
│   │   ├── capability/          # 能力注册表（vendors + operations）
│   │   ├── workflow/            # executor、scheduler、debug_controller、handlers/
│   │   ├── model/               # node 与 workflow_graph 数据模型
│   │   ├── security/            # 文件访问策略（共享目录沙箱）
│   │   └── vendor/
│   │       ├── inference_engine.h    # 抽象引擎接口
│   │       └── ncnn/                 # NCNN 实现
│   └── tests/                   # googletest 测试
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # React Flow 画布
│   │   ├── nodes/               # 10 种自定义节点（含测试）
│   │   ├── panels/              # Toolbar、NodePalette、PropertiesPanel、DebugPanel、ConsolePanel
│   │   ├── transport/           # WsClient（JSON-RPC 2.0 + 自动重连）
│   │   ├── engine/              # WorkflowRunner（前端执行协调）
│   │   ├── store/               # Zustand 状态（workflow/debug/toast）+ zundo 历史
│   │   ├── components/, hooks/, utils/
│   ├── e2e/                     # Playwright 测试 + mock-backend.mjs + live-*.mjs
│   ├── src-tauri/               # Tauri v2 桌面外壳（Rust）
│   └── playwright.config.ts
├── shared/                      # 远程客户端文件访问的默认共享根目录
│   └── demo/NCNN_demo/          # 内置 Demo（shufflenet.param + workflow.json）
└── demo/                        # 示例工作流
```

## 技术栈

- **前端：** React 19.2、`@xyflow/react` 12、Zustand 5（配合 `zundo` 历史）、dagre、Vite 8、TypeScript 6
- **后端：** C++17、uWebSockets 20.70、uSockets 0.8.8、nlohmann/json 3.11.3、ZLIB、pthreads、googletest
- **桌面：** Tauri v2.10（Rust edition 2021，rustc ≥ 1.77.2）
- **推理：** NCNN（可选，编译期开关）+ 内置 Stub 引擎
- **测试：** Playwright 1.59、Vitest 4.1、googletest
- **通信：** WebSocket + JSON-RPC 2.0
