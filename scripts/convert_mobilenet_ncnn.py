#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 WorkflowUI contributors
"""
Convert pretrained MobileNetV2 from torchvision to NCNN format.

Two backends are supported, in order of preference:
  1. pnnx (modern, bundled with `pip install pnnx`) — TorchScript -> NCNN.
  2. onnx2ncnn (legacy, from ncnn release tarballs)  — ONNX -> NCNN.

pnnx is the recommended path on current torch (>= 2.0). It takes a
TorchScript module produced by `torch.jit.trace` and emits NCNN's
`.param` + `.bin` directly without an ONNX hop, dodging opset
incompatibilities between torchvision and onnx2ncnn.

Why MobileNetV2:
- 1000-class ImageNet classifier, ~13 MB weights.
- Standard 224x224x3 input, simple preprocessing.
- Wide vendor support: every NCNN release ships verified ops for it.

Dependencies:
    pip install torch torchvision pnnx
    # OR (legacy path):
    pip install torch torchvision onnx onnxsim
    # plus an `onnx2ncnn` binary on PATH.

Usage:
    python scripts/convert_mobilenet_ncnn.py

Output:
    demo/image_processing/mobilenetv2.param
    demo/image_processing/mobilenetv2.bin
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(REPO_ROOT, "demo", "image_processing")
PT_PATH = os.path.join(OUT_DIR, "mobilenetv2.pt")
ONNX_PATH = os.path.join(OUT_DIR, "mobilenetv2.onnx")
PARAM_PATH = os.path.join(OUT_DIR, "mobilenetv2.param")
BIN_PATH = os.path.join(OUT_DIR, "mobilenetv2.bin")


def _load_model():
    try:
        import torch
        import torchvision.models as models
    except ImportError:
        sys.exit(
            "torch and torchvision are required.\n"
            "Install with: pip install torch torchvision"
        )

    print("[1/3] Loading pretrained MobileNetV2...")
    # weights="DEFAULT" works on torchvision >= 0.13; fall back to the
    # legacy `pretrained=True` API on older installs.
    try:
        model = models.mobilenet_v2(weights="DEFAULT")
    except TypeError:
        model = models.mobilenet_v2(pretrained=True)
    model.eval()
    return model, torch


def find_pnnx() -> str | None:
    """Locate the `pnnx` CLI: PATH first, then the pnnx pip package."""
    found = shutil.which("pnnx")
    if found:
        return found
    try:
        import pnnx as _pnnx  # type: ignore
    except ImportError:
        return None
    pkg_dir = os.path.dirname(_pnnx.__file__)
    candidate = os.path.join(pkg_dir, "pnnx")
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


def find_onnx2ncnn() -> str | None:
    found = shutil.which("onnx2ncnn")
    if found:
        return found
    try:
        import ncnn  # type: ignore
    except ImportError:
        return None
    pkg_dir = os.path.dirname(ncnn.__file__)
    for candidate in [
        os.path.join(pkg_dir, "bin", "onnx2ncnn"),
        os.path.join(pkg_dir, "onnx2ncnn"),
    ]:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def convert_via_pnnx(model, torch_module) -> bool:
    tool = find_pnnx()
    if not tool:
        return False
    print("[2/3] Tracing TorchScript and running pnnx...")
    dummy = torch_module.randn(1, 3, 224, 224)
    traced = torch_module.jit.trace(model, dummy)
    traced.save(PT_PATH)

    # pnnx emits a fan of files alongside the input .pt; we keep only the
    # ncnn pair and clean the rest up at the end.
    cwd = OUT_DIR
    cmd = [
        tool,
        os.path.basename(PT_PATH),
        "inputshape=[1,3,224,224]",
        f"ncnnparam={os.path.basename(PARAM_PATH)}",
        f"ncnnbin={os.path.basename(BIN_PATH)}",
    ]
    print("[3/3] Running:", " ".join(cmd), f"(cwd={cwd})")
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.exit(f"pnnx failed (exit {result.returncode}).")
    return True


def convert_via_onnx(model, torch_module) -> bool:
    tool = find_onnx2ncnn()
    if not tool:
        return False
    print("[2/3] Exporting to ONNX (opset 11, fixed 1x3x224x224)...")
    dummy = torch_module.randn(1, 3, 224, 224)
    torch_module.onnx.export(
        model,
        dummy,
        ONNX_PATH,
        opset_version=11,
        input_names=["data"],
        output_names=["output"],
        dynamic_axes=None,
    )

    # Optional simplification step. We swallow any failure and continue
    # with the un-simplified model — it usually still converts fine.
    try:
        import onnx
        from onnxsim import simplify

        print("    Simplifying ONNX graph...")
        m = onnx.load(ONNX_PATH)
        simplified, ok = simplify(m)
        if ok:
            onnx.save(simplified, ONNX_PATH)
    except Exception as exc:  # noqa: BLE001 — best effort
        print(f"    Skipped simplification: {exc}")

    print("[3/3] Converting ONNX -> NCNN...")
    result = subprocess.run(
        [tool, ONNX_PATH, PARAM_PATH, BIN_PATH], capture_output=True, text=True
    )
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.exit(f"onnx2ncnn failed (exit {result.returncode}).")
    return True


def cleanup_intermediate() -> None:
    """Remove anything pnnx/onnx leaves behind that isn't .param/.bin."""
    for fname in os.listdir(OUT_DIR):
        full = os.path.join(OUT_DIR, fname)
        if full in (PARAM_PATH, BIN_PATH):
            continue
        # Match common pnnx/onnx auxiliaries: *.onnx, *.pt, model.pnnx.*,
        # debug.bin/.param, model_pnnx.py, model_ncnn.py.
        keep_suffix = fname.endswith((".png",))  # keep sample.png, README.md
        if keep_suffix or fname == "README.md" or fname == "workflow.json":
            continue
        if (
            fname.endswith(".onnx")
            or fname.endswith(".onnx.data")
            or fname.endswith(".pt")
            or fname.endswith(".py")
            or "pnnx" in fname
            or fname.startswith("debug")
        ):
            try:
                os.remove(full)
            except OSError:
                pass


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    model, torch_module = _load_model()
    if not convert_via_pnnx(model, torch_module):
        if not convert_via_onnx(model, torch_module):
            sys.exit(
                "No NCNN converter available. Install one of:\n"
                "  - pnnx (recommended): pip install pnnx\n"
                "  - onnx2ncnn (legacy): from ncnn release builds, plus "
                "`pip install onnx onnxsim`\n"
                "Then re-run this script."
            )
    cleanup_intermediate()
    print()
    print("Conversion complete:")
    print(f"  param: {PARAM_PATH}")
    print(f"  bin:   {BIN_PATH}")
    print()
    print("Model specs:")
    print("  input:  blob 'data' (or 'in0' if produced by pnnx), 1x3x224x224")
    print("  output: blob 'output' (or 'out0' if pnnx), 1x1000 ImageNet logits")
    print()
    print("If the input/output blob names differ from the workflow.json "
          "(`data`/`output`), open the generated .param file to copy the "
          "real names into the createNet node config.")


if __name__ == "__main__":
    main()
