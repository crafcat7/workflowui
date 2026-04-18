#include "core_handlers.h"
#include <fstream>
#include <sstream>
#include <numeric>
#include <algorithm>
#include <iostream>
#include <numeric>
#include <cmath>

namespace workflow {
namespace handlers {

// Helper to get config
static std::string get_config(const NodeDef& node, const std::string& key) {
    auto it = node.config.find(key);
    return (it != node.config.end()) ? it->second : "";
}

static float iou(const float* a, const float* b) {
    float x1 = std::max(a[0], b[0]);
    float y1 = std::max(a[1], b[1]);
    float x2 = std::min(a[2], b[2]);
    float y2 = std::min(a[3], b[3]);

    float w = std::max(0.0f, x2 - x1);
    float h = std::max(0.0f, y2 - y1);
    float inter = w * h;
    float area_a = (a[2] - a[0]) * (a[3] - a[1]);
    float area_b = (b[2] - b[0]) * (b[3] - b[1]);
    return inter / (area_a + area_b - inter + 1e-6f);
}

class PostprocessHandler : public NodeHandler {
public:
    std::string type() const override { return "postprocess"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "input_data", graph);
        if (std::holds_alternative<std::monostate>(data_val)) throw std::runtime_error("Missing input_data");
        
        auto& input = std::get<TensorData>(data_val);
        std::string op = get_config(node, "op");
        if (op.empty()) op = "nms"; // Default to nms if not specified

        TensorData output;

        if (op == "nms") {
            // NMS expects [x1, y1, x2, y2, score] repeated
            float iou_thresh = 0.45f;
            std::string t_str = get_config(node, "iouThreshold");
            if (!t_str.empty()) try { iou_thresh = std::stof(t_str); } catch(...) {}

            int num_boxes = input.size() / 5;
            std::vector<int> indices(num_boxes);
            std::iota(indices.begin(), indices.end(), 0);

            // Sort by score descending
            std::sort(indices.begin(), indices.end(), [&input](int a, int b) {
                return input[a * 5 + 4] > input[b * 5 + 4];
            });

            std::vector<int> keep;
            for (int idx : indices) {
                bool discard = false;
                const float* b1 = &input[idx * 5];
                for (int k : keep) {
                    const float* b2 = &input[k * 5];
                    if (iou(b1, b2) > iou_thresh) {
                        discard = true;
                        break;
                    }
                }
                if (!discard) {
                    keep.push_back(idx);
                    output.insert(output.end(), b1, b1 + 5);
                }
            }
        } else if (op == "topk") {
            int k = 1;
            std::string k_str = get_config(node, "k");
            if (!k_str.empty()) try { k = std::stoi(k_str); } catch(...) {}

            std::vector<int> indices(input.size());
            std::iota(indices.begin(), indices.end(), 0);

            std::sort(indices.begin(), indices.end(), [&input](int a, int b) {
                return input[a] > input[b];
            });

            int actual_k = std::min(k, (int)indices.size());
            for (int i = 0; i < actual_k; ++i) {
                output.push_back((float)indices[i]);
                output.push_back(input[indices[i]]);
            }
        } else {
            throw std::runtime_error("Unknown postprocess op: " + op);
        }

        std::cout << "[PostprocessHandler] Output size: " << output.size() << std::endl;

        ctx.set_output(node.id, "output_data", output);
        return {{"output", output}};
    }
};

class InputImageHandler : public NodeHandler {
public:
    std::string type() const override { return "inputImage"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        std::string path = get_config(node, "filePath");
        std::ifstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("Cannot open image: " + path);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());
        ImageData img;
        img.pixels = std::move(data);
        ctx.set_output(node.id, "image_data", std::move(img));
        return {};
    }
};

class InputTensorHandler : public NodeHandler {
public:
    std::string type() const override { return "inputTensor"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        TensorData tensor;
        std::string mode = get_config(node, "fillMode");
        
        if (mode == "auto") {
            std::string shape_str = get_config(node, "shape");
            std::string fill_str = get_config(node, "fillValue");
            
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
            std::string text = get_config(node, "tensorText");
            std::istringstream iss(text);
            float val;
            while (iss >> val) {
                tensor.push_back(val);
            }
        }
        
        ctx.set_output(node.id, "tensor_data", std::move(tensor));
        return {};
    }
};

class CreateNetHandler : public NodeHandler {
public:
    std::string type() const override { return "createNet"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        NetConfig nc;
        nc.model_path = get_config(node, "modelPath");
        nc.param_path = get_config(node, "paramPath");
        auto in_name = get_config(node, "inputName");
        if (!in_name.empty()) nc.input_name = in_name;
        auto out_name = get_config(node, "outputName");
        if (!out_name.empty()) nc.output_name = out_name;
        auto threads_str = get_config(node, "numThreads");
        if (!threads_str.empty()) nc.num_threads = std::stoi(threads_str);
        auto iw = get_config(node, "inputW");
        if (!iw.empty()) nc.input_w = std::stoi(iw);
        auto ih = get_config(node, "inputH");
        if (!ih.empty()) nc.input_h = std::stoi(ih);
        auto ic = get_config(node, "inputC");
        if (!ic.empty()) nc.input_c = std::stoi(ic);
        auto ew = get_config(node, "emptyWeights");
        if (ew == "true" || ew == "1") nc.empty_weights = true;

        auto start = std::chrono::high_resolution_clock::now();
        auto handle = ctx.engine()->init_net(nc);
        auto end = std::chrono::high_resolution_clock::now();
        double ms = std::chrono::duration<double, std::milli>(end - start).count();

        ctx.set_output(node.id, "net_handle", static_cast<int64_t>(handle));

        json extra;
        extra["elapsed_ms"] = ms;
        return extra;
    }
};

class InferenceHandler : public NodeHandler {
public:
    std::string type() const override { return "inference"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto handle_val = ctx.resolve_input(node.id, "net_handle", graph);
        auto input_val = ctx.resolve_input(node.id, "input_data", graph);

        if (std::holds_alternative<std::monostate>(handle_val)) throw std::runtime_error("Missing net_handle input");
        if (std::holds_alternative<std::monostate>(input_val)) throw std::runtime_error("Missing input_data");

        auto handle = std::get<int64_t>(handle_val);
        auto& input = std::get<TensorData>(input_val);

        auto result = ctx.engine()->execute(handle, input);
        ctx.set_output(node.id, "output_data", result.output);

        json extra;
        extra["elapsed_ms"] = static_cast<double>(result.elapsed.count());
        return extra;
    }
};

class BenchmarkHandler : public NodeHandler {
public:
    std::string type() const override { return "benchmark"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto handle_val = ctx.resolve_input(node.id, "net_handle", graph);
        auto input_val = ctx.resolve_input(node.id, "input_data", graph);

        if (std::holds_alternative<std::monostate>(handle_val)) throw std::runtime_error("Missing net_handle input");
        if (std::holds_alternative<std::monostate>(input_val)) throw std::runtime_error("Missing input_data");

        auto handle = std::get<int64_t>(handle_val);
        auto& input = std::get<TensorData>(input_val);

        int duration_sec = 10; // Default 10s
        std::string dur_str = get_config(node, "duration");
        if (!dur_str.empty()) {
            try {
                duration_sec = std::stoi(dur_str);
                if (duration_sec <= 0) duration_sec = 10;
            } catch (...) { /* fallback */ }
        }

        auto result = ctx.engine()->benchmark(handle, input, duration_sec);
        
        // Also run a single execute to get the output data so downstream nodes can use it
        auto final_output = ctx.engine()->execute(handle, input);
        ctx.set_output(node.id, "benchmark_result", final_output.output);

        json extra;
        extra["runs_count"] = result.runs;
        extra["avg_ms"] = result.avg_ms;
        extra["duration_sec"] = duration_sec;
        extra["output"] = final_output.output;
        return extra;
    }
};

class SaveTextHandler : public NodeHandler {
public:
    std::string type() const override { return "saveText"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "data", graph);

        std::string path = get_config(node, "filePath");
        if (path.empty()) path = "output.txt";

        std::ofstream f(path);
        if (!f.is_open()) throw std::runtime_error("Failed to open file for writing: " + path);

        if (auto* t = std::get_if<TensorData>(&data_val)) {
            for (auto v : *t) f << v << "\n";
        } else if (auto* s = std::get_if<std::string>(&data_val)) {
            f << *s << "\n";
        }
        return {};
    }
};

class SaveImageHandler : public NodeHandler {
public:
    std::string type() const override { return "saveImage"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "image_data", graph);

        std::string path = get_config(node, "filePath");
        if (path.empty()) path = "output.png";

        if (auto* img = std::get_if<ImageData>(&data_val)) {
            std::ofstream f(path, std::ios::binary);
            if (!f.is_open()) throw std::runtime_error("Failed to open image file for writing: " + path);
            f.write(reinterpret_cast<const char*>(img->pixels.data()), img->pixels.size());
        }
        return {};
    }
};

class ConditionHandler : public NodeHandler {
public:
    std::string type() const override { return "condition"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "input_data", graph);

        std::string expr = get_config(node, "expression");

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
        ctx.set_output(node.id, "true_branch", data_val);
        ctx.set_output(node.id, "false_branch", data_val);
        // The condition result determines which branch is "active"
        ctx.set_output(node.id, "__condition_result__", result ? 1.0f : 0.0f);
        return {};
    }
};

class OutputHandler : public NodeHandler {
public:
    std::string type() const override { return "output"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "data", graph);

        json extra;
        if (auto* t = std::get_if<TensorData>(&data_val)) {
            extra["output"] = *t;
        } else if (auto* s = std::get_if<std::string>(&data_val)) {
            extra["output"] = *s;
        }
        return extra;
    }
};

class DebugHandler : public NodeHandler {
public:
    std::string type() const override { return "debug"; }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "data_in", graph);
        ctx.set_output(node.id, "data_out", data_val);
        return {};
    }
};

void register_core_handlers(std::unordered_map<std::string, std::shared_ptr<NodeHandler>>& registry) {
    auto add = [&](std::shared_ptr<NodeHandler> h) { registry[h->type()] = std::move(h); };
    add(std::make_shared<InputImageHandler>());
    add(std::make_shared<InputTensorHandler>());
    add(std::make_shared<CreateNetHandler>());
    add(std::make_shared<InferenceHandler>());
    add(std::make_shared<BenchmarkHandler>());
    add(std::make_shared<SaveTextHandler>());
    add(std::make_shared<SaveImageHandler>());
    add(std::make_shared<ConditionHandler>());
    add(std::make_shared<OutputHandler>());
    add(std::make_shared<DebugHandler>());
    add(std::make_shared<PostprocessHandler>());
}

} // namespace handlers
} // namespace workflow
