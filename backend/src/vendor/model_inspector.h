// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

namespace workflow {

/**
 * Vendor-neutral, structural view of an inference model.
 *
 * `InferenceEngine` answers the question "load and run a model"; this
 * sibling interface answers "what is *inside* the model file" without
 * actually allocating GPU buffers or running anything. The frontend
 * uses the resulting graph to render a per-model preview drawer
 * (selected an inference node → "View Model"), and a future iteration
 * will support edit-and-export. Both ncnn (`.param` text) and any
 * future backend (onnx, torchscript) plug in by implementing this
 * interface — the wire payload is fully described by `ModelGraph`.
 *
 * Design constraints baked into the IR:
 *   - Layers and blobs are kept as flat lists with explicit string ids
 *     so the frontend's mini ReactFlow canvas can hand each ModelLayer
 *     to a node and each `(producer, output_blob → consumer)` triple
 *     to an edge without a second resolution step.
 *   - `params` is a free-form `json` object. ncnn's `.param` exposes
 *     k=v scalars and small arrays per layer; pinning them into a
 *     fixed struct would force every consumer (tooltip, future
 *     editor) to track a schema enum. Keeping them as JSON also lets
 *     the wire shape pass through `nlohmann::json` without a custom
 *     serializer.
 *   - `editable` is part of the public IR but read-only in this
 *     iteration. NcnnInspector returns `false`; the next phase adds
 *     `write_param` and flips it on for the layers we know how to
 *     round-trip.
 */
struct ModelLayer {
    std::string id;                          // layer name (unique within graph)
    std::string type;                        // "Convolution", "ReLU", ...
    std::vector<std::string> input_blobs;
    std::vector<std::string> output_blobs;
    nlohmann::json params = nlohmann::json::object(); // engine-specific k=v
};

struct ModelBlob {
    std::string name;
    // Optional: ncnn .param does not always carry shape annotations
    // (the inference-time shape is determined by the input tensor +
    // each layer's transfer function). Empty when unknown.
    std::vector<int> shape;
    std::string producer; // layer id that emits this blob; empty for graph inputs
    std::vector<std::string> consumers; // layer ids reading this blob
};

struct ModelGraph {
    std::string vendor;          // matches `ModelInspector::vendor()`
    std::string format_version;  // engine-specific tag, e.g. "ncnn-7767517"
    std::vector<ModelLayer> layers;
    std::vector<ModelBlob>  blobs;

    // Whole-model metadata — surfaced in the drawer header.
    int64_t param_bytes = 0;
    int64_t bin_bytes = 0;
    std::vector<std::string> input_blob_names;
    std::vector<std::string> output_blob_names;

    // Reserved: this iteration always returns false. Wired through so
    // the frontend can branch on it today instead of waiting for a
    // schema bump when edit support lands.
    bool editable = false;
};

/**
 * Inputs to an inspect call. Symmetric with `NetConfig` for the
 * inference path: `param_path` is required, `model_path` (the .bin)
 * is optional because pure structural inspection only needs .param.
 */
struct ModelInspectRequest {
    std::string param_path;
    std::string model_path; // optional — empty means "metadata only, skip bin"
};

/**
 * Thrown by inspectors for any user-facing failure (missing file,
 * malformed param, unsupported magic). The message is surfaced
 * verbatim to the frontend as a JSON-RPC error string, so it must
 * make sense without any frontend translation.
 */
class ModelInspectError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class ModelInspector {
public:
    virtual ~ModelInspector() = default;
    // Stable identifier matching the `vendor` field on inference
    // nodes ("ncnn" today). The frontend dispatches drawer requests
    // by this name so multi-vendor coexistence works without an
    // engine registry on the FE side.
    virtual std::string vendor() const = 0;
    virtual ModelGraph inspect(const ModelInspectRequest& req) = 0;
};

// ── JSON conversions ────────────────────────────────────────────────
// Defined inline so backend translation units that include this
// header (RPC handler, tests) and any future SDK consumer get the
// serializer for free without an extra .cpp dependency. The shape is
// the wire contract documented on ModelGraph above.

inline nlohmann::json to_json(const ModelLayer& l) {
    return nlohmann::json{
        {"id", l.id},
        {"type", l.type},
        {"input_blobs", l.input_blobs},
        {"output_blobs", l.output_blobs},
        {"params", l.params},
    };
}

inline nlohmann::json to_json(const ModelBlob& b) {
    return nlohmann::json{
        {"name", b.name},
        {"shape", b.shape},
        {"producer", b.producer},
        {"consumers", b.consumers},
    };
}

inline nlohmann::json to_json(const ModelGraph& g) {
    nlohmann::json layers = nlohmann::json::array();
    for (const auto& l : g.layers) layers.push_back(to_json(l));
    nlohmann::json blobs = nlohmann::json::array();
    for (const auto& b : g.blobs) blobs.push_back(to_json(b));
    return nlohmann::json{
        {"vendor", g.vendor},
        {"format_version", g.format_version},
        {"layers", std::move(layers)},
        {"blobs", std::move(blobs)},
        {"param_bytes", g.param_bytes},
        {"bin_bytes", g.bin_bytes},
        {"input_blob_names", g.input_blob_names},
        {"output_blob_names", g.output_blob_names},
        {"editable", g.editable},
    };
}

} // namespace workflow
