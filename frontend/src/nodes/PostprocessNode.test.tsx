// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PostprocessNode } from './PostprocessNode';
import type { WorkflowNodeData } from '../store/workflowStore';

// Mock dependencies
vi.mock('@xyflow/react', () => ({
  Position: { Left: 'left', Right: 'right' },
  Handle: () => <div data-testid="handle" />,
}));

vi.mock('../components/LabeledHandle', () => ({
  LabeledHandle: ({ id, label }: { id: string; label: string }) => (
    <div data-testid={`labeled-handle-${id}`}>{label}</div>
  ),
}));

describe('PostprocessNode', () => {
  const commonProps = {
    id: '1',
    selected: false,
    type: 'postprocess',
    zIndex: 1,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
  };

  it('renders NMS configuration by default', () => {
    const data = {
      config: {},
      status: 'pending',
    };
    render(<PostprocessNode data={data as unknown as WorkflowNodeData} {...commonProps} />);

    expect(screen.getByText('NMS')).toBeInTheDocument();
    expect(screen.getByText('IoU: 0.45')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('renders Top-K configuration', () => {
    const data = {
      config: { op: 'topk', k: '5' },
      status: 'done',
    };
    render(<PostprocessNode data={data as unknown as WorkflowNodeData} {...commonProps} />);

    expect(screen.getByText('TOPK')).toBeInTheDocument();
    expect(screen.getByText('K: 5')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });
});
