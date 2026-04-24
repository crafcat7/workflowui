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

    // The demo contains a benchmark node with duration=30s. The stub
    // engine returns immediately (runs=1000, avg=1ms), but the
    // BenchmarkHandler still honors the requested wall-clock, so the
    // real lower bound is ~30s + scheduling overhead. 45s gives a
    // small cushion; set E2E_SLOW=1 to extend further for slow CI.
    const completeTimeoutMs = process.env.E2E_SLOW ? 90_000 : 45_000;
    await expect.poll(
      () => wsEvents.some((e) => e.method === 'workflow.complete'),
      { timeout: completeTimeoutMs, message: 'workflow.complete never arrived' },
    ).toBe(true);

    // Every node from the demo should have reached status=done (or an
    // equivalent terminal). We pull the unique node_ids that emitted a
    // 'done' event and compare against the demo graph.
    const doneIds = new Set(
      wsEvents
        .filter((e) => e.method === 'node.status' && e.params.status === 'done')
        .map((e) => e.params.node_id as string),
    );
    const errored = wsEvents
      .filter((e) => e.method === 'node.status' && e.params.status === 'error')
      .map((e) => ({ id: e.params.node_id, error: e.params.error }));

    expect(errored, `No node should error out. Got: ${JSON.stringify(errored)}`).toHaveLength(0);

    const expectedIds = new Set<string>(graph.nodes.map((n: { id: string }) => n.id));
    for (const id of expectedIds) {
      expect(doneIds, `node ${id} never reached done`).toContain(id);
    }

    // Backend must still be alive at the end — a regression of the
    // empty_weights crash would silently kill the process here.
    expect(backendProc?.killed ?? true, 'Backend process died mid-run').toBe(false);
  });
});
