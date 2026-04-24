// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "scheduler.h"

namespace workflow {

std::vector<std::string> Scheduler::schedule(const WorkflowGraph& graph) {
    return graph.topological_sort();
}

} // namespace workflow
