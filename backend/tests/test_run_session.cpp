// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <thread>

#include "mock_engine.h"
#include "model/workflow_graph.h"
#include "workflow/executor.h"
#include "workflow/run_session.h"

using namespace workflow;
using workflow::testing::MockEngine;

namespace {

// A minimal one-node graph that runs almost instantly. We use it as a
// smoke test that start() actually launches a worker and that it
// terminates cleanly.
WorkflowGraph make_trivial_graph() {
  WorkflowGraph g;
  NodeDef n;
  n.id = "only";
  n.type = "inputTensor";
  n.config["fillMode"] = "text";
  n.config["tensorText"] = "1.0";
  g.add_node(n);
  return g;
}

// Busy-wait until `pred` returns true or `timeout` elapses; returns
// whether the predicate held. Used to synchronize with the worker
// thread without a condition variable in the executor.
template <class Pred>
bool wait_for(Pred pred, std::chrono::milliseconds timeout) {
  auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (pred())
      return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return pred();
}

}  // namespace

TEST(RunSessionTest, StartRunsGraphToCompletion) {
  auto engine = std::make_shared<MockEngine>();
  auto executor = std::make_shared<Executor>(engine);

  std::atomic<bool> completed{false};
  executor->set_status_callback([&](const std::string& id, const json& msg) {
    if (id == "__workflow__" && msg.value("status", "") == "complete") {
      completed = true;
    }
  });

  {
    RunSession session(executor);
    session.start(make_trivial_graph());
    EXPECT_TRUE(wait_for([&] { return completed.load(); }, std::chrono::seconds(2)))
        << "workflow did not complete within 2s";
  }  // session destructor must join the worker even after the run
     // finished; no hang here means success.

  EXPECT_TRUE(completed);
}

TEST(RunSessionTest, RestartStopsPreviousRunAndCleansUp) {
  auto engine = std::make_shared<MockEngine>();
  auto executor = std::make_shared<Executor>(engine);

  std::atomic<int> complete_events{0};
  executor->set_status_callback([&](const std::string& id, const json& msg) {
    if (id == "__workflow__" && msg.value("status", "") == "complete") {
      complete_events++;
    }
  });

  RunSession session(executor);
  // Two back-to-back start() calls: session.start() must stop+join
  // the first run before launching the second. Both graphs are
  // trivial so two complete events are expected, not one, and no
  // worker threads leak.
  session.start(make_trivial_graph());
  session.start(make_trivial_graph());

  EXPECT_TRUE(wait_for([&] { return complete_events.load() >= 1; }, std::chrono::seconds(2)));

  session.shutdown();  // idempotent; safe to call before destructor
  session.shutdown();

  // At minimum the second run must have completed; the first one may
  // or may not have emitted its 'complete' before being stopped,
  // depending on timing — both outcomes are acceptable.
  EXPECT_GE(complete_events.load(), 1);
}

TEST(RunSessionTest, StartReturnsUniqueRunIdAndTagsEvents) {
  // R1 semantics: every start() must return a distinct run_id, and
  // every status event emitted by the executor for that run must
  // carry the same id verbatim so clients can filter stale events.
  auto engine = std::make_shared<MockEngine>();
  auto executor = std::make_shared<Executor>(engine);

  std::vector<std::string> run_ids_on_events;
  std::mutex events_mu;
  executor->set_status_callback([&](const std::string&, const json& msg) {
    std::lock_guard<std::mutex> lk(events_mu);
    if (msg.contains("run_id")) {
      run_ids_on_events.push_back(msg["run_id"].get<std::string>());
    }
  });

  RunSession session(executor);
  std::string id1 = session.start(make_trivial_graph());
  EXPECT_FALSE(id1.empty());
  // Let the first run finish before starting the second so we can
  // reason about which events belong to which id without timing
  // assumptions about stop-and-relaunch.
  ASSERT_TRUE(wait_for(
      [&] {
        std::lock_guard<std::mutex> lk(events_mu);
        return !run_ids_on_events.empty();
      },
      std::chrono::seconds(2)));
  session.shutdown();

  std::string id2 = session.start(make_trivial_graph());
  EXPECT_FALSE(id2.empty());
  EXPECT_NE(id1, id2) << "successive starts must yield distinct run_ids";
  EXPECT_EQ(id2, session.current_run_id());
  session.shutdown();

  // Every observed event must have carried one of the two ids —
  // never a blank or third value.
  std::lock_guard<std::mutex> lk(events_mu);
  EXPECT_FALSE(run_ids_on_events.empty());
  for (const auto& id : run_ids_on_events) {
    EXPECT_TRUE(id == id1 || id == id2) << "unexpected run_id on status event: " << id;
  }
}

TEST(RunSessionTest, ShutdownWithoutStartIsNoop) {
  // Destroying/shutdown-ing a session that never started a run
  // must not deadlock, crash, or do anything observable.
  auto engine = std::make_shared<MockEngine>();
  auto executor = std::make_shared<Executor>(engine);
  {
    RunSession session(executor);
    session.shutdown();
    session.shutdown();
  }
  SUCCEED();
}

// Race regression: before this fix the run_id was published only on
// the worker thread inside Executor::execute, so a workflow.state RPC
// arriving in the window between start() returning to the WS thread
// and the worker entering execute() would observe the *previous*
// run's id+statuses. The frontend would then call setActiveRunId
// with the stale id and isFreshEvent would discard the new run's
// node.status events. start() now calls executor->begin_run(id)
// synchronously before launching the worker, so a snapshot taken
// immediately after start() must reflect the new run.
TEST(RunSessionTest, SnapshotAfterStartReflectsNewRunIdImmediately) {
  auto engine = std::make_shared<MockEngine>();
  auto executor = std::make_shared<Executor>(engine);

  // Prime the executor with a prior run that uses a *different*
  // node id so any leakage into the new run is detectable. We
  // build a one-off graph here rather than reuse make_trivial_graph
  // (which uses id "only" — same as the second start below).
  {
    WorkflowGraph prior;
    NodeDef n;
    n.id = "prior_node";
    n.type = "inputTensor";
    n.config["fillMode"] = "text";
    n.config["tensorText"] = "1.0";
    prior.add_node(n);
    executor->execute(prior, "run-prior");
  }
  ASSERT_EQ(executor->snapshot_state()["run_id"].get<std::string>(), "run-prior");

  RunSession session(executor);
  std::string id = session.start(make_trivial_graph());
  // Immediately — before any sleep, before the worker has a
  // realistic chance to schedule — the snapshot must already show
  // the new run with the prior run's status keys cleared. Pre-fix
  // this assertion would have flaked: the snapshot would carry
  // run-prior's id together with its `prior_node` status until
  // the worker thread reached the lock inside execute().
  auto snap = executor->snapshot_state();
  EXPECT_EQ(snap["run_id"].get<std::string>(), id);
  EXPECT_FALSE(snap["statuses"].contains("prior_node"))
      << "snapshot leaked prior run's status keys under new run_id";
  session.shutdown();
}
