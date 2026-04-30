// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "run_session.h"

#include <atomic>
#include <chrono>
#include <sstream>
#include <utility>

namespace workflow {

namespace {

// Monotonic, per-process run id. Format `run-<seq>-<ms>` where <seq>
// is a process-local counter (so repeated starts within the same
// millisecond still differ) and <ms> is steady_clock milliseconds
// since process start (human-sortable without leaking wall-clock
// time, and safe against system clock jumps). Kept short because it
// travels on every status event.
std::string make_run_id() {
  static std::atomic<uint64_t> seq{0};
  static const auto epoch = std::chrono::steady_clock::now();
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - epoch)
                      .count();
  std::ostringstream oss;
  oss << "run-" << seq.fetch_add(1, std::memory_order_relaxed) << "-" << ms;
  return oss.str();
}

}  // namespace

RunSession::RunSession(std::shared_ptr<Executor> executor) : executor_(std::move(executor)) {}

RunSession::~RunSession() {
  // Mirror shutdown(); doing it unconditionally in the destructor
  // guarantees no worker thread outlives the session even if the
  // owner forgets to call shutdown() explicitly.
  shutdown();
}

std::string RunSession::start(WorkflowGraph graph) {
  std::lock_guard<std::mutex> lock(mutex_);

  // Tear down the previous run, if any. Executor::stop() flips an
  // atomic flag that Executor::execute() polls between nodes, so
  // the join typically completes quickly (≤ one node latency).
  if (worker_.joinable()) {
    if (executor_)
      executor_->stop();
    worker_.join();
  }

  // Assign a fresh id AFTER the previous run is fully joined: that
  // way no stale status event from the prior run can accidentally
  // be tagged with the new id (the executor writes current_run_id_
  // from its own thread, and we've just proven that thread is gone).
  last_run_id_ = make_run_id();

  // Publish the new run_id (and reset per-node state) into the
  // executor *before* the worker thread starts. Otherwise a
  // `workflow.state` RPC arriving in the window between start()
  // returning and the worker entering execute() would observe the
  // *previous* run's id and statuses — the frontend would then call
  // `setActiveRunId` with a stale id and `isFreshEvent` would drop
  // the fresh run's `node.status` events until the worker finally
  // got around to overwriting current_run_id_. Doing it here on the
  // WS thread (under our own mutex) closes the race entirely; the
  // Executor's matching `state_mutex_` ensures snapshot_state()
  // sees a consistent (id, statuses) pair.
  if (executor_)
    executor_->begin_run(last_run_id_);

  // Capture by value (graph already moved into the lambda, executor
  // is a shared_ptr so the worker keeps it alive independently of
  // the RunSession); if the session is destroyed mid-run, shutdown()
  // will still synchronize via the mutex and the join below.
  worker_ = std::thread([exec = executor_, g = std::move(graph), id = last_run_id_]() mutable {
    if (exec)
      exec->execute(g, id);
  });
  return last_run_id_;
}

std::string RunSession::current_run_id() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return last_run_id_;
}

void RunSession::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (executor_)
    executor_->stop();
  if (worker_.joinable())
    worker_.join();
}

}  // namespace workflow
