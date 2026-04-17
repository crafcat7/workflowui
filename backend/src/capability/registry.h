#pragma once
#include <string>
#include <vector>
#include <functional>
#include <nlohmann/json.hpp>

namespace workflow {

using json = nlohmann::json;

struct OperationDef {
    std::string id;
    std::vector<std::string> inputs;
    std::vector<std::string> outputs;
    std::string description;
};

/**
 * Registry of backend capabilities.
 * Tells the frontend what operations and vendors are available.
 */
class CapabilityRegistry {
public:
    void register_vendor(const std::string& vendor_name);
    void register_operation(const OperationDef& op);

    json to_json() const;

    const std::vector<std::string>& vendors() const { return vendors_; }
    const std::vector<OperationDef>& operations() const { return operations_; }

private:
    std::vector<std::string> vendors_;
    std::vector<OperationDef> operations_;
};

} // namespace workflow
