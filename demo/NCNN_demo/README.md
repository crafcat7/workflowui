<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 WorkflowUI contributors -->
# NCNN Demos

Two ready-to-import workflow files live in this directory.

## 1. `workflow.json` — ShuffleNet sanity check (no weights)

Loads ShuffleNet's `.param` only, runs inference on a synthetic tensor, and exercises a benchmark side-branch. Useful for verifying the executor wiring without needing real weights.

## 2. `image_classification.json` — MobileNetV2 end-to-end image classification

Real image → image-to-tensor coercion → MobileNetV2 inference → benchmark → top-5 → conditional inspect/log → softmax heatmap → annotated image → composited overlay → segmentation mask → detection box overlay. Exercises the full image processing pipeline, including every inference/output image handler (`benchmark`, `tensorToImage` with overlay, `annotateImage`, `composite`, `segmentationMask`, `drawBoxes`).

```
inputImage ─► saveImage  (round-trip preview)
       │
       └─► inference (image→tensor, NCNN MobileNetV2) ─► topk(5) ─► condition ─┬─► inspect → output
       │                                                                      └─► saveText (low-confidence log)
       │
       ├─► benchmark (1s sample) ─► output
       │
       ├─► tensorToImage (softmax heatmap, overlay on image) ─► composite (+ original) ─► saveImage (composite.png)
       │
       ├─► annotateImage (top-5 labels) ─► saveImage (classified.png)
       │
       ├─► inputTensor (synthetic 5x5x3 logits) ─► segmentationMask ─► saveImage (segmask.png)
       │
       └─► inputTensor (synthetic boxes) ─► postprocess(NMS) ─► drawBoxes ─► saveImage (boxes.png)
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

### Node Reference

Every node in `image_classification.json` — 23 nodes, 25 edges. Pins (source → target) describe how data flows.

| Node | Type | Purpose | Key Config |
|---|---|---|---|
| `img_in` | Input Image | Load the 224×224 Samoyed photo. Shows a live preview thumbnail. | `filePath: demo/NCNN_demo/sample_224.png` |
| `img_save` | Save Image | Re-encode and save the decoded image for round-trip verification. | `filePath: demo/NCNN_demo/roundtrip.png` |
| `net` | Create Net | Load MobileNetV2 NCNN model. *View Model* button parses `.param`. | `vendor: ncnn`, `paramPath`, `modelPath`, `inputName: in0`, `outputName: out0`, `inputW/H/C: 224/224/3` |
| `infer` | Inference | Single forward pass. Accepts image input (auto coercion to CHW float). | — |
| `bench` | Benchmark | Run MobileNetV2 repeatedly for 1 second and report avg latency. | `duration: 1` |
| `out_bench` | Output | Display benchmark results (runs, avg-ms). | — |
| `post` | Postprocess | Select top-5 classes by score from the 1000-class output vector. | `op: topk`, `k: 5` |
| `cond` | Condition | Route to the true branch when max score > 0.1. | `expression: max > 0.1` |
| `inspect` | Debug | Pass-through inspection point for the true-branch tensor. | — |
| `out_main` | Output | Display top-5 classification results inline. | — |
| `save_text` | Save Text | Save low-confidence log (only written when condition takes false branch). | `filePath: demo/NCNN_demo/low_confidence.txt` |
| `heatmap` | Tensor To Image | Render the softmax heatmap overlaid on the input image. | `colormap: viridis`, `normalize: auto`, `overlayOpacity: 0.5` |
| `comp` | Composite | Blend the heatmap overlay onto the original image at reduced opacity. | `opacity: 0.4` |
| `save_comp` | Save Image | Save the composited heatmap result. | `filePath: demo/NCNN_demo/composite.png` |
| `annotate` | Annotate Image | Overlay top-5 class names and confidence scores on the image. | `labelsPath: demo/NCNN_demo/imagenet_classes.txt`, `maxLines: 5`, `fontScale: 2` |
| `save_annotated` | Save Image | Save the annotated classification image. | `filePath: demo/NCNN_demo/classified.png` |
| `seg_src` | Input Tensor | Synthetic 5×5×3 logits (3-class spatial grid). | `fillMode: text`, `tensorText: 75 floats` |
| `seg` | Segmentation Mask | Argmax per-pixel logits → viridis-colored mask. | `width: 5`, `height: 5` |
| `save_seg` | Save Image | Save the 5×5 segmentation mask. | `filePath: demo/NCNN_demo/segmask.png` |
| `boxes_src` | Input Tensor | Synthetic NMS-format detection boxes `[x1,y1,x2,y2,score,…]`. | `fillMode: text`, `tensorText: 4 boxes` |
| `nms_boxes` | Postprocess | Non-max suppression on synthetic boxes. | `op: nms`, `iouThreshold: 0.45` |
| `draw_boxes` | Draw Boxes | Render surviving boxes on the input image with scores. | `confidenceThreshold: 0.3`, `lineWidth: 3`, `fontScale: 2` |
| `save_boxes` | Save Image | Save the box overlay image. | `filePath: demo/NCNN_demo/boxes.png` |

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
