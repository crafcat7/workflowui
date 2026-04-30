// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include <functional>
#include <mutex>
#include <string>

#include "rpc_handler.h"

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

  // `publish_fn_` and `loop_` are written by the uWS thread in run() and
  // read by broadcast() from arbitrary threads. The mutex guards the pair
  // as a unit so broadcast() never sees a half-torn publisher during
  // shutdown.
  std::mutex publisher_mu_;
  std::function<void(std::string)> publish_fn_;
  void* loop_ = nullptr;  // uWS::Loop*, stored as void* to avoid header dep
};

}  // namespace workflow
