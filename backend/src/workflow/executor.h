// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "../model/workflow_graph.h"
#include "../model/node.h"
#include "../vendor/inference_engine.h"
#include "scheduler.h"
#include "debug_controller.h"
#include "handlers/node_handler.h"
#include <functional>
#include <unordered_map>
#include <unordered_set>
#include <memory>
#include <nlohmann/json.hpp>

namespace workflow {

using json = nlohmann::json;

// Callback to send status updates to frontend
using StatusCallback = std::function<void(const std::string& node_id, const json& status)>;
// Callback to notify debug pause
using PauseCallback = std::function<void(const std::string& node_id, const json& data)>;

/**
 * Executes a workflow graph node-by-node in topological order.
 */
class Executor : public ExecutionContext {
public:
    explicit Executor(std::shared_ptr<InferenceEngine> engine);

    void set_status_callback(StatusCallback cb) { status_cb_ = std::move(cb); }
    void set_pause_callback(PauseCallback cb) { pause_cb_ = std::move(cb); }

    DebugController& debug_controller() { return debug_; }

    // Execute the full workflow. Blocks until complete or stopped.
    void execute(const WorkflowGraph& graph);

    // Stop current execution
    void stop();

    // ExecutionContext implementation
    PortValue resolve_input(const std::string& node_id, const std::string& handle, const WorkflowGraph& graph) override;
    void set_output(const std::string& node_id, const std::string& port_name, PortValue value) override;
    void mark_dead_output(const std::string& node_id, const std::string& port_name) override;
    std::shared_ptr<InferenceEngine> engine() override { return engine_; }

private:
    void notify_status(const std::string& node_id, const std::string& status, const json& extra = {});
    void register_handlers();

    // Returns true if `node` has at least one input edge AND every input
    // edge's source port is dead; such a node is pruned (its outputs are
    // also marked dead, propagating the skip forward).
    bool should_skip(const std::string& node_id, const WorkflowGraph& graph) const;

    std::shared_ptr<InferenceEngine> engine_;
    Scheduler scheduler_;
    DebugController debug_;

    StatusCallback status_cb_;
    PauseCallback pause_cb_;

    // Runtime data store: node_id:port_id -> value
    std::unordered_map<std::string, PortValue> port_data_;

    // Output ports that are "dead" (produced no value because the node was
    // skipped, or explicitly pruned by a Condition node). Keys are
    // "node_id:port_name" exactly like port_data_.
    std::unordered_set<std::string> dead_ports_;

    // Registry of node handlers
    std::unordered_map<std::string, std::shared_ptr<NodeHandler>> handlers_;
};

} // namespace workflow
