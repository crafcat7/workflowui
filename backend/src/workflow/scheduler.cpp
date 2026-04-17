#include "scheduler.h"

namespace workflow {

std::vector<std::string> Scheduler::schedule(const WorkflowGraph& graph) {
    return graph.topological_sort();
}

} // namespace workflow
