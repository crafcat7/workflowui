// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "node.h"
#include <vector>
#include <unordered_map>
#include <string>

namespace workflow {

/**
 * Directed acyclic graph representing a workflow.
 */
class WorkflowGraph {
public:
    void add_node(const NodeDef& node);
    void add_edge(const EdgeDef& edge);

    const NodeDef* get_node(const std::string& id) const;
    const std::vector<NodeDef>& nodes() const { return nodes_; }
    const std::vector<EdgeDef>& edges() const { return edges_; }

    // Returns topologically sorted node IDs (throws if cycle detected)
    std::vector<std::string> topological_sort() const;

    // Get input edges for a given node
    std::vector<const EdgeDef*> inputs_for(const std::string& node_id) const;

private:
    std::vector<NodeDef> nodes_;
    std::vector<EdgeDef> edges_;
    std::unordered_map<std::string, size_t> node_index_;
};

} // namespace workflow
