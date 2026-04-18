#include <gtest/gtest.h>
#include "workflow/executor.h"
#include "model/workflow_graph.h"

using namespace workflow;

// A simple stub engine for testing
class MockEngine : public InferenceEngine {
public:
    std::string name() const override { return "mock"; }
    std::vector<ConfigFieldSchema> config_schema() const override { return {}; }
    NetHandle init_net(const NetConfig&) override { return 1; }
    void configure(NetHandle, const NetConfig&) override {}
    InferResult execute(NetHandle, const TensorData& input) override {
        return {input, std::chrono::milliseconds(1)};
    }
    BenchmarkResult benchmark(NetHandle, const TensorData&, int) override {
        return {1, 1.0, 1.0, 1.0};
    }
    void destroy_net(NetHandle) override {}
};

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
