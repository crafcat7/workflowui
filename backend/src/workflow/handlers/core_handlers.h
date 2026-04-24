#pragma once
#include "node_handler.h"

namespace workflow {
namespace handlers {

// Register all core handlers into a registry (map)
void register_core_handlers(std::unordered_map<std::string, std::shared_ptr<NodeHandler>>& registry);

} // namespace handlers
} // namespace workflow
