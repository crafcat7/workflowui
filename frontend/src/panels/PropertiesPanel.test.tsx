// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PropertiesPanel } from './PropertiesPanel';
import { useWorkflowStore } from '../store/workflowStore';

// Seed helper that respects the F1 nodesById cache invariant: any
// direct `setState({nodes})` must also rebuild the id→node map or the
// panel's `selectedNodeId` subscription returns undefined.
function seedNode(partial: {
  id: string;
  type?: string;
  label?: string;
  status?: 'idle' | 'running' | 'done' | 'error' | 'paused' | 'skipped';
  error?: string;
}) {
  const node = {
    id: partial.id,
    type: partial.type ?? 'add',
    position: { x: 0, y: 0 },
    data: {
      label: partial.label ?? 'Test Node',
      type: partial.type ?? 'add',
      status: partial.status ?? 'idle',
      config: {},
      ...(partial.error !== undefined ? { error: partial.error } : {}),
    },
  };
  useWorkflowStore.setState({
    nodes: [node as never],
    nodesById: new Map([[node.id, node as never]]),
    selectedNodeId: node.id,
  });
}

describe('PropertiesPanel error surfacing', () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      nodes: [],
      nodesById: new Map(),
      selectedNodeId: null,
    });
  });

  it('does not render an error block when data.error is absent', () => {
    // Baseline: a healthy node has no alert region. `role="alert"` is the
    // semantic used by the error block, so its absence is the negative
    // proof that we aren't leaking empty containers into the DOM.
    seedNode({ id: 'n1', status: 'done' });
    render(<PropertiesPanel />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the error text in an alert block when data.error is set', () => {
    // The canonical failure case: a node finishes with an error message
    // written by WorkflowRunner (either `[kind] msg` or raw msg). The
    // panel must surface that message verbatim so the user doesn't have
    // to dig through the console or re-run the workflow.
    seedNode({
      id: 'n2',
      status: 'error',
      error: '[runtime] shape mismatch on inference port',
    });
    render(<PropertiesPanel />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('shape mismatch on inference port');
    expect(alert).toHaveTextContent('[runtime]');
  });

  it('surfaces validation errors written by S1 the same way', () => {
    // S1 FE writes the plain `message` (no `[kind]` prefix, since the
    // kind is already in the console log). The panel shouldn't care who
    // wrote it — any `data.error` becomes visible.
    seedNode({
      id: 'n3',
      status: 'error',
      error: 'input port "x" has no incoming edge',
    });
    render(<PropertiesPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('input port "x" has no incoming edge');
  });
});
