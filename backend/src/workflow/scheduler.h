// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "../model/workflow_graph.h"
#include "../model/node.h"
#include <vector>
#include <string>

namespace workflow {

/**
 * Schedules nodes for execution via topological sort.
 */
class Scheduler {
public:
    // Returns ordered list of node IDs to execute
    std::vector<std::string> schedule(const WorkflowGraph& graph);
};

} // namespace workflow
