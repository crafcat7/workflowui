#include "ws_server.h"
#include <App.h>
#include <Loop.h>
#include <iostream>
#include <nlohmann/json.hpp>

namespace workflow {

using json = nlohmann::json;

struct PerSocketData {};

static constexpr std::string_view BROADCAST_TOPIC = "broadcast";

WsServer::WsServer(int port, RpcHandler& handler)
    : port_(port), handler_(handler) {}

void WsServer::run() {
    running_ = true;

    auto app = uWS::App();

    app.ws<PerSocketData>("/*", {
        .compression = uWS::DISABLED,
        .maxPayloadLength = 16 * 1024 * 1024,
        .open = [](auto* ws) {
            std::cout << "[WS] Client connected\n";
            ws->subscribe(BROADCAST_TOPIC);
        },
        .message = [this](auto* ws, std::string_view message, uWS::OpCode) {
            std::string response = handler_.handle_message(std::string(message));
            if (!response.empty()) {
                ws->send(response, uWS::OpCode::TEXT);
            }
        },
        .close = [](auto*, int, std::string_view) {
            std::cout << "[WS] Client disconnected\n";
        }
    });

    app.listen(port_, [this](auto* listen_socket) {
        if (listen_socket) {
            std::cout << "[WS] Server listening on port " << port_ << "\n";
        } else {
            std::cerr << "[WS] Failed to listen on port " << port_ << "\n";
            running_ = false;
        }
    });

    // Store loop and publish function for thread-safe broadcasting
    loop_ = (void*)uWS::Loop::get();

    publish_fn_ = [&app](std::string msg) {
        app.publish(BROADCAST_TOPIC, msg, uWS::OpCode::TEXT);
    };

    app.run();
    publish_fn_ = nullptr;
    loop_ = nullptr;
}

void WsServer::stop() {
    running_ = false;
}

void WsServer::broadcast(const std::string& method, const json& params) {
    json notification;
    notification["jsonrpc"] = "2.0";
    notification["method"] = method;
    notification["params"] = params;

    std::string msg = notification.dump();

    if (loop_ && publish_fn_) {
        auto fn = publish_fn_;
        ((uWS::Loop*)loop_)->defer([fn, msg = std::move(msg)]() {
            if (fn) {
                fn(msg);
            }
        });
    }
}

} // namespace workflow
