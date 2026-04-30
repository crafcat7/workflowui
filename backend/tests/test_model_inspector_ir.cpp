// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>

#include "vendor/model_inspector.h"

// Pin the wire shape produced by `to_json` for ModelGraph and its
// subcomponents. The frontend's ModelInspectorDrawer parses this
// JSON directly off the WS payload — any field rename here is a
// breaking change, and a missing field would silently render an
// empty drawer.
TEST(ModelInspectorIRTest, ToJsonShapeMatchesWireContract) {
  using namespace workflow;
  ModelGraph g;
  g.vendor = "ncnn";
  g.format_version = "ncnn-7767517";
  g.param_bytes = 1234;
  g.bin_bytes = 567890;
  g.input_blob_names = {"data"};
  g.output_blob_names = {"output"};
  g.editable = false;

  ModelLayer conv;
  conv.id = "conv1";
  conv.type = "Convolution";
  conv.input_blobs = {"data"};
  conv.output_blobs = {"conv1_out"};
  conv.params = {{"num_output", 64}, {"kernel", 3}};
  g.layers.push_back(conv);

  ModelBlob blob;
  blob.name = "data";
  blob.shape = {1, 3, 224, 224};
  blob.producer = "";
  blob.consumers = {"conv1"};
  g.blobs.push_back(blob);

  auto j = to_json(g);
  EXPECT_EQ(j["vendor"].get<std::string>(), "ncnn");
  EXPECT_EQ(j["format_version"].get<std::string>(), "ncnn-7767517");
  EXPECT_EQ(j["param_bytes"].get<int64_t>(), 1234);
  EXPECT_EQ(j["bin_bytes"].get<int64_t>(), 567890);
  EXPECT_EQ(j["input_blob_names"].size(), 1u);
  EXPECT_EQ(j["output_blob_names"][0].get<std::string>(), "output");
  EXPECT_FALSE(j["editable"].get<bool>());

  ASSERT_EQ(j["layers"].size(), 1u);
  auto& jl = j["layers"][0];
  EXPECT_EQ(jl["id"].get<std::string>(), "conv1");
  EXPECT_EQ(jl["type"].get<std::string>(), "Convolution");
  EXPECT_EQ(jl["input_blobs"][0].get<std::string>(), "data");
  EXPECT_EQ(jl["output_blobs"][0].get<std::string>(), "conv1_out");
  EXPECT_EQ(jl["params"]["num_output"].get<int>(), 64);
  EXPECT_EQ(jl["params"]["kernel"].get<int>(), 3);

  ASSERT_EQ(j["blobs"].size(), 1u);
  auto& jb = j["blobs"][0];
  EXPECT_EQ(jb["name"].get<std::string>(), "data");
  EXPECT_EQ(jb["shape"].size(), 4u);
  EXPECT_EQ(jb["shape"][2].get<int>(), 224);
  EXPECT_TRUE(jb["producer"].get<std::string>().empty());
  EXPECT_EQ(jb["consumers"][0].get<std::string>(), "conv1");
}

// An empty ModelGraph still serializes to a fully-formed JSON object
// (not null, not an array), so the frontend can deserialize an
// "inspector returned nothing useful" result without a special case.
TEST(ModelInspectorIRTest, EmptyGraphSerializesToObjectWithEmptyArrays) {
  using namespace workflow;
  ModelGraph g;
  g.vendor = "ncnn";
  auto j = to_json(g);
  EXPECT_TRUE(j.is_object());
  EXPECT_TRUE(j["layers"].is_array());
  EXPECT_TRUE(j["blobs"].is_array());
  EXPECT_TRUE(j["input_blob_names"].is_array());
  EXPECT_TRUE(j["output_blob_names"].is_array());
  EXPECT_EQ(j["param_bytes"].get<int64_t>(), 0);
  EXPECT_FALSE(j["editable"].get<bool>());
}

// `params` is engine-specific — round-trip nested arrays + scalars
// without flattening or stringifying. ncnn's Convolution layer for
// example uses kernel_w/kernel_h as separate ints, but a future
// onnx inspector may store ints, floats, lists.
TEST(ModelInspectorIRTest, LayerParamsPreserveJsonStructure) {
  using namespace workflow;
  ModelLayer l;
  l.id = "x";
  l.type = "Custom";
  l.params = {
      {"kernel", nlohmann::json::array({3, 3})},
      {"alpha", 0.25},
      {"flag", true},
  };
  auto j = to_json(l);
  EXPECT_TRUE(j["params"]["kernel"].is_array());
  EXPECT_EQ(j["params"]["kernel"][1].get<int>(), 3);
  EXPECT_DOUBLE_EQ(j["params"]["alpha"].get<double>(), 0.25);
  EXPECT_TRUE(j["params"]["flag"].get<bool>());
}

// ModelInspectError must be catchable as std::runtime_error so the
// RPC handler in main.cpp can map it to a -32000 server error
// without a custom catch ladder.
TEST(ModelInspectorIRTest, InspectErrorIsRuntimeError) {
  using namespace workflow;
  try {
    throw ModelInspectError("bad magic");
  } catch (const std::runtime_error& e) {
    EXPECT_STREQ(e.what(), "bad magic");
  } catch (...) {
    FAIL() << "ModelInspectError must derive from std::runtime_error";
  }
}
