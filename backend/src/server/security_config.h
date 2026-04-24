// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>

namespace workflow {

/**
 * Process-wide security policy.
 *
 * Two orthogonal policies live here:
 *   1. A shared-directory sandbox. When `shared_dir` is set, every filesystem
 *      path coming from workflow config (inputImage, saveText, saveImage,
 *      createNet) must resolve inside that directory; paths that escape via
 *      "..", absolute targets, or symlinks are rejected.
 *   2. A WebSocket Origin allow-list. When `allow_origins` is non-empty, the
 *      ws server's HTTP upgrade handler refuses connections whose `Origin`
 *      header is not present in the set. Connections with no Origin header
 *      (e.g. native clients, curl) are allowed because browsers always send
 *      one for cross-origin WebSocket upgrades — see RFC 6455 §4.1.
 *
 * When `shared_dir` is unset, path resolution is a pass-through (legacy
 * behavior). When `allow_origins` is empty, the origin check is skipped.
 * Both are opt-in and configured via CLI flags in main.cpp.
 *
 * The config is process-global and set once at startup; handlers read it
 * through `SecurityConfig::instance()`. This avoids threading a context
 * object through every NodeHandler::execute signature.
 */
class SecurityConfig {
public:
    static SecurityConfig& instance();

    // Set the sandbox root. Empty/unset string disables sandboxing.
    // The path is canonicalized via weakly_canonical, so it does not need
    // to exist on disk yet — handlers that write new files still resolve
    // correctly as long as their targets land under this root.
    void set_shared_dir(const std::string& dir);
    const std::optional<std::filesystem::path>& shared_dir() const { return shared_dir_; }

    // Add an allowed Origin header value (case-insensitive). Typical values:
    // "http://localhost:5173", "tauri://localhost".
    void add_allowed_origin(const std::string& origin);
    void clear_allowed_origins();
    bool is_origin_allowed(std::string_view origin) const;
    bool has_origin_allowlist() const { return !allow_origins_.empty(); }

    // Resolve a user-supplied path against the sandbox. If no sandbox is
    // configured, returns the path unchanged. Otherwise returns the
    // canonicalized absolute path, guaranteed to be inside `shared_dir_`,
    // or throws std::runtime_error if the path escapes the sandbox.
    //
    // The path need not exist on disk; resolution uses
    // std::filesystem::weakly_canonical so that write targets (saveText,
    // saveImage) can point at files that will only be created by the node.
    std::filesystem::path resolve_shared_path(const std::string& user_path) const;

    // Reset to defaults. For tests.
    void reset();

private:
    SecurityConfig() = default;

    std::optional<std::filesystem::path> shared_dir_;
    // Stored lowercased for case-insensitive comparison.
    std::unordered_set<std::string> allow_origins_;
};

} // namespace workflow
