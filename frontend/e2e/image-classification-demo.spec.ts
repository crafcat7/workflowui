// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * End-to-end test for the MobileNetV2 image classification demo.
 *
 * Flow:
 *   1. Spawn the real C++ backend on an isolated port.
 *   2. Open the app, override VITE_WS_URL so it talks to our backend.
 *   3. Import demo/NCNN_demo/image_classification.json via the hidden
 *      file input (the same path the toolbar's Load button takes).
 *   4. Run the workflow; assert workflow.complete arrives, every node
 *      lands in {done, skipped}, no node errors, the conditional routes
 *      exactly one branch (true: inspect+out_main done, false: save_text
 *      skipped with reason=branch_pruned), and the SaveImage round-trip
 *      file exists with a PNG magic header.
 *
 * This is the regression guard for the entire image-processing pipeline:
 *   - InputImage preview (image.preview RPC + 300ms debounce)
 *   - SaveImage preview on done transition
 *   - image -> tensor coercion in InferenceHandler
 *   - NCNN MobileNetV2 inference end-to-end
 *   - Postprocess top-K + conditional skip propagation
 *
 * Skipped automatically if the backend binary or generated MobileNetV2
 * model files are not present, so CI without ENABLE_NCNN / without the
 * generated model won't fail this spec.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_BIN = path.join(REPO_ROOT, 'backend', 'build', 'workflow_backend');
const DEMO_WORKFLOW = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'image_classification.json');
const MODEL_PARAM = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'mobilenetv2.param');
const MODEL_BIN = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'mobilenetv2.bin');
const SAMPLE_IMAGE = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'sample_224.png');
const ROUNDTRIP_PATH = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'roundtrip.png');
const LOW_CONF_PATH = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'low_confidence.txt');
const COMPOSITE_PATH = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'composite.png');
const ANNOTATED_PATH = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'classified.png');
const SEGMASK_PATH = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'segmask.png');

// Isolated from the mock backend (9099), prod (9090), and the
// shufflenet ncnn-demo test (9098).
const BACKEND_PORT = 9097;

let backendProc: ChildProcessWithoutNullStreams | undefined;
let backendOutput = '';

test.beforeAll(async () => {
  test.skip(!fs.existsSync(BACKEND_BIN), `Backend binary not built at ${BACKEND_BIN}`);
  test.skip(!fs.existsSync(DEMO_WORKFLOW), `Demo workflow missing at ${DEMO_WORKFLOW}`);
  test.skip(
    !fs.existsSync(MODEL_PARAM) || !fs.existsSync(MODEL_BIN),
    `MobileNetV2 NCNN model not generated. Run: python scripts/convert_mobilenet_ncnn.py`,
  );
  test.skip(!fs.existsSync(SAMPLE_IMAGE), `sample_224.png missing at ${SAMPLE_IMAGE}`);

  // Clean any stale outputs from a prior run so existence assertions are
  // not satisfied by leftovers.
  for (const p of [ROUNDTRIP_PATH, LOW_CONF_PATH, COMPOSITE_PATH, ANNOTATED_PATH, SEGMASK_PATH]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  backendProc = spawn(BACKEND_BIN, ['--port', String(BACKEND_PORT)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backendProc.stdout.on('data', (d) => {
    backendOutput += d.toString();
  });
  backendProc.stderr.on('data', (d) => {
    backendOutput += d.toString();
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !backendOutput.includes('listening on port')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!backendOutput.includes('listening on port')) {
    throw new Error(`Backend did not start in time. Output:\n${backendOutput}`);
  }
});

test.afterAll(async () => {
  if (backendProc && !backendProc.killed) {
    backendProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!backendProc.killed) backendProc.kill('SIGKILL');
  }
  // Sweep generated artifacts so the working tree stays clean.
  for (const p of [ROUNDTRIP_PATH, LOW_CONF_PATH, COMPOSITE_PATH, ANNOTATED_PATH, SEGMASK_PATH]) {
    if (fs.existsSync(p)) {
      try {
        fs.rmSync(p);
      } catch {
        /* best-effort */
      }
    }
  }
});

async function gotoAppWithBackend(page: Page) {
  await page.addInitScript((url) => {
    (window as unknown as { __VITE_WS_URL_OVERRIDE__: string }).__VITE_WS_URL_OVERRIDE__ = url;
  }, `ws://localhost:${BACKEND_PORT}`);
  await page.goto('/');
}

test.describe('Image classification demo (MobileNetV2)', () => {
  // No 2s benchmark in this workflow, but image.preview + first inference
  // load can dominate. 60s is comfortable.
  test.setTimeout(60_000);

  test('imports image_classification.json and runs end-to-end', async ({ page }) => {
    const wsEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
    page.on('websocket', (ws) => {
      ws.on('framereceived', (evt) => {
        try {
          const payload =
            typeof evt.payload === 'string' ? evt.payload : evt.payload.toString('utf8');
          const msg = JSON.parse(payload);
          if (msg.method) wsEvents.push({ method: msg.method, params: msg.params ?? {} });
        } catch {
          /* binary or non-json */
        }
      });
    });

    await gotoAppWithBackend(page);
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.locator('.console-ws-status .ws-dot.connected')).toBeVisible({
      timeout: 10_000,
    });

    // Import via the hidden file input — same code path the toolbar
    // Load button takes (App.tsx onFileChange -> importWorkflow).
    await page.locator('input[type="file"]').setInputFiles(DEMO_WORKFLOW);
    const graph = JSON.parse(fs.readFileSync(DEMO_WORKFLOW, 'utf-8'));
    await expect(page.locator('.react-flow__node')).toHaveCount(graph.nodes.length);

    // Sanity: every node id from the JSON is rendered. Guards against
    // a regression where importWorkflow silently drops nodes.
    const renderedIds = await page
      .locator('.react-flow__node')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
    for (const n of graph.nodes as Array<{ id: string }>) {
      expect(renderedIds, `node ${n.id} missing from canvas after import`).toContain(n.id);
    }

    // Kick off the run.
    const runBtn = page
      .locator('button')
      .filter({ hasText: /^\s*▶?\s*RUN\s*$/i })
      .first();
    await runBtn.click();

    // Wait for workflow.complete. Real NCNN MobileNetV2 inference on a
    // 224x224 image is well under a second; 30s is generous.
    await expect
      .poll(() => wsEvents.some((e) => e.method === 'workflow.complete'), {
        timeout: 30_000,
        message: 'workflow.complete never arrived',
      })
      .toBe(true);

    // No node may error.
    const errored = wsEvents
      .filter((e) => e.method === 'node.status' && e.params.status === 'error')
      .map((e) => ({ id: e.params.node_id, error: e.params.error }));
    expect(errored, `No node should error. Got: ${JSON.stringify(errored)}`).toHaveLength(0);

    // Conditional routing: the all-true gradient image yields max > 0.1
    // through MobileNetV2, so the true branch (inspect + out_main) must
    // reach done and the false branch (save_text) must be skipped with
    // reason=branch_pruned.
    const SKIPPED_IDS = new Set(['save_text']);
    const doneIds = new Set(
      wsEvents
        .filter((e) => e.method === 'node.status' && e.params.status === 'done')
        .map((e) => e.params.node_id as string),
    );
    const skippedEvents = wsEvents.filter(
      (e) => e.method === 'node.status' && e.params.status === 'skipped',
    );
    const expectedIds = new Set<string>(graph.nodes.map((n: { id: string }) => n.id));
    for (const id of expectedIds) {
      if (SKIPPED_IDS.has(id)) {
        expect(doneIds, `node ${id} should NOT reach done (must be skipped)`).not.toContain(id);
        const skipForId = skippedEvents.find((e) => e.params.node_id === id);
        expect(skipForId, `node ${id} should emit a skipped event`).toBeTruthy();
        expect(skipForId?.params.reason, `node ${id} skipped reason should be branch_pruned`).toBe(
          'branch_pruned',
        );
      } else {
        expect(doneIds, `node ${id} never reached done`).toContain(id);
      }
    }

    // Backend must still be alive — a NCNN handler crash would silently
    // kill it here.
    expect(backendProc?.killed ?? true, 'Backend process died mid-run').toBe(false);

    // SaveImage round-trip witness: img_save re-encodes the decoded
    // RGBA8 pixels of sample_224.png as PNG to roundtrip.png. Verify
    // file existence + canonical PNG magic header.
    expect(fs.existsSync(ROUNDTRIP_PATH), `roundtrip.png missing at ${ROUNDTRIP_PATH}`).toBe(true);
    const head = fs.readFileSync(ROUNDTRIP_PATH).subarray(0, 8);
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      head.equals(PNG_MAGIC),
      `roundtrip.png is not a PNG (head=${head.toString('hex')})`,
    ).toBe(true);

    // tensorToImage overlay + composite: softmax heatmap drawn onto the
    // original image via overlay mode, then composited at reduced opacity.
    expect(fs.existsSync(COMPOSITE_PATH), `composite.png missing`).toBe(true);
    const compHead = fs.readFileSync(COMPOSITE_PATH).subarray(0, 8);
    expect(
      compHead.equals(PNG_MAGIC),
      `composite.png is not a PNG (head=${compHead.toString('hex')})`,
    ).toBe(true);

    // annotateImage → saveImage: input image with top-5 predictions overlaid.
    expect(fs.existsSync(ANNOTATED_PATH), `classified.png missing`).toBe(true);
    const annHead = fs.readFileSync(ANNOTATED_PATH).subarray(0, 8);
    expect(
      annHead.equals(PNG_MAGIC),
      `classified.png is not a PNG (head=${annHead.toString('hex')})`,
    ).toBe(true);

    // segmentationMask → saveImage: synthetic 5x5 argmax mask rendered as
    // viridis-colored PNG.
    expect(fs.existsSync(SEGMASK_PATH), `segmask.png missing`).toBe(true);
    const segHead = fs.readFileSync(SEGMASK_PATH).subarray(0, 8);
    expect(
      segHead.equals(PNG_MAGIC),
      `segmask.png is not a PNG (head=${segHead.toString('hex')})`,
    ).toBe(true);

    // The false branch saveText writes a low_confidence.txt only on
    // skip — i.e. it must NOT exist when the true branch is taken.
    expect(
      fs.existsSync(LOW_CONF_PATH),
      'low_confidence.txt should NOT exist when true branch is taken',
    ).toBe(false);
  });
});
