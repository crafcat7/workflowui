// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "condition_expr.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <limits>
#include <numeric>
#include <optional>

namespace workflow {
namespace handlers {

namespace {

// ── Selector ──────────────────────────────────────────────────────────────

// Extract a scalar from a TensorData according to the selector spec. Returns
// std::nullopt if the selector can't be honored (empty tensor, bad index).
std::optional<float> apply_selector(const std::string& selector, const TensorData& t) {
    if (t.empty()) return std::nullopt;
    if (selector == "first") return t.front();
    if (selector == "max")   return *std::max_element(t.begin(), t.end());
    if (selector == "min")   return *std::min_element(t.begin(), t.end());
    if (selector == "sum")   return std::accumulate(t.begin(), t.end(), 0.0f);
    if (selector == "mean") {
        float s = std::accumulate(t.begin(), t.end(), 0.0f);
        return s / static_cast<float>(t.size());
    }
    // "[i]" — literal-indexed access.
    if (selector.size() >= 3 && selector.front() == '[' && selector.back() == ']') {
        try {
            int idx = std::stoi(selector.substr(1, selector.size() - 2));
            if (idx < 0 || static_cast<size_t>(idx) >= t.size()) return std::nullopt;
            return t[static_cast<size_t>(idx)];
        } catch (...) {
            return std::nullopt;
        }
    }
    return std::nullopt;
}

// Extract a scalar from any PortValue by applying `selector` when the value
// is a tensor, or returning the scalar directly for numeric PortValues.
std::optional<float> scalar_from_input(const std::string& selector, const PortValue& input) {
    if (auto* t = std::get_if<TensorData>(&input)) return apply_selector(selector, *t);
    if (auto* f = std::get_if<float>(&input))     return *f;
    if (auto* i = std::get_if<int64_t>(&input))   return static_cast<float>(*i);
    return std::nullopt;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────

std::string trim(std::string s) {
    auto not_space = [](unsigned char c) { return !std::isspace(c); };
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), not_space));
    s.erase(std::find_if(s.rbegin(), s.rend(), not_space).base(), s.end());
    return s;
}

// Try to split `expr` into (lhs, op, rhs). Operators are matched longest-first
// so ">=" beats ">". Returns true on success.
bool split_comparison(const std::string& expr, std::string& lhs, std::string& op, std::string& rhs) {
    // Longest operators first so substring matches are unambiguous.
    static const std::vector<std::string> ops = {">=", "<=", "==", "!=", ">", "<"};
    for (const auto& candidate : ops) {
        auto pos = expr.find(candidate);
        if (pos != std::string::npos) {
            lhs = trim(expr.substr(0, pos));
            op  = candidate;
            rhs = trim(expr.substr(pos + candidate.size()));
            return !lhs.empty() && !rhs.empty();
        }
    }
    return false;
}

bool apply_op(const std::string& op, float a, float b) {
    if (op == ">")  return a >  b;
    if (op == ">=") return a >= b;
    if (op == "<")  return a <  b;
    if (op == "<=") return a <= b;
    if (op == "==") return a == b;
    if (op == "!=") return a != b;
    return false;
}

bool try_parse_float(const std::string& s, float& out) {
    if (s.empty()) return false;
    try {
        size_t consumed = 0;
        out = std::stof(s, &consumed);
        // Allow trailing whitespace only.
        while (consumed < s.size() && std::isspace(static_cast<unsigned char>(s[consumed]))) ++consumed;
        return consumed == s.size();
    } catch (...) {
        return false;
    }
}

} // namespace

bool evaluate_condition(const std::string& raw_expr, const PortValue& input,
                        std::string* error_out) {
    auto fail = [&](const char* msg) {
        if (error_out) *error_out = msg;
        return false;
    };

    std::string expr = trim(raw_expr);
    if (expr.empty()) return fail("empty expression");

    // Boolean literals — useful for testing / forcing a branch at author-time.
    if (expr == "true")  return true;
    if (expr == "false") return false;

    std::string lhs, op, rhs;
    if (split_comparison(expr, lhs, op, rhs)) {
        float rhs_val;
        if (!try_parse_float(rhs, rhs_val)) return fail("rhs is not a number");
        auto scalar = scalar_from_input(lhs, input);
        if (!scalar) return fail("selector could not be applied to input");
        return apply_op(op, *scalar, rhs_val);
    }

    // No comparison operator. Two legacy-friendly fallbacks:
    //  a) a bare number → preserve pre-Phase-7 "first > N" semantics so old
    //     workflows stored as just "0.5" still work.
    //  b) a bare selector → truthy test (non-zero).
    float n;
    if (try_parse_float(expr, n)) {
        auto scalar = scalar_from_input("first", input);
        if (!scalar) return fail("input is empty");
        return *scalar > n;
    }

    auto scalar = scalar_from_input(expr, input);
    if (!scalar) return fail("unrecognised selector or empty input");
    return *scalar != 0.0f;
}

} // namespace handlers
} // namespace workflow
