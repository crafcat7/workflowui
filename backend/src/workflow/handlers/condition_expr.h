// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once

#include "../../model/node.h"
#include <string>

namespace workflow {
namespace handlers {

/**
 * Tiny expression language for the Condition node.
 *
 * Grammar:
 *   expr     := selector op number
 *            |  selector                 (truthy test, non-zero = true)
 *            |  bool_literal             ("true" / "false")
 *            |  number                   (legacy: "first > N")
 *   selector := "max" | "min" | "sum" | "mean" | "first" | "[" integer "]"
 *   op       := ">" | ">=" | "<" | "<=" | "==" | "!="
 *
 * Notes:
 *   - Whitespace between tokens is tolerated and ignored.
 *   - `bool_literal` returns the literal value regardless of data.
 *   - A bare number preserves the pre-Phase-7 behavior: the first element of
 *     the input tensor is compared `>` against that number.
 *   - For scalar inputs (float/int64) the selector is ignored and the value
 *     itself is used.
 *   - Returns false (with `error_out` set) on malformed input; the caller
 *     is expected to route both branches as dead in that case but we keep
 *     the contract simple: a bad expression evaluates to false.
 */
bool evaluate_condition(const std::string& expr, const PortValue& input,
                        std::string* error_out = nullptr);

} // namespace handlers
} // namespace workflow
