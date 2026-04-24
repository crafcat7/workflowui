# SPDX-License-Identifier: MIT
# Copyright (c) 2026 workflowUI contributors
#
# Cross-compile toolchain: aarch64-linux-gnu.
#
# Usage (from the repo root, after `apt-get install gcc-aarch64-linux-gnu
# g++-aarch64-linux-gnu`):
#
#   cmake -S backend -B backend/build-aarch64-linux \
#     -DCMAKE_TOOLCHAIN_FILE=backend/cmake/toolchains/aarch64-linux.cmake \
#     -DENABLE_NCNN=OFF
#   cmake --build backend/build-aarch64-linux -j
#
# Running the resulting binary requires qemu-user or a real aarch64 host.
# The CI workflow uses qemu-user-static to execute workflow_test.

set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)

set(CMAKE_C_COMPILER   aarch64-linux-gnu-gcc)
set(CMAKE_CXX_COMPILER aarch64-linux-gnu-g++)

# Only find target libraries in the sysroot, but let cmake still look at the
# host for programs (for FetchContent-built generators like protoc, etc.).
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
