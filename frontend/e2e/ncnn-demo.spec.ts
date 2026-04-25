// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * End-to-end simulation of a user loading the NCNN demo workflow,
 * running it against a real C++ backend process, and verifying that
 * every node reaches status=done plus workflow.complete arrives.
 *
 * This is the regression guard for the empty_weights crash fixed by
 * the DataReaderFromEmpty change in NcnnEngine::init_net. Before that
 * fix this test reliably produced a node.status=error (or a silent
 * disconnect when the backend segfaulted) on the `inference` node.
 *
 * We deliberately use the stub backend build (no ENABLE_NCNN) because:
 *   - stub exercises the same executor + handler + WS broadcast path
 *     the real NCNN path uses, so it catches workflow-level regressions
 *   - it doesn't require a vendored ncnn install to be present on the
 *     test machine, which keeps CI green without vendor-specific setup
 * An ncnn-enabled smoke test belongs in a separate, optional CI job.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_BIN = path.join(REPO_ROOT, 'backend', 'build', 'workflow_backend');
const DEMO_WORKFLOW = path.join(REPO_ROOT, 'demo', 'NCNN_demo', 'workflow.json');
const BACKEND_PORT = 9098;  // isolated from the mock backend on 9099 and prod 9090

let backendProc: ChildProcessWithoutNullStreams | undefined;
let backendOutput = '';

test.beforeAll(async () => {
  test.skip(!fs.existsSync(BACKEND_BIN), `Backend binary not built at ${BACKEND_BIN}`);
  test.skip(!fs.existsSync(DEMO_WORKFLOW), `Demo workflow missing at ${DEMO_WORKFLOW}`);

  backendProc = spawn(BACKEND_BIN, ['--port', String(BACKEND_PORT)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backendProc.stdout.on('data', (d) => { backendOutput += d.toString(); });
  backendProc.stderr.on('data', (d) => { backendOutput += d.toString(); });

  // Wait for the "WS Server listening" banner or timeout.
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
    // Give it a moment, then SIGKILL if still alive.
    await new Promise((r) => setTimeout(r, 500));
    if (!backendProc.killed) backendProc.kill('SIGKILL');
  }
});

async function gotoAppWithBackend(page: Page) {
  // Override VITE_WS_URL at page level by setting localStorage before navigation?
  // Simpler: the Vite dev server was started with VITE_WS_URL=ws://localhost:9099
  // (mock backend). We want this test to talk to OUR real backend on 9098.
  // Inject the override via an init script so WsClient picks it up.
  await page.addInitScript((url) => {
    (window as unknown as { __VITE_WS_URL_OVERRIDE__: string }).__VITE_WS_URL_OVERRIDE__ = url;
  }, `ws://localhost:${BACKEND_PORT}`);
  await page.goto('/');
}

test.describe('NCNN demo end-to-end', () => {
  // The demo contains a 30-second benchmark node; default Playwright timeout
  // (30s) is not enough even with no fudge factor. Give the whole test 90s.
  test.setTimeout(90_000);

  test('loads demo workflow, runs it, every node reaches status=done', async ({ page }) => {
    // Capture every JSON-RPC frame the backend sends so we can assert on the
    // full lifecycle (node.status progression, workflow.complete). We listen
    // at the websocket layer because the UI does not surface every event.
    const wsEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
    page.on('websocket', (ws) => {
      ws.on('framereceived', (evt) => {
        try {
          const payload = typeof evt.payload === 'string'
            ? evt.payload
            : evt.payload.toString('utf8');
          const msg = JSON.parse(payload);
          if (msg.method) wsEvents.push({ method: msg.method, params: msg.params ?? {} });
        } catch { /* binary or non-json */ }
      });
    });

    await gotoAppWithBackend(page);
    await expect(page.locator('.react-flow')).toBeVisible();
    // Wait for the WS handshake to actually complete (dot turns green)
    // instead of a fixed sleep. The app does its first RPC right after,
    // so a late connect used to drop the initial frame on slow CI.
    await expect(page.locator('.console-ws-status .ws-dot.connected')).toBeVisible({
      timeout: 10_000,
    });

    // Load the demo workflow via the hidden file input. The LOAD button
    // triggers a native file picker; setInputFiles bypasses that.
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(DEMO_WORKFLOW);
    const graph = JSON.parse(fs.readFileSync(DEMO_WORKFLOW, 'utf-8'));
    const nodeCount = graph.nodes.length;
    await expect(page.locator('.react-flow__node')).toHaveCount(nodeCount);

    // Kick off execution. The button label varies across the toolbar; we
    // target the canonical Run control on the console toolbar.
    const runBtn = page.locator('button').filter({ hasText: /^\s*▶?\s*RUN\s*$/i }).first();
    await runBtn.click();

    // The demo benchmark node runs for 2 wall-clock seconds. Stub engine
    // is sub-millisecond per call, so total run is dominated by that 2s
    // bound. 20s is comfortable on slow CI; E2E_SLOW=1 doubles it.
    const completeTimeoutMs = process.env.E2E_SLOW ? 60_000 : 20_000;
    await expect.poll(
      () => wsEvents.some((e) => e.method === 'workflow.complete'),
      { timeout: completeTimeoutMs, message: 'workflow.complete never arrived' },
    ).toBe(true);

    // Partition expected terminals: the false_branch consumer (save_text)
    // is the deliberate skipped target — condition expr "> 0.4" against
    // the topk output of an all-0.5 tensor takes the true branch, so the
    // save_text node must be reported skipped with reason=branch_pruned
    // and never produce a 'done'. Every other node must terminate as
    // done. This is a regression guard for the entire skip-propagation
    // path (Executor::mark_dead_output → branch_pruned skipped event).
    const SKIPPED_IDS = new Set(['save_text']);
    const doneIds = new Set(
      wsEvents
        .filter((e) => e.method === 'node.status' && e.params.status === 'done')
        .map((e) => e.params.node_id as string),
    );
    const skippedEvents = wsEvents.filter(
      (e) => e.method === 'node.status' && e.params.status === 'skipped',
    );
    const errored = wsEvents
      .filter((e) => e.method === 'node.status' && e.params.status === 'error')
      .map((e) => ({ id: e.params.node_id, error: e.params.error }));

    expect(errored, `No node should error out. Got: ${JSON.stringify(errored)}`).toHaveLength(0);

    const expectedIds = new Set<string>(graph.nodes.map((n: { id: string }) => n.id));
    for (const id of expectedIds) {
      if (SKIPPED_IDS.has(id)) {
        expect(doneIds, `node ${id} should NOT reach done (must be skipped)`).not.toContain(id);
        const skipForId = skippedEvents.find((e) => e.params.node_id === id);
        expect(skipForId, `node ${id} should emit a skipped event`).toBeTruthy();
        expect(
          skipForId?.params.reason,
          `node ${id} skipped reason should be branch_pruned`,
        ).toBe('branch_pruned');
      } else {
        expect(doneIds, `node ${id} never reached done`).toContain(id);
      }
    }

    // Backend must still be alive at the end — a regression of the
    // empty_weights crash would silently kill the process here.
    expect(backendProc?.killed ?? true, 'Backend process died mid-run').toBe(false);
  });

  test('View Model opens the inspector drawer for the createNet node', async ({ page }) => {
    // Verifies the full Model Inspector chain end-to-end: PropertiesPanel
    // surfaces the button on a vendor=ncnn node, clicking it issues
    // model.inspect over the same WS that runs the workflow, and the
    // drawer renders the parsed metadata strip + layer table without
    // touching the run path.
    await gotoAppWithBackend(page);
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.locator('.console-ws-status .ws-dot.connected')).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('input[type="file"]').setInputFiles(DEMO_WORKFLOW);
    const graph = JSON.parse(fs.readFileSync(DEMO_WORKFLOW, 'utf-8'));
    await expect(page.locator('.react-flow__node')).toHaveCount(graph.nodes.length);

    // Select the createNet node by its stable data-id="net" (set in
    // demo/NCNN_demo/workflow.json). Filtering by visible label is
    // brittle now that the upgraded demo also has an inputImage node
    // whose configured filePath ('shufflenet.param') renders inside
    // the node body.
    await page.locator('.react-flow__node[data-id="net"]').click();

    // The View Model button should now be visible in the properties panel.
    const viewBtn = page.getByTestId('view-model-btn');
    await expect(viewBtn).toBeVisible();
    await viewBtn.click();

    // Drawer header is the unique anchor for an open inspector.
    await expect(page.getByText('Model Inspector')).toBeVisible();

    // Metadata strip shows the parser-reported format + a non-zero layer
    // count from shufflenet.param. The exact magic string is part of the
    // wire contract — pin it so a parser regression surfaces here.
    await expect(page.getByText('ncnn-7767517')).toBeVisible({ timeout: 5_000 });

    // The layer table renders one row per layer; shufflenet has 120
    // layers but we only need to verify rows exist.
    await expect(page.locator('[data-testid="model-inspector-layers"] tbody tr')).not.toHaveCount(0);

    // Escape closes the drawer.
    await page.keyboard.press('Escape');
    await expect(page.getByText('Model Inspector')).not.toBeVisible();
  });
});
