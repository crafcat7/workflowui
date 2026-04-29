// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { type MouseEvent as ReactMouseEvent } from 'react';

interface ResizerProps {
  direction: 'horizontal' | 'vertical';
  onMouseDown: (e: ReactMouseEvent) => void;
  isResizing: boolean;
}

export function Resizer({ direction, onMouseDown, isResizing }: ResizerProps) {
  return (
    <div
      className={`resizer resizer-${direction} ${isResizing ? 'resizer-active' : ''}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
    />
  );
}
