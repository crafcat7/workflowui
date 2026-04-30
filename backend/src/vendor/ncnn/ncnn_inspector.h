// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
#pragma once
#include "../model_inspector.h"

namespace workflow {

/**
 * Pure-stdlib parser for ncnn `.param` text files (magic 7767517).
 *
 * Why text-only / no `ncnn::Net` dependency:
 *   - The parser must be available even when the backend is built
 *     with `ENABLE_NCNN=OFF` (e.g. CI matrix targets that lack the
 *     ncnn install). Inspection is a structural read; it would be
 *     surprising if disabling the inference backend also disabled
 *     "View Model".
 *   - Going through `ncnn::Net::load_param` would also force every
 *     model layer through ncnn's layer factory, which fails on
 *     custom op types we may want to surface in the drawer rather
 *     than reject.
 *
 * Format reference (mirrored across ncnn upstream `paramdict.cpp`
 * and `net.cpp`, also visible in demo/NCNN_demo/shufflenet.param):
 *   Line 1: magic, must read as the integer 7767517.
 *   Line 2: "<layer_count> <blob_count>".
 *   Line 3..: per-layer rows of the form
 *     "<type> <name> <in_count> <out_count> <in_blobs...> <out_blobs...> <k=v|k=arr>..."
 *   Where <k=v> is either:
 *     - "<int_key>=<scalar>"           → params[key] = int|float
 *     - "<int_key>=<count>,<v0>,..."   → params[key] = json array
 *     - "-23330=N,d0,d1,..."           → ncnn shape hint; the trailing
 *       (N+1)-tuple maps to a blob shape annotation. We pull the
 *       inner shape values out and apply them to the layer's output
 *       blobs in declaration order; they do NOT land in `params`.
 *   Missing fields → ModelInspectError.
 *
 * The implementation is single-pass and allocates one ModelGraph;
 * blobs map is built incrementally so we can fill `producer` /
 * `consumers` while reading layer rows.
 */
class NcnnInspector : public ModelInspector {
 public:
  std::string vendor() const override { return "ncnn"; }
  ModelGraph inspect(const ModelInspectRequest& req) override;
};

}  // namespace workflow
