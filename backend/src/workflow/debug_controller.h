// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_set>
#include <vector>

namespace workflow {

/**
 * Controls debug breakpoints and pause/resume during execution.
 *
 * Breakpoints are keyed by node id. A node pauses before execution if it
 * carries a breakpoint or if the controller is in "step" mode (each node
 * pauses once, then continues).
 */
class DebugController {
 public:
  void add_breakpoint(const std::string& node_id);
  void remove_breakpoint(const std::string& node_id);
  bool has_breakpoint(const std::string& node_id) const;

  /**
   * Replace the current breakpoint set atomically. Used by
   * `workflow.execute` to seed breakpoints from the frontend.
   */
  void set_breakpoints(const std::vector<std::string>& node_ids);
  void clear_breakpoints();

  // Called by executor before running a node. Returns true if the node
  // should pause — either a breakpoint is armed on `node_id` or the
  // controller is currently stepping.
  bool should_pause(const std::string& node_id) const;

  /**
   * Snapshot the current resume epoch. The executor MUST call this
   * before publishing the pause event to the frontend, and then
   * call `wait_for_resume()` afterwards. Any `resume`/`step_over`
   * /`stop` that lands between the two is guaranteed to advance
   * the epoch past the snapshot, so the subsequent wait trips
   * immediately instead of stranding forever.
   */
  void begin_pause();

  // Block until resumed. Must be preceded by `begin_pause()`.
  void wait_for_resume();

  // Resume from breakpoint
  void resume();

  // Step to next node
  void step_over();

  // Stop execution entirely
  void stop();

  bool is_stopped() const { return stopped_.load(); }

  /**
   * Reset pause/stop/step flags for a new run. Does NOT clear breakpoints
   * so the user's armed set survives between runs.
   */
  void reset();

 private:
  std::unordered_set<std::string> breakpoints_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  // Monotonically increasing token bumped by every resume/step/stop.
  // `wait_for_resume` snapshots this under the lock before waiting
  // and releases as soon as the observed token has moved. This
  // closes the race where a resume fired before the worker reached
  // the wait would otherwise be lost — the worker's snapshot
  // captures the *current* token, so any subsequent resume (even
  // one that already completed its notify into an empty waiter
  // set) is guaranteed to have advanced the counter past the
  // snapshot value, and the predicate trips immediately.
  uint64_t resume_epoch_{0};
  uint64_t pause_snapshot_{0};
  std::atomic<bool> stopped_{false};
  std::atomic<bool> stepping_{false};
};

}  // namespace workflow
