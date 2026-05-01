// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <thread>
#include <unordered_set>

#include "mock_engine.h"
#include "model/workflow_graph.h"
#include "workflow/executor.h"

using namespace workflow;
using workflow::testing::MockEngine;

TEST(ExecutorTest, SimpleGraphExecution) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  // Add input tensor node
  NodeDef node1;
  node1.id = "n1";
  node1.type = "inputTensor";
  node1.config["fillMode"] = "text";
  node1.config["tensorText"] = "1.0 2.0 3.0";
  graph.add_node(node1);

  // Add output node
  NodeDef node2;
  node2.id = "n2";
  node2.type = "output";
  graph.add_node(node2);

  // Connect
  EdgeDef edge;
  edge.source = "n1";
  edge.source_handle = "tensor_data";
  edge.target = "n2";
  edge.target_handle = "data";
  graph.add_edge(edge);

  // Track status
  std::string last_status;
  json last_extra;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (node_id == "n2" && status["status"] == "done") {
      last_status = status["status"];
      last_extra = status;
    }
  });

  executor.execute(graph);

  EXPECT_EQ(last_status, "done");
  ASSERT_TRUE(last_extra.contains("output"));
  auto output = last_extra["output"].get<std::vector<float>>();
  EXPECT_EQ(output.size(), 3);
  EXPECT_FLOAT_EQ(output[0], 1.0f);
  EXPECT_FLOAT_EQ(output[1], 2.0f);
  EXPECT_FLOAT_EQ(output[2], 3.0f);
}

TEST(ExecutorTest, PostprocessNMS) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  // NMS input: [x1, y1, x2, y2, score]
  // Box 0: 0, 0, 10, 10, 0.9  (area=100)
  // Box 1: 0, 0, 10, 10, 0.8  (area=100, iou=1.0) -> should be suppressed
  // Box 2: 20, 20, 30, 30, 0.95 (area=100) -> kept
  NodeDef node1;
  node1.id = "n1";
  node1.type = "inputTensor";
  node1.config["fillMode"] = "text";
  node1.config["tensorText"] = "0 0 10 10 0.9   0 0 10 10 0.8   20 20 30 30 0.95";
  graph.add_node(node1);

  NodeDef node2;
  node2.id = "n2";
  node2.type = "postprocess";
  node2.config["op"] = "nms";
  node2.config["iouThreshold"] = "0.5";
  graph.add_node(node2);

  EdgeDef edge;
  edge.source = "n1";
  edge.source_handle = "tensor_data";
  edge.target = "n2";
  edge.target_handle = "input_data";
  graph.add_edge(edge);

  json last_extra;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (node_id == "n2" && status["status"] == "done") {
      last_extra = status;
    }
  });

  executor.execute(graph);

  ASSERT_TRUE(last_extra.contains("output"));
  auto output = last_extra["output"].get<std::vector<float>>();
  EXPECT_EQ(output.size(), 10);  // 2 boxes * 5
  // Box 2 should be first since it has highest score
  EXPECT_FLOAT_EQ(output[0], 20.0f);
  EXPECT_FLOAT_EQ(output[4], 0.95f);
}

TEST(ExecutorTest, PostprocessTopK) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  NodeDef node1;
  node1.id = "n1";
  node1.type = "inputTensor";
  node1.config["fillMode"] = "text";
  node1.config["tensorText"] = "0.1 0.5 0.9 0.2 0.8";  // indices 2 and 4 are top 2
  graph.add_node(node1);

  NodeDef node2;
  node2.id = "n2";
  node2.type = "postprocess";
  node2.config["op"] = "topk";
  node2.config["k"] = "2";
  graph.add_node(node2);

  EdgeDef edge;
  edge.source = "n1";
  edge.source_handle = "tensor_data";
  edge.target = "n2";
  edge.target_handle = "input_data";
  graph.add_edge(edge);

  json last_extra;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (node_id == "n2" && status["status"] == "done") {
      last_extra = status;
    }
  });

  executor.execute(graph);

  ASSERT_TRUE(last_extra.contains("output"));
  auto output = last_extra["output"].get<std::vector<float>>();
  EXPECT_EQ(output.size(), 4);  // 2 elements * 2 (index, score)
  EXPECT_FLOAT_EQ(output[0], 2.0f);
  EXPECT_FLOAT_EQ(output[1], 0.9f);
  EXPECT_FLOAT_EQ(output[2], 4.0f);
  EXPECT_FLOAT_EQ(output[3], 0.8f);
}

// ---------------------------------------------------------------------------
// Image-output handlers (tensorToImage, annotateImage)
//
// We exercise these end-to-end: drive the handler from a real Executor run,
// pipe the result into saveImage, then poke at the resulting PNG on disk.
// SecurityConfig is left in pass-through mode so absolute temp paths work.
// ---------------------------------------------------------------------------

namespace {

namespace fs = std::filesystem;

fs::path make_scratch_dir(const std::string& tag) {
  fs::path p = fs::temp_directory_path() /
               ("workflowui_imgh_" +
                std::to_string(::testing::UnitTest::GetInstance()->random_seed()) + "_" + tag);
  fs::create_directories(p);
  return p;
}

// Validates the file is a non-empty PNG (89 50 4E 47 magic). We deliberately
// don't try to decode + verify pixel content here — that path is already
// covered by InputImageHandler tests elsewhere; here we only need to know the
// handler produced a writable, structurally-valid PNG.
void expect_valid_png(const fs::path& p) {
  ASSERT_TRUE(fs::exists(p)) << "expected PNG at " << p;
  ASSERT_GE(fs::file_size(p), 8u);
  std::ifstream f(p, std::ios::binary);
  ASSERT_TRUE(f.good());
  unsigned char magic[8] = {0};
  f.read(reinterpret_cast<char*>(magic), 8);
  EXPECT_EQ(magic[0], 0x89);
  EXPECT_EQ(magic[1], 'P');
  EXPECT_EQ(magic[2], 'N');
  EXPECT_EQ(magic[3], 'G');
}

}  // namespace

TEST(ExecutorTest, TensorToImageWritesPng) {
  auto scratch = make_scratch_dir("t2i");
  auto out = scratch / "heatmap.png";

  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  NodeDef n1;
  n1.id = "src";
  n1.type = "inputTensor";
  n1.config["fillMode"] = "text";
  // 8 values that span a non-trivial range so normalize=auto exercises both
  // ends of the colormap.
  n1.config["tensorText"] = "0.0 0.1 0.2 0.5 0.8 1.0 0.4 0.3";
  graph.add_node(n1);

  NodeDef n2;
  n2.id = "viz";
  n2.type = "tensorToImage";
  n2.config["width"] = "32";
  n2.config["height"] = "8";
  n2.config["colormap"] = "viridis";
  graph.add_node(n2);

  NodeDef n3;
  n3.id = "sink";
  n3.type = "saveImage";
  n3.config["filePath"] = out.string();
  graph.add_node(n3);

  EdgeDef e1;
  e1.source = "src";
  e1.source_handle = "tensor_data";
  e1.target = "viz";
  e1.target_handle = "input_data";
  graph.add_edge(e1);

  EdgeDef e2;
  e2.source = "viz";
  e2.source_handle = "image_data";
  e2.target = "sink";
  e2.target_handle = "image_data";
  graph.add_edge(e2);

  // Capture per-node terminal statuses so the test surfaces a useful
  // error if any node failed instead of just complaining about a missing PNG.
  std::unordered_set<std::string> done_ids;
  std::string failure_msg;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (status.value("status", "") == "done") done_ids.insert(node_id);
    if (status.value("status", "") == "error") {
      failure_msg += node_id + ":" + status.value("error", "") + ";";
    }
  });

  executor.execute(graph);

  EXPECT_TRUE(failure_msg.empty()) << failure_msg;
  EXPECT_EQ(done_ids.size(), 3u);
  expect_valid_png(out);

  // Cleanup
  std::error_code ec;
  fs::remove_all(scratch, ec);
}

TEST(ExecutorTest, TensorToImageGrayscaleAlsoWorks) {
  auto scratch = make_scratch_dir("t2i_gray");
  auto out = scratch / "gray.png";

  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  NodeDef n1;
  n1.id = "src";
  n1.type = "inputTensor";
  n1.config["fillMode"] = "text";
  n1.config["tensorText"] = "0.2 0.5 0.9";
  graph.add_node(n1);

  NodeDef n2;
  n2.id = "viz";
  n2.type = "tensorToImage";
  n2.config["colormap"] = "gray";
  n2.config["normalize"] = "none";  // raw 0..1 clamp
  graph.add_node(n2);

  NodeDef n3;
  n3.id = "sink";
  n3.type = "saveImage";
  n3.config["filePath"] = out.string();
  graph.add_node(n3);

  graph.add_edge(EdgeDef{"src", "tensor_data", "viz", "input_data"});
  graph.add_edge(EdgeDef{"viz", "image_data", "sink", "image_data"});

  std::string failure_msg;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (status.value("status", "") == "error") {
      failure_msg += node_id + ":" + status.value("error", "") + ";";
    }
  });

  executor.execute(graph);
  EXPECT_TRUE(failure_msg.empty()) << failure_msg;
  expect_valid_png(out);

  std::error_code ec;
  fs::remove_all(scratch, ec);
}

TEST(ExecutorTest, AnnotateImageOverlaysTopKWithLabels) {
  auto scratch = make_scratch_dir("annotate");
  auto labels_path = scratch / "labels.txt";
  auto out_path = scratch / "annotated.png";

  // A tiny 3-class label file. Index 2 will win the synthetic top-K.
  {
    std::ofstream f(labels_path);
    f << "alpha\n";
    f << "beta\n";
    f << "gamma\n";
  }

  // Synthesize a 16x16 RGBA image directly via tensorToImage so we don't need
  // a fixture PNG. We then route it into annotateImage along with a top-K
  // tensor, and finally saveImage. This is the same wiring shape the demo
  // workflow uses (postprocess→annotateImage), minus an inference engine.
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  // Synthetic image source.
  NodeDef img_src;
  img_src.id = "img_src";
  img_src.type = "inputTensor";
  img_src.config["fillMode"] = "auto";
  img_src.config["shape"] = "256";
  img_src.config["fillValue"] = "0.5";
  graph.add_node(img_src);

  NodeDef to_img;
  to_img.id = "to_img";
  to_img.type = "tensorToImage";
  to_img.config["width"] = "128";
  to_img.config["height"] = "64";
  to_img.config["colormap"] = "gray";
  graph.add_node(to_img);

  // Top-K tensor source — pretend postprocess already ran. Index 2 ("gamma")
  // beats the others.
  NodeDef topk_src;
  topk_src.id = "topk_src";
  topk_src.type = "inputTensor";
  topk_src.config["fillMode"] = "text";
  topk_src.config["tensorText"] = "2 0.91  0 0.05  1 0.04";
  graph.add_node(topk_src);

  NodeDef ann;
  ann.id = "ann";
  ann.type = "annotateImage";
  ann.config["labelsPath"] = labels_path.string();
  ann.config["maxLines"] = "3";
  ann.config["fontScale"] = "1";
  graph.add_node(ann);

  NodeDef sink;
  sink.id = "sink";
  sink.type = "saveImage";
  sink.config["filePath"] = out_path.string();
  graph.add_node(sink);

  graph.add_edge(EdgeDef{"img_src", "tensor_data", "to_img", "input_data"});
  graph.add_edge(EdgeDef{"to_img", "image_data", "ann", "image_data"});
  graph.add_edge(EdgeDef{"topk_src", "tensor_data", "ann", "topk_data"});
  graph.add_edge(EdgeDef{"ann", "output_data", "sink", "image_data"});

  std::string failure_msg;
  std::unordered_set<std::string> done_ids;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (status.value("status", "") == "done") done_ids.insert(node_id);
    if (status.value("status", "") == "error") {
      failure_msg += node_id + ":" + status.value("error", "") + ";";
    }
  });

  executor.execute(graph);

  EXPECT_TRUE(failure_msg.empty()) << failure_msg;
  EXPECT_EQ(done_ids.count("ann"), 1u);
  EXPECT_EQ(done_ids.count("sink"), 1u);
  expect_valid_png(out_path);

  // Sanity-check the annotated PNG dimensions match the input by re-decoding
  // and comparing widths. Cheap, but proves annotateImage didn't accidentally
  // resize or corrupt the buffer geometry.
  std::ifstream f(out_path, std::ios::binary);
  ASSERT_TRUE(f.good());
  // PNG IHDR width/height are at byte offsets 16..23 (big-endian uint32 each).
  unsigned char header[24] = {0};
  f.read(reinterpret_cast<char*>(header), 24);
  uint32_t w = (uint32_t(header[16]) << 24) | (uint32_t(header[17]) << 16) |
               (uint32_t(header[18]) << 8) | uint32_t(header[19]);
  uint32_t h = (uint32_t(header[20]) << 24) | (uint32_t(header[21]) << 16) |
               (uint32_t(header[22]) << 8) | uint32_t(header[23]);
  EXPECT_EQ(w, 128u);
  EXPECT_EQ(h, 64u);

  std::error_code ec;
  fs::remove_all(scratch, ec);
}

TEST(ExecutorTest, AnnotateImageWithoutLabelsFallsBackToIndex) {
  auto scratch = make_scratch_dir("annotate_nolabels");
  auto out_path = scratch / "annotated_idx.png";

  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  NodeDef img_src;
  img_src.id = "img_src";
  img_src.type = "inputTensor";
  img_src.config["fillMode"] = "auto";
  img_src.config["shape"] = "16";
  graph.add_node(img_src);

  NodeDef to_img;
  to_img.id = "to_img";
  to_img.type = "tensorToImage";
  to_img.config["width"] = "64";
  to_img.config["height"] = "32";
  graph.add_node(to_img);

  NodeDef topk_src;
  topk_src.id = "topk_src";
  topk_src.type = "inputTensor";
  topk_src.config["fillMode"] = "text";
  topk_src.config["tensorText"] = "207 0.79";
  graph.add_node(topk_src);

  NodeDef ann;
  ann.id = "ann";
  ann.type = "annotateImage";
  // labelsPath intentionally unset.
  graph.add_node(ann);

  NodeDef sink;
  sink.id = "sink";
  sink.type = "saveImage";
  sink.config["filePath"] = out_path.string();
  graph.add_node(sink);

  graph.add_edge(EdgeDef{"img_src", "tensor_data", "to_img", "input_data"});
  graph.add_edge(EdgeDef{"to_img", "image_data", "ann", "image_data"});
  graph.add_edge(EdgeDef{"topk_src", "tensor_data", "ann", "topk_data"});
  graph.add_edge(EdgeDef{"ann", "output_data", "sink", "image_data"});

  std::string failure_msg;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (status.value("status", "") == "error") {
      failure_msg += node_id + ":" + status.value("error", "") + ";";
    }
  });
  executor.execute(graph);

  EXPECT_TRUE(failure_msg.empty()) << failure_msg;
  expect_valid_png(out_path);

  std::error_code ec;
  fs::remove_all(scratch, ec);
}

TEST(ExecutorTest, AnnotateImageMissingLabelsFileErrors) {
  auto scratch = make_scratch_dir("annotate_badlabels");
  auto bogus_labels = scratch / "does_not_exist.txt";
  auto out_path = scratch / "annotated_err.png";

  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;

  NodeDef img_src;
  img_src.id = "img_src";
  img_src.type = "inputTensor";
  img_src.config["fillMode"] = "auto";
  img_src.config["shape"] = "16";
  graph.add_node(img_src);

  NodeDef to_img;
  to_img.id = "to_img";
  to_img.type = "tensorToImage";
  to_img.config["width"] = "32";
  to_img.config["height"] = "16";
  graph.add_node(to_img);

  NodeDef topk_src;
  topk_src.id = "topk_src";
  topk_src.type = "inputTensor";
  topk_src.config["fillMode"] = "text";
  topk_src.config["tensorText"] = "0 0.5";
  graph.add_node(topk_src);

  NodeDef ann;
  ann.id = "ann";
  ann.type = "annotateImage";
  ann.config["labelsPath"] = bogus_labels.string();
  graph.add_node(ann);

  NodeDef sink;
  sink.id = "sink";
  sink.type = "saveImage";
  sink.config["filePath"] = out_path.string();
  graph.add_node(sink);

  graph.add_edge(EdgeDef{"img_src", "tensor_data", "to_img", "input_data"});
  graph.add_edge(EdgeDef{"to_img", "image_data", "ann", "image_data"});
  graph.add_edge(EdgeDef{"topk_src", "tensor_data", "ann", "topk_data"});
  graph.add_edge(EdgeDef{"ann", "output_data", "sink", "image_data"});

  std::string ann_error;
  executor.set_status_callback([&](const std::string& node_id, const json& status) {
    if (node_id == "ann" && status.value("status", "") == "error") {
      ann_error = status.value("error", "");
    }
  });
  executor.execute(graph);

  EXPECT_FALSE(ann_error.empty());
  EXPECT_NE(ann_error.find("labelsPath"), std::string::npos) << ann_error;
  EXPECT_FALSE(fs::exists(out_path));

  std::error_code ec;
  fs::remove_all(scratch, ec);
}

// ---------------------------------------------------------------------------
// Breakpoint tests (Phase 2)
// ---------------------------------------------------------------------------

namespace {

WorkflowGraph make_passthrough_graph(const std::string& src, const std::string& dst) {
  WorkflowGraph g;
  NodeDef n1;
  n1.id = src;
  n1.type = "inputTensor";
  n1.config["fillMode"] = "text";
  n1.config["tensorText"] = "1 2 3";
  g.add_node(n1);

  NodeDef n2;
  n2.id = dst;
  n2.type = "output";
  g.add_node(n2);

  EdgeDef e;
  e.source = src;
  e.source_handle = "tensor_data";
  e.target = dst;
  e.target_handle = "data";
  g.add_edge(e);
  return g;
}

}  // namespace

TEST(DebugControllerTest, SetBreakpointsReplacesSet) {
  DebugController dc;
  dc.add_breakpoint("n1");
  dc.add_breakpoint("n2");
  EXPECT_TRUE(dc.has_breakpoint("n1"));

  dc.set_breakpoints({"n3", "n4"});
  EXPECT_FALSE(dc.has_breakpoint("n1"));
  EXPECT_FALSE(dc.has_breakpoint("n2"));
  EXPECT_TRUE(dc.has_breakpoint("n3"));
  EXPECT_TRUE(dc.has_breakpoint("n4"));

  dc.clear_breakpoints();
  EXPECT_FALSE(dc.has_breakpoint("n3"));
}

TEST(DebugControllerTest, ResetPreservesBreakpoints) {
  DebugController dc;
  dc.add_breakpoint("n1");
  dc.reset();
  EXPECT_TRUE(dc.has_breakpoint("n1"));
}

TEST(ExecutorTest, DebugNodeDoesNotImplicitlyPause) {
  // Regression: previously `type == "debug"` auto-paused execution. We
  // now only pause on explicit breakpoints so Debug nodes are pure
  // passthrough/logging.
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph g;
  NodeDef n1;
  n1.id = "n1";
  n1.type = "inputTensor";
  n1.config["fillMode"] = "text";
  n1.config["tensorText"] = "1 2 3";
  g.add_node(n1);

  NodeDef n2;
  n2.id = "dbg";
  n2.type = "debug";
  g.add_node(n2);

  EdgeDef e;
  e.source = "n1";
  e.source_handle = "tensor_data";
  e.target = "dbg";
  e.target_handle = "data_in";
  g.add_edge(e);

  std::atomic<int> pause_count{0};
  executor.set_pause_callback([&](const std::string&, const json&) { pause_count.fetch_add(1); });

  executor.execute(g);
  EXPECT_EQ(pause_count.load(), 0);
}

TEST(ExecutorTest, BreakpointPausesAndResumes) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  auto g = make_passthrough_graph("src", "dst");
  executor.debug_controller().set_breakpoints({"dst"});

  std::atomic<int> pause_count{0};
  std::string paused_node;
  json paused_payload;
  executor.set_pause_callback([&](const std::string& id, const json& data) {
    paused_node = id;
    paused_payload = data;
    pause_count.fetch_add(1);
  });

  std::atomic<bool> completed{false};
  executor.set_status_callback([&](const std::string& id, const json& s) {
    if (id == "__workflow__" && s.value("status", "") == "complete") {
      completed.store(true);
    }
  });

  std::thread runner([&] { executor.execute(g); });

  // Wait for pause (bounded)
  for (int i = 0; i < 50 && pause_count.load() == 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  ASSERT_EQ(pause_count.load(), 1);
  EXPECT_EQ(paused_node, "dst");
  EXPECT_FALSE(completed.load());

  // The pause payload must carry a summary of every inbound port so
  // the frontend inspector can render it. The upstream `inputTensor`
  // with text `"1 2 3"` should surface as a 3-element tensor on the
  // `data` handle.
  ASSERT_TRUE(paused_payload.contains("inputs"));
  ASSERT_TRUE(paused_payload["inputs"].is_array());
  ASSERT_EQ(paused_payload["inputs"].size(), 1u);
  const auto& entry = paused_payload["inputs"][0];
  EXPECT_EQ(entry["handle"], "data");
  EXPECT_EQ(entry["source"], "src:tensor_data");
  EXPECT_EQ(entry["value"]["type"], "tensor");
  EXPECT_EQ(entry["value"]["length"], 3);
  ASSERT_TRUE(entry["value"]["preview"].is_array());
  EXPECT_EQ(entry["value"]["preview"].size(), 3u);

  executor.debug_controller().resume();
  runner.join();
  EXPECT_TRUE(completed.load());
}

// Regression: net handles produced by `createNet` must not leak across
// runs. Before architecture-audit §M1 the engine's `destroy_net` had no
// callers, so every re-run permanently accumulated handles.
TEST(ExecutorTest, ReleasesNetHandlesBetweenRuns) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph g;
  NodeDef net;
  net.id = "net";
  net.type = "createNet";
  net.config["emptyWeights"] = "true";
  g.add_node(net);

  executor.execute(g);
  ASSERT_EQ(engine->live_handles.size(), 1u);

  // Second run: the first handle should be released before the new
  // one is allocated.
  executor.execute(g);
  EXPECT_EQ(engine->live_handles.size(), 1u);

  // And destructing the executor must release the last live handle.
  {
    Executor one_shot(engine);
    one_shot.execute(g);
    EXPECT_EQ(engine->live_handles.size(), 2u);
  }
  EXPECT_EQ(engine->live_handles.size(), 1u);
}

// Verifies that every registered handler reports non-empty identity
// metadata (type/label/category) through `describe_nodes()` and that
// the catalog is stable, sorted, and port-complete. This is the
// backend mirror of the frontend manifest cross-check.
TEST(ExecutorTest, DescribeNodesCoversAllHandlers) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  auto catalog = executor.describe_nodes();
  ASSERT_TRUE(catalog.is_array());
  EXPECT_GE(catalog.size(), 11u);  // 11 core handlers at time of writing

  // Catalog must be sorted by type for deterministic consumption.
  std::vector<std::string> types;
  for (const auto& e : catalog)
    types.push_back(e.at("type").get<std::string>());
  EXPECT_TRUE(std::is_sorted(types.begin(), types.end()));

  // Every entry has non-empty metadata and a well-formed ports array.
  static const std::unordered_set<std::string> valid_categories{"input", "inference", "output",
                                                                "control", "debug"};
  for (const auto& e : catalog) {
    EXPECT_FALSE(e.at("type").get<std::string>().empty());
    EXPECT_FALSE(e.at("label").get<std::string>().empty());
    EXPECT_TRUE(valid_categories.count(e.at("category").get<std::string>()))
        << "unknown category for type " << e.at("type");
    ASSERT_TRUE(e.at("ports").is_array());
    for (const auto& p : e.at("ports")) {
      const auto dir = p.at("direction").get<std::string>();
      EXPECT_TRUE(dir == "source" || dir == "target");
      EXPECT_FALSE(p.at("id").get<std::string>().empty());
      EXPECT_FALSE(p.at("dataType").get<std::string>().empty());
    }
  }

  // Spot-check a node with known ports (inference) to catch drift.
  auto it = std::find_if(catalog.begin(), catalog.end(),
                         [](const json& e) { return e.at("type") == "inference"; });
  ASSERT_NE(it, catalog.end());
  EXPECT_EQ(it->at("label"), "Inference");
  EXPECT_EQ(it->at("category"), "inference");
  EXPECT_EQ(it->at("ports").size(), 3u);
}

// A handler that fails must (a) emit an `error` status with a typed
// kind and (b) mark its source ports dead so downstream nodes skip
// with `reason=upstream_failed` instead of emitting their own
// misleading 'Missing input' errors.
TEST(ExecutorTest, UpstreamFailurePropagatesAsSkipNotError) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;
  // A: inference node with no inputs wired → handler will throw
  //    NodeError(MissingInput, "Missing net_handle input"). A is a
  //    *sink* from the scheduler's perspective only if we don't
  //    give it inputs; but we also need downstream nodes that would
  //    otherwise try to run, so plant B → output directly fed by A.
  NodeDef a;
  a.id = "a";
  a.type = "inference";  // will fail: no net_handle/input_data edges
  graph.add_node(a);

  NodeDef b;
  b.id = "b";
  b.type = "output";
  graph.add_node(b);

  EdgeDef e1;
  e1.source = "a";
  e1.source_handle = "output_data";
  e1.target = "b";
  e1.target_handle = "data";
  graph.add_edge(e1);

  std::unordered_map<std::string, json> statuses;  // last status per node
  executor.set_status_callback([&](const std::string& id, const json& msg) {
    if (id == "__workflow__")
      return;
    statuses[id] = msg;
  });

  executor.execute(graph);

  ASSERT_TRUE(statuses.count("a"));
  EXPECT_EQ(statuses["a"].at("status"), "error");
  EXPECT_EQ(statuses["a"].at("kind"), "missing_input");
  EXPECT_NE(statuses["a"].at("error").get<std::string>().find("net_handle"), std::string::npos);

  ASSERT_TRUE(statuses.count("b"));
  EXPECT_EQ(statuses["b"].at("status"), "skipped");
  EXPECT_EQ(statuses["b"].at("reason"), "upstream_failed");
  EXPECT_EQ(statuses["b"].at("upstream"), "a");
  // Crucially, b must not have emitted an error of its own.
  EXPECT_FALSE(statuses["b"].contains("kind"));
}

// ---------------------------------------------------------------------------
// Graph validation: every node type must be known to the handler registry,
// every edge must terminate on declared ports of the correct direction, and
// the dataType at both endpoints must be compatible. Failures emit a single
// `__workflow__`/`validation_failed` event and abort the run.
// ---------------------------------------------------------------------------

namespace {

// Capture-all listener that records every status payload keyed by node_id.
// Returns a lambda suitable for set_status_callback.
auto record_statuses(std::unordered_map<std::string, std::vector<json>>& out) {
  return [&out](const std::string& id, const json& msg) { out[id].push_back(msg); };
}

// Find the first `__workflow__` message whose `status` equals `status`,
// or nullptr if none was emitted.
const json* find_workflow_status(const std::unordered_map<std::string, std::vector<json>>& statuses,
                                 const std::string& status) {
  auto it = statuses.find("__workflow__");
  if (it == statuses.end())
    return nullptr;
  for (const auto& m : it->second) {
    if (m.value("status", "") == status)
      return &m;
  }
  return nullptr;
}

}  // namespace

TEST(ExecutorTest, ValidationRejectsUnknownNodeType) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;
  NodeDef bogus;
  bogus.id = "x";
  bogus.type = "doesNotExist";
  graph.add_node(bogus);

  std::unordered_map<std::string, std::vector<json>> statuses;
  executor.set_status_callback(record_statuses(statuses));
  executor.execute(graph);

  auto* failed = find_workflow_status(statuses, "validation_failed");
  ASSERT_NE(failed, nullptr) << "expected a validation_failed event";
  ASSERT_TRUE(failed->contains("errors"));
  const auto& errs = failed->at("errors");
  ASSERT_EQ(errs.size(), 1u);
  EXPECT_EQ(errs[0].at("kind"), "unknown_node_type");
  EXPECT_EQ(errs[0].at("node_id"), "x");

  // Node 'x' must not have been executed; no per-node running/done/error
  // for it either.
  EXPECT_EQ(statuses.count("x"), 0u);
}

TEST(ExecutorTest, ValidationRejectsUnknownPortAndTypeMismatch) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;
  // inputTensor.tensor_data (tensor, source)
  NodeDef n1;
  n1.id = "n1";
  n1.type = "inputTensor";
  n1.config["fillMode"] = "text";
  n1.config["tensorText"] = "1.0";
  graph.add_node(n1);

  // saveImage.image_data (image, target) — connecting tensor → image
  // (neither endpoint is generic, neither is branch) is a type_mismatch.
  NodeDef n2;
  n2.id = "n2";
  n2.type = "saveImage";
  graph.add_node(n2);

  // Edge 1: type_mismatch (tensor → image)
  EdgeDef bad_type;
  bad_type.source = "n1";
  bad_type.source_handle = "tensor_data";
  bad_type.target = "n2";
  bad_type.target_handle = "image_data";
  graph.add_edge(bad_type);

  // Edge 2: unknown_port on the source side.
  EdgeDef bad_port;
  bad_port.source = "n1";
  bad_port.source_handle = "nope";
  bad_port.target = "n2";
  bad_port.target_handle = "image_data";
  graph.add_edge(bad_port);

  std::unordered_map<std::string, std::vector<json>> statuses;
  executor.set_status_callback(record_statuses(statuses));
  executor.execute(graph);

  auto* failed = find_workflow_status(statuses, "validation_failed");
  ASSERT_NE(failed, nullptr);
  const auto& errs = failed->at("errors");
  ASSERT_EQ(errs.size(), 2u);

  std::unordered_set<std::string> kinds;
  for (const auto& e : errs)
    kinds.insert(e.at("kind"));
  EXPECT_TRUE(kinds.count("type_mismatch"));
  EXPECT_TRUE(kinds.count("unknown_port"));
}

TEST(ExecutorTest, ValidationAllowsGenericAndImageToTensor) {
  // Happy path: generic targets accept tensors (output.data), and the
  // image→tensor implicit coercion is respected (not tested elsewhere
  // but is the documented FE rule). Mix both in one graph to catch
  // accidental regressions together.
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;
  NodeDef src;
  src.id = "src";
  src.type = "inputTensor";
  src.config["fillMode"] = "text";
  src.config["tensorText"] = "1.0";
  graph.add_node(src);

  NodeDef sink;
  sink.id = "sink";
  sink.type = "output";  // data is `generic`
  graph.add_node(sink);

  EdgeDef e;
  e.source = "src";
  e.source_handle = "tensor_data";
  e.target = "sink";
  e.target_handle = "data";
  graph.add_edge(e);

  std::unordered_map<std::string, std::vector<json>> statuses;
  executor.set_status_callback(record_statuses(statuses));
  executor.execute(graph);

  // Must *not* emit validation_failed; sink should reach done.
  EXPECT_EQ(find_workflow_status(statuses, "validation_failed"), nullptr);
  ASSERT_TRUE(statuses.count("sink"));
  const auto& sink_msgs = statuses.at("sink");
  ASSERT_FALSE(sink_msgs.empty());
  EXPECT_EQ(sink_msgs.back().at("status"), "done");
}

// Cycles must be rejected at validate_graph time. Before this guard,
// `topological_sort` threw `std::runtime_error` from the worker thread,
// which (with no surrounding try/catch) called `std::terminate` and
// brought the entire backend down — taking every other connected
// client's session with it. The frontend already paints cyclic edges
// red, but a user clicking RUN must NOT be able to crash the server.
TEST(ExecutorTest, ValidationRejectsCycle) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  // Two `inference` nodes wired output→input both ways. `inference`
  // has both source (output_data:tensor) and target (input_data:tensor)
  // ports of compatible type, which is the minimum needed to form a
  // cycle through the typed-port validator.
  WorkflowGraph graph;
  NodeDef a;
  a.id = "a";
  a.type = "inference";
  graph.add_node(a);
  NodeDef b;
  b.id = "b";
  b.type = "inference";
  graph.add_node(b);

  EdgeDef ab;
  ab.source = "a";
  ab.source_handle = "output_data";
  ab.target = "b";
  ab.target_handle = "input_data";
  graph.add_edge(ab);

  EdgeDef ba;
  ba.source = "b";
  ba.source_handle = "output_data";
  ba.target = "a";
  ba.target_handle = "input_data";
  graph.add_edge(ba);

  std::unordered_map<std::string, std::vector<json>> statuses;
  executor.set_status_callback(record_statuses(statuses));
  // The pre-fix behaviour was std::terminate; under the fix this
  // returns cleanly with a validation_failed event.
  executor.execute(graph);

  auto* failed = find_workflow_status(statuses, "validation_failed");
  ASSERT_NE(failed, nullptr) << "expected a validation_failed event for the cycle";
  ASSERT_TRUE(failed->contains("errors"));
  const auto& errs = failed->at("errors");
  ASSERT_FALSE(errs.empty());

  // Every reported error must be a cycle (no port/type noise from
  // a cyclic graph — pass 0 short-circuits).
  std::unordered_set<std::string> cycle_nodes;
  for (const auto& e : errs) {
    EXPECT_EQ(e.at("kind"), "cycle");
    if (e.contains("node_id"))
      cycle_nodes.insert(e.at("node_id").get<std::string>());
  }
  EXPECT_TRUE(cycle_nodes.count("a"));
  EXPECT_TRUE(cycle_nodes.count("b"));

  // Neither node should have produced per-node status events: the
  // run was refused before scheduling.
  EXPECT_EQ(statuses.count("a"), 0u);
  EXPECT_EQ(statuses.count("b"), 0u);
}

// Self-loop is the degenerate cycle case. Same guarantee: no crash,
// validation_failed event names the offending node.
TEST(ExecutorTest, ValidationRejectsSelfLoop) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  WorkflowGraph graph;
  NodeDef n;
  n.id = "loop";
  n.type = "inference";
  graph.add_node(n);

  EdgeDef e;
  e.source = "loop";
  e.source_handle = "output_data";
  e.target = "loop";
  e.target_handle = "input_data";
  graph.add_edge(e);

  std::unordered_map<std::string, std::vector<json>> statuses;
  executor.set_status_callback(record_statuses(statuses));
  executor.execute(graph);

  auto* failed = find_workflow_status(statuses, "validation_failed");
  ASSERT_NE(failed, nullptr);
  const auto& errs = failed->at("errors");
  ASSERT_FALSE(errs.empty());
  EXPECT_EQ(errs[0].at("kind"), "cycle");
  EXPECT_EQ(errs[0].at("node_id"), "loop");
  EXPECT_EQ(statuses.count("loop"), 0u);
}

// W1 reconnect reconciliation: snapshot_state() must return a usable
// shape before any run has happened — empty run_id, empty statuses,
// no paused_at. The frontend calls this right after a reconnect and
// needs to tolerate a backend that never ran anything.
TEST(ExecutorTest, SnapshotStateBeforeAnyRunIsEmpty) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  json snap = executor.snapshot_state();
  ASSERT_TRUE(snap.is_object());
  EXPECT_EQ(snap.value("run_id", "missing"), "");
  ASSERT_TRUE(snap.contains("statuses"));
  EXPECT_TRUE(snap["statuses"].is_object());
  EXPECT_EQ(snap["statuses"].size(), 0u);
  EXPECT_FALSE(snap.contains("paused_at"));
}

// After a completed run, the snapshot retains the per-node terminal
// status (done/error/skipped) and the run_id, so a client that
// reconnected *after* completion can still reconcile. Running a new
// graph must clear the previous snapshot entries.
TEST(ExecutorTest, SnapshotStateReflectsCompletedRunAndClearsOnRerun) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  auto g1 = make_passthrough_graph("src", "dst");
  executor.execute(g1, "run-A");

  json snap = executor.snapshot_state();
  EXPECT_EQ(snap["run_id"], "run-A");
  EXPECT_EQ(snap["statuses"].value("src", ""), "done");
  EXPECT_EQ(snap["statuses"].value("dst", ""), "done");
  EXPECT_FALSE(snap.contains("paused_at"));

  // Second run with a *different* node id — the previous run's
  // entries must not bleed into the new snapshot.
  auto g2 = make_passthrough_graph("s2", "d2");
  executor.execute(g2, "run-B");

  json snap2 = executor.snapshot_state();
  EXPECT_EQ(snap2["run_id"], "run-B");
  EXPECT_FALSE(snap2["statuses"].contains("src"));
  EXPECT_FALSE(snap2["statuses"].contains("dst"));
  EXPECT_EQ(snap2["statuses"].value("s2", ""), "done");
  EXPECT_EQ(snap2["statuses"].value("d2", ""), "done");
}

// While a run is paused at a breakpoint, snapshot_state() must report
// `paused_at` and flag that node's status as "paused". This is the
// reconnect case that actually matters: the user hit a breakpoint,
// network blipped, and on reopen the UI needs to know to re-show the
// debug panel anchored at the right node.
TEST(ExecutorTest, SnapshotStateReportsPausedAtDuringBreakpoint) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  auto g = make_passthrough_graph("src", "dst");
  executor.debug_controller().set_breakpoints({"dst"});

  std::atomic<int> pause_count{0};
  executor.set_pause_callback([&](const std::string&, const json&) { pause_count.fetch_add(1); });

  std::thread runner([&] { executor.execute(g, "run-pause"); });

  for (int i = 0; i < 50 && pause_count.load() == 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  ASSERT_EQ(pause_count.load(), 1);

  json snap = executor.snapshot_state();
  EXPECT_EQ(snap["run_id"], "run-pause");
  EXPECT_EQ(snap.value("paused_at", ""), "dst");
  EXPECT_EQ(snap["statuses"].value("dst", ""), "paused");
  EXPECT_EQ(snap["statuses"].value("src", ""), "done");

  executor.debug_controller().resume();
  runner.join();

  // After the run completes, paused_at is cleared and the node's
  // status reflects the real terminal state.
  json snap_after = executor.snapshot_state();
  EXPECT_FALSE(snap_after.contains("paused_at"));
  EXPECT_EQ(snap_after["statuses"].value("dst", ""), "done");
}

// R1+ boundary cancel: a handler that finished *after* the user
// pressed cancel must not ship its terminal event. Before the
// post-handler `is_stopped()` check was added, the sequence went
// `running → (user cancels) → handler returns → done` and the
// client received a `done` for a node it had written off. With the
// check in place, `done` is suppressed and the loop breaks before
// touching any downstream node.
TEST(ExecutorTest, CancelAfterHandlerStartsSuppressesDoneAndStopsLoop) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);
  auto g = make_passthrough_graph("src", "dst");

  // Stop the run the moment we see `src` start running. The handler
  // itself is trivial (pass-through inputTensor), so it will finish
  // promptly — but post-handler the executor must re-check and
  // short-circuit before emitting `done` or advancing to `dst`.
  std::vector<std::pair<std::string, std::string>> events;
  std::mutex ev_mu;
  executor.set_status_callback([&](const std::string& id, const json& s) {
    std::lock_guard<std::mutex> lk(ev_mu);
    events.push_back({id, s.value("status", "")});
    if (id == "src" && s.value("status", "") == "running") {
      executor.stop();
    }
  });

  std::thread runner([&] { executor.execute(g, "run-cancel"); });
  runner.join();

  // Expected wire events: src/running, __workflow__/complete. The
  // crucial absences: no src/done (suppressed post-handler), no
  // dst/running (loop broke before reaching it).
  auto has_event = [&](const std::string& node, const std::string& st) {
    std::lock_guard<std::mutex> lk(ev_mu);
    for (auto& e : events)
      if (e.first == node && e.second == st)
        return true;
    return false;
  };
  EXPECT_TRUE(has_event("src", "running"));
  EXPECT_FALSE(has_event("src", "done"));
  EXPECT_FALSE(has_event("dst", "running"));
  EXPECT_FALSE(has_event("dst", "done"));
  // complete still fires — FE's `isRunning` flag depends on it to
  // clear, even on cancelled runs.
  EXPECT_TRUE(has_event("__workflow__", "complete"));

  // Snapshot reflects the partial state: src never received `done`
  // so it stays on the last written status, which is `running`.
  // This is acceptable because the FE's run_id filter treats a
  // cancelled run's snapshot as stale anyway.
  json snap = executor.snapshot_state();
  EXPECT_EQ(snap["statuses"].value("src", ""), "running");
  EXPECT_FALSE(snap["statuses"].contains("dst"));
}

// Symmetric case: a handler that *threw* after cancel must not ship
// its error event either. Otherwise the FE would mark a node red
// for a failure the user had already abandoned — surprising UX,
// especially when the "failure" was just the handler reacting to
// shutdown (e.g. thread interruption wrapped as an exception).
TEST(ExecutorTest, CancelAfterHandlerThrowsSuppressesErrorEvent) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  // Use a graph with a handler that always throws — the cleanest
  // way to drive the catch path without custom handler injection.
  // `inputTensor` with `fillMode=text` and malformed text triggers
  // a NodeError during execute().
  WorkflowGraph g;
  NodeDef bad;
  bad.id = "bad";
  bad.type = "inputTensor";
  bad.config["fillMode"] = "text";
  bad.config["tensorText"] = "not-a-number";  // triggers parse failure
  g.add_node(bad);

  std::vector<std::string> statuses_for_bad;
  std::mutex ev_mu;
  executor.set_status_callback([&](const std::string& id, const json& s) {
    if (id != "bad")
      return;
    std::lock_guard<std::mutex> lk(ev_mu);
    statuses_for_bad.push_back(s.value("status", ""));
    if (s.value("status", "") == "running") {
      // Request cancel while the handler is executing; by the
      // time it throws, the post-catch is_stopped() check must
      // suppress the `error` event.
      executor.stop();
    }
  });

  std::thread runner([&] { executor.execute(g, "run-err-cancel"); });
  runner.join();

  std::lock_guard<std::mutex> lk(ev_mu);
  // Sequence must be just [running] — neither `done` nor `error`.
  ASSERT_EQ(statuses_for_bad.size(), 1u);
  EXPECT_EQ(statuses_for_bad[0], "running");
}

// Benchmark cancellation: a `benchmark` handler that hits `Stop` mid-
// loop must exit promptly. Pre-fix, NcnnEngine::benchmark only checked
// the deadline (up to 60 s in the UI) so a Stop request was effectively
// ignored until the loop expired on its own. The fix threads the
// executor's stopped flag down through the engine; this test verifies
// the handler→engine wiring without needing ncnn (MockEngine simulates
// the iteration loop with a configurable target run count and records
// the cancel-poll behaviour for assertion).
TEST(ExecutorTest, BenchmarkObservesCancelMidLoop) {
  auto engine = std::make_shared<MockEngine>();
  // Many iterations so we don't accidentally complete before stop()
  // takes effect; the executor calls stop() from the status callback
  // on the first 'running' event for the benchmark node.
  engine->benchmark_target_runs = 1000;
  Executor executor(engine);

  // Graph: createNet (emptyWeights) → benchmark.input_data fed by an
  // inputTensor source (tensors are stub-routed by MockEngine::execute).
  WorkflowGraph g;
  NodeDef cn;
  cn.id = "cn";
  cn.type = "createNet";
  cn.config["emptyWeights"] = "true";
  g.add_node(cn);

  NodeDef in;
  in.id = "in";
  in.type = "inputTensor";
  in.config["fillMode"] = "text";
  in.config["tensorText"] = "1";
  g.add_node(in);

  NodeDef bm;
  bm.id = "bm";
  bm.type = "benchmark";
  bm.config["duration"] = "60";  // would be 60 s without cancel
  g.add_node(bm);

  EdgeDef e1;
  e1.source = "cn";
  e1.source_handle = "net_handle";
  e1.target = "bm";
  e1.target_handle = "net_handle";
  g.add_edge(e1);
  EdgeDef e2;
  e2.source = "in";
  e2.source_handle = "tensor_data";
  e2.target = "bm";
  e2.target_handle = "input_data";
  g.add_edge(e2);

  executor.set_status_callback([&](const std::string& id, const json& s) {
    if (id == "bm" && s.value("status", "") == "running") {
      executor.stop();
    }
  });

  std::thread runner([&] { executor.execute(g, "run-bm-cancel"); });
  runner.join();

  // The benchmark loop must have polled the cancel callback and
  // observed it true, exiting before completing all 1000 simulated
  // iterations. Without the fix `benchmark_cancelled` would be false
  // (the engine never received the callback) and we'd have run the
  // full target.
  EXPECT_TRUE(engine->benchmark_cancelled) << "benchmark engine never observed the cancel signal";
  EXPECT_GE(engine->benchmark_cancel_polls, 1);
}

// Race regression: before this fix RunSession::start published the
// new run_id only on the worker thread (inside Executor::execute),
// so a workflow.state RPC arriving in the gap between start()
// returning and the worker entering execute() would observe the
// previous run's id+statuses. Now begin_run() publishes both
// synchronously on the caller's thread, so snapshot_state called
// immediately after begin_run must reflect the new run.
TEST(ExecutorTest, BeginRunPublishesIdAndClearsStatusesSynchronously) {
  auto engine = std::make_shared<MockEngine>();
  auto executor = std::make_shared<Executor>(engine);

  // Simulate a previous run that left some node statuses around
  // and a stale id. Setting them via execute on a trivial graph is
  // simpler than reaching into private state.
  WorkflowGraph g;
  NodeDef n;
  n.id = "warm";
  n.type = "inputTensor";
  n.config["fillMode"] = "text";
  n.config["tensorText"] = "1.0";
  g.add_node(n);
  executor->execute(g, "run-old");

  // Sanity: prior run id is observable and at least one status was
  // recorded.
  auto pre = executor->snapshot_state();
  ASSERT_EQ(pre["run_id"].get<std::string>(), "run-old");
  ASSERT_TRUE(pre["statuses"].is_object());
  ASSERT_FALSE(pre["statuses"].empty());

  // The actual contract under test: begin_run must atomically
  // publish the new id AND clear the prior run's per-node statuses
  // so a same-thread snapshot_state never sees a (new id, old
  // statuses) tuple — that mismatch is exactly what the frontend's
  // reconcileFromSnapshot would have stamped onto the canvas.
  executor->begin_run("run-new");
  auto post = executor->snapshot_state();
  EXPECT_EQ(post["run_id"].get<std::string>(), "run-new");
  EXPECT_TRUE(post["statuses"].empty())
      << "begin_run must clear stale statuses; got: " << post["statuses"].dump();
}

// Companion to the begin_run contract test: ensure execute() is
// idempotent when begin_run() already published the same id, i.e.
// it must not re-clear statuses that the worker has already started
// updating between begin_run() and the lock acquisition inside
// execute(). Hard to provoke in a real race, so we drive the path
// directly: begin_run, then execute with the same id.
TEST(ExecutorTest, ExecuteDoesNotResetStateWhenBeginRunAlreadyPublished) {
  auto engine = std::make_shared<MockEngine>();
  auto executor = std::make_shared<Executor>(engine);

  WorkflowGraph g;
  NodeDef n;
  n.id = "only";
  n.type = "inputTensor";
  n.config["fillMode"] = "text";
  n.config["tensorText"] = "1.0";
  g.add_node(n);

  executor->begin_run("run-A");
  executor->execute(g, "run-A");

  // After execute completes, current_run_id_ must still be "run-A"
  // (execute did not reset it to a different value) and the node
  // status reflects the just-finished run.
  auto snap = executor->snapshot_state();
  EXPECT_EQ(snap["run_id"].get<std::string>(), "run-A");
  EXPECT_TRUE(snap["statuses"].contains("only"));
}
