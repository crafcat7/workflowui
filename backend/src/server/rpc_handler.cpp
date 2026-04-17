#include "rpc_handler.h"
#include <iostream>

namespace workflow {

void RpcHandler::register_method(const std::string& method, MethodHandler handler) {
    methods_[method] = std::move(handler);
}

void RpcHandler::register_notify(const std::string& method, NotifyHandler handler) {
    notifiers_[method] = std::move(handler);
}

std::string RpcHandler::handle_message(const std::string& raw_message) {
    json msg;
    try {
        msg = json::parse(raw_message);
    } catch (...) {
        json error_resp;
        error_resp["jsonrpc"] = "2.0";
        error_resp["error"] = {{"code", -32700}, {"message", "Parse error"}};
        return error_resp.dump();
    }

    std::string method = msg.value("method", "");
    auto params = msg.value("params", json::object());

    // Check if it's a notification (no id)
    if (!msg.contains("id")) {
        auto it = notifiers_.find(method);
        if (it != notifiers_.end()) {
            try {
                it->second(params);
            } catch (const std::exception& e) {
                std::cerr << "[RPC] Notification error: " << method << ": " << e.what() << "\n";
            }
        }
        return ""; // No response for notifications
    }

    // It's a request
    auto id = msg["id"];
    json response;
    response["jsonrpc"] = "2.0";
    response["id"] = id;

    auto it = methods_.find(method);
    if (it == methods_.end()) {
        response["error"] = {{"code", -32601}, {"message", "Method not found: " + method}};
    } else {
        try {
            response["result"] = it->second(params);
        } catch (const std::exception& e) {
            response["error"] = {{"code", -32000}, {"message", e.what()}};
        }
    }

    return response.dump();
}

} // namespace workflow
