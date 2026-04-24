// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "executor.h"
#include "handlers/core_handlers.h"
#include "node_error.h"
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

json Executor::describe_nodes() const {
    // The list order follows whatever hash-map iteration produces, which
    // is good enough for a diagnostic RPC; frontends sort by `type` if
    // they need stability. Kept sorted here so snapshot tests are
    // deterministic.
    std::vector<std::string> types;
    types.reserve(handlers_.size());
    for (const auto& [t, _] : handlers_) types.push_back(t);
    std::sort(types.begin(), types.end());

    json out = json::array();
    for (const auto& t : types) {
        const auto& h = handlers_.at(t);
        json entry;
        entry["type"]     = h->type();
        entry["label"]    = h->label();
        entry["category"] = h->category();
        json ports = json::array();
        for (const auto& p : h->port_defs()) {
            ports.push_back({
                {"id", p.id},
                {"direction", p.direction},
                {"dataType", p.data_type},
            });
        }
        entry["ports"] = std::move(ports);
        out.push_back(std::move(entry));
    }
    return out;
}

void Executor::execute(const WorkflowGraph& graph, std::string run_id) {
    {
        std::lock_guard<std::mutex> lk(state_mutex_);
        current_run_id_ = std::move(run_id);
        // Per-run snapshot: clear stale per-node statuses from whatever
        // executed before. `paused_at_` is always empty at this point
        // (prior execute() would have joined by now), but reset defensively.
        node_statuses_.clear();
        paused_at_.clear();
    }
    debug_.reset();
    // Release nets created by the previous run before we drop the port
    // map; without this, `init_net` handles leak for the whole process
    // lifetime (inference_engine.h:89 `destroy_net` had no callers).
    if (engine_) {
        release_net_handles(*engine_, port_data_);
    }
    port_data_.clear();
    dead_ports_.clear();
    failed_nodes_.clear();

    // Fail fast on structurally broken graphs. Without this, unknown node
    // types surface as "Unknown node type" per-node errors (still correct,
    // but one per node), and mismatched/unknown ports only manifest as
    // silent "Missing input" downstream. `validate_graph` emits a single
    // `__workflow__`/`validation_failed` event with every problem attached
    // and skips the run entirely.
    if (!validate_graph(graph)) {
        if (status_cb_) {
            json complete;
            complete["status"] = "complete";
            status_cb_("__workflow__", complete);
        }
        return;
    }

    // Topological order is the only schedule we need — inputs are
    // fully resolved from previous iterations by the time a node is
    // visited, so a single linear pass suffices. Pulled inline from
    // the old `Scheduler` class, which was a one-line forwarder.
    auto order = graph.topological_sort();

    for (auto& node_id : order) {
        if (debug_.is_stopped()) break;

        auto* node = graph.get_node(node_id);
        if (!node) continue;

        // Branch pruning / upstream-failure propagation: if every incoming
        // edge's source port is dead, this node is unreachable. Determine
        // *why* (un-taken Condition branch vs. upstream handler failure)
        // so the frontend can distinguish intentional pruning from error
        // propagation, mark all of its outgoing edges' source ports dead
        // so the skip keeps propagating, notify the frontend, and move on.
        if (should_skip(node_id, graph)) {
            std::string upstream_cause;
            for (auto* edge : graph.inputs_for(node_id)) {
                if (failed_nodes_.count(edge->source)) {
                    upstream_cause = edge->source;
                    break;
                }
            }
            for (const auto& e : graph.edges()) {
                if (e.source == node_id) {
                    dead_ports_.insert(node_id + ":" + e.source_handle);
                }
            }
            json extra;
            if (!upstream_cause.empty()) {
                extra["reason"] = "upstream_failed";
                extra["upstream"] = upstream_cause;
                // Inherit-mark this node as failed too so skip cascades
                // downstream are attributed correctly.
                failed_nodes_[node_id] = {"upstream_failed",
                    "Upstream node '" + upstream_cause + "' failed"};
            } else {
                extra["reason"] = "branch_pruned";
            }
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
            // Stamp the pause event with the run id for the same reason
            // notify_status does: a client that cancelled this run must
            // be able to drop the paused event without acting on it.
            std::string run_id_copy;
            {
                // Snapshot: mark this node as paused so a reconnecting
                // client sees via `workflow.state` that the run is
                // waiting here. Cleared right after wait_for_resume()
                // returns, before the node starts executing.
                std::lock_guard<std::mutex> lk(state_mutex_);
                paused_at_ = node_id;
                node_statuses_[node_id] = "paused";
                run_id_copy = current_run_id_;
            }
            if (!run_id_copy.empty()) {
                data["run_id"] = run_id_copy;
            }
            if (pause_cb_) pause_cb_(node_id, data);

            debug_.wait_for_resume();
            {
                std::lock_guard<std::mutex> lk(state_mutex_);
                paused_at_.clear();
            }
            if (debug_.is_stopped()) break;
        }

        notify_status(node_id, "running");

        try {
            auto it = handlers_.find(node->type);
            if (it == handlers_.end()) {
                throw NodeError(NodeError::Kind::InvalidConfig,
                                "Unknown node type: " + node->type);
            }
            json extra = it->second->execute(*node, graph, *this);
            // Post-node cancel check: the handler may have taken seconds
            // (inference, file I/O) during which the user pressed cancel.
            // Suppressing the terminal event here avoids shipping a
            // `done`/`error` for a node the client has already written
            // off. FE run_id filtering is a second line of defense;
            // this is the first. `port_data_` is intentionally left
            // populated so a fast re-run can reuse upstream outputs.
            if (debug_.is_stopped()) break;
            notify_status(node_id, "done", extra);
        } catch (const NodeError& e) {
            if (debug_.is_stopped()) break;
            record_failure(node_id, graph, NodeError::kind_to_string(e.kind()), e.message());
        } catch (const std::exception& e) {
            // Handlers not yet migrated to NodeError still land here; treat
            // as generic runtime errors but apply the same dead-port
            // propagation so downstream nodes get `upstream_failed`
            // instead of a confusing "Missing input" message.
            if (debug_.is_stopped()) break;
            record_failure(node_id, graph, "runtime", e.what());
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
    std::string run_id_copy;
    {
        // Record this status in the per-run snapshot so a reconnecting
        // client can reconcile via `workflow.state`. Skip the synthetic
        // `__workflow__` node — it is a workflow-level control event
        // (complete / validation_failed), not a node state.
        //
        // This must happen even when `status_cb_` is unset: tests and
        // embeds that don't wire a callback still rely on snapshot_state()
        // reflecting reality, and decoupling the snapshot from the wire
        // callback matches the intent (snapshot = truth, callback = fan-out).
        std::lock_guard<std::mutex> lk(state_mutex_);
        if (node_id != "__workflow__") {
            node_statuses_[node_id] = status;
        }
        run_id_copy = current_run_id_;
    }
    if (!status_cb_) return;
    json msg;
    msg["node_id"] = node_id;
    msg["status"] = status;
    // Tag the event with the current run so clients can ignore stale
    // messages from a superseded/cancelled run (see Executor::execute).
    // Empty when the caller did not provide a run_id (e.g. legacy tests).
    if (!run_id_copy.empty()) {
        msg["run_id"] = run_id_copy;
    }
    for (auto& [k, v] : extra.items()) {
        msg[k] = v;
    }
    status_cb_(node_id, msg);
}

void Executor::record_failure(const std::string& node_id, const WorkflowGraph& graph,
                              const std::string& kind, const std::string& message) {
    failed_nodes_[node_id] = {kind, message};
    for (const auto& e : graph.edges()) {
        if (e.source == node_id) {
            dead_ports_.insert(node_id + ":" + e.source_handle);
        }
    }
    json err;
    err["error"] = message;
    err["kind"] = kind;
    notify_status(node_id, "error", err);
}

bool Executor::validate_graph(const WorkflowGraph& graph) {
    // Build a per-node lookup: node_id -> {source_ports, target_ports} as
    // {handle_id -> data_type}. This lets us check each edge endpoint in
    // O(1) without walking port_defs() per edge.
    struct NodePorts {
        std::unordered_map<std::string, std::string> sources; // handle -> dataType
        std::unordered_map<std::string, std::string> targets;
    };
    std::unordered_map<std::string, NodePorts> by_node;
    json errors = json::array();

    auto add_error = [&](const char* kind, const std::string& message,
                         const std::string& node_id, const std::string& edge_id = "") {
        json e;
        e["kind"] = kind;
        e["message"] = message;
        if (!node_id.empty()) e["node_id"] = node_id;
        if (!edge_id.empty()) e["edge"] = edge_id;
        errors.push_back(std::move(e));
    };

    // Pass 1: nodes — every type must map to a handler; index its port_defs.
    for (const auto& node : graph.nodes()) {
        auto it = handlers_.find(node.type);
        if (it == handlers_.end()) {
            add_error("unknown_node_type",
                      "Unknown node type '" + node.type + "'",
                      node.id);
            continue;
        }
        NodePorts& np = by_node[node.id];
        for (const auto& p : it->second->port_defs()) {
            if (p.direction == "source") {
                np.sources[p.id] = p.data_type;
            } else if (p.direction == "target") {
                np.targets[p.id] = p.data_type;
            }
            // Any other direction is a backend bug, not a graph error;
            // silently ignore so malformed handler metadata doesn't
            // break otherwise-valid graphs.
        }
    }

    // Pass 2: edges — endpoints must exist and agree on data type.
    // `generic` on either side is intentionally permissive: e.g. Debug
    // Display accepts anything, Condition branches are typed as
    // `branch` but also route generic data upstream of Condition.
    for (const auto& e : graph.edges()) {
        const std::string edge_label =
            e.source + ":" + e.source_handle + " -> " + e.target + ":" + e.target_handle;

        auto src_it = by_node.find(e.source);
        auto tgt_it = by_node.find(e.target);

        if (src_it == by_node.end()) {
            add_error("dangling_edge",
                      "Edge references missing source node '" + e.source + "'",
                      "", edge_label);
            continue;
        }
        if (tgt_it == by_node.end()) {
            add_error("dangling_edge",
                      "Edge references missing target node '" + e.target + "'",
                      "", edge_label);
            continue;
        }

        auto sp = src_it->second.sources.find(e.source_handle);
        auto tp = tgt_it->second.targets.find(e.target_handle);

        if (sp == src_it->second.sources.end()) {
            add_error("unknown_port",
                      "Node '" + e.source + "' has no source port '" + e.source_handle + "'",
                      e.source, edge_label);
            continue;
        }
        if (tp == tgt_it->second.targets.end()) {
            add_error("unknown_port",
                      "Node '" + e.target + "' has no target port '" + e.target_handle + "'",
                      e.target, edge_label);
            continue;
        }

        const std::string& st = sp->second;
        const std::string& tt = tp->second;
        // Compatibility rules mirror `frontend/src/nodes/portSchema.ts`:
        //   - identical dataTypes always compatible
        //   - 'branch' SOURCE may feed any non-branch target (Condition
        //     routes the original payload through, so the branch port
        //     is really 'payload + prune semantics', not pure signal)
        //   - 'branch' TARGET only accepts another 'branch' source
        //   - 'generic' bridges anything
        //   - implicit coercion: image source -> tensor target
        //   - otherwise mismatched types are rejected
        bool compatible = (st == tt);
        if (!compatible) {
            if (tt == "branch") {
                // Only branch sources may plug into a branch target.
                compatible = (st == "branch");
            } else {
                compatible = (st == "branch") ||
                             (st == "generic" || tt == "generic") ||
                             (st == "image" && tt == "tensor");
            }
        }
        if (!compatible) {
            add_error("type_mismatch",
                      "Port type mismatch on " + edge_label +
                          ": source is '" + st + "', target is '" + tt + "'",
                      e.target, edge_label);
        }
    }

    if (errors.empty()) return true;

    if (status_cb_) {
        json msg;
        msg["status"] = "validation_failed";
        msg["errors"] = std::move(errors);
        status_cb_("__workflow__", msg);
    }
    return false;
}

std::string Executor::current_run_id() const {
    std::lock_guard<std::mutex> lk(state_mutex_);
    return current_run_id_;
}

json Executor::snapshot_state() const {
    json out;
    json statuses = json::object();
    std::lock_guard<std::mutex> lk(state_mutex_);
    for (const auto& [id, st] : node_statuses_) {
        statuses[id] = st;
    }
    out["run_id"] = current_run_id_;
    out["statuses"] = std::move(statuses);
    if (!paused_at_.empty()) {
        out["paused_at"] = paused_at_;
    }
    return out;
}

} // namespace workflow
