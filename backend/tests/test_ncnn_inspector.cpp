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

const char* shufflenet_path = "../demo/NCNN_demo/shufflenet.param";

}  // namespace

// Golden-file: parsing the demo shufflenet.param committed in this
// repo must succeed and report the layer/blob counts declared on
// line 2 of the file (120 layers, 136 blobs). This is the strongest
// regression net we have for the parser — it covers Convolution,
// ConvolutionDepthWise, Split, Concat, ReLU, Pooling, Eltwise,
// InnerProduct, Softmax, plus shape hints on every layer.
TEST(NcnnInspectorTest, ParsesShufflenetGoldenFile) {
  workflow::NcnnInspector ins;
  workflow::ModelInspectRequest req;
  req.param_path = shufflenet_path;
  auto g = ins.inspect(req);

  EXPECT_EQ(g.vendor, "ncnn");
  EXPECT_EQ(g.format_version, "ncnn-7767517");
  EXPECT_EQ(g.layers.size(), 120u);
  EXPECT_EQ(g.blobs.size(), 136u);
  EXPECT_FALSE(g.editable);
  EXPECT_GT(g.param_bytes, 0);
  // bin not provided → 0 (well-defined, not -1, not stat-error).
  EXPECT_EQ(g.bin_bytes, 0);

  // First layer must be the Input on blob "data" with shape hint
  // [3, 224, 224, 3] — confirms we both wired graph-input
  // detection (Input layer type) and shape-hint extraction.
  ASSERT_GE(g.layers.size(), 1u);
  EXPECT_EQ(g.layers[0].type, "Input");
  EXPECT_EQ(g.layers[0].id, "data");
  ASSERT_EQ(g.layers[0].output_blobs.size(), 1u);
  EXPECT_EQ(g.layers[0].output_blobs[0], "data");

  // input_blob_names is populated from Input layers.
  ASSERT_EQ(g.input_blob_names.size(), 1u);
  EXPECT_EQ(g.input_blob_names[0], "data");

  // The "data" blob has shape hint -23330=4,3,224,224,3 which the
  // parser decodes as {count=4, dims=3, d0=224, d1=224, d2=3}.
  // We surface only the `dims` shape values (224,224,3) and drop
  // the leading dims count, matching how the frontend would
  // display ncnn's CHW Mat extents.
  bool found_data = false;
  for (const auto& b : g.blobs) {
    if (b.name == "data") {
      found_data = true;
      EXPECT_EQ(b.shape, (std::vector<int>{224, 224, 3}));
      // Input layer is the producer.
      EXPECT_EQ(b.producer, "data");
      EXPECT_FALSE(b.consumers.empty());
    }
  }
  EXPECT_TRUE(found_data);

  // Conv-style layer params survive the round-trip. shufflenet's
  // "conv1" row is: Convolution conv1 1 1 data conv1_conv1_relu
  //   -23330=4,3,112,112,24 0=24 1=3 3=2 4=1 5=1 6=648 9=1
  // We verify a couple of canonical keys are int-typed.
  bool found_conv1 = false;
  for (const auto& l : g.layers) {
    if (l.id == "conv1") {
      found_conv1 = true;
      EXPECT_EQ(l.type, "Convolution");
      ASSERT_TRUE(l.params.contains("0"));
      EXPECT_EQ(l.params["0"].get<int>(), 24);  // num_output
      EXPECT_EQ(l.params["1"].get<int>(), 3);   // kernel_w
      EXPECT_EQ(l.params["3"].get<int>(), 2);   // stride
    }
  }
  EXPECT_TRUE(found_conv1);

  // Output blobs: at least one. shufflenet ends in fc1000 → softmax,
  // and the final softmax output should appear here.
  EXPECT_FALSE(g.output_blob_names.empty());
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
