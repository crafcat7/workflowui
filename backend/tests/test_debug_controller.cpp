// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>
#include "workflow/debug_controller.h"

#include <atomic>
#include <chrono>
#include <thread>

using namespace workflow;
using namespace std::chrono_literals;

namespace {

// Short spin helper: waits up to `timeout` for `pred` to become true,
// polling every 1 ms. Returns whether the predicate ultimately held.
// Used instead of blindly sleeping so tests pass quickly on fast
// machines and don't flake on slow ones.
template <typename Pred>
bool wait_for(Pred pred, std::chrono::milliseconds timeout = 2s) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (pred()) return true;
        std::this_thread::sleep_for(1ms);
    }
    return pred();
}

} // namespace

TEST(DebugControllerTest, WaitAndResumeRoundTrip) {
    // Baseline: worker calls begin_pause + wait_for_resume, stays
    // blocked, main thread calls resume, worker unblocks.
    DebugController dc;
    std::atomic<bool> woke{false};
    dc.begin_pause();
    std::thread worker([&] {
        dc.wait_for_resume();
        woke.store(true);
    });

    std::this_thread::sleep_for(20ms);
    EXPECT_FALSE(woke.load()) << "worker should still be waiting";

    dc.resume();
    EXPECT_TRUE(wait_for([&] { return woke.load(); }));
    worker.join();
}

TEST(DebugControllerTest, ResumeBeforeWaitDoesNotStrandWorker) {
    // The race the epoch fix targets: a `resume` fired from the UI
    // thread can land before the worker enters `wait_for_resume`.
    //
    // The contract is: executor calls `begin_pause()` BEFORE
    // publishing the pause event (which is what unblocks the UI to
    // send resume). `begin_pause` snapshots the current epoch under
    // the lock. Any subsequent resume — even one that completes its
    // notify into an empty waiter set — advances `resume_epoch_`
    // past the snapshot, so when the worker finally takes the lock
    // in `wait_for_resume` the predicate
    // `resume_epoch_ > snapshot` is already true and the wait
    // returns immediately.
    //
    // Stress the race across many iterations: interleave begin_pause
    // → spawn worker → resume with no sleep so resume sometimes
    // lands before the worker reaches cv_.wait.
    for (int i = 0; i < 200; ++i) {
        DebugController dc;
        std::atomic<bool> woke{false};
        dc.begin_pause();
        std::thread worker([&] {
            dc.wait_for_resume();
            woke.store(true);
        });
        dc.resume();
        ASSERT_TRUE(wait_for([&] { return woke.load(); }, 500ms))
            << "worker stranded on iteration " << i;
        worker.join();
    }
}

TEST(DebugControllerTest, StopUnblocksWaitingWorker) {
    DebugController dc;
    std::atomic<bool> woke{false};
    dc.begin_pause();
    std::thread worker([&] {
        dc.wait_for_resume();
        woke.store(true);
    });
    std::this_thread::sleep_for(10ms);
    dc.stop();
    EXPECT_TRUE(wait_for([&] { return woke.load(); }));
    EXPECT_TRUE(dc.is_stopped());
    worker.join();
}

TEST(DebugControllerTest, StepOverResumesAndArmsSteppingFlag) {
    DebugController dc;
    std::atomic<bool> woke{false};
    dc.begin_pause();
    std::thread worker([&] {
        dc.wait_for_resume();
        woke.store(true);
    });
    std::this_thread::sleep_for(10ms);
    dc.step_over();
    EXPECT_TRUE(wait_for([&] { return woke.load(); }));
    EXPECT_TRUE(dc.should_pause("node-with-no-breakpoint"));
    worker.join();
}

TEST(DebugControllerTest, ResetClearsStopAndPauseButKeepsBreakpoints) {
    // `reset` is called at the start of each new run. Per the header
    // contract, it clears transient flags but preserves the user's
    // breakpoint set — losing breakpoints between runs would be a
    // terrible debugging experience.
    DebugController dc;
    dc.add_breakpoint("bp1");
    dc.stop();
    EXPECT_TRUE(dc.is_stopped());

    dc.reset();
    EXPECT_FALSE(dc.is_stopped());
    EXPECT_TRUE(dc.has_breakpoint("bp1"));
    // `stepping_` is internal; proxy the check through should_pause:
    // with stepping_ cleared, a node without a breakpoint must NOT
    // pause.
    EXPECT_FALSE(dc.should_pause("no-bp"));
    EXPECT_TRUE(dc.should_pause("bp1"));
}

TEST(DebugControllerTest, ConcurrentResumersAreSafe) {
    DebugController dc;
    std::atomic<bool> woke{false};
    dc.begin_pause();
    std::thread worker([&] {
        dc.wait_for_resume();
        woke.store(true);
    });
    std::this_thread::sleep_for(10ms);

    std::vector<std::thread> resumers;
    for (int i = 0; i < 8; ++i) {
        resumers.emplace_back([&] { dc.resume(); });
    }
    for (auto& t : resumers) t.join();

    EXPECT_TRUE(wait_for([&] { return woke.load(); }));
    worker.join();
}
