// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once

#include <chrono>
#include <string>
#include <unordered_set>
#include <vector>

#include "vendor/inference_engine.h"

namespace workflow::testing {

/**
 * Shared stub InferenceEngine used by executor and condition tests.
 *
 * Every method returns a deterministic, minimal result so tests can focus on
 * graph-traversal / scheduling behavior rather than engine semantics.
 * `execute()` echoes its input tensor, which is what the existing tests rely
 * on for downstream node assertions.
 *
 * `init_net` hands out fresh handles and records them in `live_handles` so
 * tests can assert net-handle lifetime. `destroy_net` removes from the same
 * set.
 */
class MockEngine : public InferenceEngine {
 public:
  std::string name() const override { return "mock"; }
  std::vector<ConfigFieldSchema> config_schema() const override { return {}; }
  NetHandle init_net(const NetConfig&) override {
    NetHandle h = next_handle_++;
    live_handles.insert(h);
    return h;
  }
  void configure(NetHandle, const NetConfig&) override {}
  InferResult execute(NetHandle, const TensorData& input) override {
    return {input, std::chrono::milliseconds(1)};
  }
  BenchmarkResult benchmark(NetHandle, const TensorData&, int duration_sec,
                            std::function<bool()> should_cancel) override {
    // Simulate the real engine's loop semantics so tests can verify
    // the BenchmarkHandler wiring of cancellation. We "run" up to
    // `benchmark_target_runs` iterations; before each one, we poll
    // `should_cancel` and bail out early if it returns true. The
    // last polled value is captured for assertions.
    last_benchmark_duration_sec = duration_sec;
    int runs = 0;
    for (int i = 0; i < benchmark_target_runs; ++i) {
      if (should_cancel) {
        ++benchmark_cancel_polls;
        if (should_cancel()) {
          benchmark_cancelled = true;
          break;
        }
      }
      ++runs;
    }
    return {runs, 1.0, 1.0, 1.0};
  }
  void destroy_net(NetHandle h) override { live_handles.erase(h); }

  std::unordered_set<NetHandle> live_handles;

  // Knobs / probes for benchmark cancellation tests. Defaults preserve
  // historical behaviour (one run, no real polling impact for callers
  // that ignore the new fields).
  int benchmark_target_runs = 1;
  int benchmark_cancel_polls = 0;
  bool benchmark_cancelled = false;
  int last_benchmark_duration_sec = 0;

 private:
  NetHandle next_handle_ = 1;
};

}  // namespace workflow::testing
