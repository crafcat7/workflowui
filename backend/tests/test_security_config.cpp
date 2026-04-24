// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include <gtest/gtest.h>
#include "server/security_config.h"

#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;
using workflow::SecurityConfig;

namespace {

// Each test gets a fresh scratch directory so they don't race through the
// shared filesystem. The fixture also resets the singleton between tests
// because SecurityConfig is process-global by design.
class SecurityConfigTest : public ::testing::Test {
protected:
    fs::path tmp_;

    void SetUp() override {
        SecurityConfig::instance().reset();
        tmp_ = fs::temp_directory_path() /
               ("workflowui_sec_" + std::to_string(::testing::UnitTest::GetInstance()->random_seed()) +
                "_" + ::testing::UnitTest::GetInstance()->current_test_info()->name());
        fs::create_directories(tmp_);
    }

    void TearDown() override {
        SecurityConfig::instance().reset();
        std::error_code ec;
        fs::remove_all(tmp_, ec);
    }
};

// ── Path sandbox ──────────────────────────────────────────────────────────

TEST_F(SecurityConfigTest, NoSandboxIsPassThrough) {
    // Backward compat: when no shared_dir is set, any string is returned
    // verbatim so legacy tests and CLI-only setups keep working.
    auto& sec = SecurityConfig::instance();
    EXPECT_EQ(sec.resolve_shared_path("/etc/passwd").string(), "/etc/passwd");
    EXPECT_EQ(sec.resolve_shared_path("relative.txt").string(), "relative.txt");
}

TEST_F(SecurityConfigTest, RelativePathResolvesInsideSandbox) {
    auto& sec = SecurityConfig::instance();
    sec.set_shared_dir(tmp_.string());
    auto resolved = sec.resolve_shared_path("sub/file.txt");
    EXPECT_EQ(resolved.parent_path().parent_path(), fs::weakly_canonical(tmp_));
    EXPECT_EQ(resolved.filename(), "file.txt");
}

TEST_F(SecurityConfigTest, AbsolutePathInsideSandboxIsAccepted) {
    auto& sec = SecurityConfig::instance();
    sec.set_shared_dir(tmp_.string());
    fs::path inside = tmp_ / "ok.txt";
    auto resolved = sec.resolve_shared_path(inside.string());
    EXPECT_EQ(resolved, fs::weakly_canonical(inside));
}

TEST_F(SecurityConfigTest, DotDotTraversalIsRejected) {
    auto& sec = SecurityConfig::instance();
    sec.set_shared_dir(tmp_.string());
    EXPECT_THROW(sec.resolve_shared_path("../etc/passwd"), std::runtime_error);
    EXPECT_THROW(sec.resolve_shared_path("sub/../../outside.txt"), std::runtime_error);
}

TEST_F(SecurityConfigTest, AbsolutePathOutsideSandboxIsRejected) {
    auto& sec = SecurityConfig::instance();
    sec.set_shared_dir(tmp_.string());
    EXPECT_THROW(sec.resolve_shared_path("/etc/passwd"), std::runtime_error);
}

TEST_F(SecurityConfigTest, EmptyPathIsRejectedUnderSandbox) {
    auto& sec = SecurityConfig::instance();
    sec.set_shared_dir(tmp_.string());
    EXPECT_THROW(sec.resolve_shared_path(""), std::runtime_error);
}

TEST_F(SecurityConfigTest, NonExistentTargetIsResolvedForWriteNodes) {
    // saveText / saveImage point at files that don't exist yet; weakly_canonical
    // must accept that and still apply the sandbox check.
    auto& sec = SecurityConfig::instance();
    sec.set_shared_dir(tmp_.string());
    auto resolved = sec.resolve_shared_path("output/result.png");
    EXPECT_EQ(resolved.filename(), "result.png");
    EXPECT_FALSE(fs::exists(resolved));
}

TEST_F(SecurityConfigTest, EmptySharedDirDisablesSandbox) {
    auto& sec = SecurityConfig::instance();
    sec.set_shared_dir(tmp_.string());
    EXPECT_TRUE(sec.shared_dir().has_value());
    sec.set_shared_dir("");
    EXPECT_FALSE(sec.shared_dir().has_value());
    // Pass-through again:
    EXPECT_EQ(sec.resolve_shared_path("/etc/passwd").string(), "/etc/passwd");
}

// ── Origin allow-list ────────────────────────────────────────────────────

TEST_F(SecurityConfigTest, NoAllowListPermitsEverything) {
    auto& sec = SecurityConfig::instance();
    EXPECT_FALSE(sec.has_origin_allowlist());
    EXPECT_TRUE(sec.is_origin_allowed("http://anywhere.example"));
    EXPECT_TRUE(sec.is_origin_allowed(""));
}

TEST_F(SecurityConfigTest, AllowListMatchesExactOrigin) {
    auto& sec = SecurityConfig::instance();
    sec.add_allowed_origin("http://localhost:5173");
    EXPECT_TRUE(sec.has_origin_allowlist());
    EXPECT_TRUE(sec.is_origin_allowed("http://localhost:5173"));
    EXPECT_FALSE(sec.is_origin_allowed("http://evil.example"));
}

TEST_F(SecurityConfigTest, AllowListIsCaseInsensitive) {
    // RFC 6454 treats scheme/host as case-insensitive; ports are numeric.
    auto& sec = SecurityConfig::instance();
    sec.add_allowed_origin("http://Localhost:5173");
    EXPECT_TRUE(sec.is_origin_allowed("HTTP://localhost:5173"));
    EXPECT_TRUE(sec.is_origin_allowed("http://LOCALHOST:5173"));
}

TEST_F(SecurityConfigTest, EmptyOriginIsAllowedWhenListConfigured) {
    // Native/CLI clients don't send Origin; rejecting them would break
    // local tooling. If stricter behavior is needed, a separate flag
    // should gate it rather than overloading the allow-list.
    auto& sec = SecurityConfig::instance();
    sec.add_allowed_origin("tauri://localhost");
    EXPECT_TRUE(sec.is_origin_allowed(""));
}

TEST_F(SecurityConfigTest, TauriOriginIsMatched) {
    auto& sec = SecurityConfig::instance();
    sec.add_allowed_origin("tauri://localhost");
    EXPECT_TRUE(sec.is_origin_allowed("tauri://localhost"));
    EXPECT_FALSE(sec.is_origin_allowed("tauri://other"));
}

TEST_F(SecurityConfigTest, ClearAllowedOriginsDisablesCheck) {
    auto& sec = SecurityConfig::instance();
    sec.add_allowed_origin("http://localhost:5173");
    sec.clear_allowed_origins();
    EXPECT_FALSE(sec.has_origin_allowlist());
    EXPECT_TRUE(sec.is_origin_allowed("http://anywhere.example"));
}

} // namespace
