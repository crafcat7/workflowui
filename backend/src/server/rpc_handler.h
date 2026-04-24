#pragma once
#include <string>
#include <functional>
#include <nlohmann/json.hpp>

namespace workflow {

using json = nlohmann::json;

/**
 * Routes incoming JSON-RPC requests to appropriate handlers.
 */
class RpcHandler {
public:
    using MethodHandler = std::function<json(const json& params)>;
    using NotifyHandler = std::function<void(const json& params)>;

    void register_method(const std::string& method, MethodHandler handler);
    void register_notify(const std::string& method, NotifyHandler handler);

    // Process an incoming JSON-RPC message, returns response JSON (or empty for notifications)
    std::string handle_message(const std::string& raw_message);

private:
    std::unordered_map<std::string, MethodHandler> methods_;
    std::unordered_map<std::string, NotifyHandler> notifiers_;
};

} // namespace workflow
