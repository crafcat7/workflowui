<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 WorkflowUI contributors -->
# NCNN Demos

Two ready-to-import workflow files live in this directory.

## 1. `workflow.json` — ShuffleNet sanity check (no weights)

Loads ShuffleNet's `.param` only, runs inference on a synthetic tensor, and exercises a benchmark side-branch. Useful for verifying the executor wiring without needing real weights.

## 2. `image_classification.json` — MobileNetV2 end-to-end image classification

Full visual pipeline with every post-inference handler exercised. Nodes are arranged in a vertical three-column layout for clean, orthogonal edge connections.

```
img_in
  ├─► img_save ─► roundtrip.png
  └─► img_pass (composite passthrough)
        ├─► infer ← net
        │     └─► post ─► cond ─┬─► inspect → output
        │                       └─► saveText (low-confidence log, skipped)
        │
        ├─► benchmark ← net ─► output
        │
        ├─► post ─► heatmap ─► save_comp (composite.png)
        │
        ├─► post ─► annotate (topk + image) ─► save_annotated (classified.png)
        │
        ├─► post ─► seg ← seg_src ─► save_seg (segmask.png)
        │
        └─► post ─► nms ← boxes_src ─► draw_boxes ─► save_boxes (boxes.png)
```

The `benchmark` branch measures one second of MobileNetV2 inference and emits a sample tensor to `output`. The `composite` branch demonstrates `tensorToImage`'s overlay mode (heatmap drawn directly onto the input image) combined with the `composite` handler (second pass at reduced opacity). The `segmentationMask` branch uses a synthetic 3-class 5×5 logits tensor to showcase argmax → per-pixel viridis coloring without requiring a real segmentation model. The `drawBoxes` branch uses synthetic detection boxes, applies NMS, then renders the surviving boxes on the original image.

### Files

| File | Purpose |
|------|---------|
| `workflow.json` | ShuffleNet sanity workflow (uses `sample.png` 1×1 placeholder for image round-trip only). |
| `image_classification.json` | MobileNetV2 image classification workflow. |
| `sample.png` | 1×1 placeholder used by `workflow.json`'s round-trip step. |
| `sample_224.png` | 224×224 dog photo used by `image_classification.json`. Sourced from [pytorch/hub `images/dog.jpg`](https://github.com/pytorch/hub/blob/master/images/dog.jpg) (commonly used by PyTorch tutorials), center-cropped and resized to 224×224. Used here for non-commercial demo/testing purposes only. Replace with your own image if licensing for your distribution requires it. |
| `imagenet_classes.txt` | 1000 ImageNet class labels (one per line), used by `annotateImage` to render human-readable class names. Generated via `torchvision.models.MobileNet_V2_Weights.IMAGENET1K_V1.meta['categories']`. |
| `shufflenet.param` | ShuffleNet topology (no weights, runs with `emptyWeights:true`). |
| `mobilenetv2.param` / `mobilenetv2.bin` | MobileNetV2 NCNN files. **Generated** — see [`scripts/convert_mobilenet_ncnn.py`](../../scripts/convert_mobilenet_ncnn.py). |

### Importing the workflow

1. Build the backend with NCNN enabled (only required for `image_classification.json`):
   ```bash
   cmake -DENABLE_NCNN=ON -S backend -B backend/build && cmake --build backend/build
   ```
2. Start the backend **from the repository root** (paths are resolved relative to the backend's CWD):
   ```bash
   backend/build/workflow_backend --port 9090
   ```
3. Optional but recommended: verify the running backend supports every node/port used by this demo (catches stale binaries):
   ```bash
   node scripts/check_backend_capabilities.mjs demo/NCNN_demo/image_classification.json
   ```
4. In the UI, click the toolbar **Load** button (or `Cmd+O`) and select `demo/NCNN_demo/image_classification.json`.
5. Click **Run**. Expect:
   - Image preview thumbnail in `Input Image` and (after run) in `Save Image`.
   - Top-5 logits in the `Inspect Top-K` debug view → `Classification Output`. With the bundled dog photo, the top class is **Samoyed** at ~0.79.
   - Benchmark metrics in `Benchmark Output` after a 1-second sample run.
   - `composite.png` — softmax heatmap overlay composited onto the original image via `tensorToImage` overlay mode + `composite` handler.
   - `classified.png` — input image with top-5 predictions overlaid (class name + confidence).
   - `segmask.png` — 5×5 viridis-colored segmentation mask from synthetic 3-class logits (demonstrates `segmentationMask` handler).
   - `boxes.png` — synthetic object boxes rendered on the input image after NMS (demonstrates `drawBoxes`).
   - `low_confidence.txt` is **not** written (max > 0.1 takes the true branch); `save_text` shows `skipped`.

### Headless verification

```bash
node scripts/verify_image_workflow.mjs demo/NCNN_demo/image_classification.json
```

Submits the workflow over WebSocket, asserts every node lands in `done`/`skipped`, that exactly one branch of the condition is exercised, and that `workflow.complete` arrives. Exits non-zero on any regression. Uses Node 22's built-in `WebSocket`; no extra dependencies.
