// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "registry.h"

namespace workflow {

void CapabilityRegistry::register_vendor(const std::string& vendor_name) {
    vendors_.push_back(vendor_name);
}

void CapabilityRegistry::register_operation(const OperationDef& op) {
    operations_.push_back(op);
}

json CapabilityRegistry::to_json() const {
    json j;
    j["vendors"] = vendors_;

    json ops = json::array();
    for (auto& op : operations_) {
        ops.push_back({
            {"id", op.id},
            {"inputs", op.inputs},
            {"outputs", op.outputs},
            {"description", op.description}
        });
    }
    j["operations"] = ops;
    return j;
}

} // namespace workflow
