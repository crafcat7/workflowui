#pragma once
#include <string>
#include <unordered_set>
#include <vector>
#include <mutex>
#include <condition_variable>
#include <atomic>

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

    // Called by executor before running a node.
    // Returns true if execution should pause (breakpoint hit).
    bool should_pause(const std::string& node_id) const;

    // Block until resumed
    void wait_for_resume();

    // Resume from breakpoint
    void resume();

    // Step to next node
    void step_over();

    // Stop execution entirely
    void stop();

    bool is_stopped() const { return stopped_.load(); }
    bool is_stepping() const { return stepping_.load(); }

    /**
     * Reset pause/stop/step flags for a new run. Does NOT clear breakpoints
     * so the user's armed set survives between runs.
     */
    void reset();

private:
    std::unordered_set<std::string> breakpoints_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::atomic<bool> paused_{false};
    std::atomic<bool> stopped_{false};
    std::atomic<bool> stepping_{false};
};

} // namespace workflow
