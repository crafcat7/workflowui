// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>

#include <atomic>

#include "mock_engine.h"
#include "model/workflow_graph.h"
#include "workflow/executor.h"
#include "workflow/handlers/condition_expr.h"

using namespace workflow;
using namespace workflow::handlers;
using workflow::testing::MockEngine;

// ── Expression parser ─────────────────────────────────────────────────────

TEST(ConditionExpr, BooleanLiterals) {
  PortValue empty{};
  EXPECT_TRUE(evaluate_condition("true", empty));
  EXPECT_FALSE(evaluate_condition("false", empty));
  EXPECT_TRUE(evaluate_condition("  true  ", empty));
}

TEST(ConditionExpr, BareNumberLegacySemantics) {
  // Pre-Phase-7 behavior: "0.5" means "first element > 0.5".
  TensorData t = {0.9f, 0.1f};
  EXPECT_TRUE(evaluate_condition("0.5", PortValue{t}));

  TensorData low = {0.1f, 0.9f};
  EXPECT_FALSE(evaluate_condition("0.5", PortValue{low}));
}

TEST(ConditionExpr, FirstSelectorComparison) {
  TensorData t = {0.9f, 0.1f};
  EXPECT_TRUE(evaluate_condition("first > 0.5", PortValue{t}));
  EXPECT_TRUE(evaluate_condition("first >= 0.9", PortValue{t}));
  EXPECT_FALSE(evaluate_condition("first == 0.5", PortValue{t}));
  EXPECT_TRUE(evaluate_condition("first != 0.5", PortValue{t}));
}

TEST(ConditionExpr, AggregateSelectors) {
  TensorData t = {1.0f, 2.0f, 3.0f, 4.0f};
  EXPECT_TRUE(evaluate_condition("max > 3.5", PortValue{t}));
  EXPECT_TRUE(evaluate_condition("min < 2", PortValue{t}));
  EXPECT_TRUE(evaluate_condition("sum == 10", PortValue{t}));
  EXPECT_TRUE(evaluate_condition("mean == 2.5", PortValue{t}));
}

TEST(ConditionExpr, IndexedSelector) {
  TensorData t = {5.0f, 10.0f, 15.0f};
  EXPECT_TRUE(evaluate_condition("[2] > 14", PortValue{t}));
  EXPECT_TRUE(evaluate_condition("[0] == 5", PortValue{t}));
  // Out-of-range selector → false with error message.
  std::string err;
  EXPECT_FALSE(evaluate_condition("[99] > 0", PortValue{t}, &err));
  EXPECT_FALSE(err.empty());
}

TEST(ConditionExpr, ScalarInput) {
  EXPECT_TRUE(evaluate_condition("first > 0.5", PortValue{0.9f}));
  EXPECT_TRUE(evaluate_condition("first > 0.5", PortValue{int64_t{1}}));
  EXPECT_FALSE(evaluate_condition("first > 0.5", PortValue{0.1f}));
}

TEST(ConditionExpr, TruthyBareSelector) {
  TensorData t = {0.0f, 1.0f};
  // "[1]" → 1.0 → truthy.
  EXPECT_TRUE(evaluate_condition("[1]", PortValue{t}));
  EXPECT_FALSE(evaluate_condition("[0]", PortValue{t}));
}

TEST(ConditionExpr, EmptyExpressionFails) {
  std::string err;
  EXPECT_FALSE(evaluate_condition("", PortValue{}, &err));
  EXPECT_FALSE(err.empty());
}

TEST(ConditionExpr, WhitespaceTolerant) {
  TensorData t = {1.0f};
  EXPECT_TRUE(evaluate_condition("  first   >=   1.0  ", PortValue{t}));
}

// ── Executor branch-skip ──────────────────────────────────────────────────

namespace {

// Build a graph:
//   input(n1) --tensor--> cond(c)
//       cond.true_branch  --> out_true(ot)
//       cond.false_branch --> out_false(of)
// With a given expression. The expression is evaluated against {1, 2, 3}.
WorkflowGraph make_branching_graph(const std::string& expr) {
  WorkflowGraph g;
  NodeDef n1;
  n1.id = "n1";
  n1.type = "inputTensor";
  n1.config["fillMode"] = "text";
  n1.config["tensorText"] = "1 2 3";
  g.add_node(n1);

  NodeDef c;
  c.id = "c";
  c.type = "condition";
  c.config["expression"] = expr;
  g.add_node(c);

  NodeDef ot;
  ot.id = "ot";
  ot.type = "output";
  g.add_node(ot);

  NodeDef of;
  of.id = "of";
  of.type = "output";
  g.add_node(of);

  EdgeDef e1{"n1", "tensor_data", "c", "input_data"};
  EdgeDef e2{"c", "true_branch", "ot", "data"};
  EdgeDef e3{"c", "false_branch", "of", "data"};
  g.add_edge(e1);
  g.add_edge(e2);
  g.add_edge(e3);
  return g;
}

struct StatusRecorder {
  std::unordered_map<std::string, std::string> last_status_by_node;

  StatusCallback as_callback() {
    return [this](const std::string& id, const json& s) {
      last_status_by_node[id] = s.value("status", "");
    };
  }
};

}  // namespace

TEST(ExecutorBranching, TrueBranchTakenFalseBranchSkipped) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  auto g = make_branching_graph("first > 0.5");  // 1.0 > 0.5 → true

  StatusRecorder rec;
  executor.set_status_callback(rec.as_callback());

  executor.execute(g);

  EXPECT_EQ(rec.last_status_by_node["c"], "done");
  EXPECT_EQ(rec.last_status_by_node["ot"], "done");
  EXPECT_EQ(rec.last_status_by_node["of"], "skipped");
}

TEST(ExecutorBranching, FalseBranchTakenTrueBranchSkipped) {
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  auto g = make_branching_graph("max > 100");  // 3 > 100 → false

  StatusRecorder rec;
  executor.set_status_callback(rec.as_callback());

  executor.execute(g);

  EXPECT_EQ(rec.last_status_by_node["c"], "done");
  EXPECT_EQ(rec.last_status_by_node["of"], "done");
  EXPECT_EQ(rec.last_status_by_node["ot"], "skipped");
}

TEST(ExecutorBranching, SkipPropagatesThroughChain) {
  // Two-hop false chain: cond.false_branch -> mid(debug) -> sink(output)
  auto engine = std::make_shared<MockEngine>();
  Executor executor(engine);

  auto g = make_branching_graph("true");

  NodeDef mid;
  mid.id = "mid";
  mid.type = "debug";
  g.add_node(mid);

  NodeDef sink;
  sink.id = "sink";
  sink.type = "output";
  g.add_node(sink);

  // Re-wire: disconnect of and route false_branch through mid -> sink.
  // (The existing of node stays in the graph but is also skipped.)
  g.add_edge(EdgeDef{"c", "false_branch", "mid", "data_in"});
  g.add_edge(EdgeDef{"mid", "data_out", "sink", "data"});

  StatusRecorder rec;
  executor.set_status_callback(rec.as_callback());

  executor.execute(g);

  EXPECT_EQ(rec.last_status_by_node["c"], "done");
  EXPECT_EQ(rec.last_status_by_node["ot"], "done");
  EXPECT_EQ(rec.last_status_by_node["mid"], "skipped");
  EXPECT_EQ(rec.last_status_by_node["sink"], "skipped");
}
