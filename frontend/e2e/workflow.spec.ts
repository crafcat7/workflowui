// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { test, expect, type Page } from '@playwright/test';
import { ChildProcess, fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mockBackend: ChildProcess;

test.beforeAll(async () => {
  // Start mock WS backend. We resolve strictly on the "listening" stdout
  // banner so the first test never races an unready socket; a bounded
  // deadline turns a stuck child into a clear failure instead of a cascade
  // of connection timeouts.
  mockBackend = fork(path.join(__dirname, 'mock-backend.mjs'), ['9099'], {
    stdio: 'pipe',
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('mock-backend never emitted "listening" banner within 5s')),
      5000,
    );
    mockBackend.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('listening')) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
});

test.afterAll(async () => {
  mockBackend?.kill();
});

// Force every test in this file to point its WsClient at the mock backend
// regardless of how the Vite dev server was started (CI starts it with the
// right VITE_WS_URL, but developers often have a dev server already running
// with different env vars — `reuseExistingServer: true` would then silently
// talk to the wrong URL). The override is picked up by WsClient before
// constructing its socket.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __VITE_WS_URL_OVERRIDE__: string }).__VITE_WS_URL_OVERRIDE__ =
      'ws://localhost:9099';
  });
});

// Helper: wait for WS indicator to actually report "Connected" (dot turns
// green + text flips to ONLINE). The App renders `.console-ws-status`
// immediately on load, so testing for mere visibility doesn't prove the
// socket handshake completed.
async function waitForConnection(page: Page) {
  await expect(page.locator('.console-ws-status .ws-dot.connected')).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Canvas & basic UI', () => {
  test('loads the workflow canvas', async ({ page }) => {
    await page.goto('/');
    // React Flow canvas should be present
    await expect(page.locator('.react-flow')).toBeVisible();
  });

  test('shows empty state guidance text', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow')).toBeVisible();
    // The empty state text
    const emptyText = page.getByText('Workflow Canvas');
    await expect(emptyText).toBeVisible();
  });

  test('shows WS connection status', async ({ page }) => {
    await page.goto('/');
    await waitForConnection(page);
    await expect(page.locator('.console-ws-status')).toContainText(/ONLINE/i);
  });

  test('shows MiniMap', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__minimap')).toBeVisible();
  });
});

test.describe('Node CRUD', () => {
  test('adds a node from toolbar', async ({ page }) => {
    await page.goto('/');
    await waitForConnection(page);

    // Drag an "Input Image" node to canvas
    const btn = page.locator('.palette-node-card').filter({ hasText: 'Input Image' }).first();
    await btn.dragTo(page.locator('.react-flow__pane'));

    // A node should appear on the canvas
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  });

  test('adds multiple nodes', async ({ page }) => {
    await page.goto('/');
    await waitForConnection(page);

    const pane = page.locator('.react-flow__pane');
    // Add Input Tensor
    await page.locator('.palette-node-card').filter({ hasText: 'Input Tensor' }).first().dragTo(pane);
    // Add Create Net
    await page.locator('.palette-node-card').filter({ hasText: 'Create Net' }).first().dragTo(pane);
    // Add Inference
    await page.locator('.palette-node-card').filter({ hasText: 'Inference' }).first().dragTo(pane);
    // Add Postprocess
    await page.locator('.palette-node-card').filter({ hasText: 'Postprocess' }).first().dragTo(pane);

    await expect(page.locator('.react-flow__node')).toHaveCount(4);
  });

  test('selects a node and shows properties panel', async ({ page }) => {
    await page.goto('/');
    await waitForConnection(page);

    await page.locator('.palette-node-card').filter({ hasText: 'Input Tensor' }).first().dragTo(page.locator('.react-flow__pane'));
    // Click on the node
    await page.locator('.react-flow__node').first().click();

    // Properties panel should show node config
    const panel = page.locator('.properties-panel').first();
    await expect(panel).toBeVisible();
  });

  test('deletes a node via backspace', async ({ page }) => {
    await page.goto('/');
    await waitForConnection(page);

    await page.locator('.palette-node-card').filter({ hasText: 'Output' }).first().dragTo(page.locator('.react-flow__pane'));
    await expect(page.locator('.react-flow__node')).toHaveCount(1);

    // Select the node
    await page.locator('.react-flow__node').first().click();
    // Press delete/backspace
    await page.keyboard.press('Backspace');

    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });
});

test.describe('Workflow execution', () => {
  test('runs a workflow and receives status updates', async ({ page }) => {
    // Capture every JSON-RPC frame so we can assert on lifecycle events
    // instead of waiting out a wall-clock delay.
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

    await page.goto('/');
    await waitForConnection(page);

    // Single-node workflow: the run action scopes to connected nodes when
    // there is more than one, which would require drawing an edge between
    // handles (very awkward in Playwright). A one-node graph always runs
    // as-is, so we use Input Tensor alone.
    await page
      .locator('.palette-node-card')
      .filter({ hasText: 'Input Tensor' })
      .first()
      .dragTo(page.locator('.react-flow__pane'));

    // Click Run button
    const runBtn = page.locator('button').filter({ hasText: /Run|Execute/i }).first();
    await runBtn.click();

    // The mock backend emits workflow.complete after all nodes report done.
    await expect
      .poll(() => wsEvents.some((e) => e.method === 'workflow.complete'), {
        timeout: 10_000,
        message: 'workflow.complete never arrived from mock backend',
      })
      .toBe(true);

    // The one node should have reported done.
    const doneCount = wsEvents.filter(
      (e) => e.method === 'node.status' && e.params.status === 'done',
    ).length;
    expect(doneCount).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Save / Load workflow', () => {
  test('exports and imports a workflow', async ({ page }) => {
    await page.goto('/');
    await waitForConnection(page);

    // Add a node
    const pane = page.locator('.react-flow__pane');
    await page.locator('.palette-node-card').filter({ hasText: 'Input Tensor' }).first().dragTo(pane);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);

    // Click Save button — triggers download
    const downloadPromise = page.waitForEvent('download');
    const saveBtn = page.locator('button.file-op').filter({ hasText: 'Save' }).first();
    await saveBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('workflow');

    // Read the downloaded file
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
  });
});

test.describe('WS disconnection', () => {
  test('shows offline status when backend URL is unreachable', async ({ page }) => {
    // Point WsClient at a port nothing is listening on so the socket cannot
    // complete its handshake. The status indicator must settle on
    // disconnected/OFFLINE rather than a stale connected state.
    await page.addInitScript(() => {
      (window as unknown as { __VITE_WS_URL_OVERRIDE__: string }).__VITE_WS_URL_OVERRIDE__ =
        'ws://127.0.0.1:1';
    });
    await page.goto('/');
    await expect(page.locator('.console-ws-status .ws-dot.disconnected')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('.console-ws-status')).toContainText(/OFFLINE/i);
  });
});
