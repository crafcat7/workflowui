// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "core_handlers.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <numeric>
#include <sstream>

#include "../node_error.h"
#include "condition_expr.h"
#include "image_tensor.h"
#include "server/security_config.h"
#include "stb_image.h"
#include "stb_image_write.h"

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
        {"input_data", "target", "tensor"},
        {"output_data", "source", "tensor"},
    };
  }
  json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
    auto data_val = ctx.resolve_input(node.id, "input_data", graph);
    if (std::holds_alternative<std::monostate>(data_val))
      throw NodeError(NodeError::Kind::MissingInput, "Missing input_data");

    auto& input = std::get<TensorData>(data_val);
    std::string op = get_config(node, "op");
    if (op.empty())
      op = "nms";  // Default to nms if not specified

    TensorData output;

    if (op == "nms") {
      // NMS expects [x1, y1, x2, y2, score] repeated
      float iou_thresh = 0.45f;
      std::string t_str = get_config(node, "iouThreshold");
      if (!t_str.empty())
        try {
          iou_thresh = std::stof(t_str);
        } catch (...) {
        }

      int num_boxes = input.size() / 5;
      std::vector<int> indices(num_boxes);
      std::iota(indices.begin(), indices.end(), 0);

      // Sort by score descending
      std::sort(indices.begin(), indices.end(),
                [&input](int a, int b) { return input[a * 5 + 4] > input[b * 5 + 4]; });

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
      if (!k_str.empty())
        try {
          k = std::stoi(k_str);
        } catch (...) {
        }

      std::vector<int> indices(input.size());
      std::iota(indices.begin(), indices.end(), 0);

      std::sort(indices.begin(), indices.end(),
                [&input](int a, int b) { return input[a] > input[b]; });

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
    unsigned char* decoded =
        stbi_load(resolved.string().c_str(), &w, &h, &src_channels, /*desired*/ 4);
    if (!decoded) {
      const char* reason = stbi_failure_reason();
      throw NodeError(NodeError::Kind::Runtime,
                      std::string("Cannot decode image: ") + path +
                          (reason ? std::string(" (") + reason + ")" : ""));
    }
    ImageData img;
    const std::size_t byte_count = static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4u;
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
        try {
          fill_val = std::stof(fill_str);
        } catch (...) {
        }
      }

      int total_size = 1;
      std::string token;
      std::istringstream ss(shape_str);
      while (std::getline(ss, token, ',')) {
        try {
          int dim = std::stoi(token);
          if (dim > 0)
            total_size *= dim;
        } catch (...) {
        }
      }
      if (total_size <= 0)
        total_size = 1;

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
    if (!in_name.empty())
      nc.input_name = in_name;
    auto out_name = get_config(node, "outputName");
    if (!out_name.empty())
      nc.output_name = out_name;
    auto threads_str = get_config(node, "numThreads");
    if (!threads_str.empty())
      nc.num_threads = std::stoi(threads_str);
    auto iw = get_config(node, "inputW");
    if (!iw.empty())
      nc.input_w = std::stoi(iw);
    auto ih = get_config(node, "inputH");
    if (!ih.empty())
      nc.input_h = std::stoi(ih);
    auto ic = get_config(node, "inputC");
    if (!ic.empty())
      nc.input_c = std::stoi(ic);
    auto ew = get_config(node, "emptyWeights");
    if (ew == "true" || ew == "1")
      nc.empty_weights = true;

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
        {"net_handle", "target", "net"},
        {"input_data", "target", "tensor"},
        {"output_data", "source", "tensor"},
    };
  }
  json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
    auto handle_val = ctx.resolve_input(node.id, "net_handle", graph);
    auto input_val = ctx.resolve_input(node.id, "input_data", graph);

    if (std::holds_alternative<std::monostate>(handle_val))
      throw NodeError(NodeError::Kind::MissingInput, "Missing net_handle input");
    if (std::holds_alternative<std::monostate>(input_val))
      throw NodeError(NodeError::Kind::MissingInput, "Missing input_data");

    auto handle = std::get<int64_t>(handle_val);
    // Accept either a tensor (already-coerced upstream) or a raw image. The
    // image branch performs the RGBA8 → CHW float reshape declared by the
    // image→tensor coercion in portSchema.ts. See image_tensor.h.
    TensorData input;
    if (auto* img = std::get_if<ImageData>(&input_val)) {
      input = image_to_tensor(*img);
    } else if (auto* t = std::get_if<TensorData>(&input_val)) {
      input = std::move(*t);
    } else {
      throw NodeError(NodeError::Kind::MissingInput,
                      "inference: input_data must be tensor or image");
    }

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
        {"net_handle", "target", "net"},
        {"input_data", "target", "tensor"},
        {"benchmark_result", "source", "generic"},
    };
  }
  json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
    auto handle_val = ctx.resolve_input(node.id, "net_handle", graph);
    auto input_val = ctx.resolve_input(node.id, "input_data", graph);

    if (std::holds_alternative<std::monostate>(handle_val))
      throw NodeError(NodeError::Kind::MissingInput, "Missing net_handle input");
    if (std::holds_alternative<std::monostate>(input_val))
      throw NodeError(NodeError::Kind::MissingInput, "Missing input_data");

    auto handle = std::get<int64_t>(handle_val);
    // Same image→tensor coercion as InferenceHandler — keeps benchmarking
    // valid against image-source pipelines without a manual preprocess node.
    TensorData input;
    if (auto* img = std::get_if<ImageData>(&input_val)) {
      input = image_to_tensor(*img);
    } else if (auto* t = std::get_if<TensorData>(&input_val)) {
      input = std::move(*t);
    } else {
      throw NodeError(NodeError::Kind::MissingInput,
                      "benchmark: input_data must be tensor or image");
    }

    int duration_sec = 10;  // Default 10s
    std::string dur_str = get_config(node, "duration");
    if (!dur_str.empty()) {
      try {
        duration_sec = std::stoi(dur_str);
        if (duration_sec <= 0)
          duration_sec = 10;
      } catch (...) { /* fallback */
      }
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
  std::vector<HandlerPortDef> port_defs() const override { return {{"data", "target", "generic"}}; }
  json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
    auto data_val = ctx.resolve_input(node.id, "data", graph);

    std::string path = get_config(node, "filePath");
    if (path.empty())
      path = "output.txt";
    auto resolved = resolve_path(path);

    std::ofstream f(resolved);
    if (!f.is_open())
      throw NodeError(NodeError::Kind::Runtime, "Failed to open file for writing: " + path);

    if (auto* t = std::get_if<TensorData>(&data_val)) {
      for (auto v : *t)
        f << v << "\n";
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
    if (path.empty())
      path = "output.png";
    auto resolved = resolve_path(path);

    auto* img = std::get_if<ImageData>(&data_val);
    if (!img) {
      // Be explicit instead of silently no-op'ing: a saveImage
      // node fed something that isn't an image is a workflow
      // wiring bug the operator should hear about.
      throw NodeError(NodeError::Kind::Runtime, "saveImage: input is not ImageData");
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
      throw NodeError(NodeError::Kind::Runtime, "saveImage: pixel buffer size mismatch (expected " +
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
      rc = stbi_write_jpg(resolved_str.c_str(), w, h, 4, img->pixels.data(), 90);
    } else {
      rc = stbi_write_png(resolved_str.c_str(), w, h, 4, img->pixels.data(), stride);
    }
    if (!rc) {
      throw NodeError(NodeError::Kind::Runtime, "saveImage: encode/write failed for " + path);
    }
    return {};
  }
};

// Render a 1-D tensor as a heatmap strip. Values are min/max-normalized to
// [0,1] (auto) or clamped (none), then mapped through a colormap. The output
// is always a tightly-packed RGBA8 ImageData of (width x height) so it slots
// straight into saveImage / preview without further conversion.
class TensorToImageHandler : public NodeHandler {
 public:
  std::string type() const override { return "tensorToImage"; }
  std::string label() const override { return "Tensor To Image"; }
  std::string category() const override { return "output"; }
  std::vector<HandlerPortDef> port_defs() const override {
    return {
        {"input_data", "target", "tensor"},
        {"image_data", "source", "image"},
    };
  }
  json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
    auto data_val = ctx.resolve_input(node.id, "input_data", graph);
    if (std::holds_alternative<std::monostate>(data_val))
      throw NodeError(NodeError::Kind::MissingInput, "Missing input_data");
    auto* tensor = std::get_if<TensorData>(&data_val);
    if (!tensor)
      throw NodeError(NodeError::Kind::Runtime, "tensorToImage: input is not a tensor");
    if (tensor->empty())
      throw NodeError(NodeError::Kind::Runtime, "tensorToImage: empty tensor");

    int w = 256, h = 64;
    {
      auto ws = get_config(node, "width");
      auto hs = get_config(node, "height");
      try {
        if (!ws.empty()) w = std::max(1, std::stoi(ws));
      } catch (...) {
      }
      try {
        if (!hs.empty()) h = std::max(1, std::stoi(hs));
      } catch (...) {
      }
    }

    std::string colormap = get_config(node, "colormap");
    if (colormap.empty()) colormap = "viridis";
    std::string normalize = get_config(node, "normalize");
    if (normalize.empty()) normalize = "auto";

    // Determine value range. "auto" rescales the observed min..max to 0..1
    // so even softmax outputs (which are already in [0,1] but tend to cluster
    // near 0) light up; "none" just clamps to [0,1] and trusts the upstream.
    float vmin = (*tensor)[0], vmax = (*tensor)[0];
    for (float v : *tensor) {
      vmin = std::min(vmin, v);
      vmax = std::max(vmax, v);
    }
    float scale = (vmax > vmin) ? 1.0f / (vmax - vmin) : 1.0f;

    auto sample = [&](int col) -> float {
      // Map column index to source-tensor index via nearest-neighbour
      // resampling. Good enough for a diagnostic heatmap; spline / linear
      // interp would be overkill here.
      int n = static_cast<int>(tensor->size());
      int idx = (col * n) / w;
      if (idx >= n) idx = n - 1;
      float v = (*tensor)[idx];
      if (normalize == "auto") {
        v = (v - vmin) * scale;
      }
      if (v < 0.0f) v = 0.0f;
      if (v > 1.0f) v = 1.0f;
      return v;
    };

    // Cheap viridis approximation: 5 control points evaluated by piecewise
    // linear interp. Visually close to the matplotlib LUT; we don't need
    // perceptual accuracy for a debug heatmap.
    auto viridis = [](float t, uint8_t& r, uint8_t& g, uint8_t& b) {
      static const float stops[5][3] = {
          {0.267f, 0.005f, 0.329f},  // 0.00 — deep purple
          {0.229f, 0.322f, 0.546f},  // 0.25 — blue
          {0.127f, 0.566f, 0.551f},  // 0.50 — teal
          {0.369f, 0.789f, 0.383f},  // 0.75 — green
          {0.993f, 0.906f, 0.144f},  // 1.00 — yellow
      };
      if (t < 0.0f) t = 0.0f;
      if (t > 1.0f) t = 1.0f;
      float fi = t * 4.0f;
      int i = static_cast<int>(fi);
      if (i > 3) i = 3;
      float f = fi - static_cast<float>(i);
      float fr = stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f;
      float fg = stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f;
      float fb = stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f;
      r = static_cast<uint8_t>(std::round(fr * 255.0f));
      g = static_cast<uint8_t>(std::round(fg * 255.0f));
      b = static_cast<uint8_t>(std::round(fb * 255.0f));
    };

    ImageData img;
    img.width = w;
    img.height = h;
    img.channels = 4;
    img.pixels.resize(static_cast<std::size_t>(w) * h * 4u);

    // Build one row's worth of RGBA, then memcpy it into every other row
    // so we don't pay the per-row colormap eval h times.
    std::vector<uint8_t> row(static_cast<std::size_t>(w) * 4u);
    for (int x = 0; x < w; ++x) {
      float v = sample(x);
      uint8_t r, g, b;
      if (colormap == "gray") {
        uint8_t gray = static_cast<uint8_t>(std::round(v * 255.0f));
        r = g = b = gray;
      } else {
        viridis(v, r, g, b);
      }
      row[x * 4 + 0] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = 255;
    }
    for (int y = 0; y < h; ++y) {
      std::memcpy(&img.pixels[static_cast<std::size_t>(y) * w * 4u], row.data(), row.size());
    }

    ctx.set_output(node.id, "image_data", std::move(img));
    return {};
  }
};

// 5x7 bitmap font, ASCII printable range 0x20..0x7E. Each glyph is 5 columns
// wide; each column is a 7-bit mask (LSB = top row, bit 6 = bottom row). Glyphs
// are kept simple/legible rather than typographically beautiful — this is for
// debug overlays, not body copy.
//
// Design notes:
//   * 1-pixel inter-glyph spacing handled by the renderer (advance = 6).
//   * Lowercase letters reuse uppercase shapes shifted into rows 2..6 where
//     possible to keep the table compact and the visuals predictable.
//   * Unsupported / unmapped chars render as a hollow box.
namespace {
struct Glyph5x7 {
  uint8_t cols[5];
};

constexpr Glyph5x7 kGlyphMissing = {{0x7F, 0x41, 0x41, 0x41, 0x7F}};

// clang-format off
constexpr Glyph5x7 kFont[95] = {
  {{0x00,0x00,0x00,0x00,0x00}}, // ' '
  {{0x00,0x00,0x5F,0x00,0x00}}, // !
  {{0x00,0x07,0x00,0x07,0x00}}, // "
  {{0x14,0x7F,0x14,0x7F,0x14}}, // #
  {{0x24,0x2A,0x7F,0x2A,0x12}}, // $
  {{0x23,0x13,0x08,0x64,0x62}}, // %
  {{0x36,0x49,0x55,0x22,0x50}}, // &
  {{0x00,0x05,0x03,0x00,0x00}}, // '
  {{0x00,0x1C,0x22,0x41,0x00}}, // (
  {{0x00,0x41,0x22,0x1C,0x00}}, // )
  {{0x14,0x08,0x3E,0x08,0x14}}, // *
  {{0x08,0x08,0x3E,0x08,0x08}}, // +
  {{0x00,0x50,0x30,0x00,0x00}}, // ,
  {{0x08,0x08,0x08,0x08,0x08}}, // -
  {{0x00,0x60,0x60,0x00,0x00}}, // .
  {{0x20,0x10,0x08,0x04,0x02}}, // /
  {{0x3E,0x51,0x49,0x45,0x3E}}, // 0
  {{0x00,0x42,0x7F,0x40,0x00}}, // 1
  {{0x42,0x61,0x51,0x49,0x46}}, // 2
  {{0x21,0x41,0x45,0x4B,0x31}}, // 3
  {{0x18,0x14,0x12,0x7F,0x10}}, // 4
  {{0x27,0x45,0x45,0x45,0x39}}, // 5
  {{0x3C,0x4A,0x49,0x49,0x30}}, // 6
  {{0x01,0x71,0x09,0x05,0x03}}, // 7
  {{0x36,0x49,0x49,0x49,0x36}}, // 8
  {{0x06,0x49,0x49,0x29,0x1E}}, // 9
  {{0x00,0x36,0x36,0x00,0x00}}, // :
  {{0x00,0x56,0x36,0x00,0x00}}, // ;
  {{0x08,0x14,0x22,0x41,0x00}}, // <
  {{0x14,0x14,0x14,0x14,0x14}}, // =
  {{0x00,0x41,0x22,0x14,0x08}}, // >
  {{0x02,0x01,0x51,0x09,0x06}}, // ?
  {{0x32,0x49,0x79,0x41,0x3E}}, // @
  {{0x7E,0x11,0x11,0x11,0x7E}}, // A
  {{0x7F,0x49,0x49,0x49,0x36}}, // B
  {{0x3E,0x41,0x41,0x41,0x22}}, // C
  {{0x7F,0x41,0x41,0x22,0x1C}}, // D
  {{0x7F,0x49,0x49,0x49,0x41}}, // E
  {{0x7F,0x09,0x09,0x09,0x01}}, // F
  {{0x3E,0x41,0x49,0x49,0x7A}}, // G
  {{0x7F,0x08,0x08,0x08,0x7F}}, // H
  {{0x00,0x41,0x7F,0x41,0x00}}, // I
  {{0x20,0x40,0x41,0x3F,0x01}}, // J
  {{0x7F,0x08,0x14,0x22,0x41}}, // K
  {{0x7F,0x40,0x40,0x40,0x40}}, // L
  {{0x7F,0x02,0x0C,0x02,0x7F}}, // M
  {{0x7F,0x04,0x08,0x10,0x7F}}, // N
  {{0x3E,0x41,0x41,0x41,0x3E}}, // O
  {{0x7F,0x09,0x09,0x09,0x06}}, // P
  {{0x3E,0x41,0x51,0x21,0x5E}}, // Q
  {{0x7F,0x09,0x19,0x29,0x46}}, // R
  {{0x46,0x49,0x49,0x49,0x31}}, // S
  {{0x01,0x01,0x7F,0x01,0x01}}, // T
  {{0x3F,0x40,0x40,0x40,0x3F}}, // U
  {{0x1F,0x20,0x40,0x20,0x1F}}, // V
  {{0x7F,0x20,0x18,0x20,0x7F}}, // W
  {{0x63,0x14,0x08,0x14,0x63}}, // X
  {{0x03,0x04,0x78,0x04,0x03}}, // Y
  {{0x61,0x51,0x49,0x45,0x43}}, // Z
  {{0x00,0x7F,0x41,0x41,0x00}}, // [
  {{0x02,0x04,0x08,0x10,0x20}}, // backslash
  {{0x00,0x41,0x41,0x7F,0x00}}, // ]
  {{0x04,0x02,0x01,0x02,0x04}}, // ^
  {{0x40,0x40,0x40,0x40,0x40}}, // _
  {{0x00,0x01,0x02,0x04,0x00}}, // `
  {{0x20,0x54,0x54,0x54,0x78}}, // a
  {{0x7F,0x48,0x44,0x44,0x38}}, // b
  {{0x38,0x44,0x44,0x44,0x20}}, // c
  {{0x38,0x44,0x44,0x48,0x7F}}, // d
  {{0x38,0x54,0x54,0x54,0x18}}, // e
  {{0x08,0x7E,0x09,0x01,0x02}}, // f
  {{0x0C,0x52,0x52,0x52,0x3E}}, // g
  {{0x7F,0x08,0x04,0x04,0x78}}, // h
  {{0x00,0x44,0x7D,0x40,0x00}}, // i
  {{0x20,0x40,0x44,0x3D,0x00}}, // j
  {{0x7F,0x10,0x28,0x44,0x00}}, // k
  {{0x00,0x41,0x7F,0x40,0x00}}, // l
  {{0x7C,0x04,0x18,0x04,0x78}}, // m
  {{0x7C,0x08,0x04,0x04,0x78}}, // n
  {{0x38,0x44,0x44,0x44,0x38}}, // o
  {{0x7C,0x14,0x14,0x14,0x08}}, // p
  {{0x08,0x14,0x14,0x18,0x7C}}, // q
  {{0x7C,0x08,0x04,0x04,0x08}}, // r
  {{0x48,0x54,0x54,0x54,0x20}}, // s
  {{0x04,0x3F,0x44,0x40,0x20}}, // t
  {{0x3C,0x40,0x40,0x20,0x7C}}, // u
  {{0x1C,0x20,0x40,0x20,0x1C}}, // v
  {{0x3C,0x40,0x30,0x40,0x3C}}, // w
  {{0x44,0x28,0x10,0x28,0x44}}, // x
  {{0x0C,0x50,0x50,0x50,0x3C}}, // y
  {{0x44,0x64,0x54,0x4C,0x44}}, // z
  {{0x00,0x08,0x36,0x41,0x00}}, // {
  {{0x00,0x00,0x7F,0x00,0x00}}, // |
  {{0x00,0x41,0x36,0x08,0x00}}, // }
  {{0x08,0x04,0x08,0x10,0x08}}, // ~
};
// clang-format on

inline const Glyph5x7& glyph_for(char c) {
  if (c < 0x20 || c > 0x7E) return kGlyphMissing;
  return kFont[static_cast<int>(c) - 0x20];
}
}  // namespace

// Overlay top-K labels on an RGBA image. Consumes the [idx, score, idx, score,
// ...] tensor produced by PostprocessHandler/topk and (optionally) a labels
// file with one class name per line. Renders a translucent black box in the
// top-left and draws lines like "Samoyed: 0.79" or, when no labels file is
// configured, "[207]: 0.79". Output is a new ImageData (input is not mutated).
class AnnotateImageHandler : public NodeHandler {
 public:
  std::string type() const override { return "annotateImage"; }
  std::string label() const override { return "Annotate Image"; }
  std::string category() const override { return "output"; }
  std::vector<HandlerPortDef> port_defs() const override {
    return {
        {"image_data", "target", "image"},
        {"topk_data", "target", "tensor"},
        {"output_data", "source", "image"},
    };
  }
  json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
    auto img_val = ctx.resolve_input(node.id, "image_data", graph);
    auto topk_val = ctx.resolve_input(node.id, "topk_data", graph);
    auto* in_img = std::get_if<ImageData>(&img_val);
    if (!in_img)
      throw NodeError(NodeError::Kind::MissingInput, "annotateImage: missing image_data");
    auto* topk = std::get_if<TensorData>(&topk_val);
    if (!topk)
      throw NodeError(NodeError::Kind::MissingInput, "annotateImage: missing topk_data");
    if (in_img->width <= 0 || in_img->height <= 0)
      throw NodeError(NodeError::Kind::Runtime, "annotateImage: zero-sized input image");
    const std::size_t expected =
        static_cast<std::size_t>(in_img->width) * in_img->height * 4u;
    if (in_img->pixels.size() != expected) {
      throw NodeError(NodeError::Kind::Runtime,
                      "annotateImage: input pixel buffer size mismatch");
    }

    int max_lines = 5;
    {
      auto s = get_config(node, "maxLines");
      if (!s.empty()) try {
          max_lines = std::max(1, std::stoi(s));
        } catch (...) {
        }
    }
    int scale = 2;
    {
      auto s = get_config(node, "fontScale");
      if (!s.empty()) try {
          scale = std::max(1, std::stoi(s));
        } catch (...) {
        }
    }

    // Optionally load labels. Unset => print "[idx]: score". Set-but-unreadable
    // => raise so the operator fixes the workflow rather than silently
    // shipping a label-less image.
    std::vector<std::string> labels;
    auto labels_path = get_config(node, "labelsPath");
    if (!labels_path.empty()) {
      auto resolved = resolve_path(labels_path);
      std::ifstream f(resolved);
      if (!f)
        throw NodeError(NodeError::Kind::Runtime,
                        "annotateImage: cannot open labelsPath: " + labels_path);
      std::string line;
      while (std::getline(f, line)) {
        // Strip trailing CR (CRLF files) so the rendered string doesn't drag
        // an unprintable byte through the bitmap font.
        if (!line.empty() && line.back() == '\r') line.pop_back();
        labels.push_back(line);
      }
    }

    // Build the text lines. Top-K layout from PostprocessHandler is pairs of
    // (index, score). We walk pairs until we hit max_lines or run out.
    std::vector<std::string> lines;
    int pair_count = static_cast<int>(topk->size() / 2);
    int n_lines = std::min(max_lines, pair_count);
    lines.reserve(n_lines);
    for (int i = 0; i < n_lines; ++i) {
      int idx = static_cast<int>((*topk)[i * 2 + 0]);
      float score = (*topk)[i * 2 + 1];
      char score_buf[16];
      std::snprintf(score_buf, sizeof(score_buf), "%.3f", score);
      std::string lbl;
      if (!labels.empty() && idx >= 0 && idx < static_cast<int>(labels.size())) {
        lbl = labels[idx];
      } else {
        lbl = "[" + std::to_string(idx) + "]";
      }
      lines.push_back(lbl + ": " + score_buf);
    }
    if (lines.empty()) lines.push_back("(no predictions)");

    // Copy input to output; we draw on the copy.
    ImageData out = *in_img;

    const int char_w = 5 * scale;
    const int char_h = 7 * scale;
    const int char_advance = (5 + 1) * scale;  // 1px inter-glyph in source units
    const int line_advance = (7 + 2) * scale;  // 2px between lines
    const int padding = 4 * scale;

    int max_chars = 0;
    for (const auto& l : lines) max_chars = std::max(max_chars, static_cast<int>(l.size()));
    int box_w = max_chars * char_advance + padding * 2;
    int box_h = static_cast<int>(lines.size()) * line_advance + padding * 2 - (2 * scale);
    box_w = std::min(box_w, out.width);
    box_h = std::min(box_h, out.height);

    // Translucent black background (alpha-blended over existing pixels) so
    // the text remains readable on busy images without nuking the underlay.
    const float alpha = 0.55f;
    for (int y = 0; y < box_h; ++y) {
      for (int x = 0; x < box_w; ++x) {
        std::size_t off = (static_cast<std::size_t>(y) * out.width + x) * 4u;
        for (int c = 0; c < 3; ++c) {
          float src = static_cast<float>(out.pixels[off + c]);
          out.pixels[off + c] = static_cast<uint8_t>(src * (1.0f - alpha));
        }
        out.pixels[off + 3] = 255;
      }
    }

    auto put_pixel = [&](int x, int y, uint8_t r, uint8_t g, uint8_t b) {
      if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
      std::size_t off = (static_cast<std::size_t>(y) * out.width + x) * 4u;
      out.pixels[off + 0] = r;
      out.pixels[off + 1] = g;
      out.pixels[off + 2] = b;
      out.pixels[off + 3] = 255;
    };

    auto draw_char = [&](char c, int ox, int oy) {
      const Glyph5x7& g = glyph_for(c);
      for (int col = 0; col < 5; ++col) {
        uint8_t mask = g.cols[col];
        for (int row = 0; row < 7; ++row) {
          if (mask & (1u << row)) {
            // Each source pixel becomes a scale*scale block to honour fontScale.
            int px0 = ox + col * scale;
            int py0 = oy + row * scale;
            for (int dy = 0; dy < scale; ++dy)
              for (int dx = 0; dx < scale; ++dx)
                put_pixel(px0 + dx, py0 + dy, 255, 255, 255);
          }
        }
      }
    };

    int cy = padding;
    for (const auto& line : lines) {
      int cx = padding;
      // Truncate per-line to whatever fits in the box; "..." for clarity.
      int max_glyphs = (out.width - padding * 2) / char_advance;
      std::string render = line;
      if (static_cast<int>(render.size()) > max_glyphs && max_glyphs >= 4) {
        render = render.substr(0, max_glyphs - 3) + "...";
      }
      for (char c : render) {
        draw_char(c, cx, cy);
        cx += char_advance;
      }
      cy += line_advance;
      if (cy + char_h > out.height) break;
    }

    ctx.set_output(node.id, "output_data", std::move(out));
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
        {"input_data", "target", "tensor"},
        {"true_branch", "source", "branch"},
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
    if (!err.empty())
      extra["expression_error"] = err;
    return extra;
  }
};

class OutputHandler : public NodeHandler {
 public:
  std::string type() const override { return "output"; }
  std::string label() const override { return "Output"; }
  std::string category() const override { return "output"; }
  std::vector<HandlerPortDef> port_defs() const override { return {{"data", "target", "generic"}}; }
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
        {"data_in", "target", "generic"},
        {"data_out", "source", "generic"},
    };
  }
  json execute(const NodeDef& node, const WorkflowGraph& graph, ExecutionContext& ctx) override {
    auto data_val = ctx.resolve_input(node.id, "data_in", graph);
    ctx.set_output(node.id, "data_out", data_val);
    return {};
  }
};

void register_core_handlers(
    std::unordered_map<std::string, std::shared_ptr<NodeHandler>>& registry) {
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
  add(std::make_shared<TensorToImageHandler>());
  add(std::make_shared<AnnotateImageHandler>());
}

}  // namespace handlers
}  // namespace workflow
