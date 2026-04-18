#include "executor.h"
#include "handlers/core_handlers.h"
#include <chrono>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <iostream>

namespace workflow {

Executor::Executor(std::shared_ptr<InferenceEngine> engine)
    : engine_(std::move(engine)) {
    register_handlers();
}

void Executor::register_handlers() {
    handlers::register_core_handlers(handlers_);
}

void Executor::execute(const WorkflowGraph& graph) {
    debug_.reset();
    port_data_.clear();

    auto order = scheduler_.schedule(graph);

    for (auto& node_id : order) {
        if (debug_.is_stopped()) break;

        auto* node = graph.get_node(node_id);
        if (!node) continue;

        // Check for breakpoint / debug node
        bool is_debug = (node->type == "debug");
        if (is_debug || debug_.should_pause(node_id)) {
            // Notify frontend we're paused
            json data;
            data["node_id"] = node_id;
            data["type"] = node->type;
            if (pause_cb_) pause_cb_(node_id, data);

            debug_.wait_for_resume();
            if (debug_.is_stopped()) break;
        }

        notify_status(node_id, "running");

        try {
            auto it = handlers_.find(node->type);
            if (it == handlers_.end()) {
                throw std::runtime_error("Unknown node type: " + node->type);
            }
            json extra = it->second->execute(*node, graph, *this);
            notify_status(node_id, "done", extra);
        } catch (const std::exception& e) {
            json err;
            err["error"] = e.what();
            notify_status(node_id, "error", err);
        }
    }

    // Notify completion
    if (status_cb_) {
        json complete;
        complete["status"] = "complete";
        status_cb_("__workflow__", complete);
    }
}

void Executor::stop() {
    debug_.stop();
}

PortValue Executor::resolve_input(const std::string& node_id, const std::string& handle,
                                   const WorkflowGraph& graph) {
    auto edges = graph.inputs_for(node_id);
    for (auto* edge : edges) {
        if (edge->target_handle == handle) {
            std::string key = edge->source + ":" + edge->source_handle;
            auto it = port_data_.find(key);
            if (it != port_data_.end()) return it->second;
        }
    }
    return std::monostate{};
}

void Executor::set_output(const std::string& node_id, const std::string& port_name, PortValue value) {
    port_data_[node_id + ":" + port_name] = std::move(value);
}

void Executor::notify_status(const std::string& node_id, const std::string& status,
                             const json& extra) {
    if (!status_cb_) return;
    json msg;
    msg["node_id"] = node_id;
    msg["status"] = status;
    if (!extra.empty()) {
        for (auto& [k, v] : extra.items()) {
            msg[k] = v;
        }
    }
    status_cb_(node_id, msg);
}

} // namespace workflow
