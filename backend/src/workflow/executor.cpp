#include "executor.h"
#include <chrono>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <iostream>

namespace workflow {

Executor::Executor(std::shared_ptr<InferenceEngine> engine)
    : engine_(std::move(engine)) {}

void Executor::execute(const WorkflowGraph& graph) {
    debug_.reset();
    port_data_.clear();

    auto order = scheduler_.schedule(graph);

    for (auto& node_id : order) {
        if (debug_.is_stopped()) break;

        auto* node = graph.get_node(node_id);
        if (!node) continue;

        // Check for breakpoint / debug node
        bool is_debug = (node->type == "debug");
        if (is_debug || debug_.should_pause(node_id)) {
            // Notify frontend we're paused
            json data;
            data["node_id"] = node_id;
            data["type"] = node->type;
            if (pause_cb_) pause_cb_(node_id, data);

            debug_.wait_for_resume();
            if (debug_.is_stopped()) break;
        }

        notify_status(node_id, "running");

        try {
            json extra = execute_node(*node, graph);
            notify_status(node_id, "done", extra);
        } catch (const std::exception& e) {
            json err;
            err["error"] = e.what();
            notify_status(node_id, "error", err);
        }
    }

    // Notify completion
    if (status_cb_) {
        json complete;
        complete["status"] = "complete";
        status_cb_("__workflow__", complete);
    }
}

void Executor::stop() {
    debug_.stop();
}

json Executor::execute_node(const NodeDef& node, const WorkflowGraph& graph) {
    const auto& type = node.type;
    const auto& config = node.config;
    json extra;

    auto get_config = [&](const std::string& key) -> std::string {
        auto it = config.find(key);
        return (it != config.end()) ? it->second : "";
    };

    if (type == "inputImage") {
        // Read image file → store as ImageData
        std::string path = get_config("filePath");
        std::ifstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("Cannot open image: " + path);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());
        ImageData img;
        img.pixels = std::move(data);
        port_data_[node.id + ":image_data"] = std::move(img);

    } else if (type == "inputTensor") {
        TensorData tensor;
        std::string mode = get_config("fillMode");
        
        if (mode == "auto") {
            std::string shape_str = get_config("shape");
            std::string fill_str = get_config("fillValue");
            
            float fill_val = 0.0f;
            if (!fill_str.empty()) {
                try { fill_val = std::stof(fill_str); } catch (...) {}
            }
            
            int total_size = 1;
            std::string token;
            std::istringstream ss(shape_str);
            while (std::getline(ss, token, ',')) {
                try {
                    int dim = std::stoi(token);
                    if (dim > 0) total_size *= dim;
                } catch (...) {}
            }
            if (total_size <= 0) total_size = 1;
            
            tensor.assign(total_size, fill_val);
            
        } else {
            // Parse text into tensor
            std::string text = get_config("tensorText");
            std::istringstream iss(text);
            float val;
            while (iss >> val) {
                tensor.push_back(val);
            }
        }
        
        port_data_[node.id + ":tensor_data"] = std::move(tensor);

    } else if (type == "createNet") {
        NetConfig nc;
        nc.model_path = get_config("modelPath");
        nc.param_path = get_config("paramPath");
        auto in_name = get_config("inputName");
        if (!in_name.empty()) nc.input_name = in_name;
        auto out_name = get_config("outputName");
        if (!out_name.empty()) nc.output_name = out_name;
        auto threads_str = get_config("numThreads");
        if (!threads_str.empty()) nc.num_threads = std::stoi(threads_str);
        auto iw = get_config("inputW");
        if (!iw.empty()) nc.input_w = std::stoi(iw);
        auto ih = get_config("inputH");
        if (!ih.empty()) nc.input_h = std::stoi(ih);
        auto ic = get_config("inputC");
        if (!ic.empty()) nc.input_c = std::stoi(ic);
        auto ew = get_config("emptyWeights");
        if (ew == "true" || ew == "1") nc.empty_weights = true;

        auto start = std::chrono::high_resolution_clock::now();
        auto handle = engine_->init_net(nc);
        auto end = std::chrono::high_resolution_clock::now();
        double ms = std::chrono::duration<double, std::milli>(end - start).count();

        port_data_[node.id + ":net_handle"] = static_cast<int64_t>(handle);

        extra["elapsed_ms"] = ms;

    } else if (type == "inference") {
        auto handle_val = resolve_input(node.id, "net_handle", graph);
        auto input_val = resolve_input(node.id, "input_data", graph);

        if (std::holds_alternative<std::monostate>(handle_val)) throw std::runtime_error("Missing net_handle input");
        if (std::holds_alternative<std::monostate>(input_val)) throw std::runtime_error("Missing input_data");

        auto handle = std::get<int64_t>(handle_val);
        auto& input = std::get<TensorData>(input_val);

        auto result = engine_->execute(handle, input);
        port_data_[node.id + ":output_data"] = result.output;

        extra["elapsed_ms"] = static_cast<double>(result.elapsed.count());

    } else if (type == "benchmark") {
        auto handle_val = resolve_input(node.id, "net_handle", graph);
        auto input_val = resolve_input(node.id, "input_data", graph);

        if (std::holds_alternative<std::monostate>(handle_val)) throw std::runtime_error("Missing net_handle input");
        if (std::holds_alternative<std::monostate>(input_val)) throw std::runtime_error("Missing input_data");

        auto handle = std::get<int64_t>(handle_val);
        auto& input = std::get<TensorData>(input_val);

        int duration_sec = 10; // Default 10s
        std::string dur_str = get_config("duration");
        if (!dur_str.empty()) {
            try {
                duration_sec = std::stoi(dur_str);
                if (duration_sec <= 0) duration_sec = 10;
            } catch (...) { /* fallback */ }
        }

        auto result = engine_->benchmark(handle, input, duration_sec);
        
        // Also run a single execute to get the output data so downstream nodes can use it
        auto final_output = engine_->execute(handle, input);
        port_data_[node.id + ":benchmark_result"] = final_output.output;

        extra["runs_count"] = result.runs;
        extra["avg_ms"] = result.avg_ms;
        extra["duration_sec"] = duration_sec;
        extra["output"] = final_output.output;

    } else if (type == "saveText") {
        auto data_val = resolve_input(node.id, "data", graph);

        std::string path = get_config("filePath");
        if (path.empty()) path = "output.txt";

        std::ofstream f(path);
        if (!f.is_open()) throw std::runtime_error("Failed to open file for writing: " + path);

        if (auto* t = std::get_if<TensorData>(&data_val)) {
            for (auto v : *t) f << v << "\n";
        } else if (auto* s = std::get_if<std::string>(&data_val)) {
            f << *s << "\n";
        }

    } else if (type == "saveImage") {
        auto data_val = resolve_input(node.id, "image_data", graph);

        std::string path = get_config("filePath");
        if (path.empty()) path = "output.png";

        if (auto* img = std::get_if<ImageData>(&data_val)) {
            std::ofstream f(path, std::ios::binary);
            if (!f.is_open()) throw std::runtime_error("Failed to open image file for writing: " + path);
            f.write(reinterpret_cast<const char*>(img->pixels.data()), img->pixels.size());
        }

    } else if (type == "condition") {
        auto data_val = resolve_input(node.id, "input_data", graph);

        std::string expr = get_config("expression");

        // Simple threshold check: "value > N"
        bool result = false;
        if (auto* t = std::get_if<TensorData>(&data_val)) {
            if (!t->empty()) {
                // Parse simple "value > N" expression
                float threshold = 0;
                try { threshold = std::stof(expr); } catch (...) {}
                result = (*t)[0] > threshold;
            }
        }

        // Store result on both branches
        port_data_[node.id + ":true_branch"] = data_val;
        port_data_[node.id + ":false_branch"] = data_val;
        // The condition result determines which branch is "active"
        port_data_[node.id + ":__condition_result__"] = result ? 1.0f : 0.0f;

    } else if (type == "output") {
        auto data_val = resolve_input(node.id, "data", graph);

        if (auto* t = std::get_if<TensorData>(&data_val)) {
            extra["output"] = *t;
        } else if (auto* s = std::get_if<std::string>(&data_val)) {
            extra["output"] = *s;
        }

    } else if (type == "debug") {
        // Pass through data
        auto data_val = resolve_input(node.id, "data_in", graph);
        port_data_[node.id + ":data_out"] = data_val;
    }

    return extra;
}

PortValue Executor::resolve_input(const std::string& node_id, const std::string& handle,
                                   const WorkflowGraph& graph) {
    auto edges = graph.inputs_for(node_id);
    for (auto* edge : edges) {
        if (edge->target_handle == handle) {
            std::string key = edge->source + ":" + edge->source_handle;
            auto it = port_data_.find(key);
            if (it != port_data_.end()) return it->second;
        }
    }
    return std::monostate{};
}

void Executor::notify_status(const std::string& node_id, const std::string& status,
                             const json& extra) {
    if (!status_cb_) return;
    json msg;
    msg["node_id"] = node_id;
    msg["status"] = status;
    if (!extra.empty()) {
        for (auto& [k, v] : extra.items()) {
            msg[k] = v;
        }
    }
    status_cb_(node_id, msg);
}

} // namespace workflow
