// SPDX-License-Identifier: MIT
// Copyright (c) 2026 workflowUI contributors
#include "security_config.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <system_error>

namespace workflow {

namespace fs = std::filesystem;

namespace {

std::string to_lower(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    return out;
}

// Return true iff `child` equals `parent` or is nested within it. Both are
// assumed to already be in weakly_canonical form (absolute, no "..").
bool is_within(const fs::path& parent, const fs::path& child) {
    auto p_it = parent.begin();
    auto c_it = child.begin();
    for (; p_it != parent.end(); ++p_it, ++c_it) {
        if (c_it == child.end()) return false;
        if (*p_it != *c_it) return false;
    }
    return true;
}

} // namespace

SecurityConfig& SecurityConfig::instance() {
    static SecurityConfig inst;
    return inst;
}

void SecurityConfig::set_shared_dir(const std::string& dir) {
    if (dir.empty()) {
        shared_dir_.reset();
        return;
    }
    std::error_code ec;
    fs::path canonical = fs::weakly_canonical(fs::path(dir), ec);
    // weakly_canonical tolerates non-existent paths; on hard error fall back
    // to absolute+lexically_normal so the sandbox is still enforceable.
    if (ec) {
        canonical = fs::absolute(fs::path(dir)).lexically_normal();
    }
    shared_dir_ = std::move(canonical);
}

void SecurityConfig::add_allowed_origin(const std::string& origin) {
    if (origin.empty()) return;
    allow_origins_.insert(to_lower(origin));
}

void SecurityConfig::clear_allowed_origins() {
    allow_origins_.clear();
}

bool SecurityConfig::is_origin_allowed(std::string_view origin) const {
    // No allow-list configured → everything is allowed. This preserves the
    // pre-Phase-6 behavior for native/CLI clients and tests.
    if (allow_origins_.empty()) return true;
    // Browsers always send an Origin on cross-origin WS upgrades. Non-browser
    // clients (curl, native apps without setting Origin) get a pass so the
    // allow-list doesn't break local tooling. If a stricter policy is ever
    // needed, add a separate `require_origin` flag rather than overloading
    // the allow-list semantics.
    if (origin.empty()) return true;
    return allow_origins_.count(to_lower(origin)) > 0;
}

fs::path SecurityConfig::resolve_shared_path(const std::string& user_path) const {
    if (!shared_dir_) {
        // Sandboxing disabled; legacy behavior (resolve against CWD as before).
        return fs::path(user_path);
    }
    if (user_path.empty()) {
        throw std::runtime_error("empty path not allowed inside sandbox");
    }

    // Resolve relative paths against the sandbox root; keep absolute paths as
    // given. weakly_canonical collapses "..", symlinks, and "." segments.
    fs::path raw(user_path);
    fs::path joined = raw.is_absolute() ? raw : (*shared_dir_ / raw);
    std::error_code ec;
    fs::path canonical = fs::weakly_canonical(joined, ec);
    if (ec) {
        canonical = joined.lexically_normal();
    }

    if (!is_within(*shared_dir_, canonical)) {
        throw std::runtime_error(
            "path '" + user_path + "' escapes shared directory");
    }
    return canonical;
}

void SecurityConfig::reset() {
    shared_dir_.reset();
    allow_origins_.clear();
}

} // namespace workflow
