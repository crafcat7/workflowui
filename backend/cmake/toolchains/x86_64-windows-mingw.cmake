# SPDX-License-Identifier: MIT
# Copyright (c) 2026 workflowUI contributors
#
# Cross-compile toolchain: x86_64-w64-mingw32 (MinGW-w64).
#
# Usage (from the repo root, after `apt-get install mingw-w64`):
#
#   cmake -S backend -B backend/build-windows \
#     -DCMAKE_TOOLCHAIN_FILE=backend/cmake/toolchains/x86_64-windows-mingw.cmake \
#     -DENABLE_NCNN=OFF
#   cmake --build backend/build-windows -j
#
# Produces workflow_backend.exe and workflow_test.exe; run them via wine
# in CI or on a Windows host. The runtime DLL dependencies (libstdc++-6,
# libgcc_s_seh-1, libwinpthread-1) ship with the MinGW toolchain.

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(CMAKE_C_COMPILER   x86_64-w64-mingw32-gcc)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++)
set(CMAKE_RC_COMPILER  x86_64-w64-mingw32-windres)

# Static-link the MinGW runtime so the .exe runs on a vanilla Windows
# install without extra DLLs sitting next to it.
set(CMAKE_EXE_LINKER_FLAGS_INIT
    "-static-libgcc -static-libstdc++ -static -lpthread")

set(CMAKE_FIND_ROOT_PATH /usr/x86_64-w64-mingw32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
