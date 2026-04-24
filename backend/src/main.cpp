// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "server/ws_server.h"
#include "server/rpc_handler.h"
#include "server/security_config.h"
#include "workflow/executor.h"
#include "model/workflow_graph.h"
#include "vendor/inference_engine.h"

#ifdef ENABLE_NCNN
#include "vendor/ncnn/ncnn_engine.h"
#endif

#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include <nlohmann/json.hpp>

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <execinfo.h>

// Async-signal-safe-ish crash reporter. WSL swallows core dumps and gdb is
// not installed in our dev container, so we self-print a backtrace on fatal
// signals. Uses backtrace()/backtrace_symbols_fd(); symbols require the
// binary to be linked with -rdynamic (added in CMake below).
namespace {
void crash_handler(int sig) {
    void* frames[64];
    int n = backtrace(frames, 64);
    const char* name = strsignal(sig);
    // Write(2) is signal-safe; iostreams are not.
    char hdr[128];
    int hl = std::snprintf(hdr, sizeof(hdr), "\n[CRASH] signal %d (%s), backtrace (%d frames):\n",
                           sig, name ? name : "?", n);
    if (hl > 0) (void)!write(STDERR_FILENO, hdr, static_cast<size_t>(hl));
    backtrace_symbols_fd(frames, n, STDERR_FILENO);
    std::signal(sig, SIG_DFL);
    std::raise(sig);
}

void install_crash_handlers() {
    for (int s : {SIGSEGV, SIGABRT, SIGBUS, SIGFPE, SIGILL}) {
        std::signal(s, crash_handler);
    }
}
}  // namespace

using namespace workflow;
using json = nlohmann::json;

// Stub engine for when no vendor is compiled in
class StubEngine : public InferenceEngine {
public:
    std::string name() const override { return "stub"; }
    std::vector<ConfigFieldSchema> config_schema() const override {
        return {
            {"modelPath", "Model Path", "string", "MODEL", "model file", "", {}},
        };
    }
    NetHandle init_net(const NetConfig&) override {
        return 1;
    }
    void configure(NetHandle, const NetConfig&) override {}
    InferResult execute(NetHandle, const TensorData& input) override {
        // Echo input as output with 1ms fake latency
        return InferResult{input, std::chrono::milliseconds(1)};
    }
    BenchmarkResult benchmark(NetHandle, const TensorData&, int) override {
        return BenchmarkResult{1000, 1.0, 0.5, 1.5};
    }
    void destroy_net(NetHandle) override {}
};

int main(int argc, char* argv[]) {
    install_crash_handlers();
    // Force unbuffered stdout/stderr so parent processes (Playwright spawn,
    // CI log tailing, supervisord) see the "[WS] Server listening …" banner
    // the instant it is emitted rather than when the glibc 4 KiB pipe buffer
    // happens to fill. Without this, piping stdout to anything other than a
    // tty deadlocks startup detection.
    std::cout << std::unitbuf;
    std::cerr << std::unitbuf;
    // ── CLI parsing ──
    // Accepts a legacy positional port (`./backend 9091`) for back-compat
    // plus long flags for the security knobs. Kept deliberately minimal;
    // anything more elaborate deserves a real parser.
    int port = 9090;
    std::string shared_dir;
    std::vector<std::string> allow_origins;
    bool origin_flag_seen = false;

    auto print_help = []() {
        std::cout <<
            "Usage: workflow_backend [PORT] [options]\n"
            "  --port <n>             Listen port (default 9090)\n"
            "  --shared-dir <path>    Sandbox filesystem access to this directory\n"
            "  --allow-origin <url>   Add allowed WS Origin (repeatable).\n"
            "                         Defaults to localhost + tauri://localhost.\n"
            "  -h, --help             Show this help and exit\n";
    };

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--port") {
            if (i + 1 >= argc) { std::cerr << "--port requires a value\n"; return 1; }
            port = std::atoi(argv[++i]);
        } else if (arg == "--shared-dir") {
            if (i + 1 >= argc) { std::cerr << "--shared-dir requires a value\n"; return 1; }
            shared_dir = argv[++i];
        } else if (arg == "--allow-origin") {
            if (i + 1 >= argc) { std::cerr << "--allow-origin requires a value\n"; return 1; }
            allow_origins.emplace_back(argv[++i]);
            origin_flag_seen = true;
        } else if (arg == "-h" || arg == "--help") {
            print_help();
            return 0;
        } else if (!arg.empty() && arg[0] != '-') {
            // Legacy positional port.
            port = std::atoi(arg.c_str());
        } else {
            std::cerr << "Unknown option: " << arg << "\n";
            print_help();
            return 1;
        }
    }

    // ── Security config ──
    auto& sec = SecurityConfig::instance();
    if (!shared_dir.empty()) {
        sec.set_shared_dir(shared_dir);
        std::cout << "[Backend] Sandbox shared dir: " << *sec.shared_dir() << "\n";
    }
    if (origin_flag_seen) {
        for (const auto& o : allow_origins) sec.add_allowed_origin(o);
    } else {
        // Sensible defaults: Vite dev server, Tauri shell, Tauri default port.
        for (const char* o : {
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "tauri://localhost",
        }) sec.add_allowed_origin(o);
    }
    std::cout << "[Backend] Allowed origins: "
              << (sec.has_origin_allowlist() ? "configured" : "ANY") << "\n";


    // ── Initialize engine ──
    std::shared_ptr<InferenceEngine> engine;
#ifdef ENABLE_NCNN
    engine = std::make_shared<NcnnEngine>();
    std::cout << "[Backend] Using NCNN engine\n";
#else
    engine = std::make_shared<StubEngine>();
    std::cout << "[Backend] Using stub engine (NCNN not enabled)\n";
#endif

    // ── Executor ──
    auto executor = std::make_shared<Executor>(engine);

    // ── RPC Handler ──
    RpcHandler rpc;

    rpc.register_method("vendor.getConfigSchema", [&](const json&) -> json {
        json result;
        result["vendor"] = engine->name();
        json fields = json::array();
        for (const auto& f : engine->config_schema()) {
            fields.push_back(f.to_json());
        }
        result["fields"] = fields;
        return result;
    });

    // Catalog of every node type this backend can execute, with ports.
    // Frontends can call this at startup to cross-check their manifest
    // against the server they're talking to and warn on drift.
    rpc.register_method("nodes.list", [&](const json&) -> json {
        return {{"nodes", executor->describe_nodes()}};
    });

    rpc.register_method("workflow.execute", [&](const json& params) -> json {
        WorkflowGraph graph;

        for (auto& jn : params["nodes"]) {
            NodeDef node;
            node.id = jn["id"];
            node.type = jn["type"];
            if (jn.contains("config")) {
                for (auto& [k, v] : jn["config"].items()) {
                    node.config[k] = v.is_string() ? v.get<std::string>() : v.dump();
                }
            }
            graph.add_node(node);
        }

        for (auto& je : params["edges"]) {
            EdgeDef edge;
            edge.source = je["source"];
            edge.source_handle = je.value("sourceHandle", "");
            edge.target = je["target"];
            edge.target_handle = je.value("targetHandle", "");
            graph.add_edge(edge);
        }

        // Seed breakpoints for this run. Replacing the set atomically keeps
        // behavior predictable: whatever the frontend sends is the truth for
        // this execution, and later debug.add_breakpoint/remove_breakpoint
        // RPCs layer on top while paused.
        std::vector<std::string> breakpoints;
        if (params.contains("breakpoints") && params["breakpoints"].is_array()) {
            for (auto& bp : params["breakpoints"]) {
                if (bp.is_string()) breakpoints.push_back(bp.get<std::string>());
            }
        }
        executor->debug_controller().set_breakpoints(breakpoints);

        // Execute in background thread
        std::thread([executor, graph = std::move(graph)]() mutable {
            executor->execute(graph);
        }).detach();

        return {{"status", "started"}};
    });

    rpc.register_notify("workflow.stop", [&](const json&) {
        executor->stop();
    });

    rpc.register_notify("debug.continue", [&](const json&) {
        executor->debug_controller().resume();
    });

    rpc.register_notify("debug.step_over", [&](const json&) {
        executor->debug_controller().step_over();
    });

    rpc.register_method("debug.add_breakpoint", [&](const json& params) -> json {
        executor->debug_controller().add_breakpoint(params["node_id"]);
        return {{"ok", true}};
    });

    rpc.register_method("debug.remove_breakpoint", [&](const json& params) -> json {
        executor->debug_controller().remove_breakpoint(params["node_id"]);
        return {{"ok", true}};
    });

    // ── WebSocket Server ──
    WsServer server(port, rpc);

    // Wire executor callbacks to broadcast via WS
    executor->set_status_callback([&server](const std::string& node_id, const json& data) {
        if (node_id == "__workflow__") {
            server.broadcast("workflow.complete", data);
        } else {
            server.broadcast("node.status", data);
        }
    });

    executor->set_pause_callback([&server](const std::string& node_id, const json& data) {
        server.broadcast("debug.paused", data);
    });

    std::cout << "[Backend] Starting WebSocket server on port " << port << "\n";
    server.run();

    return 0;
}
