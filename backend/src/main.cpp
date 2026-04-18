#include "server/ws_server.h"
#include "server/rpc_handler.h"
#include "capability/registry.h"
#include "workflow/executor.h"
#include "model/workflow_graph.h"
#include "vendor/inference_engine.h"

#ifdef ENABLE_NCNN
#include "vendor/ncnn/ncnn_engine.h"
#endif

#include <iostream>
#include <memory>
#include <thread>
#include <nlohmann/json.hpp>

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
        std::cout << "[Stub] init_net called\n";
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
    int port = 9090;
    if (argc > 1) {
        port = std::atoi(argv[1]);
    }

    // ── Initialize engine ──
    std::shared_ptr<InferenceEngine> engine;
#ifdef ENABLE_NCNN
    engine = std::make_shared<NcnnEngine>();
    std::cout << "[Backend] Using NCNN engine\n";
#else
    engine = std::make_shared<StubEngine>();
    std::cout << "[Backend] Using stub engine (NCNN not enabled)\n";
#endif

    // ── Capability registry ──
    CapabilityRegistry capabilities;
    capabilities.register_vendor(engine->name());
    capabilities.register_operation({"init_net", {"model_path", "config"}, {"net_handle"}, "Initialize neural network"});
    capabilities.register_operation({"execute", {"net_handle", "input_data"}, {"output_data"}, "Run inference"});
    capabilities.register_operation({"benchmark", {"net_handle", "input_data", "duration_sec"}, {"runs", "avg_ms"}, "Benchmark inference"});
    capabilities.register_operation({"read_image", {"file_path"}, {"image_data"}, "Read image file"});
    capabilities.register_operation({"read_tensor", {}, {"tensor_data"}, "Read tensor from text"});
    capabilities.register_operation({"save_file", {"data", "file_path"}, {}, "Save data to file"});
    capabilities.register_operation({"condition", {"input_data", "expression"}, {"true_branch", "false_branch"}, "Conditional branch"});
    capabilities.register_operation({"postprocess", {"input_data", "op", "iouThreshold", "k"}, {"output_data"}, "Postprocess outputs"});

    // ── Executor ──
    auto executor = std::make_shared<Executor>(engine);

    // ── RPC Handler ──
    RpcHandler rpc;

    rpc.register_method("capabilities", [&](const json&) -> json {
        return capabilities.to_json();
    });

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
