// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include <stdexcept>
#include <string>

namespace workflow {

/**
 * Typed exception raised by node handlers to signal structured errors.
 *
 * Plain `std::runtime_error` is still caught by the executor for
 * backward compatibility, but handlers should prefer `NodeError` so
 * the UI can render context-appropriate messages (missing input vs.
 * bad config vs. engine failure) and so downstream nodes can
 * distinguish a local failure from an upstream one.
 */
class NodeError : public std::runtime_error {
public:
    enum class Kind {
        MissingInput,   // Required input port had no value
        InvalidConfig,  // User-supplied config rejected
        Runtime,        // Handler logic failed at runtime
        UpstreamFailed, // Dependency produced no value because it errored
    };

    NodeError(Kind kind, std::string message)
        : std::runtime_error(message), kind_(kind), message_(std::move(message)) {}

    Kind kind() const noexcept { return kind_; }
    const std::string& message() const noexcept { return message_; }

    static const char* kind_to_string(Kind k) noexcept {
        switch (k) {
            case Kind::MissingInput:   return "missing_input";
            case Kind::InvalidConfig:  return "invalid_config";
            case Kind::Runtime:        return "runtime";
            case Kind::UpstreamFailed: return "upstream_failed";
        }
        return "runtime";
    }

private:
    Kind kind_;
    std::string message_;
};

} // namespace workflow
