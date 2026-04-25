// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PropertiesPanel } from './PropertiesPanel';
import { useWorkflowStore } from '../store/workflowStore';

// PropertiesPanel mounts ModelInspectorDrawer, which uses ReactFlow.
// We don't exercise the drawer's contents here — only the button gating
// and the open-on-click handoff — so a noop ResizeObserver is enough.
beforeEach(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

vi.mock('../transport/WsClient', () => ({
  wsClient: {
    call: vi.fn(() => new Promise(() => {})),
    onNotification: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  },
}));

function seedNode(opts: {
  id?: string;
  type: string;
  config?: Record<string, unknown>;
}) {
  const node = {
    id: opts.id ?? 'n1',
    type: opts.type,
    position: { x: 0, y: 0 },
    data: {
      label: 'Test',
      type: opts.type,
      status: 'idle',
      config: opts.config ?? {},
    },
  };
  useWorkflowStore.setState({
    nodes: [node as never],
    nodesById: new Map([[node.id, node as never]]),
    selectedNodeId: node.id,
  });
}

describe('PropertiesPanel · View Model button', () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      nodes: [],
      nodesById: new Map(),
      selectedNodeId: null,
    });
  });

  it('does not render the button when paramPath is empty', () => {
    seedNode({ type: 'ncnnInfer', config: {} });
    render(<PropertiesPanel />);
    expect(screen.queryByTestId('view-model-btn')).toBeNull();
  });

  it('does not render the button on non-ncnn node types even with paramPath', () => {
    // The node type discriminator must contain 'ncnn' (case-insensitive)
    // for the button to appear; this test pins that vendor inference.
    seedNode({ type: 'add', config: { paramPath: '/x.param' } });
    render(<PropertiesPanel />);
    expect(screen.queryByTestId('view-model-btn')).toBeNull();
  });

  it('renders the button when an ncnn-flavored node carries a paramPath', () => {
    seedNode({ type: 'ncnnInfer', config: { paramPath: '/x.param' } });
    render(<PropertiesPanel />);
    expect(screen.getByTestId('view-model-btn')).toBeInTheDocument();
  });

  it('treats whitespace-only paramPath as empty (button not shown)', () => {
    seedNode({ type: 'ncnnInfer', config: { paramPath: '   ' } });
    render(<PropertiesPanel />);
    expect(screen.queryByTestId('view-model-btn')).toBeNull();
  });

  it('clicking the button mounts the drawer', () => {
    seedNode({ type: 'ncnnInfer', config: { paramPath: '/x.param' } });
    render(<PropertiesPanel />);
    // Drawer is closed by default — its header text is not in the DOM.
    expect(screen.queryByText('Model Inspector')).toBeNull();
    fireEvent.click(screen.getByTestId('view-model-btn'));
    expect(screen.getByText('Model Inspector')).toBeInTheDocument();
  });
});
