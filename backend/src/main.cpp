// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "server/ws_server.h"
#include "server/rpc_handler.h"
#include "server/rpc_errors.h"
#include "server/security_config.h"
#include "workflow/executor.h"
#include "workflow/run_session.h"
#include "model/workflow_graph.h"
#include "vendor/inference_engine.h"

#ifdef ENABLE_NCNN
#include "vendor/ncnn/ncnn_engine.h"
#endif

#include <iostream>
#include <memory>
#include <string>
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

    // Owns the worker thread that drives a running workflow. Replaces
    // the previous detached-thread approach so the thread is guaranteed
    // to be joined on shutdown, before the executor (and its engine
    // handles) are destroyed.
    RunSession run_session(executor);

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
        // Defense-in-depth: reject malformed payloads at the RPC boundary so
        // the executor only sees well-formed graphs. Without this, a missing
        // `nodes`/`edges` array surfaces as a generic -32000 std::exception
        // and clients can't distinguish caller bugs from server bugs.
        if (!params.is_object()) {
            throw InvalidParams("params must be an object");
        }
        if (!params.contains("nodes") || !params["nodes"].is_array()) {
            throw InvalidParams("params.nodes must be an array");
        }
        if (!params.contains("edges") || !params["edges"].is_array()) {
            throw InvalidParams("params.edges must be an array");
        }

        WorkflowGraph graph;

        for (auto& jn : params["nodes"]) {
            if (!jn.is_object()) {
                throw InvalidParams("params.nodes[*] must be an object");
            }
            if (!jn.contains("id") || !jn["id"].is_string() || jn["id"].get<std::string>().empty()) {
                throw InvalidParams("params.nodes[*].id must be a non-empty string");
            }
            if (!jn.contains("type") || !jn["type"].is_string() || jn["type"].get<std::string>().empty()) {
                throw InvalidParams("params.nodes[*].type must be a non-empty string");
            }
            NodeDef node;
            node.id = jn["id"];
            node.type = jn["type"];
            if (jn.contains("config")) {
                if (!jn["config"].is_object()) {
                    throw InvalidParams("params.nodes[*].config must be an object");
                }
                for (auto& [k, v] : jn["config"].items()) {
                    node.config[k] = v.is_string() ? v.get<std::string>() : v.dump();
                }
            }
            graph.add_node(node);
        }

        for (auto& je : params["edges"]) {
            if (!je.is_object()) {
                throw InvalidParams("params.edges[*] must be an object");
            }
            if (!je.contains("source") || !je["source"].is_string()) {
                throw InvalidParams("params.edges[*].source must be a string");
            }
            if (!je.contains("target") || !je["target"].is_string()) {
                throw InvalidParams("params.edges[*].target must be a string");
            }
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
        if (params.contains("breakpoints")) {
            if (!params["breakpoints"].is_array()) {
                throw InvalidParams("params.breakpoints must be an array if present");
            }
            for (auto& bp : params["breakpoints"]) {
                if (bp.is_string()) breakpoints.push_back(bp.get<std::string>());
            }
        }
        executor->debug_controller().set_breakpoints(breakpoints);

        // Hand off to the session: it stops+joins any previous run
        // before launching the new worker, giving this RPC a
        // well-defined "start now" semantic even under rapid
        // back-to-back invocations. The returned run_id is echoed
        // back to the client so it can tag subsequent events and
        // correlate a later workflow.cancel.
        std::string run_id = run_session.start(std::move(graph));

        return {{"status", "started"}, {"run_id", run_id}};
    });

    rpc.register_notify("workflow.stop", [&](const json&) {
        executor->stop();
    });

    // Explicit cancel verb: semantically identical to workflow.stop
    // today but returns the run_id that was interrupted so a client
    // can confirm which run it just cancelled (important when the
    // user double-taps cancel during back-to-back runs). Mid-node
    // preemption is still not implemented — the cancel is observed
    // at the next node boundary.
    rpc.register_method("workflow.cancel", [&](const json&) -> json {
        std::string run_id = run_session.current_run_id();
        executor->stop();
        return {{"cancelled", true}, {"run_id", run_id}};
    });

    // Snapshot of executor state for reconnect reconciliation. A
    // client that missed events while the WebSocket was down calls
    // this right after re-opening to merge per-node statuses back
    // into its canvas; without it, nodes that finished mid-outage
    // would stay stuck on `running` forever. Cheap — just copies
    // a small map under a mutex.
    rpc.register_method("workflow.state", [&](const json&) -> json {
        return executor->snapshot_state();
    });

    rpc.register_notify("debug.continue", [&](const json&) {
        executor->debug_controller().resume();
    });

    rpc.register_notify("debug.step_over", [&](const json&) {
        executor->debug_controller().step_over();
    });

    rpc.register_method("debug.add_breakpoint", [&](const json& params) -> json {
        if (!params.is_object() || !params.contains("node_id") ||
            !params["node_id"].is_string() || params["node_id"].get<std::string>().empty()) {
            throw InvalidParams("params.node_id must be a non-empty string");
        }
        executor->debug_controller().add_breakpoint(params["node_id"]);
        return {{"ok", true}};
    });

    rpc.register_method("debug.remove_breakpoint", [&](const json& params) -> json {
        if (!params.is_object() || !params.contains("node_id") ||
            !params["node_id"].is_string() || params["node_id"].get<std::string>().empty()) {
            throw InvalidParams("params.node_id must be a non-empty string");
        }
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

    // `server.run()` typically blocks forever; if it ever returns (the
    // embedded ws server's run-loop being interrupted, e.g. by a future
    // signal-aware stop() hook) we still want a graceful teardown:
    // stop the current workflow, join the worker, THEN let the
    // executor's destructor release net handles.
    run_session.shutdown();
    return 0;
}
