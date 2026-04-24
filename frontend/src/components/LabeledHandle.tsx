// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * LabeledHandle - A React Flow handle with a visible text label and data-type color coding.
 * Uses CSS classes for positioning so multiple handles on the same side don't overlap.
 * The parent node must use relative positioning; handles are placed via React Flow's
 * `top` prop and labels sit beside them using the `.handle-label` class.
 */
import { Handle, Position } from '@xyflow/react';

export type HandleDataType = 'tensor' | 'image' | 'net' | 'generic' | 'branch';

interface LabeledHandleProps {
  type: 'source' | 'target';
  position: Position;
  id: string;
  label: string;
  dataType?: HandleDataType;
  top?: string;
}

export function LabeledHandle({ type, position, id, label, dataType = 'generic', top }: LabeledHandleProps) {
  const isLeft = position === Position.Left;

  return (
    <div className="labeled-handle-wrapper" style={{ top: top ?? '50%' }}>
      <Handle
        type={type}
        position={position}
        id={id}
        className={`handle-${dataType}`}
        style={{ top: 0, position: 'relative' }}
      />
      <span className={`handle-label ${isLeft ? 'handle-label-left' : 'handle-label-right'}`}>
        {label}
      </span>
    </div>
  );
}
