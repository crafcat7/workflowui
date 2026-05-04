<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 WorkflowUI contributors -->
# Image Processing Demo (MobileNetV2)

End-to-end image classification pipeline with benchmarking and post-inference image visualization. Nodes are arranged in a clean vertical three-column layout with orthogonal (non-diagonal) connections.

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

## Files

| File | Purpose |
|------|---------|
| `workflow.json` | Wired demo workflow loadable from the UI. |
| `sample.png` | 224×224 dog photo (Samoyed). Sourced from [pytorch/hub `images/dog.jpg`](https://github.com/pytorch/hub/blob/master/images/dog.jpg), center-cropped and resized. Used here for non-commercial demo/testing only — replace with your own image if your distribution requires a clean license. |
| `imagenet_classes.txt` | 1000 ImageNet class labels (one per line), used by `annotateImage` to render human-readable class names. |
| `mobilenetv2.param` / `mobilenetv2.bin` | NCNN model files. **Generated** — see below. |

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
