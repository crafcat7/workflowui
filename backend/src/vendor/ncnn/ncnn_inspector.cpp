// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#include "ncnn_inspector.h"

#include <sys/stat.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace workflow {
namespace {

// ncnn's internal "shape hint" key, written as a 23330 array.
// The layout is `dims, d0, d1, ..., d{dims-1}, c_step` per ncnn's
// Mat::dims convention. We surface only the leading `dims` values
// as the blob shape; the trailing element is an internal stride and
// not user-facing.
constexpr int kNcnnShapeHintKey = -23330;

// File-size helper kept local: stat() is portable enough across the
// linux/macos/mingw matrix without pulling in <filesystem>, which
// has had spotty support on the older toolchains we target.
int64_t file_size_or_zero(const std::string& path) {
  if (path.empty())
    return 0;
  struct stat st {};
  if (::stat(path.c_str(), &st) != 0)
    return 0;
  return static_cast<int64_t>(st.st_size);
}

// Tokenize on any run of whitespace. ncnn's `.param` writer aligns
// columns with arbitrary spaces, so a single-char split would emit
// empty tokens. The caller treats tokens.empty() lines as blanks.
std::vector<std::string> split_ws(const std::string& s) {
  std::vector<std::string> out;
  std::istringstream iss(s);
  std::string tok;
  while (iss >> tok)
    out.push_back(std::move(tok));
  return out;
}

// Parse a scalar that ncnn allows to be int OR float. ncnn upstream
// distinguishes by presence of '.' / 'e' / 'E'; we mirror that so
// integer keys (kernel, num_output) stay ints in JSON.
nlohmann::json parse_scalar(const std::string& s) {
  bool is_float = s.find_first_of(".eE") != std::string::npos;
  try {
    if (is_float)
      return std::stod(s);
    // Accept negative ints (some keys legitimately use them).
    return static_cast<int64_t>(std::stoll(s));
  } catch (const std::exception&) {
    // Fall back to string if it really isn't numeric. This
    // shouldn't happen on a well-formed .param but we choose
    // tolerance over a hard failure so the rest of the graph
    // still renders.
    return s;
  }
}

// Parse "<count>,<v0>,<v1>,..." into a json array of length count.
// The leading count is authoritative; if comma-separated values
// after it are short, we throw — silent truncation would corrupt
// shape hints we surface to the frontend.
nlohmann::json parse_array(const std::string& payload, const std::string& layer_name, int key) {
  std::vector<std::string> parts;
  {
    std::string cur;
    for (char c : payload) {
      if (c == ',') {
        parts.push_back(std::move(cur));
        cur.clear();
      } else
        cur.push_back(c);
    }
    parts.push_back(std::move(cur));
  }
  if (parts.empty()) {
    throw ModelInspectError("ncnn .param: empty array value for key " + std::to_string(key) +
                            " in layer '" + layer_name + "'");
  }
  int count = 0;
  try {
    count = std::stoi(parts[0]);
  } catch (const std::exception&) {
    throw ModelInspectError("ncnn .param: array count not an int for key " + std::to_string(key) +
                            " in layer '" + layer_name + "'");
  }
  if (count < 0 || static_cast<size_t>(count) + 1 != parts.size()) {
    throw ModelInspectError("ncnn .param: array length mismatch for key " + std::to_string(key) +
                            " in layer '" + layer_name + "'");
  }
  nlohmann::json arr = nlohmann::json::array();
  for (int i = 1; i <= count; ++i)
    arr.push_back(parse_scalar(parts[i]));
  return arr;
}

}  // namespace

ModelGraph NcnnInspector::inspect(const ModelInspectRequest& req) {
  if (req.param_path.empty()) {
    throw ModelInspectError("ncnn inspect: param_path is required");
  }

  std::ifstream in(req.param_path);
  if (!in) {
    throw ModelInspectError("ncnn inspect: cannot open .param: " + req.param_path);
  }

  ModelGraph g;
  g.vendor = "ncnn";
  g.editable = false;  // edit support arrives in a later iteration
  g.param_bytes = file_size_or_zero(req.param_path);
  g.bin_bytes = file_size_or_zero(req.model_path);

  std::string line;

  // Line 1: magic.
  if (!std::getline(in, line)) {
    throw ModelInspectError("ncnn .param: file is empty");
  }
  {
    auto tokens = split_ws(line);
    if (tokens.size() != 1 || tokens[0] != "7767517") {
      throw ModelInspectError("ncnn .param: bad magic, expected 7767517 got '" + line + "'");
    }
    g.format_version = "ncnn-7767517";
  }

  // Line 2: layer_count blob_count.
  if (!std::getline(in, line)) {
    throw ModelInspectError("ncnn .param: missing layer/blob count line");
  }
  int layer_count = 0;
  int blob_count = 0;
  {
    auto tokens = split_ws(line);
    if (tokens.size() != 2) {
      throw ModelInspectError("ncnn .param: header expected '<layers> <blobs>', got '" + line +
                              "'");
    }
    try {
      layer_count = std::stoi(tokens[0]);
      blob_count = std::stoi(tokens[1]);
    } catch (const std::exception&) {
      throw ModelInspectError("ncnn .param: header counts not integers: '" + line + "'");
    }
    if (layer_count < 0 || blob_count < 0) {
      throw ModelInspectError("ncnn .param: negative counts in header");
    }
  }

  g.layers.reserve(static_cast<size_t>(layer_count));
  g.blobs.reserve(static_cast<size_t>(blob_count));

  // Index into g.blobs while we read so we can populate
  // producer/consumers in one pass. A blob is created on first
  // mention (input or output) and updated when seen again.
  std::unordered_map<std::string, size_t> blob_index;
  auto touch_blob = [&](const std::string& name) -> ModelBlob& {
    auto it = blob_index.find(name);
    if (it == blob_index.end()) {
      blob_index.emplace(name, g.blobs.size());
      ModelBlob b;
      b.name = name;
      g.blobs.push_back(std::move(b));
      return g.blobs.back();
    }
    return g.blobs[it->second];
  };

  for (int li = 0; li < layer_count; ++li) {
    if (!std::getline(in, line)) {
      throw ModelInspectError("ncnn .param: truncated, expected " + std::to_string(layer_count) +
                              " layer rows, got " + std::to_string(li));
    }
    auto tokens = split_ws(line);
    if (tokens.empty()) {
      --li;
      continue;
    }  // skip blank lines
    if (tokens.size() < 4) {
      throw ModelInspectError("ncnn .param: layer row too short: '" + line + "'");
    }

    ModelLayer layer;
    layer.type = tokens[0];
    layer.id = tokens[1];
    int in_count = 0, out_count = 0;
    try {
      in_count = std::stoi(tokens[2]);
      out_count = std::stoi(tokens[3]);
    } catch (const std::exception&) {
      throw ModelInspectError("ncnn .param: bad in/out count on layer '" + layer.id + "'");
    }
    if (in_count < 0 || out_count < 0) {
      throw ModelInspectError("ncnn .param: negative in/out count on layer '" + layer.id + "'");
    }
    size_t expected = 4 + static_cast<size_t>(in_count) + static_cast<size_t>(out_count);
    if (tokens.size() < expected) {
      throw ModelInspectError("ncnn .param: layer '" + layer.id + "' missing blob names");
    }

    layer.input_blobs.reserve(static_cast<size_t>(in_count));
    layer.output_blobs.reserve(static_cast<size_t>(out_count));
    for (int i = 0; i < in_count; ++i)
      layer.input_blobs.push_back(tokens[4 + i]);
    for (int i = 0; i < out_count; ++i)
      layer.output_blobs.push_back(tokens[4 + in_count + i]);

    // Hold shape hint until we know which output blobs to write
    // it onto. ncnn writes `-23330=N,d0,...` once per layer and
    // it covers every output blob in `output_blobs` order.
    std::vector<std::vector<int>> per_output_shapes;

    for (size_t ti = expected; ti < tokens.size(); ++ti) {
      const std::string& kv = tokens[ti];
      auto eq = kv.find('=');
      if (eq == std::string::npos) {
        throw ModelInspectError("ncnn .param: malformed k=v '" + kv + "' on layer '" + layer.id +
                                "'");
      }
      int key = 0;
      try {
        key = std::stoi(kv.substr(0, eq));
      } catch (const std::exception&) {
        throw ModelInspectError("ncnn .param: non-int key '" + kv + "' on layer '" + layer.id +
                                "'");
      }
      std::string value = kv.substr(eq + 1);
      bool is_array = value.find(',') != std::string::npos;

      if (key == kNcnnShapeHintKey) {
        // Always an array. Layout per ncnn upstream:
        // count, then N output_blob shape blocks, each block is
        // {dims, d0, d1, ..., d{dims-1}}. count == sum of those
        // (dims+1) entries.
        if (!is_array) {
          throw ModelInspectError("ncnn .param: shape hint must be array on layer '" + layer.id +
                                  "'");
        }
        auto arr = parse_array(value, layer.id, key);
        size_t i = 0;
        for (int oi = 0; oi < out_count; ++oi) {
          if (i >= arr.size())
            break;
          int dims = arr[i].is_number_integer() ? arr[i].get<int>() : 0;
          ++i;
          std::vector<int> shape;
          shape.reserve(static_cast<size_t>(std::max(0, dims)));
          for (int d = 0; d < dims && i < arr.size(); ++d, ++i) {
            shape.push_back(arr[i].is_number_integer() ? arr[i].get<int>() : 0);
          }
          per_output_shapes.push_back(std::move(shape));
        }
        continue;
      }

      if (is_array) {
        layer.params[std::to_string(key)] = parse_array(value, layer.id, key);
      } else {
        layer.params[std::to_string(key)] = parse_scalar(value);
      }
    }

    // Wire blobs. Producer for each output, consumer for each input.
    for (const auto& iname : layer.input_blobs) {
      auto& b = touch_blob(iname);
      b.consumers.push_back(layer.id);
    }
    for (size_t oi = 0; oi < layer.output_blobs.size(); ++oi) {
      auto& b = touch_blob(layer.output_blobs[oi]);
      b.producer = layer.id;
      if (oi < per_output_shapes.size() && !per_output_shapes[oi].empty()) {
        b.shape = per_output_shapes[oi];
      }
    }

    // Surface graph-level inputs/outputs by layer type. ncnn marks
    // graph entry points with type "Input"; graph outputs are blobs
    // that no later layer consumes — we compute that after the loop.
    if (layer.type == "Input" && !layer.output_blobs.empty()) {
      for (const auto& on : layer.output_blobs) {
        g.input_blob_names.push_back(on);
      }
    }

    g.layers.push_back(std::move(layer));
  }

  // Cross-check declared blob count. ncnn's blob_count is the number
  // of Mat slots it allocates at runtime — we compare against unique
  // blob names. A mismatch usually means a hand-edited .param.
  if (static_cast<int>(g.blobs.size()) != blob_count) {
    throw ModelInspectError("ncnn .param: declared " + std::to_string(blob_count) +
                            " blobs but found " + std::to_string(g.blobs.size()));
  }

  // Compute graph outputs: any blob with a producer but no consumers
  // is a dangling tensor and treated as a model output. This matches
  // ncnn::Net::find_blob_index_by_name semantics for inference roots.
  for (const auto& b : g.blobs) {
    if (!b.producer.empty() && b.consumers.empty()) {
      g.output_blob_names.push_back(b.name);
    }
  }

  return g;
}

}  // namespace workflow
