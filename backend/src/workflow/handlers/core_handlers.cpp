// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "core_handlers.h"
#include "condition_expr.h"
#include "../node_error.h"
#include "server/security_config.h"
#include "stb_image.h"
#include "stb_image_write.h"
#include <fstream>
#include <sstream>
#include <numeric>
#include <algorithm>
#include <cctype>

namespace workflow {
namespace handlers {

// Helper to get config
static std::string get_config(const NodeDef& node, const std::string& key) {
    auto it = node.config.find(key);
    return (it != node.config.end()) ? it->second : "";
}

// Resolve a user-supplied path through the process-wide sandbox. Without a
// configured sandbox this is a pass-through, which keeps tests and
// CLI-only setups working.
static std::filesystem::path resolve_path(const std::string& user_path) {
    return SecurityConfig::instance().resolve_shared_path(user_path);
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
    std::string label() const override { return "Postprocess"; }
    std::string category() const override { return "inference"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {
            {"input_data",  "target", "tensor"},
            {"output_data", "source", "tensor"},
        };
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "input_data", graph);
        if (std::holds_alternative<std::monostate>(data_val)) throw NodeError(NodeError::Kind::MissingInput, "Missing input_data");
        
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
            throw NodeError(NodeError::Kind::InvalidConfig, "Unknown postprocess op: " + op);
        }

        ctx.set_output(node.id, "output_data", output);
        return {{"output", output}};
    }
};

class InputImageHandler : public NodeHandler {
public:
    std::string type() const override { return "inputImage"; }
    std::string label() const override { return "Input Image"; }
    std::string category() const override { return "input"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {{"image_data", "source", "image"}};
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        std::string path = get_config(node, "filePath");
        auto resolved = resolve_path(path);

        // Decode PNG/JPG via stb_image. We force 4 channels (RGBA) so
        // every downstream consumer (and the round-trip encoder below)
        // sees a uniform pixel layout regardless of the source's alpha
        // channel. Width/height/source-channel-count are still recorded
        // on ImageData for inspectors; consumers that care about the
        // original channel count can read `channels` (1/3/4) — the
        // pixel buffer is always tightly packed RGBA8.
        int w = 0, h = 0, src_channels = 0;
        unsigned char* decoded = stbi_load(
            resolved.string().c_str(), &w, &h, &src_channels, /*desired*/ 4);
        if (!decoded) {
            const char* reason = stbi_failure_reason();
            throw NodeError(NodeError::Kind::Runtime,
                std::string("Cannot decode image: ") + path +
                (reason ? std::string(" (") + reason + ")" : ""));
        }
        ImageData img;
        const std::size_t byte_count =
            static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4u;
        img.pixels.assign(decoded, decoded + byte_count);
        img.width = w;
        img.height = h;
        img.channels = src_channels;  // semantic source count, not buffer stride
        stbi_image_free(decoded);
        ctx.set_output(node.id, "image_data", std::move(img));
        return {};
    }
};

class InputTensorHandler : public NodeHandler {
public:
    std::string type() const override { return "inputTensor"; }
    std::string label() const override { return "Input Tensor"; }
    std::string category() const override { return "input"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {{"tensor_data", "source", "tensor"}};
    }
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
    std::string label() const override { return "Create Net"; }
    std::string category() const override { return "inference"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {{"net_handle", "source", "net"}};
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        NetConfig nc;
        {
            auto mp = get_config(node, "modelPath");
            auto pp = get_config(node, "paramPath");
            // Only route non-empty paths through the sandbox; createNet with
            // emptyWeights=true or a stub engine may legitimately omit them.
            nc.model_path = mp.empty() ? mp : resolve_path(mp).string();
            nc.param_path = pp.empty() ? pp : resolve_path(pp).string();
        }
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
    std::string label() const override { return "Inference"; }
    std::string category() const override { return "inference"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {
            {"net_handle",  "target", "net"},
            {"input_data",  "target", "tensor"},
            {"output_data", "source", "tensor"},
        };
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto handle_val = ctx.resolve_input(node.id, "net_handle", graph);
        auto input_val = ctx.resolve_input(node.id, "input_data", graph);

        if (std::holds_alternative<std::monostate>(handle_val)) throw NodeError(NodeError::Kind::MissingInput, "Missing net_handle input");
        if (std::holds_alternative<std::monostate>(input_val)) throw NodeError(NodeError::Kind::MissingInput, "Missing input_data");

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
    std::string label() const override { return "Benchmark"; }
    std::string category() const override { return "inference"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {
            {"net_handle",       "target", "net"},
            {"input_data",       "target", "tensor"},
            {"benchmark_result", "source", "generic"},
        };
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto handle_val = ctx.resolve_input(node.id, "net_handle", graph);
        auto input_val = ctx.resolve_input(node.id, "input_data", graph);

        if (std::holds_alternative<std::monostate>(handle_val)) throw NodeError(NodeError::Kind::MissingInput, "Missing net_handle input");
        if (std::holds_alternative<std::monostate>(input_val)) throw NodeError(NodeError::Kind::MissingInput, "Missing input_data");

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

        auto result = ctx.engine()->benchmark(handle, input, duration_sec,
                                              [&ctx]() { return ctx.is_cancelled(); });

        // Benchmark already ran the net repeatedly; re-run once to capture a
        // representative output tensor for downstream nodes. This is not the
        // winning run — it's a single sample chosen for wiring convenience.
        auto sample_output = ctx.engine()->execute(handle, input);
        ctx.set_output(node.id, "benchmark_result", sample_output.output);

        json extra;
        extra["runs_count"] = result.runs;
        extra["avg_ms"] = result.avg_ms;
        extra["duration_sec"] = duration_sec;
        extra["output"] = sample_output.output;
        return extra;
    }
};

class SaveTextHandler : public NodeHandler {
public:
    std::string type() const override { return "saveText"; }
    std::string label() const override { return "Save Text"; }
    std::string category() const override { return "output"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {{"data", "target", "generic"}};
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "data", graph);

        std::string path = get_config(node, "filePath");
        if (path.empty()) path = "output.txt";
        auto resolved = resolve_path(path);

        std::ofstream f(resolved);
        if (!f.is_open()) throw NodeError(NodeError::Kind::Runtime, "Failed to open file for writing: " + path);

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
    std::string label() const override { return "Save Image"; }
    std::string category() const override { return "output"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {{"image_data", "target", "image"}};
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "image_data", graph);

        std::string path = get_config(node, "filePath");
        if (path.empty()) path = "output.png";
        auto resolved = resolve_path(path);

        auto* img = std::get_if<ImageData>(&data_val);
        if (!img) {
            // Be explicit instead of silently no-op'ing: a saveImage
            // node fed something that isn't an image is a workflow
            // wiring bug the operator should hear about.
            throw NodeError(NodeError::Kind::Runtime,
                "saveImage: input is not ImageData");
        }
        if (img->width <= 0 || img->height <= 0) {
            throw NodeError(NodeError::Kind::Runtime,
                "saveImage: ImageData has zero width/height; "
                "did upstream actually decode?");
        }
        // Pixel buffer is always tightly-packed RGBA8 (see
        // InputImageHandler). Writers all take stride_in_bytes = w*4.
        const int w = img->width, h = img->height;
        const int stride = w * 4;
        const std::size_t expected = static_cast<std::size_t>(stride) * h;
        if (img->pixels.size() != expected) {
            throw NodeError(NodeError::Kind::Runtime,
                "saveImage: pixel buffer size mismatch (expected " +
                std::to_string(expected) + ", got " +
                std::to_string(img->pixels.size()) + ")");
        }

        // Pick encoder by extension. Default to PNG when the path has
        // no extension or one we don't recognise — gives the operator
        // a lossless round-trip in the common case.
        std::string ext;
        auto dot = path.find_last_of('.');
        if (dot != std::string::npos) {
            ext = path.substr(dot + 1);
            std::transform(ext.begin(), ext.end(), ext.begin(),
                [](unsigned char c) { return std::tolower(c); });
        }

        int rc = 0;
        const auto resolved_str = resolved.string();
        if (ext == "jpg" || ext == "jpeg") {
            // Quality 90 — visually lossless for sanity round-trips
            // without bloating fixtures.
            rc = stbi_write_jpg(resolved_str.c_str(), w, h, 4,
                                img->pixels.data(), 90);
        } else {
            rc = stbi_write_png(resolved_str.c_str(), w, h, 4,
                                img->pixels.data(), stride);
        }
        if (!rc) {
            throw NodeError(NodeError::Kind::Runtime,
                "saveImage: encode/write failed for " + path);
        }
        return {};
    }
};

class ConditionHandler : public NodeHandler {
public:
    std::string type() const override { return "condition"; }
    std::string label() const override { return "Condition"; }
    std::string category() const override { return "control"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {
            {"input_data",   "target", "tensor"},
            {"true_branch",  "source", "branch"},
            {"false_branch", "source", "branch"},
        };
    }
    json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
        auto data_val = ctx.resolve_input(node.id, "input_data", graph);

        std::string expr = get_config(node, "expression");
        std::string err;
        bool taken = evaluate_condition(expr, data_val, &err);

        // Only the taken branch receives the payload; the other port is
        // marked dead so every node downstream of it gets pruned by the
        // executor (see Executor::should_skip).
        if (taken) {
            ctx.set_output(node.id, "true_branch", data_val);
            ctx.mark_dead_output(node.id, "false_branch");
        } else {
            ctx.set_output(node.id, "false_branch", data_val);
            ctx.mark_dead_output(node.id, "true_branch");
        }

        json extra;
        extra["condition"] = taken;
        extra["expression"] = expr;
        if (!err.empty()) extra["expression_error"] = err;
        return extra;
    }
};

class OutputHandler : public NodeHandler {
public:
    std::string type() const override { return "output"; }
    std::string label() const override { return "Output"; }
    std::string category() const override { return "output"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {{"data", "target", "generic"}};
    }
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
    std::string label() const override { return "Inspect"; }
    std::string category() const override { return "debug"; }
    std::vector<HandlerPortDef> port_defs() const override {
        return {
            {"data_in",  "target", "generic"},
            {"data_out", "source", "generic"},
        };
    }
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
