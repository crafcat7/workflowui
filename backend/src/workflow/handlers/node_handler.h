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
#include <vector>

namespace workflow {

using json = nlohmann::json;

/**
 * Port direction and data type, mirrored from the frontend manifest
 * (see `frontend/src/nodes/manifest.ts` / `portSchema.ts`). Values are
 * exchanged as strings in the `nodes.list` RPC so frontend and backend
 * can be cross-checked without a shared code generator.
 */
struct HandlerPortDef {
    std::string id;
    std::string direction;   // "source" or "target"
    std::string data_type;   // "image" | "tensor" | "net" | "branch" | "generic"
};

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
 * Interface for node-specific execution logic *and* self-describing
 * metadata. Every handler must report its type/label/category/ports
 * so the backend can expose the full node catalog via `nodes.list`
 * without a second registry to keep in sync.
 */
class NodeHandler {
public:
    virtual ~NodeHandler() = default;

    // --- Identity & metadata ---------------------------------------------

    // Unique type id, e.g. "inputImage". Must match the frontend manifest.
    virtual std::string type() const = 0;

    // Human-readable label shown in UI, e.g. "Input Image".
    virtual std::string label() const = 0;

    // Category for UI grouping. One of:
    //   "input" | "inference" | "output" | "control" | "debug"
    virtual std::string category() const = 0;

    // Ports exposed by this node type. Empty vector is legal (e.g. a
    // pure source that writes through a single port might still list it;
    // handlers that take no typed inputs should return an empty vector).
    virtual std::vector<HandlerPortDef> port_defs() const = 0;

    // --- Execution -------------------------------------------------------

    // Execute the node's logic. Returns a JSON object with extra data to send to frontend.
    virtual json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) = 0;
};

} // namespace workflow
