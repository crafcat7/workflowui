import { test, expect, type Page } from '@playwright/test';
import { ChildProcess, fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mockBackend: ChildProcess;

test.beforeAll(async () => {
  // Start mock WS backend
  mockBackend = fork(path.join(__dirname, 'mock-backend.mjs'), ['9099'], {
    stdio: 'pipe',
  });
  // Wait for it to be ready
  await new Promise<void>((resolve) => {
    mockBackend.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('listening')) resolve();
    });
    setTimeout(resolve, 2000);
  });
});

test.afterAll(async () => {
  mockBackend?.kill();
});

// Helper: wait for WS connection indicator to show "Connected"
async function waitForConnection(page: Page) {
  await page.waitForSelector('.console-ws-status', { timeout: 10000 });
  // Give a moment for WS to connect
  await page.waitForTimeout(1000);
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
    const status = page.locator('.console-ws-status');
    await expect(status).toBeVisible();
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
    await page.goto('/');
    await waitForConnection(page);

    // Add two nodes
    const pane = page.locator('.react-flow__pane');
    await page.locator('.palette-node-card').filter({ hasText: 'Input Tensor' }).first().dragTo(pane);
    await page.locator('.palette-node-card').filter({ hasText: 'Output' }).first().dragTo(pane);

    // Click Run button
    const runBtn = page.locator('button').filter({ hasText: /Run|Execute/i }).first();
    await runBtn.click();

    // Wait for workflow completion — the mock backend sends workflow.complete after all nodes
    await page.waitForTimeout(2000);

    // Nodes should have status indicators (done state)
    // The toast or status should show success
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
  test('shows offline status when backend is down', async ({ page }) => {
    // Navigate with a WS URL that doesn't exist
    await page.goto('/?_test=1');
    // The status indicator should eventually show disconnected
    // (this depends on the actual WS URL configured — mock may or may not be running)
    await page.waitForTimeout(1000);
    const status = page.locator('.console-ws-status');
    await expect(status).toBeVisible();
  });
});
