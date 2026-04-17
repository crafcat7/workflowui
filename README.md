# WorkflowUI — Inference Workbench

可视化、可编程的推理框架编排工作台。通过节点图范式，拖拽构建推理流水线，支持逐步调试、断点、数据检查。

## ✨ 特性 (Features)

- **节点图驱动的拖拽式开发**：通过直观的 React Flow 界面，轻松构建包含数据加载、推理执行和输出处理的复杂流水线。
- **全栈式调试支持**：在任何节点设置断点，暂停执行，实时检查输入/输出张量数据。
- **跨平台与桌面支持**：提供基于 Tauri 的原生桌面应用，并内置浏览器支持。
- **模块化插件式推理引擎**：Vendor Layer 提供 C++ 层面的 `InferenceEngine` 抽象接口，原生支持 NCNN，并易于扩展到 TensorRT、ONNX Runtime 等其他推理框架。

## 🏗️ 架构设计

```
┌──────────────┐  WebSocket   ┌──────────────────┐        ┌──────────────┐
│   Frontend   │◄────────────►│  Backend Wrapper │◄──────►│ Vendor Layer │
│  React Flow  │  JSON-RPC    │  C++ / uWS       │        │ NCNN / Stub  │
└──────────────┘              └──────────────────┘        └──────────────┘
```

**三层解耦:**
- **Frontend** — React + React Flow + Zustand，节点图编辑器
- **Backend Wrapper** — C++ WebSocket 服务，能力注册、工作流调度、调试控制
- **Vendor Layer** — `InferenceEngine` 纯虚基类，NCNN 为第一个实现，编译时可选

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

这会：
1. 构建 C++ 后端（使用 Stub 推理引擎）
2. 安装前端依赖并构建
3. 启动后端（默认端口 9090）+ 前端开发服务器（端口 5173）
4. 打开浏览器访问 http://localhost:5173

### 启用 NCNN 真实推理

```bash
./setup.sh --ncnn
```

会自动从源码编译 ncnn（CPU only，约 2 分钟），然后构建后端时链接 ncnn。

### 其他命令

```bash
# 仅启动（需已构建）
./setup.sh --dev

# 运行 E2E 测试
./setup.sh --test

# 自定义后端端口
BACKEND_PORT=8080 ./setup.sh

# 查看帮助
./setup.sh --help
```

## 手动构建

如果不使用 `setup.sh`，可以手动操作：

### 后端

```bash
cd backend

# Stub 模式
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

# NCNN 模式（需要先编译安装 ncnn）
cmake -S . -B build -DENABLE_NCNN=ON -Dncnn_DIR=/path/to/ncnn/lib/cmake/ncnn
cmake --build build -j$(nproc)

# 启动（默认端口 9090，可传参指定）
./build/workflow_backend 9090
```

### 前端

```bash
cd frontend
npm install
npm run dev          # 开发模式
npm run build        # 生产构建
```

前端默认连接 `ws://localhost:9090`，可通过环境变量覆盖：

```bash
VITE_WS_URL=ws://localhost:8080 npm run dev
```

### Tauri 桌面应用

```bash
cd frontend
npm run tauri dev     # 开发模式
npm run tauri build   # 打包
```

Tauri 层会自动启动/停止 C++ 后端进程。

## 节点类型

| 节点 | 类别 | 说明 |
|------|------|------|
| Input Image | input | 加载图片文件 |
| Input Tensor | input | 手动输入张量数据 |
| Create Net | inference | 加载模型（.param + .bin） |
| Inference | inference | 执行推理 |
| Benchmark | inference | 性能基准测试 |
| Save Text | output | 保存文本结果 |
| Save Image | output | 保存图片结果 |
| Output | output | 显示输出数据 |
| Condition | control | 条件分支 |
| Debug | debug | 断点 / 数据检查 |

## 调试系统

- 在 Debug 节点上设置断点
- 工作流执行到断点时暂停，可检查当前节点的输入/输出数据
- 支持 Continue（继续）和 Step Over（单步跳过）

## 测试

### E2E 测试（Playwright）

```bash
cd frontend
npm run test:e2e           # 无头模式
npm run test:e2e:headed    # 有头模式（可观察浏览器）
```

E2E 测试使用 mock WebSocket 后端（`e2e/mock-backend.mjs`），无需启动真实后端。

### 集成测试（NCNN）

`backend/test_models/` 目录包含最小测试模型（单层 InnerProduct + Softmax），用于验证 NCNN 推理链路。

## 项目结构

```
workflowUI/
├── setup.sh                    # 一键构建 & 启动脚本
├── backend/
│   ├── CMakeLists.txt          # C++ 构建配置
│   ├── src/
│   │   ├── main.cpp            # 入口，RPC 路由，引擎初始化
│   │   ├── server/             # WebSocket 服务 + JSON-RPC
│   │   ├── capability/         # 能力注册（告知前端可用操作）
│   │   ├── workflow/           # 执行器、调度器、调试控制器
│   │   ├── model/              # 节点、边、工作流图数据模型
│   │   └── vendor/             # 推理引擎抽象层
│   │       ├── inference_engine.h   # InferenceEngine 虚基类
│   │       └── ncnn/                # NCNN 实现
│   └── test_models/            # 最小 NCNN 测试模型
├── frontend/
│   ├── src/
│   │   ├── App.tsx             # 主界面（React Flow 画布）
│   │   ├── nodes/              # 10 种自定义节点组件
│   │   ├── panels/             # 工具栏、属性面板、调试面板
│   │   ├── transport/          # WebSocket JSON-RPC 客户端
│   │   ├── engine/             # WorkflowRunner（前端执行协调）
│   │   └── store/              # Zustand 状态管理
│   ├── e2e/                    # Playwright E2E 测试
│   │   ├── mock-backend.mjs    # Mock WebSocket 后端
│   │   └── workflow.spec.ts    # 测试套件（13 个测试）
│   ├── src-tauri/              # Tauri 桌面应用配置
│   └── playwright.config.ts
└── test_integration.mjs        # Node.js WebSocket 集成测试
```

## 技术栈

- **前端:** React 19, React Flow, Zustand, Vite, TypeScript
- **后端:** C++17, uWebSockets, nlohmann/json, CMake
- **桌面:** Tauri v2 (Rust)
- **推理:** NCNN (可选)
- **测试:** Playwright
- **通信:** WebSocket + JSON-RPC 2.0
