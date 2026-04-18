cmake_minimum_required(VERSION 3.16)
project(workflow_backend LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ── Options ──────────────────────────────────────────
option(ENABLE_NCNN "Enable NCNN vendor backend" OFF)

# ── Dependencies ─────────────────────────────────────
# nlohmann/json (header-only)
include(FetchContent)
FetchContent_Declare(
  json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(json)

# uWebSockets requires uSockets
FetchContent_Declare(
  usockets
  GIT_REPOSITORY https://github.com/uNetworking/uSockets.git
  GIT_TAG v0.8.8
  GIT_SHALLOW TRUE
)
FetchContent_GetProperties(usockets)
if(NOT usockets_POPULATED)
  FetchContent_Populate(usockets)
endif()

FetchContent_Declare(
  uwebsockets
  GIT_REPOSITORY https://github.com/uNetworking/uWebSockets.git
  GIT_TAG v20.70.0
  GIT_SHALLOW TRUE
)
FetchContent_GetProperties(uwebsockets)
if(NOT uwebsockets_POPULATED)
  FetchContent_Populate(uwebsockets)
endif()

# Build uSockets as a static library
file(GLOB USOCKETS_SRC "${usockets_SOURCE_DIR}/src/*.c" "${usockets_SOURCE_DIR}/src/eventing/*.c" "${usockets_SOURCE_DIR}/src/crypto/*.c")
add_library(uSockets STATIC ${USOCKETS_SRC})
target_include_directories(uSockets PUBLIC "${usockets_SOURCE_DIR}/src")
target_compile_definitions(uSockets PUBLIC LIBUS_NO_SSL)

# ── Sources ──────────────────────────────────────────
set(BACKEND_SOURCES
  src/main.cpp
  src/server/ws_server.cpp
  src/server/rpc_handler.cpp
  src/capability/registry.cpp
  src/workflow/executor.cpp
  src/workflow/scheduler.cpp
  src/workflow/debug_controller.cpp
  src/workflow/handlers/core_handlers.cpp
  src/model/node.cpp
  src/model/workflow_graph.cpp
)

if(ENABLE_NCNN)
  list(APPEND BACKEND_SOURCES src/vendor/ncnn/ncnn_engine.cpp)
endif()

add_executable(workflow_backend ${BACKEND_SOURCES})

target_include_directories(workflow_backend PRIVATE
  src
  "${uwebsockets_SOURCE_DIR}/src"
  "${usockets_SOURCE_DIR}/src"
)

target_link_libraries(workflow_backend PRIVATE
  nlohmann_json::nlohmann_json
  uSockets
  pthread
  z
)

if(ENABLE_NCNN)
  find_package(ncnn REQUIRED)
  target_link_libraries(workflow_backend PRIVATE ncnn)
  target_compile_definitions(workflow_backend PRIVATE ENABLE_NCNN=1)
endif()

# ── Tests ────────────────────────────────────────────
enable_testing()

include(FetchContent)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/archive/03597a01ee50ed33e9dfd640b249b4be3799d395.zip
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

# Remove main.cpp from sources so it doesn't conflict with gtest_main
set(BACKEND_LIB_SOURCES ${BACKEND_SOURCES})
list(REMOVE_ITEM BACKEND_LIB_SOURCES src/main.cpp)

set(BACKEND_TEST_SOURCES
  tests/main_test.cpp
  tests/test_executor.cpp
)

add_executable(workflow_test ${BACKEND_TEST_SOURCES} ${BACKEND_LIB_SOURCES})

target_include_directories(workflow_test PRIVATE
  src
  "${uwebsockets_SOURCE_DIR}/src"
  "${usockets_SOURCE_DIR}/src"
)

target_link_libraries(workflow_test PRIVATE
  gtest_main
  nlohmann_json::nlohmann_json
  uSockets
  pthread
  z
)

if(ENABLE_NCNN)
  target_link_libraries(workflow_test PRIVATE ncnn)
  target_compile_definitions(workflow_test PRIVATE ENABLE_NCNN=1)
endif()

include(GoogleTest)
gtest_discover_tests(workflow_test)

# ── Install ──────────────────────────────────────────
install(TARGETS workflow_backend DESTINATION bin)
