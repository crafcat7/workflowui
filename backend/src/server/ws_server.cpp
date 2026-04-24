// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
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
        }
    });

    // uWS::Loop is tied to the calling thread. Capturing it here lets
    // broadcast() on other threads marshal work back in via `defer`. The
    // lock pairs with broadcast()'s snapshot and with the tear-down below
    // so a concurrent broadcast() never observes a half-initialized or
    // half-destroyed publisher.
    {
        std::lock_guard<std::mutex> lock(publisher_mu_);
        loop_ = (void*)uWS::Loop::get();
        publish_fn_ = [&app](std::string msg) {
            app.publish(BROADCAST_TOPIC, msg, uWS::OpCode::TEXT);
        };
    }

    app.run();

    {
        std::lock_guard<std::mutex> lock(publisher_mu_);
        publish_fn_ = nullptr;
        loop_ = nullptr;
    }
}

void WsServer::broadcast(const std::string& method, const json& params) {
    json notification;
    notification["jsonrpc"] = "2.0";
    notification["method"] = method;
    notification["params"] = params;

    std::string msg = notification.dump();

    // Snapshot the publisher under the lock so the event-loop pointer and
    // the publish functor can't be torn down between our null-check and
    // the defer() call below.
    void* loop = nullptr;
    std::function<void(std::string)> fn;
    {
        std::lock_guard<std::mutex> lock(publisher_mu_);
        loop = loop_;
        fn = publish_fn_;
    }

    if (loop && fn) {
        ((uWS::Loop*)loop)->defer([fn = std::move(fn), msg = std::move(msg)]() {
            fn(msg);
        });
    }
}

} // namespace workflow
