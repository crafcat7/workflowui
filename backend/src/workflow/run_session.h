// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "executor.h"
#include "../model/workflow_graph.h"
#include <memory>
#include <mutex>
#include <thread>

namespace workflow {

/**
 * Owner of the worker thread that runs a single workflow execution.
 *
 * Replaces the previous pattern of spawning a detached `std::thread`
 * from the `workflow.execute` RPC handler, which left the thread
 * outliving the executor on process shutdown — an undefined-behavior
 * hazard that worsened the moment the executor started holding ncnn
 * net handles that need explicit destruction.
 *
 * Responsibilities:
 *   - Keep the background thread joinable and visible to the server
 *     so it can be stopped & joined during graceful shutdown.
 *   - Serialize concurrent `start()` calls: if a run is already in
 *     progress, the previous one is stopped and joined before the
 *     new thread is launched. This gives the RPC a well-defined
 *     behavior ("start now, discarding whatever was running") instead
 *     of silently interleaving two runs.
 *
 * Not responsible for: cancelling in-flight handler work mid-node.
 * `stop()` still only interrupts between nodes via DebugController;
 * a handler running a 60-second benchmark will run to completion
 * before the cancel is observed. Each started run does receive a
 * unique run_id so clients can ignore status events from a
 * superseded run.
 */
class RunSession {
public:
    explicit RunSession(std::shared_ptr<Executor> executor);
    ~RunSession();

    RunSession(const RunSession&) = delete;
    RunSession& operator=(const RunSession&) = delete;

    // Start a new run. If a previous run is still live, stops and
    // joins it first so the new run observes a clean executor state.
    // Returns the run_id assigned to this run; the same id appears in
    // every status/pause event the executor emits for the run, so
    // callers can pass it back to the client (workflow.execute reply)
    // and correlate later cancellation.
    std::string start(WorkflowGraph graph);

    // Returns the run_id of the most recently started run, or empty
    // if start() has never been called. Used by workflow.cancel to
    // report which run was actually interrupted.
    std::string current_run_id() const;

    // Signal the current run to stop at the next node boundary and
    // join the worker thread if one is running. Idempotent.
    void shutdown();

private:
    std::shared_ptr<Executor> executor_;
    mutable std::mutex mutex_;
    std::thread worker_;
    std::string last_run_id_;
};

} // namespace workflow
