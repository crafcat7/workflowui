#pragma once
#include <string>
#include <unordered_set>
#include <mutex>
#include <condition_variable>
#include <atomic>

namespace workflow {

/**
 * Controls debug breakpoints and pause/resume during execution.
 */
class DebugController {
public:
    void add_breakpoint(const std::string& node_id);
    void remove_breakpoint(const std::string& node_id);
    bool has_breakpoint(const std::string& node_id) const;

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
