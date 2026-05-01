<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 WorkflowUI contributors -->
# NCNN Demos

Two ready-to-import workflow files live in this directory.

## 1. `workflow.json` — ShuffleNet sanity check (no weights)

Loads ShuffleNet's `.param` only, runs inference on a synthetic tensor, and exercises a benchmark side-branch. Useful for verifying the executor wiring without needing real weights.

## 2. `image_classification.json` — MobileNetV2 end-to-end image classification

Real image → image-to-tensor coercion → MobileNetV2 inference → top-5 → conditional inspect/log → softmax heatmap → annotated image. Exercises the full image processing pipeline (PNG preview thumbnails on `inputImage` / `saveImage`, runtime `image → tensor` coercion, NCNN backend, postprocess + condition routing, `tensorToImage` heatmaps, `annotateImage` label overlay).

```
inputImage ─► saveImage  (round-trip preview)
       │
       └─► inference (image→tensor, NCNN MobileNetV2) ─► topk(5) ─► condition ─┬─► inspect → output
       │                                                                      └─► saveText (low-confidence log)
       │
       ├─► tensorToImage (softmax heatmap) ─► saveImage (softmax_heatmap.png)
       │
       └─► annotateImage (top-5 labels) ─► saveImage (classified.png)
```

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
3. In the UI, click the toolbar **Load** button (or `Cmd+O`) and select `demo/NCNN_demo/image_classification.json`.
4. Click **Run**. Expect:
   - Image preview thumbnail in `Input Image` and (after run) in `Save Image`.
   - Top-5 logits in the `Inspect Top-K` debug view → `Classification Output`. With the bundled dog photo, the top class is **Samoyed** at ~0.79.
   - `softmax_heatmap.png` — viridis heatmap of the full 1000-class softmax distribution.
   - `classified.png` — input image with top-5 predictions overlaid (class name + confidence).
   - `low_confidence.txt` is **not** written (max > 0.1 takes the true branch); `save_text` shows `skipped`.

### Headless verification

```bash
node scripts/verify_image_workflow.mjs demo/NCNN_demo/image_classification.json
```

Submits the workflow over WebSocket, asserts every node lands in `done`/`skipped`, that exactly one branch of the condition is exercised, and that `workflow.complete` arrives. Exits non-zero on any regression. Uses Node 22's built-in `WebSocket`; no extra dependencies.
