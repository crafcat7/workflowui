// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "../inference_engine.h"
#include <memory>
#include <mutex>
#include <unordered_map>

namespace workflow {

/**
 * InferenceEngine binding for Tencent NCNN.
 *
 * Only compiled when ENABLE_NCNN=ON. Each call to init_net loads a
 * (.param, .bin) pair into a fresh ncnn::Net and returns a stable
 * handle; execute() / benchmark() look the net up by handle, run
 * inference against NetConfig::input_name / output_name, and return a
 * flat float blob.
 */
class NcnnEngine : public InferenceEngine {
public:
    NcnnEngine();
    ~NcnnEngine() override;

    std::string name() const override { return "ncnn"; }
    std::vector<ConfigFieldSchema> config_schema() const override;

    NetHandle init_net(const NetConfig& config) override;
    void configure(NetHandle handle, const NetConfig& config) override;
    InferResult execute(NetHandle handle, const TensorData& input) override;
    BenchmarkResult benchmark(NetHandle handle, const TensorData& input,
                              int duration_sec,
                              std::function<bool()> should_cancel) override;
    void destroy_net(NetHandle handle) override;

private:
    struct Entry;  // PImpl to avoid leaking ncnn headers from this header.
    std::unordered_map<NetHandle, std::shared_ptr<Entry>> nets_;
    NetHandle next_handle_ = 1;
    std::mutex mu_;

    std::shared_ptr<Entry> get(NetHandle h);
};

} // namespace workflow
