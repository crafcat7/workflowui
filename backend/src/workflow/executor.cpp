// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "executor.h"
#include "handlers/core_handlers.h"
#include <algorithm>
#include <stdexcept>

namespace workflow {

namespace {

// Upper bound on how many floats we inline in a tensor preview sent over
// the pause payload; long feature maps would otherwise flood the ws.
constexpr size_t kPortPreviewValues = 16;

// Render a PortValue as a compact JSON summary for the debug inspector:
// always a {type, ...} object where the extra fields depend on the
// variant so the frontend can render meaningful info without shipping
// the entire tensor/image payload.
json summarize_port_value(const PortValue& v) {
    json out;
    if (std::holds_alternative<std::monostate>(v)) {
        out["type"] = "empty";
        return out;
    }
    if (auto* s = std::get_if<std::string>(&v)) {
        out["type"] = "string";
        out["value"] = *s;
        return out;
    }
    if (auto* f = std::get_if<float>(&v)) {
        out["type"] = "float";
        out["value"] = *f;
        return out;
    }
    if (auto* t = std::get_if<TensorData>(&v)) {
        out["type"] = "tensor";
        out["length"] = t->size();
        const size_t n = std::min<size_t>(t->size(), kPortPreviewValues);
        json preview = json::array();
        for (size_t i = 0; i < n; ++i) preview.push_back((*t)[i]);
        out["preview"] = std::move(preview);
        return out;
    }
    if (auto* img = std::get_if<ImageData>(&v)) {
        out["type"] = "image";
        out["width"] = img->width;
        out["height"] = img->height;
        out["channels"] = img->channels;
        out["bytes"] = img->pixels.size();
        return out;
    }
    if (auto* h = std::get_if<int64_t>(&v)) {
        out["type"] = "handle";
        out["value"] = *h;
        return out;
    }
    out["type"] = "unknown";
    return out;
}

// Destroy every net handle currently held in `port_data_` and erase those
// entries. `int64_t` variant slot is reserved for `NetHandle` per
// `model/node.h`, so a type-based sweep is sufficient and doesn't need a
// separate tracking list.
void release_net_handles(InferenceEngine& engine,
                         std::unordered_map<std::string, PortValue>& port_data) {
    for (auto it = port_data.begin(); it != port_data.end(); ) {
        if (auto* handle = std::get_if<int64_t>(&it->second)) {
            engine.destroy_net(*handle);
            it = port_data.erase(it);
        } else {
            ++it;
        }
    }
}

} // namespace

Executor::Executor(std::shared_ptr<InferenceEngine> engine)
    : engine_(std::move(engine)) {
    register_handlers();
}

Executor::~Executor() {
    if (engine_) {
        release_net_handles(*engine_, port_data_);
    }
}

void Executor::register_handlers() {
    handlers::register_core_handlers(handlers_);
}

void Executor::execute(const WorkflowGraph& graph) {
    debug_.reset();
    // Release nets created by the previous run before we drop the port
    // map; without this, `init_net` handles leak for the whole process
    // lifetime (inference_engine.h:89 `destroy_net` had no callers).
    if (engine_) {
        release_net_handles(*engine_, port_data_);
    }
    port_data_.clear();
    dead_ports_.clear();

    auto order = scheduler_.schedule(graph);

    for (auto& node_id : order) {
        if (debug_.is_stopped()) break;

        auto* node = graph.get_node(node_id);
        if (!node) continue;

        // Branch pruning: if every incoming edge's source port is dead,
        // this node was only reachable through an un-taken Condition
        // branch. Mark all of its outgoing edges' source ports dead so
        // the skip propagates, notify the frontend, and move on.
        if (should_skip(node_id, graph)) {
            for (const auto& e : graph.edges()) {
                if (e.source == node_id) {
                    dead_ports_.insert(node_id + ":" + e.source_handle);
                }
            }
            json extra;
            extra["reason"] = "branch_pruned";
            notify_status(node_id, "skipped", extra);
            continue;
        }

        // Pause before executing this node if it has a breakpoint set, or
        // if we are stepping.
        if (debug_.should_pause(node_id)) {
            json data;
            data["node_id"] = node_id;
            data["type"] = node->type;
            // Snapshot inbound port values so the frontend can show the
            // user what this node is about to consume. We group by target
            // handle and skip duplicates when multiple edges feed the
            // same handle (only the first wins, matching resolve_input).
            json inputs = json::array();
            std::unordered_set<std::string> seen;
            for (auto* edge : graph.inputs_for(node_id)) {
                if (!seen.insert(edge->target_handle).second) continue;
                PortValue v = resolve_input(node_id, edge->target_handle, graph);
                json entry;
                entry["handle"] = edge->target_handle;
                entry["source"] = edge->source + ":" + edge->source_handle;
                entry["value"] = summarize_port_value(v);
                inputs.push_back(std::move(entry));
            }
            data["inputs"] = std::move(inputs);
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

void Executor::mark_dead_output(const std::string& node_id, const std::string& port_name) {
    dead_ports_.insert(node_id + ":" + port_name);
}

bool Executor::should_skip(const std::string& node_id, const WorkflowGraph& graph) const {
    auto inputs = graph.inputs_for(node_id);
    // Source nodes (no inputs) always run; branch pruning only applies to
    // nodes that depend on some upstream output.
    if (inputs.empty()) return false;
    for (auto* edge : inputs) {
        std::string key = edge->source + ":" + edge->source_handle;
        if (dead_ports_.count(key) == 0) {
            // At least one input port is still alive — this node has data
            // to work with, so don't skip.
            return false;
        }
    }
    return true;
}

void Executor::notify_status(const std::string& node_id, const std::string& status,
                             const json& extra) {
    if (!status_cb_) return;
    json msg;
    msg["node_id"] = node_id;
    msg["status"] = status;
    for (auto& [k, v] : extra.items()) {
        msg[k] = v;
    }
    status_cb_(node_id, msg);
}

} // namespace workflow
