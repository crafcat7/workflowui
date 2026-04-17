#include "workflow_graph.h"
#include <queue>
#include <stdexcept>
#include <algorithm>

namespace workflow {

void WorkflowGraph::clear() {
    nodes_.clear();
    edges_.clear();
    node_index_.clear();
}

void WorkflowGraph::add_node(const NodeDef& node) {
    node_index_[node.id] = nodes_.size();
    nodes_.push_back(node);
}

void WorkflowGraph::add_edge(const EdgeDef& edge) {
    edges_.push_back(edge);
}

const NodeDef* WorkflowGraph::get_node(const std::string& id) const {
    auto it = node_index_.find(id);
    if (it == node_index_.end()) return nullptr;
    return &nodes_[it->second];
}

std::vector<std::string> WorkflowGraph::topological_sort() const {
    // Build adjacency + in-degree
    std::unordered_map<std::string, int> in_degree;
    std::unordered_map<std::string, std::vector<std::string>> adj;

    for (auto& n : nodes_) {
        in_degree[n.id] = 0;
        adj[n.id] = {};
    }

    for (auto& e : edges_) {
        adj[e.source].push_back(e.target);
        in_degree[e.target]++;
    }

    std::queue<std::string> q;
    for (auto& [id, deg] : in_degree) {
        if (deg == 0) q.push(id);
    }

    std::vector<std::string> sorted;
    while (!q.empty()) {
        auto cur = q.front(); q.pop();
        sorted.push_back(cur);
        for (auto& next : adj[cur]) {
            if (--in_degree[next] == 0) {
                q.push(next);
            }
        }
    }

    if (sorted.size() != nodes_.size()) {
        throw std::runtime_error("Cycle detected in workflow graph");
    }

    return sorted;
}

std::vector<const EdgeDef*> WorkflowGraph::inputs_for(const std::string& node_id) const {
    std::vector<const EdgeDef*> result;
    for (auto& e : edges_) {
        if (e.target == node_id) {
            result.push_back(&e);
        }
    }
    return result;
}

} // namespace workflow
