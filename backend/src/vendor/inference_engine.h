// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include <string>
#include <vector>
#include <chrono>
#include <nlohmann/json.hpp>
#include "../model/node.h"

namespace workflow {

using Duration = std::chrono::milliseconds;

struct NetConfig {
    std::string model_path;
    std::string param_path;
    int num_threads = 1;
    // Named blob support
    std::string input_name = "data";
    std::string output_name = "output";
    // Use empty (zero-filled) weights instead of loading .bin file
    bool empty_weights = false;
    // Input shape (0 = treat as 1D flat)
    int input_w = 0;
    int input_h = 0;
    int input_c = 0;
};

using NetHandle = int64_t;

struct InferResult {
    TensorData output;
    Duration elapsed;
};

struct BenchmarkResult {
    int runs;
    double avg_ms;
    double min_ms;
    double max_ms;
};

/**
 * Describes a single configurable field that a vendor engine supports.
 * Serialized as JSON and sent to the frontend so it can render dynamic UI.
 */
struct ConfigFieldSchema {
    std::string key;          // config key (matches NetConfig / get_config usage)
    std::string label;        // human-readable label
    std::string type;         // "string" | "int" | "float" | "bool" | "select"
    std::string group;        // UI group header (e.g. "MODEL", "RUNTIME")
    std::string placeholder;  // placeholder text
    std::string default_value;
    std::vector<std::string> options;  // only for type="select"

    nlohmann::json to_json() const {
        nlohmann::json j;
        j["key"] = key;
        j["label"] = label;
        j["type"] = type;
        j["group"] = group;
        if (!placeholder.empty()) j["placeholder"] = placeholder;
        if (!default_value.empty()) j["default"] = default_value;
        if (!options.empty()) j["options"] = options;
        return j;
    }
};

/**
 * Abstract interface for inference backends.
 * Each vendor (NCNN, MNN, ONNX Runtime, etc.) implements this.
 */
class InferenceEngine {
public:
    virtual ~InferenceEngine() = default;

    virtual std::string name() const = 0;

    /**
     * Returns a JSON array describing all config fields this engine supports.
     * The frontend uses this to dynamically render the CreateNet properties panel.
     */
    virtual std::vector<ConfigFieldSchema> config_schema() const = 0;

    virtual NetHandle init_net(const NetConfig& config) = 0;
    virtual void configure(NetHandle handle, const NetConfig& config) = 0;
    virtual InferResult execute(NetHandle handle, const TensorData& input) = 0;
    virtual BenchmarkResult benchmark(NetHandle handle, const TensorData& input, int duration_sec = 10) = 0;
    virtual void destroy_net(NetHandle handle) = 0;
};

} // namespace workflow
