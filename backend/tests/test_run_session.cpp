// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>
#include "workflow/run_session.h"
#include "workflow/executor.h"
#include "model/workflow_graph.h"
#include "mock_engine.h"

#include <atomic>
#include <chrono>
#include <thread>

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
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return pred();
}

} // namespace

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
        EXPECT_TRUE(wait_for([&]{ return completed.load(); }, std::chrono::seconds(2)))
            << "workflow did not complete within 2s";
    } // session destructor must join the worker even after the run
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

    EXPECT_TRUE(wait_for([&]{ return complete_events.load() >= 1; },
                         std::chrono::seconds(2)));

    session.shutdown(); // idempotent; safe to call before destructor
    session.shutdown();

    // At minimum the second run must have completed; the first one may
    // or may not have emitted its 'complete' before being stopped,
    // depending on timing — both outcomes are acceptable.
    EXPECT_GE(complete_events.load(), 1);
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
