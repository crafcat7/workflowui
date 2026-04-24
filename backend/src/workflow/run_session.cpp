// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "run_session.h"
#include <utility>

namespace workflow {

RunSession::RunSession(std::shared_ptr<Executor> executor)
    : executor_(std::move(executor)) {}

RunSession::~RunSession() {
    // Mirror shutdown(); doing it unconditionally in the destructor
    // guarantees no worker thread outlives the session even if the
    // owner forgets to call shutdown() explicitly.
    shutdown();
}

void RunSession::start(WorkflowGraph graph) {
    std::lock_guard<std::mutex> lock(mutex_);

    // Tear down the previous run, if any. Executor::stop() flips an
    // atomic flag that Executor::execute() polls between nodes, so
    // the join typically completes quickly (≤ one node latency).
    if (worker_.joinable()) {
        if (executor_) executor_->stop();
        worker_.join();
    }

    // Capture by value (graph already moved into the lambda, executor
    // is a shared_ptr so the worker keeps it alive independently of
    // the RunSession); if the session is destroyed mid-run, shutdown()
    // will still synchronize via the mutex and the join below.
    worker_ = std::thread([exec = executor_, g = std::move(graph)]() mutable {
        if (exec) exec->execute(g);
    });
}

void RunSession::shutdown() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (executor_) executor_->stop();
    if (worker_.joinable()) worker_.join();
}

} // namespace workflow
