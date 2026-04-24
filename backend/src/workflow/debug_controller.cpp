// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "debug_controller.h"

namespace workflow {

void DebugController::add_breakpoint(const std::string& node_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    breakpoints_.insert(node_id);
}

void DebugController::remove_breakpoint(const std::string& node_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    breakpoints_.erase(node_id);
}

bool DebugController::has_breakpoint(const std::string& node_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return breakpoints_.count(node_id) > 0;
}

void DebugController::set_breakpoints(const std::vector<std::string>& node_ids) {
    std::lock_guard<std::mutex> lock(mutex_);
    breakpoints_.clear();
    breakpoints_.insert(node_ids.begin(), node_ids.end());
}

void DebugController::clear_breakpoints() {
    std::lock_guard<std::mutex> lock(mutex_);
    breakpoints_.clear();
}

bool DebugController::should_pause(const std::string& node_id) const {
    if (stepping_.load()) return true;
    return has_breakpoint(node_id);
}

void DebugController::wait_for_resume() {
    // Must be preceded by `begin_pause()`, which snapshots
    // `resume_epoch_` into `pause_snapshot_` under the lock. Any
    // resume/step/stop that lands between the snapshot and this
    // wait advances `resume_epoch_` past the snapshot, so the
    // predicate trips immediately and the worker never strands.
    //
    // If no resume has fired yet, `resume_epoch_ == pause_snapshot_`
    // and the predicate correctly blocks until one arrives. The
    // next resume/step/stop bumps the epoch under the lock and
    // notifies, waking us.
    std::unique_lock<std::mutex> lock(mutex_);
    const uint64_t snapshot = pause_snapshot_;
    cv_.wait(lock, [this, snapshot] {
        return resume_epoch_ > snapshot || stopped_.load();
    });
}

void DebugController::begin_pause() {
    std::lock_guard<std::mutex> lock(mutex_);
    pause_snapshot_ = resume_epoch_;
}

void DebugController::resume() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ++resume_epoch_;
        stepping_.store(false);
    }
    cv_.notify_all();
}

void DebugController::step_over() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ++resume_epoch_;
        stepping_.store(true);
    }
    cv_.notify_all();
}

void DebugController::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ++resume_epoch_;
        stopped_.store(true);
    }
    cv_.notify_all();
}

void DebugController::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    stopped_.store(false);
    stepping_.store(false);
    // resume_epoch_ intentionally preserved — a fresh run starts with
    // pause_snapshot_ taken under the new ordering, so its absolute
    // value is irrelevant.
}

} // namespace workflow
