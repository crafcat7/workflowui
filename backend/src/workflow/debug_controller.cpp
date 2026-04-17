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

bool DebugController::should_pause(const std::string& node_id) const {
    if (stepping_.load()) return true;
    return has_breakpoint(node_id);
}

void DebugController::wait_for_resume() {
    paused_.store(true);
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this] { return !paused_.load() || stopped_.load(); });
}

void DebugController::resume() {
    paused_.store(false);
    stepping_.store(false);
    cv_.notify_all();
}

void DebugController::step_over() {
    stepping_.store(true);
    paused_.store(false);
    cv_.notify_all();
}

void DebugController::stop() {
    stopped_.store(true);
    paused_.store(false);
    cv_.notify_all();
}

void DebugController::reset() {
    paused_.store(false);
    stopped_.store(false);
    stepping_.store(false);
}

} // namespace workflow
