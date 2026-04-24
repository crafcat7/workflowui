// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>
#include "server/rpc_handler.h"

#include <stdexcept>

using workflow::RpcHandler;
using workflow::json;

namespace {

// Helper: parse the handler's response string back into json so tests can
// inspect fields symbolically instead of string-matching.
json response_of(RpcHandler& rpc, const std::string& raw) {
    auto s = rpc.handle_message(raw);
    EXPECT_FALSE(s.empty()) << "expected a response for a request";
    return json::parse(s);
}

} // namespace

TEST(RpcHandlerTest, ParseErrorReturnsMinus32700) {
    RpcHandler rpc;
    auto resp = response_of(rpc, "{not json");
    EXPECT_EQ(resp["jsonrpc"], "2.0");
    ASSERT_TRUE(resp.contains("error"));
    EXPECT_EQ(resp["error"]["code"], -32700);
    EXPECT_FALSE(resp.contains("result"));
}

TEST(RpcHandlerTest, MethodNotFoundReturnsMinus32601) {
    RpcHandler rpc;
    auto resp = response_of(rpc, R"({"jsonrpc":"2.0","id":7,"method":"no.such"})");
    EXPECT_EQ(resp["id"], 7);
    ASSERT_TRUE(resp.contains("error"));
    EXPECT_EQ(resp["error"]["code"], -32601);
    // Include the offending method name so the client can log it.
    EXPECT_NE(std::string(resp["error"]["message"]).find("no.such"), std::string::npos);
}

TEST(RpcHandlerTest, SuccessfulRequestEchoesIdAndResult) {
    RpcHandler rpc;
    rpc.register_method("add", [](const json& p) -> json {
        return {{"sum", int(p.value("a", 0)) + int(p.value("b", 0))}};
    });
    auto resp = response_of(rpc, R"({"jsonrpc":"2.0","id":"abc","method":"add","params":{"a":2,"b":3}})");
    EXPECT_EQ(resp["id"], "abc");
    ASSERT_TRUE(resp.contains("result"));
    EXPECT_EQ(resp["result"]["sum"], 5);
    EXPECT_FALSE(resp.contains("error"));
}

TEST(RpcHandlerTest, MethodExceptionBecomesMinus32000) {
    RpcHandler rpc;
    rpc.register_method("boom", [](const json&) -> json {
        throw std::runtime_error("kaboom");
    });
    auto resp = response_of(rpc, R"({"jsonrpc":"2.0","id":1,"method":"boom"})");
    ASSERT_TRUE(resp.contains("error"));
    EXPECT_EQ(resp["error"]["code"], -32000);
    EXPECT_EQ(resp["error"]["message"], "kaboom");
}

TEST(RpcHandlerTest, NotificationReturnsEmptyStringAndInvokesHandler) {
    RpcHandler rpc;
    int calls = 0;
    json last_params;
    rpc.register_notify("ping", [&](const json& p) {
        ++calls;
        last_params = p;
    });
    auto s = rpc.handle_message(R"({"jsonrpc":"2.0","method":"ping","params":{"x":1}})");
    EXPECT_TRUE(s.empty());
    EXPECT_EQ(calls, 1);
    EXPECT_EQ(last_params["x"], 1);
}

TEST(RpcHandlerTest, UnknownNotificationIsSilentlyDropped) {
    RpcHandler rpc;
    auto s = rpc.handle_message(R"({"jsonrpc":"2.0","method":"ghost"})");
    EXPECT_TRUE(s.empty());
}

TEST(RpcHandlerTest, NotificationExceptionIsSwallowed) {
    // A throwing notification handler must not leak out: there is no response
    // channel to report it on, and we don't want to take down the ws thread.
    RpcHandler rpc;
    rpc.register_notify("crash", [](const json&) {
        throw std::runtime_error("intentional");
    });
    std::string s;
    EXPECT_NO_THROW(s = rpc.handle_message(R"({"jsonrpc":"2.0","method":"crash"})"));
    EXPECT_TRUE(s.empty());
}

TEST(RpcHandlerTest, MissingParamsDefaultsToEmptyObject) {
    RpcHandler rpc;
    bool seen_object = false;
    rpc.register_method("probe", [&](const json& p) -> json {
        seen_object = p.is_object() && p.empty();
        return json::object();
    });
    auto resp = response_of(rpc, R"({"jsonrpc":"2.0","id":1,"method":"probe"})");
    EXPECT_TRUE(seen_object);
    EXPECT_TRUE(resp.contains("result"));
}

TEST(RpcHandlerTest, NullIdIsPreservedInResponse) {
    // JSON-RPC 2.0 says `id: null` still makes this a request (not a
    // notification); the response must echo `null` back, not omit it.
    RpcHandler rpc;
    rpc.register_method("noop", [](const json&) -> json { return 1; });
    auto resp = response_of(rpc, R"({"jsonrpc":"2.0","id":null,"method":"noop"})");
    ASSERT_TRUE(resp.contains("id"));
    EXPECT_TRUE(resp["id"].is_null());
    EXPECT_EQ(resp["result"], 1);
}
