<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 WorkflowUI contributors -->
# Image Processing Demo (MobileNetV2)

End-to-end image classification pipeline with benchmarking and post-inference image visualization:

```
InputImage  ─►  Inference (image→tensor coercion)  ─►  Postprocess (Top-5)
                       ▲                                       │
                       │                                       ▼
                CreateNet (NCNN)                          Condition
                MobileNetV2                                   │
                                                  ┌───────────┴───────────┐
                                                  ▼                       ▼
                                              Inspect → Output       SaveText
                                              (true: max>0.1)        (false branch)
                                                  │
                                                  ├─► Benchmark (1s sample) ─► Output
                                                  │
                                                  ├─► TensorToImage (overlay) ─► Composite ─► SaveImage (composite.png)
                                                  │
                                                  ├─► AnnotateImage (top-5 labels) ─► SaveImage (classified.png)
                                                  │
                                                  ├─► InputTensor (synthetic logits) ─► SegmentationMask ─► SaveImage (segmask.png)
                                                  │
                                                  └─► InputTensor (synthetic boxes) ─► Postprocess(NMS) ─► DrawBoxes ─► SaveImage (boxes.png)
```

## Files

| File | Purpose |
|------|---------|
| `workflow.json` | Wired demo workflow loadable from the UI. |
| `sample.png` | 224×224 dog photo (Samoyed). Sourced from [pytorch/hub `images/dog.jpg`](https://github.com/pytorch/hub/blob/master/images/dog.jpg), center-cropped and resized. Used here for non-commercial demo/testing only — replace with your own image if your distribution requires a clean license. |
| `imagenet_classes.txt` | 1000 ImageNet class labels (one per line), used by `annotateImage` to render human-readable class names. |
| `mobilenetv2.param` / `mobilenetv2.bin` | NCNN model files. **Generated** — see below. |

### Node Reference

Every node in `workflow.json` — 23 nodes, 25 edges.

| Node | Type | Purpose | Key Config |
|---|---|---|---|
| `img_in` | Input Image | Load the 224×224 Samoyed photo. Shows a live preview thumbnail. | `filePath: demo/image_processing/sample.png` |
| `img_save` | Save Image | Re-encode and save the decoded image for round-trip verification. | `filePath: demo/image_processing/roundtrip.png` |
| `net` | Create Net | Load MobileNetV2 NCNN model. *View Model* button parses `.param`. | `vendor: ncnn`, `paramPath`, `modelPath`, `inputName: in0`, `outputName: out0`, `inputW/H/C: 224/224/3` |
| `infer` | Inference | Single forward pass. Accepts image input (auto coercion to CHW float). | — |
| `bench` | Benchmark | Run MobileNetV2 repeatedly for 1 second and report avg latency. | `duration: 1` |
| `out_bench` | Output | Display benchmark results (runs, avg-ms). | — |
| `post` | Postprocess | Select top-5 classes by score from the 1000-class output vector. | `op: topk`, `k: 5` |
| `cond` | Condition | Route to the true branch when max score > 0.1. | `expression: max > 0.1` |
| `inspect` | Debug | Pass-through inspection point for the true-branch tensor. | — |
| `out_main` | Output | Display top-5 classification results inline. | — |
| `save_text` | Save Text | Save low-confidence log (only written when condition takes false branch). | `filePath: demo/image_processing/low_confidence.txt` |
| `heatmap` | Tensor To Image | Render the softmax heatmap overlaid on the input image. | `colormap: viridis`, `normalize: auto`, `overlayOpacity: 0.5` |
| `comp` | Composite | Blend the heatmap overlay onto the original image at reduced opacity. | `opacity: 0.4` |
| `save_comp` | Save Image | Save the composited heatmap result. | `filePath: demo/image_processing/composite.png` |
| `annotate` | Annotate Image | Overlay top-5 class names and confidence scores on the image. | `labelsPath: demo/image_processing/imagenet_classes.txt`, `maxLines: 5`, `fontScale: 2` |
| `save_annotated` | Save Image | Save the annotated classification image. | `filePath: demo/image_processing/classified.png` |
| `seg_src` | Input Tensor | Synthetic 5×5×3 logits (3-class spatial grid). | `fillMode: text`, `tensorText: 75 floats` |
| `seg` | Segmentation Mask | Argmax per-pixel logits → viridis-colored mask. | `width: 5`, `height: 5` |
| `save_seg` | Save Image | Save the 5×5 segmentation mask. | `filePath: demo/image_processing/segmask.png` |
| `boxes_src` | Input Tensor | Synthetic NMS-format detection boxes `[x1,y1,x2,y2,score,…]`. | `fillMode: text`, `tensorText: 4 boxes` |
| `nms_boxes` | Postprocess | Non-max suppression on synthetic boxes. | `op: nms`, `iouThreshold: 0.45` |
| `draw_boxes` | Draw Boxes | Render surviving boxes on the input image with scores. | `confidenceThreshold: 0.3`, `lineWidth: 3`, `fontScale: 2` |
| `save_boxes` | Save Image | Save the box overlay image. | `filePath: demo/image_processing/boxes.png` |

## Generating the model

The NCNN files are produced from torchvision's pretrained MobileNetV2 via
[pnnx](https://github.com/pnnx/pnnx) (or the legacy `onnx2ncnn` path):

```bash
pip install torch torchvision pnnx
python scripts/convert_mobilenet_ncnn.py
```

This writes `mobilenetv2.param` and `mobilenetv2.bin` into this directory.

The pnnx output uses blob names `in0` (input) and `out0` (output); the
included `workflow.json` already references those names. If you regenerate
the model with a different converter and the names differ, edit the
`createNet` node's `inputName` / `outputName` accordingly.

## Running the demo

1. Build the backend with NCNN enabled:

   ```bash
   cmake -DENABLE_NCNN=ON -S backend -B backend/build && cmake --build backend/build
   ```

2. Start the backend and frontend, then verify the running backend supports every node/port used by this demo (catches stale binaries):

   ```bash
   node scripts/check_backend_capabilities.mjs demo/image_processing/workflow.json
   ```

3. Load `demo/image_processing/workflow.json`, click Run.

4. Expect: image preview thumbnail in `Input Image` and `Save Image`, top-5 ImageNet logits surfaced through `inspect → output`, benchmark metrics surfaced through `Benchmark Output`, `composite.png` (softmax heatmap overlay + original image composited), `classified.png` with top-5 predictions overlaid, `segmask.png` synthetic 5×5 segmentation mask, `boxes.png` synthetic detection boxes rendered after NMS, `low_confidence.txt` only written when the max probability is ≤ 0.1.

## Verifying without the UI

A headless verification harness lives at `scripts/verify_image_workflow.mjs`. With the backend already running on a port (default 9097), run:

```bash
backend/build/workflow_backend --port 9097 &
node scripts/verify_image_workflow.mjs
# PORT=9090 node scripts/verify_image_workflow.mjs   # custom port
```

Exits 0 when every node reaches a terminal status (`done` / `skipped`), the condition routes exactly one branch, and `workflow.complete` is received. Exits non-zero on any timeout, error, or wiring regression. Uses Node 22's built-in `WebSocket`, no extra dependencies.

## Notes

- The `inference` node does **not** need a manual preprocess block: image→tensor coercion is performed in the handler (RGBA8 → RGB → CHW float [0,1]). Per-channel mean/std normalization is intentionally omitted; outputs are still meaningful for top-k inspection but won't match torchvision-reference accuracy without it. With the bundled dog photo the top-1 class is **Samoyed** at ~0.79.
- `roundtrip.png` and `low_confidence.txt` are produced when the workflow runs and are gitignored.
