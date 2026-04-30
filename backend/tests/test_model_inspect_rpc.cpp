// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
//
// Integration tests for the model.inspect RPC method.
//
// We re-register the method here against a fresh RpcHandler instead
// of pulling main.cpp's wiring into a library — main.cpp's setup is
// entangled with the executor / WS server, and re-registering keeps
// the test focused on the wire contract (JSON in → JSON out, error
// codes). The lambda body MUST stay byte-for-byte equivalent to the
// one in main.cpp; if the production handler changes, this test
// must be updated in the same commit.
#include <gtest/gtest.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "server/rpc_errors.h"
#include "server/rpc_handler.h"
#include "vendor/model_inspector.h"
#include "vendor/ncnn/ncnn_inspector.h"

using workflow::InvalidParams;
using workflow::json;
using workflow::ModelInspectRequest;
using workflow::NcnnInspector;
using workflow::RpcHandler;
using workflow::to_json;

namespace {

void install_model_inspect(RpcHandler& rpc) {
  rpc.register_method("model.inspect", [](const json& params) -> json {
    if (!params.is_object())
      throw InvalidParams("params must be an object");
    if (!params.contains("vendor") || !params["vendor"].is_string()) {
      throw InvalidParams("params.vendor must be a string");
    }
    if (!params.contains("param_path") || !params["param_path"].is_string() ||
        params["param_path"].get<std::string>().empty()) {
      throw InvalidParams("params.param_path must be a non-empty string");
    }
    const std::string vendor = params["vendor"].get<std::string>();
    ModelInspectRequest req;
    req.param_path = params["param_path"].get<std::string>();
    if (params.contains("model_path") && params["model_path"].is_string()) {
      req.model_path = params["model_path"].get<std::string>();
    }
    if (vendor == "ncnn") {
      NcnnInspector inspector;
      return to_json(inspector.inspect(req));
    }
    throw InvalidParams("params.vendor '" + vendor + "' is not a known inspector");
  });
}

json call(RpcHandler& rpc, const json& req) {
  auto s = rpc.handle_message(req.dump());
  return json::parse(s);
}

std::string write_minimal_param() {
  std::string path = "/tmp/wfui_model_inspect_minimal.param";
  std::ofstream out(path);
  out << "7767517\n2 2\nInput data 0 1 data\nReLU r 1 1 data r_out\n";
  return path;
}

}  // namespace

TEST(ModelInspectRpcTest, ReturnsModelGraphForValidNcnnRequest) {
  RpcHandler rpc;
  install_model_inspect(rpc);
  auto path = write_minimal_param();

  json req = {{"jsonrpc", "2.0"},
              {"id", 1},
              {"method", "model.inspect"},
              {"params", {{"vendor", "ncnn"}, {"param_path", path}}}};
  auto resp = call(rpc, req);

  ASSERT_TRUE(resp.contains("result")) << resp.dump();
  EXPECT_FALSE(resp.contains("error"));
  auto& r = resp["result"];
  EXPECT_EQ(r["vendor"].get<std::string>(), "ncnn");
  EXPECT_EQ(r["format_version"].get<std::string>(), "ncnn-7767517");
  EXPECT_EQ(r["layers"].size(), 2u);
  EXPECT_EQ(r["blobs"].size(), 2u);
  EXPECT_FALSE(r["editable"].get<bool>());
  EXPECT_GT(r["param_bytes"].get<int64_t>(), 0);

  std::remove(path.c_str());
}

TEST(ModelInspectRpcTest, MissingParamsObjectRejectedWithMinus32602) {
  RpcHandler rpc;
  install_model_inspect(rpc);
  json req = {
      {"jsonrpc", "2.0"}, {"id", 2}, {"method", "model.inspect"}, {"params", "not-an-object"}};
  auto resp = call(rpc, req);
  ASSERT_TRUE(resp.contains("error"));
  EXPECT_EQ(resp["error"]["code"].get<int>(), -32602);
}

TEST(ModelInspectRpcTest, MissingVendorRejectedWithMinus32602) {
  RpcHandler rpc;
  install_model_inspect(rpc);
  json req = {{"jsonrpc", "2.0"},
              {"id", 3},
              {"method", "model.inspect"},
              {"params", {{"param_path", "/tmp/whatever.param"}}}};
  auto resp = call(rpc, req);
  ASSERT_TRUE(resp.contains("error"));
  EXPECT_EQ(resp["error"]["code"].get<int>(), -32602);
}

TEST(ModelInspectRpcTest, EmptyParamPathRejectedWithMinus32602) {
  RpcHandler rpc;
  install_model_inspect(rpc);
  json req = {{"jsonrpc", "2.0"},
              {"id", 4},
              {"method", "model.inspect"},
              {"params", {{"vendor", "ncnn"}, {"param_path", ""}}}};
  auto resp = call(rpc, req);
  ASSERT_TRUE(resp.contains("error"));
  EXPECT_EQ(resp["error"]["code"].get<int>(), -32602);
}

TEST(ModelInspectRpcTest, UnknownVendorRejectedWithMinus32602) {
  RpcHandler rpc;
  install_model_inspect(rpc);
  json req = {{"jsonrpc", "2.0"},
              {"id", 5},
              {"method", "model.inspect"},
              {"params", {{"vendor", "onnx"}, {"param_path", "/tmp/x.onnx"}}}};
  auto resp = call(rpc, req);
  ASSERT_TRUE(resp.contains("error"));
  EXPECT_EQ(resp["error"]["code"].get<int>(), -32602);
}

// ModelInspectError (parser failure) must bubble up as a -32000
// server error so frontend can distinguish "client sent bad input"
// (-32602) from "your file is malformed" (-32000) without parsing
// the message string.
TEST(ModelInspectRpcTest, ParserFailureSurfacesAsMinus32000) {
  RpcHandler rpc;
  install_model_inspect(rpc);
  // Bad magic.
  std::string path = "/tmp/wfui_model_inspect_badmagic.param";
  {
    std::ofstream out(path);
    out << "1234567\n0 0\n";
  }
  json req = {{"jsonrpc", "2.0"},
              {"id", 6},
              {"method", "model.inspect"},
              {"params", {{"vendor", "ncnn"}, {"param_path", path}}}};
  auto resp = call(rpc, req);
  ASSERT_TRUE(resp.contains("error"));
  EXPECT_EQ(resp["error"]["code"].get<int>(), -32000);
  std::remove(path.c_str());
}
