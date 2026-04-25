// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "../model/workflow_graph.h"
#include "../model/node.h"
#include "../vendor/inference_engine.h"
#include "debug_controller.h"
#include "handlers/node_handler.h"
#include <functional>
#include <unordered_map>
#include <unordered_set>
#include <memory>
#include <mutex>
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
    ~Executor() override;

    void set_status_callback(StatusCallback cb) { status_cb_ = std::move(cb); }
    void set_pause_callback(PauseCallback cb) { pause_cb_ = std::move(cb); }

    DebugController& debug_controller() { return debug_; }

    // Returns backend node catalog as JSON for the `nodes.list` RPC.
    // Each entry: {type, label, category, ports:[{id,direction,dataType}]}.
    // This is the authoritative description of what this backend build
    // can execute, and is intended to be cross-checked against the
    // frontend manifest (`frontend/src/nodes/manifest.ts`).
    json describe_nodes() const;

    // Execute the full workflow. Blocks until complete or stopped.
    // `run_id` tags every status/pause event emitted by this run so
    // clients can discard stale events from an earlier run that was
    // cancelled or superseded. May be empty (legacy callers); tests
    // and simple embeds are not required to generate one.
    void execute(const WorkflowGraph& graph, std::string run_id = {});

    // Publish a fresh `run_id` and clear per-node state synchronously
    // *before* the worker thread starts executing. RunSession calls
    // this on the WS thread inside `start()` so that a `workflow.state`
    // RPC arriving in the gap between `start()` returning and the
    // worker actually entering `execute()` does not return the
    // *previous* run's id+statuses (which would cause the frontend to
    // call `setActiveRunId` with a stale id and then drop fresh
    // `node.status` events as "from a superseded run").
    //
    // Idempotent with `execute(graph, run_id)`: if `begin_run` was
    // called with the same id beforehand, `execute` skips the
    // re-publish; otherwise it falls back to the legacy in-thread
    // initialisation for embeds that drive `execute` directly.
    void begin_run(const std::string& run_id);

    // Stop current execution
    void stop();

    // Returns the run_id of the currently-executing workflow, or the
    // most recent one if none is running. Empty before the first run.
    std::string current_run_id() const;

    // Snapshot of the executor's observable state for the `workflow.state`
    // RPC. Used by the frontend after a WebSocket reconnect to reconcile
    // the canvas with the backend (events dropped while disconnected
    // can otherwise leave nodes stuck on `running`).
    //
    // Shape: {
    //   "run_id":    string,                     // current or most recent
    //   "statuses":  { node_id: status_string }, // per-node last status
    //   "paused_at": string (optional)           // node_id currently paused
    // }
    //
    // `statuses` only contains entries from the current/most recent run;
    // it is cleared at the start of every new `execute()`. Safe to call
    // concurrently with a running execution.
    nlohmann::json snapshot_state() const;

    // ExecutionContext implementation
    PortValue resolve_input(const std::string& node_id, const std::string& handle, const WorkflowGraph& graph) override;
    void set_output(const std::string& node_id, const std::string& port_name, PortValue value) override;
    void mark_dead_output(const std::string& node_id, const std::string& port_name) override;
    std::shared_ptr<InferenceEngine> engine() override { return engine_; }
    bool is_cancelled() const override { return debug_.is_stopped(); }

private:
    void notify_status(const std::string& node_id, const std::string& status, const json& extra = {});
    void register_handlers();

    // Record a handler failure: mark the node as failed, kill all of
    // its source ports so downstream nodes skip with `upstream_failed`,
    // and emit an error status with the structured kind.
    void record_failure(const std::string& node_id, const WorkflowGraph& graph,
                        const std::string& kind, const std::string& message);

    // Returns true if `node` has at least one input edge AND every input
    // edge's source port is dead; such a node is pruned (its outputs are
    // also marked dead, propagating the skip forward).
    bool should_skip(const std::string& node_id, const WorkflowGraph& graph) const;

    // Cross-check the graph against handler metadata before scheduling:
    // every node must have a known type, every edge must reference an
    // existing node and a declared port of the correct direction, and
    // the dataType at both endpoints must be compatible. On failure the
    // run is aborted and a single `__workflow__`/`validation_failed`
    // status with an `errors[]` array is emitted. Returns true iff the
    // graph is valid and execution may proceed.
    bool validate_graph(const WorkflowGraph& graph);

    std::shared_ptr<InferenceEngine> engine_;
    DebugController debug_;

    StatusCallback status_cb_;
    PauseCallback pause_cb_;

    // Runtime data store: node_id:port_id -> value
    std::unordered_map<std::string, PortValue> port_data_;

    // Output ports that are "dead" (produced no value because the node was
    // skipped, or explicitly pruned by a Condition node). Keys are
    // "node_id:port_name" exactly like port_data_.
    std::unordered_set<std::string> dead_ports_;

    // Nodes whose handler threw. Used to distinguish branch-pruned
    // skips from upstream-failure skips when reporting downstream
    // status. Value carries structured error metadata for the UI.
    struct FailureInfo {
        std::string kind;    // "missing_input" | "invalid_config" | ...
        std::string message; // Human-readable, shown verbatim in UI
    };
    std::unordered_map<std::string, FailureInfo> failed_nodes_;

    // Registry of node handlers
    std::unordered_map<std::string, std::shared_ptr<NodeHandler>> handlers_;

    // Tags every status / pause event with the run that produced it so
    // clients can discard events from a run they already cancelled or
    // superseded. Written by execute() before any events are emitted and
    // read by the worker path (notify_status, pause handler) as well as
    // the RPC thread (snapshot_state, current_run_id), hence the mutex.
    std::string current_run_id_;

    // Per-node last-known status for the current/most recent run, plus
    // the node id we are currently paused at (empty when not paused).
    // Populated from the worker thread by notify_status / the pause
    // block in execute(); read from the RPC thread by snapshot_state().
    // All three fields share `state_mutex_`.
    std::unordered_map<std::string, std::string> node_statuses_;
    std::string paused_at_;
    mutable std::mutex state_mutex_;
};

} // namespace workflow
