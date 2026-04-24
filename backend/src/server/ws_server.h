#pragma once
#include "rpc_handler.h"
#include <functional>
#include <string>

namespace workflow {

/**
 * WebSocket server using uWebSockets.
 * Listens for connections and routes messages through RpcHandler.
 */
class WsServer {
public:
    WsServer(int port, RpcHandler& handler);

    // Start the server (blocks)
    void run();

    // Broadcast a JSON-RPC notification to all connected clients (thread-safe)
    void broadcast(const std::string& method, const nlohmann::json& params);

private:
    int port_;
    RpcHandler& handler_;

    // For thread-safe broadcasting: queue messages and defer to event loop
    std::function<void(std::string)> publish_fn_;
    void* loop_ = nullptr;  // uWS::Loop*, stored as void* to avoid header dep
};

} // namespace workflow
