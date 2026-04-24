// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "../../model/node.h"
#include "../../model/workflow_graph.h"
#include "../../vendor/inference_engine.h"
#include <nlohmann/json.hpp>
#include <unordered_map>
#include <memory>
#include <string>

namespace workflow {

using json = nlohmann::json;

/**
 * Context provided to each node handler during execution.
 */
class ExecutionContext {
public:
    virtual ~ExecutionContext() = default;

    // Get input value from an incoming edge
    virtual PortValue resolve_input(const std::string& node_id, const std::string& handle, const WorkflowGraph& graph) = 0;

    // Set output value for this node's port
    virtual void set_output(const std::string& node_id, const std::string& port_name, PortValue value) = 0;

    // Mark an output port as "dead" — downstream consumers reachable only
    // through this port will be skipped by the executor. Used by the
    // Condition node to prune the un-taken branch.
    virtual void mark_dead_output(const std::string& node_id, const std::string& port_name) = 0;

    // Access to the inference engine
    virtual std::shared_ptr<InferenceEngine> engine() = 0;
};

/**
 * Interface for node-specific execution logic.
 */
class NodeHandler {
public:
    virtual ~NodeHandler() = default;

    // Return the node type string (e.g. "inputImage", "inference")
    virtual std::string type() const = 0;

    // Execute the node's logic. Returns a JSON object with extra data to send to frontend.
    virtual json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) = 0;
};

} // namespace workflow
