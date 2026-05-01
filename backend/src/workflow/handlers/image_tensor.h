// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once

#include <cstddef>

#include "../../model/node.h"
#include "../node_error.h"

namespace workflow {
namespace handlers {

/**
 * Convert RGBA8 ImageData to CHW float TensorData.
 *
 * The runtime port-coercion contract declares `image → tensor` (see
 * portSchema.ts and executor.cpp), but the actual numeric reshape is
 * performed lazily here at the consumer (InferenceHandler / BenchmarkHandler).
 * Doing the conversion at the handler — rather than synthesizing a
 * coerced PortValue at edge resolution time — keeps the executor's
 * resolve_input free of vendor-specific tensor layout choices.
 *
 * Transformation:
 *   1. Drop alpha channel (RGBA → RGB)
 *   2. Normalize uint8 [0,255] → float [0.0, 1.0]
 *   3. Reorder HWC → CHW layout
 *
 * Output layout (planar): [R_plane(H*W), G_plane(H*W), B_plane(H*W)].
 * This matches what NCNN's Mat::from_pixels(..., PIXEL_RGB) produces and what
 * standard ImageNet-trained models (MobileNet/ShuffleNet/ResNet) expect as
 * input layout. Per-channel mean/std normalization is intentionally NOT
 * applied here — that is a model-specific concern and belongs in a future
 * dedicated preprocess node, not in this generic coercion helper.
 *
 * Throws NodeError(MissingInput) on a malformed ImageData (zero dims or a
 * pixel buffer too small for the declared dimensions).
 */
inline TensorData image_to_tensor(const ImageData& img) {
  const int w = img.width;
  const int h = img.height;
  if (w <= 0 || h <= 0) {
    throw NodeError(NodeError::Kind::MissingInput,
                    "image_to_tensor: image has non-positive dimensions");
  }
  const size_t expected = static_cast<size_t>(w) * static_cast<size_t>(h) * 4u;
  if (img.pixels.size() < expected) {
    throw NodeError(NodeError::Kind::MissingInput,
                    "image_to_tensor: pixel buffer smaller than width*height*4");
  }

  constexpr int kOutChannels = 3;  // RGB; alpha is dropped.
  TensorData out(static_cast<size_t>(kOutChannels) * static_cast<size_t>(h) *
                 static_cast<size_t>(w));

  const size_t plane = static_cast<size_t>(h) * static_cast<size_t>(w);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const size_t pixel_idx = static_cast<size_t>(y) * static_cast<size_t>(w) +
                               static_cast<size_t>(x);
      const uint8_t* px = &img.pixels[pixel_idx * 4u];
      out[0 * plane + pixel_idx] = static_cast<float>(px[0]) / 255.0f;  // R
      out[1 * plane + pixel_idx] = static_cast<float>(px[1]) / 255.0f;  // G
      out[2 * plane + pixel_idx] = static_cast<float>(px[2]) / 255.0f;  // B
    }
  }
  return out;
}

}  // namespace handlers
}  // namespace workflow
