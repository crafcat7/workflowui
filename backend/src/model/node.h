// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include <variant>

namespace workflow {

// Data types flowing between ports
using TensorData = std::vector<float>;

struct ImageData {
    std::vector<uint8_t> pixels;
    int width = 0;
    int height = 0;
    int channels = 0;
};

// A port value can be one of these types
using PortValue = std::variant<
    std::monostate,      // empty
    std::string,         // text / file path
    float,               // scalar
    TensorData,          // tensor
    ImageData,           // image
    int64_t              // handle (net_handle, etc.)
>;

struct NodeDef {
    std::string id;
    std::string type;
    std::unordered_map<std::string, std::string> config;
};

struct EdgeDef {
    std::string source;
    std::string source_handle;
    std::string target;
    std::string target_handle;
};

} // namespace workflow
