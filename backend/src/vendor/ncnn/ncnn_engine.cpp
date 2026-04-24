// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "ncnn_engine.h"

#include <net.h>
#include <mat.h>
#include <datareader.h>

#include <chrono>
#include <cstring>
#include <stdexcept>

namespace workflow {

namespace {
/**
 * Mirrors ncnn's own benchmark tool (upstream `DataReaderFromEmpty` in
 * ncnn/benchmark/benchncnn.cpp): hands back zero-filled bytes for any
 * read request so `ncnn::Net::load_model` can fully initialize every
 * layer's weight blob even when the user has no .bin file. Without it,
 * calling create_extractor + extract on a net that only had load_param()
 * run walks into layers whose weight Mats are still default-constructed
 * (data pointer invalid), which segfaults deep inside Convolution::forward
 * / memcpy. Returning zeros keeps the forward graph traversal valid; the
 * output is garbage (effectively a uniform softmax) but the pipeline does
 * not crash, which is the whole point of emptyWeights=true.
 */
class DataReaderFromEmpty : public ncnn::DataReader {
public:
#if NCNN_STRING
    virtual int scan(const char* /*format*/, void* /*p*/) const { return 0; }
#endif
    virtual size_t read(void* buf, size_t size) const {
        std::memset(buf, 0, size);
        return size;
    }
};
}  // namespace

/**
 * Per-net state: the ncnn::Net itself, the last NetConfig so
 * configure()/execute() can drive input/output names, and a default
 * blob shape derived from the config. Kept in a PImpl entry so this
 * file stays the only compilation unit that includes <net.h>.
 */
struct NcnnEngine::Entry {
    ncnn::Net net;
    NetConfig cfg;
};

NcnnEngine::NcnnEngine() = default;

NcnnEngine::~NcnnEngine() {
    std::lock_guard<std::mutex> lk(mu_);
    nets_.clear();  // ncnn::Net dtor releases weights.
}

std::vector<ConfigFieldSchema> NcnnEngine::config_schema() const {
    return {
        {"paramPath",    "Param File",      "string", "MODEL",   ".param path",             "", {}},
        {"modelPath",    "Model File",      "string", "MODEL",   ".bin path",               "", {}},
        {"inputName",    "Input Blob",      "string", "MODEL",   "data",                    "data",   {}},
        {"outputName",   "Output Blob",     "string", "MODEL",   "output",                  "output", {}},
        {"numThreads",   "Threads",         "int",    "RUNTIME", "1",                       "1",      {}},
        {"inputW",       "Input W",         "int",    "RUNTIME", "0",                       "0",      {}},
        {"inputH",       "Input H",         "int",    "RUNTIME", "0",                       "0",      {}},
        {"inputC",       "Input C",         "int",    "RUNTIME", "0",                       "0",      {}},
        {"emptyWeights", "Empty Weights",   "bool",   "RUNTIME", "",                        "false",  {}},
    };
}

std::shared_ptr<NcnnEngine::Entry> NcnnEngine::get(NetHandle h) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = nets_.find(h);
    if (it == nets_.end()) return nullptr;
    return it->second;
}

NetHandle NcnnEngine::init_net(const NetConfig& config) {
    auto entry = std::make_shared<Entry>();
    entry->cfg = config;
    if (config.num_threads > 0) entry->net.opt.num_threads = config.num_threads;

    if (config.param_path.empty()) {
        throw std::runtime_error("NcnnEngine::init_net: paramPath is required");
    }

    // Load the graph first; weights afterwards (or synthesize zeros).
    if (entry->net.load_param(config.param_path.c_str()) != 0) {
        throw std::runtime_error("NcnnEngine: failed to parse .param: " + config.param_path);
    }

    if (config.empty_weights) {
        // No .bin on disk: feed ncnn a zero DataReader so every layer's
        // weight blob gets a real (zero-filled) allocation. Inference
        // produces meaningless output but won't crash inside Convolution.
        if (!config.model_path.empty()) {
            if (entry->net.load_model(config.model_path.c_str()) != 0) {
                throw std::runtime_error("NcnnEngine: failed to load .bin: " + config.model_path);
            }
        } else {
            DataReaderFromEmpty dr;
            if (entry->net.load_model(dr) != 0) {
                throw std::runtime_error("NcnnEngine: failed to synthesize zero weights for " + config.param_path);
            }
        }
    } else {
        if (config.model_path.empty()) {
            throw std::runtime_error("NcnnEngine::init_net: modelPath is required unless emptyWeights=true");
        }
        if (entry->net.load_model(config.model_path.c_str()) != 0) {
            throw std::runtime_error("NcnnEngine: failed to load .bin: " + config.model_path);
        }
    }

    std::lock_guard<std::mutex> lk(mu_);
    NetHandle h = next_handle_++;
    nets_.emplace(h, std::move(entry));
    return h;
}

void NcnnEngine::configure(NetHandle handle, const NetConfig& config) {
    auto entry = get(handle);
    if (!entry) throw std::runtime_error("NcnnEngine::configure: unknown handle");
    // Only runtime knobs (names, threads, shape hints) are live-updatable;
    // reloading the graph requires init_net.
    entry->cfg.input_name   = config.input_name;
    entry->cfg.output_name  = config.output_name;
    entry->cfg.num_threads  = config.num_threads;
    entry->cfg.input_w      = config.input_w;
    entry->cfg.input_h      = config.input_h;
    entry->cfg.input_c      = config.input_c;
    if (config.num_threads > 0) entry->net.opt.num_threads = config.num_threads;
}

namespace {

// Shape a flat vector<float> into an ncnn::Mat according to NetConfig.
// Zero means "flatten as 1-D"; non-zero W/H/C are honoured in
// whw/whc/hw/w priority order to match ncnn's overload rules.
ncnn::Mat make_input_mat(const TensorData& input, const NetConfig& cfg) {
    const int w = cfg.input_w;
    const int h = cfg.input_h;
    const int c = cfg.input_c;

    const size_t expected =
        (w > 0 && h > 0 && c > 0) ? static_cast<size_t>(w) * h * c :
        (w > 0 && h > 0)          ? static_cast<size_t>(w) * h :
        (w > 0)                   ? static_cast<size_t>(w) :
                                    input.size();

    if (input.size() < expected) {
        throw std::runtime_error("NcnnEngine: input tensor smaller than declared shape");
    }

    ncnn::Mat mat;
    if (w > 0 && h > 0 && c > 0) mat.create(w, h, c);
    else if (w > 0 && h > 0)     mat.create(w, h);
    else if (w > 0)              mat.create(w);
    else                         mat.create(static_cast<int>(input.size()));

    std::memcpy(mat.data, input.data(), expected * sizeof(float));
    return mat;
}

TensorData mat_to_tensor(const ncnn::Mat& m) {
    TensorData out;
    out.resize(static_cast<size_t>(m.w) * m.h * m.c);
    std::memcpy(out.data(), m.data, out.size() * sizeof(float));
    return out;
}

} // namespace

InferResult NcnnEngine::execute(NetHandle handle, const TensorData& input) {
    auto entry = get(handle);
    if (!entry) throw std::runtime_error("NcnnEngine::execute: unknown handle");

    ncnn::Mat in  = make_input_mat(input, entry->cfg);
    ncnn::Mat out;

    auto start = std::chrono::steady_clock::now();
    {
        ncnn::Extractor ex = entry->net.create_extractor();
        if (ex.input(entry->cfg.input_name.c_str(), in) != 0) {
            throw std::runtime_error("NcnnEngine: input blob '" + entry->cfg.input_name + "' not found");
        }
        if (ex.extract(entry->cfg.output_name.c_str(), out) != 0) {
            throw std::runtime_error("NcnnEngine: output blob '" + entry->cfg.output_name + "' not found");
        }
    }
    auto end = std::chrono::steady_clock::now();

    InferResult r;
    r.output  = mat_to_tensor(out);
    r.elapsed = std::chrono::duration_cast<Duration>(end - start);
    return r;
}

BenchmarkResult NcnnEngine::benchmark(NetHandle handle, const TensorData& input, int duration_sec) {
    auto entry = get(handle);
    if (!entry) throw std::runtime_error("NcnnEngine::benchmark: unknown handle");
    if (duration_sec <= 0) duration_sec = 10;

    ncnn::Mat in = make_input_mat(input, entry->cfg);

    double min_ms = 1e18;
    double max_ms = 0.0;
    double total_ms = 0.0;
    int    runs    = 0;

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(duration_sec);
    while (std::chrono::steady_clock::now() < deadline) {
        ncnn::Mat out;
        auto t0 = std::chrono::steady_clock::now();
        {
            ncnn::Extractor ex = entry->net.create_extractor();
            if (ex.input(entry->cfg.input_name.c_str(), in) != 0) break;
            if (ex.extract(entry->cfg.output_name.c_str(), out) != 0) break;
        }
        auto t1 = std::chrono::steady_clock::now();
        double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
        min_ms = std::min(min_ms, ms);
        max_ms = std::max(max_ms, ms);
        total_ms += ms;
        ++runs;
    }

    BenchmarkResult r;
    r.runs   = runs;
    r.avg_ms = runs > 0 ? total_ms / runs : 0.0;
    r.min_ms = runs > 0 ? min_ms : 0.0;
    r.max_ms = max_ms;
    return r;
}

void NcnnEngine::destroy_net(NetHandle handle) {
    std::lock_guard<std::mutex> lk(mu_);
    nets_.erase(handle);
}

} // namespace workflow
