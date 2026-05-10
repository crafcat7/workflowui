// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "vendor/ncnn/ncnn_inspector.h"

namespace {

// Filesystem-bound tests use a per-test tmp file. We avoid the
// shared /tmp suffix collisions by including the test name + a
// counter in the path. Keeps the suite re-runnable in parallel
// (gtest discover may shard).
std::string tmp_path(const std::string& tag) {
  static int counter = 0;
  return "/tmp/wfui_ncnn_inspector_" + tag + "_" + std::to_string(++counter) + ".param";
}

void write_file(const std::string& path, const std::string& content) {
  std::ofstream out(path);
  out << content;
}

std::string mobilenetv2_path() {
  for (const char* candidate : {
           "demo/image_processing/mobilenetv2.param",
           "../demo/image_processing/mobilenetv2.param",
           "../../demo/image_processing/mobilenetv2.param",
       }) {
    std::ifstream in(candidate);
    if (in)
      return candidate;
  }
  return "demo/image_processing/mobilenetv2.param";
}

}  // namespace

// Golden-file: parsing the demo mobilenetv2.param committed in this
// repo must succeed and report the layer/blob counts declared on
// line 2 of the file (77 layers, 87 blobs). This is the strongest
// regression net we have for the parser — it covers Convolution,
// ConvolutionDepthWise, Split, Pooling, BinaryOp, Dropout, and
// InnerProduct rows from the canonical image-processing demo model.
TEST(NcnnInspectorTest, ParsesMobilenetV2GoldenFile) {
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = mobilenetv2_path();
  auto g = ins.inspect(req);

  EXPECT_EQ(g.vendor, "ncnn");
  EXPECT_EQ(g.format_version, "ncnn-7767517");
  EXPECT_EQ(g.layers.size(), 77u);
  EXPECT_EQ(g.blobs.size(), 87u);
  EXPECT_FALSE(g.editable);
  EXPECT_GT(g.param_bytes, 0);
  // bin not provided → 0 (well-defined, not -1, not stat-error).
  EXPECT_EQ(g.bin_bytes, 0);

  // First layer must be the Input on blob "in0" — confirms we wired
  // graph-input detection from Input layer type.
  ASSERT_GE(g.layers.size(), 1u);
  EXPECT_EQ(g.layers[0].type, "Input");
  EXPECT_EQ(g.layers[0].id, "in0");
  ASSERT_EQ(g.layers[0].output_blobs.size(), 1u);
  EXPECT_EQ(g.layers[0].output_blobs[0], "in0");

  // input_blob_names is populated from Input layers.
  ASSERT_EQ(g.input_blob_names.size(), 1u);
  EXPECT_EQ(g.input_blob_names[0], "in0");

  bool found_input = false;
  for (const auto& b : g.blobs) {
    if (b.name == "in0") {
      found_input = true;
      // Input layer is the producer.
      EXPECT_EQ(b.producer, "in0");
      EXPECT_FALSE(b.consumers.empty());
    }
  }
  EXPECT_TRUE(found_input);

  // Conv-style layer params survive the round-trip. MobileNetV2's
  // first convolution row exposes canonical int params plus a clamp array.
  bool found_first_conv = false;
  for (const auto& l : g.layers) {
    if (l.id == "convclip_0") {
      found_first_conv = true;
      EXPECT_EQ(l.type, "Convolution");
      ASSERT_TRUE(l.params.contains("0"));
      ASSERT_TRUE(l.params.contains("-23310"));
      EXPECT_EQ(l.params["0"].get<int>(), 32);  // num_output
      EXPECT_EQ(l.params["1"].get<int>(), 3);   // kernel_w
      EXPECT_EQ(l.params["3"].get<int>(), 2);   // stride
      EXPECT_TRUE(l.params["-23310"].is_array());
    }
  }
  EXPECT_TRUE(found_first_conv);

  ASSERT_EQ(g.output_blob_names.size(), 1u);
  EXPECT_EQ(g.output_blob_names[0], "out0");
}

TEST(NcnnInspectorTest, RejectsEmptyParamPath) {
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  EXPECT_THROW(ins.inspect(req), workflow::ModelInspectError);
}

TEST(NcnnInspectorTest, RejectsMissingFile) {
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = "/tmp/wfui_does_not_exist_xyzzy.param";
  EXPECT_THROW(ins.inspect(req), workflow::ModelInspectError);
}

TEST(NcnnInspectorTest, RejectsBadMagic) {
  auto p = tmp_path("badmagic");
  write_file(p,
             "1234567\n"
             "0 0\n");
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = p;
  EXPECT_THROW(ins.inspect(req), workflow::ModelInspectError);
  std::remove(p.c_str());
}

TEST(NcnnInspectorTest, RejectsTruncatedAfterHeader) {
  auto p = tmp_path("truncated");
  // Says 2 layers; provides 0.
  write_file(p,
             "7767517\n"
             "2 1\n");
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = p;
  EXPECT_THROW(ins.inspect(req), workflow::ModelInspectError);
  std::remove(p.c_str());
}

TEST(NcnnInspectorTest, RejectsBlobCountMismatch) {
  auto p = tmp_path("blobmismatch");
  // Declares 99 blobs but the layer only uses 1 ("data").
  write_file(p,
             "7767517\n"
             "1 99\n"
             "Input data 0 1 data\n");
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = p;
  EXPECT_THROW(ins.inspect(req), workflow::ModelInspectError);
  std::remove(p.c_str());
}

TEST(NcnnInspectorTest, ParsesMinimalTwoLayerGraph) {
  auto p = tmp_path("minimal");
  write_file(p,
             "7767517\n"
             "2 2\n"
             "Input data 0 1 data\n"
             "ReLU relu1 1 1 data relu1_out\n");
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = p;
  auto g = ins.inspect(req);
  ASSERT_EQ(g.layers.size(), 2u);
  EXPECT_EQ(g.layers[1].type, "ReLU");
  EXPECT_EQ(g.layers[1].input_blobs.size(), 1u);
  EXPECT_EQ(g.layers[1].input_blobs[0], "data");
  // "data" blob: producer=data layer, consumer=relu1.
  bool checked_data = false;
  bool checked_out = false;
  for (const auto& b : g.blobs) {
    if (b.name == "data") {
      checked_data = true;
      EXPECT_EQ(b.producer, "data");
      ASSERT_EQ(b.consumers.size(), 1u);
      EXPECT_EQ(b.consumers[0], "relu1");
    }
    if (b.name == "relu1_out") {
      checked_out = true;
      EXPECT_EQ(b.producer, "relu1");
      EXPECT_TRUE(b.consumers.empty());
    }
  }
  EXPECT_TRUE(checked_data);
  EXPECT_TRUE(checked_out);
  // Graph output detection: relu1_out has no consumers.
  ASSERT_EQ(g.output_blob_names.size(), 1u);
  EXPECT_EQ(g.output_blob_names[0], "relu1_out");
  std::remove(p.c_str());
}

TEST(NcnnInspectorTest, ScalarParamsTypedIntVsFloat) {
  auto p = tmp_path("scalars");
  write_file(p,
             "7767517\n"
             "1 1\n"
             "Custom mylayer 0 1 out 0=42 1=0.25 2=-1\n");
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = p;
  auto g = ins.inspect(req);
  ASSERT_EQ(g.layers.size(), 1u);
  EXPECT_EQ(g.layers[0].params["0"].get<int>(), 42);
  EXPECT_DOUBLE_EQ(g.layers[0].params["1"].get<double>(), 0.25);
  EXPECT_EQ(g.layers[0].params["2"].get<int>(), -1);
  std::remove(p.c_str());
}

TEST(NcnnInspectorTest, ArrayParamRoundTripsAsJsonArray) {
  auto p = tmp_path("arr");
  write_file(p,
             "7767517\n"
             "1 1\n"
             "Custom mylayer 0 1 out 0=3,1,2,3\n");
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = p;
  auto g = ins.inspect(req);
  ASSERT_EQ(g.layers.size(), 1u);
  ASSERT_TRUE(g.layers[0].params["0"].is_array());
  EXPECT_EQ(g.layers[0].params["0"].size(), 3u);
  EXPECT_EQ(g.layers[0].params["0"][2].get<int>(), 3);
  std::remove(p.c_str());
}
