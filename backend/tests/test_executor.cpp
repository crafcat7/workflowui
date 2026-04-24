#include <gtest/gtest.h>
#include "workflow/executor.h"
#include "model/workflow_graph.h"
#include "mock_engine.h"
#include <atomic>
#include <chrono>
#include <thread>

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
    EXPECT_EQ(output.size(), 10); // 2 boxes * 5
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
    node1.config["tensorText"] = "0.1 0.5 0.9 0.2 0.8"; // indices 2 and 4 are top 2
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
    EXPECT_EQ(output.size(), 4); // 2 elements * 2 (index, score)
    EXPECT_FLOAT_EQ(output[0], 2.0f);
    EXPECT_FLOAT_EQ(output[1], 0.9f);
    EXPECT_FLOAT_EQ(output[2], 4.0f);
    EXPECT_FLOAT_EQ(output[3], 0.8f);
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

} // namespace

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
    executor.set_pause_callback([&](const std::string&, const json&) {
        pause_count.fetch_add(1);
    });

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
    executor.set_pause_callback([&](const std::string& id, const json&) {
        paused_node = id;
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

    executor.debug_controller().resume();
    runner.join();
    EXPECT_TRUE(completed.load());
}
