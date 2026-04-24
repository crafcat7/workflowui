// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once

#include "vendor/inference_engine.h"

#include <chrono>
#include <string>
#include <vector>

namespace workflow::testing {

/**
 * Shared stub InferenceEngine used by executor and condition tests.
 *
 * Every method returns a deterministic, minimal result so tests can focus on
 * graph-traversal / scheduling behavior rather than engine semantics.
 * `execute()` echoes its input tensor, which is what the existing tests rely
 * on for downstream node assertions.
 */
class MockEngine : public InferenceEngine {
public:
    std::string name() const override { return "mock"; }
    std::vector<ConfigFieldSchema> config_schema() const override { return {}; }
    NetHandle init_net(const NetConfig&) override { return 1; }
    void configure(NetHandle, const NetConfig&) override {}
    InferResult execute(NetHandle, const TensorData& input) override {
        return {input, std::chrono::milliseconds(1)};
    }
    BenchmarkResult benchmark(NetHandle, const TensorData&, int) override {
        return {1, 1.0, 1.0, 1.0};
    }
    void destroy_net(NetHandle) override {}
};

}  // namespace workflow::testing
