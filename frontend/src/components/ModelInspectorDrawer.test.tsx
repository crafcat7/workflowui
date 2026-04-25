// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  ModelInspectorDrawer,
  __layoutGraphForTest,
  __fmtBytesForTest,
} from './ModelInspectorDrawer';
import type { ModelGraph } from '../types/modelInspector';
import { wsClient } from '../transport/WsClient';

vi.mock('../transport/WsClient', () => ({
  wsClient: { call: vi.fn() },
}));

// ReactFlow needs ResizeObserver in jsdom to compute viewport size.
// We provide a noop polyfill — the drawer's smoke tests don't
// inspect ReactFlow's internal DOM, only the surrounding chrome.
beforeEach(() => {
  vi.mocked(wsClient.call).mockReset();
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!('DOMMatrixReadOnly' in globalThis)) {
    (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
      m22 = 1;
      constructor(_init?: unknown) {}
    };
  }
});

function fakeGraph(overrides: Partial<ModelGraph> = {}): ModelGraph {
  return {
    vendor: 'ncnn',
    format_version: 'ncnn-7767517',
    layers: [
      { id: 'data', type: 'Input', input_blobs: [], output_blobs: ['data'], params: {} },
      { id: 'relu', type: 'ReLU', input_blobs: ['data'], output_blobs: ['out'], params: {} },
    ],
    blobs: [
      { name: 'data', shape: [3, 224, 224], producer: 'data', consumers: ['relu'] },
      { name: 'out', shape: [], producer: 'relu', consumers: [] },
    ],
    param_bytes: 1024,
    bin_bytes: 2 * 1024 * 1024,
    input_blob_names: ['data'],
    output_blob_names: ['out'],
    editable: false,
    ...overrides,
  };
}

describe('layoutGraph', () => {
  it('returns one node per layer with computed positions', () => {
    const { nodes } = __layoutGraphForTest(fakeGraph());
    expect(nodes).toHaveLength(2);
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['data', 'relu']);
    // dagre LR places later layers to the right of earlier ones.
    const dataX = nodes.find((n) => n.id === 'data')!.position.x;
    const reluX = nodes.find((n) => n.id === 'relu')!.position.x;
    expect(reluX).toBeGreaterThan(dataX);
  });

  it('emits one edge per (producer, consumer, blob) triple with the blob as label', () => {
    const { edges } = __layoutGraphForTest(fakeGraph());
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: 'data',
      target: 'relu',
      label: 'data',
    });
    // Edge id encodes the blob so multi-output layers (e.g. Split)
    // produce distinct edges sharing source/target.
    expect(edges[0].id).toContain('data->relu');
  });

  it('skips graph-input blobs (no producer) when emitting edges', () => {
    // Manually construct a graph where one blob has empty producer
    // — must not produce a phantom edge.
    const g: ModelGraph = {
      ...fakeGraph(),
      blobs: [
        { name: 'orphan', shape: [], producer: '', consumers: ['relu'] },
        { name: 'out', shape: [], producer: 'relu', consumers: [] },
      ],
    };
    const { edges } = __layoutGraphForTest(g);
    expect(edges).toEqual([]);
  });

  it('handles a multi-consumer fan-out (Split-like layer)', () => {
    const g: ModelGraph = {
      ...fakeGraph(),
      layers: [
        { id: 'data', type: 'Input', input_blobs: [], output_blobs: ['data'], params: {} },
        { id: 'a', type: 'X', input_blobs: ['data'], output_blobs: ['ao'], params: {} },
        { id: 'b', type: 'Y', input_blobs: ['data'], output_blobs: ['bo'], params: {} },
      ],
      blobs: [
        { name: 'data', shape: [], producer: 'data', consumers: ['a', 'b'] },
        { name: 'ao', shape: [], producer: 'a', consumers: [] },
        { name: 'bo', shape: [], producer: 'b', consumers: [] },
      ],
    };
    const { edges } = __layoutGraphForTest(g);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.target).sort()).toEqual(['a', 'b']);
  });
});

describe('fmtBytes', () => {
  it.each([
    [0, '—'],
    [-5, '—'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [2048, '2.0 KB'],
    [1024 * 1024, '1.0 MB'],
    [3.5 * 1024 * 1024, '3.5 MB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(__fmtBytesForTest(bytes)).toBe(expected);
  });
});

describe('ModelInspectorDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ModelInspectorDrawer open={false} onClose={() => {}} request={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('fires inspect on open and shows loading state', async () => {
    let resolveCall: (g: ModelGraph) => void = () => {};
    vi.mocked(wsClient.call).mockImplementationOnce(
      () => new Promise((r) => { resolveCall = r; }),
    );
    render(
      <ModelInspectorDrawer
        open
        onClose={() => {}}
        request={{ vendor: 'ncnn', paramPath: '/x.param' }}
      />,
    );
    await waitFor(() => {
      expect(wsClient.call).toHaveBeenCalledWith('model.inspect', expect.objectContaining({
        vendor: 'ncnn',
        param_path: '/x.param',
      }));
    });
    expect(screen.getByText('Loading…')).toBeTruthy();
    resolveCall(fakeGraph());
  });

  it('renders metadata strip with formatted byte sizes after success', async () => {
    vi.mocked(wsClient.call).mockResolvedValueOnce(fakeGraph());
    render(
      <ModelInspectorDrawer
        open
        onClose={() => {}}
        request={{ vendor: 'ncnn', paramPath: '/x.param' }}
      />,
    );
    await waitFor(() => screen.getByTestId('model-inspector-canvas'));
    expect(screen.getByText('1.0 KB')).toBeTruthy(); // param size
    expect(screen.getByText('2.0 MB')).toBeTruthy(); // bin size
    // The vendor/format strings come from the metadata strip
    // exclusively (not duplicated elsewhere) so they uniquely
    // identify the strip rendered.
    expect(screen.getByText('ncnn-7767517')).toBeTruthy();
    expect(screen.getByText('ncnn')).toBeTruthy();
  });

  it('renders parser errors with the -32000 server-error variant', async () => {
    vi.mocked(wsClient.call).mockRejectedValueOnce({
      code: -32000,
      message: 'ncnn .param: bad magic',
    });
    render(
      <ModelInspectorDrawer
        open
        onClose={() => {}}
        request={{ vendor: 'ncnn', paramPath: '/bad.param' }}
      />,
    );
    await waitFor(() => screen.getByTestId('model-inspector-error'));
    expect(screen.getByTestId('model-inspector-error').textContent).toContain('-32000');
    expect(screen.getByTestId('model-inspector-error').textContent).toContain('bad magic');
  });

  it('renders transport errors with the "Network error" variant', async () => {
    vi.mocked(wsClient.call).mockRejectedValueOnce(new Error('ws disconnected'));
    render(
      <ModelInspectorDrawer
        open
        onClose={() => {}}
        request={{ vendor: 'ncnn', paramPath: '/x.param' }}
      />,
    );
    await waitFor(() => screen.getByTestId('model-inspector-error'));
    expect(screen.getByTestId('model-inspector-error').textContent).toContain('Network error');
  });

  it('Escape key invokes onClose', async () => {
    const onClose = vi.fn();
    vi.mocked(wsClient.call).mockResolvedValueOnce(fakeGraph());
    render(
      <ModelInspectorDrawer
        open
        onClose={onClose}
        request={{ vendor: 'ncnn', paramPath: '/x.param' }}
      />,
    );
    await waitFor(() => screen.getByTestId('model-inspector-canvas'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('layer table row click highlights the row via the selected class', async () => {
    vi.mocked(wsClient.call).mockResolvedValueOnce(fakeGraph());
    render(
      <ModelInspectorDrawer
        open
        onClose={() => {}}
        request={{ vendor: 'ncnn', paramPath: '/x.param' }}
      />,
    );
    await waitFor(() => screen.getByTestId('model-inspector-layers'));
    const reluRow = screen.getByText('relu').closest('tr')!;
    fireEvent.click(reluRow);
    expect(reluRow.className).toContain('selected');
  });
});
