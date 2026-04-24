#include "ws_server.h"
#include "security_config.h"
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
        // Inspect the HTTP upgrade before accepting the WebSocket. This is
        // the only place where uWS exposes the Origin header to us; once
        // .open fires the handshake is already complete. When no allow-list
        // is configured the security layer short-circuits to "allow" so
        // this stays a no-op for tests and CLI-only setups.
        .upgrade = [](auto* res, auto* req, auto* context) {
            std::string_view origin = req->getHeader("origin");
            if (!SecurityConfig::instance().is_origin_allowed(origin)) {
                std::cerr << "[WS] Rejected upgrade from origin '" << origin << "'\n";
                res->writeStatus("403 Forbidden")->end("origin not allowed");
                return;
            }
            std::string_view wsKey = req->getHeader("sec-websocket-key");
            std::string_view wsProto = req->getHeader("sec-websocket-protocol");
            std::string_view wsExt = req->getHeader("sec-websocket-extensions");
            res->template upgrade<PerSocketData>(
                PerSocketData{}, wsKey, wsProto, wsExt, context);
        },
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

    // uWS::Loop is tied to the calling thread. Capturing it here lets
    // broadcast() on other threads marshal work back in via `defer`.
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
