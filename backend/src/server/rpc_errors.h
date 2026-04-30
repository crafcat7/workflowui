// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include <stdexcept>
#include <string>

namespace workflow {

/**
 * JSON-RPC 2.0 "Invalid params" (-32602). Thrown by RPC handlers when
 * a request payload is structurally wrong — missing required fields,
 * wrong JSON types, empty strings where an id is required, etc.
 *
 * RpcHandler::handle_message catches this specifically and emits the
 * proper -32602 error code; generic std::exception still maps to
 * -32000 ("Server error") which is reserved for handler logic faults.
 */
class InvalidParams : public std::runtime_error {
 public:
  explicit InvalidParams(std::string message)
      : std::runtime_error(message), message_(std::move(message)) {}
  const std::string& message() const noexcept { return message_; }

 private:
  std::string message_;
};

}  // namespace workflow
