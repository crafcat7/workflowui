// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizableOptions {
  direction: 'horizontal' | 'vertical';
  minSize: number;
  maxSize: number;
  initialSize: number;
  storageKey?: string;
}

interface ResizableResult {
  size: number;
  isResizing: boolean;
  resizerProps: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
}

export function useResizable({
  direction,
  minSize,
  maxSize,
  initialSize,
  storageKey,
}: ResizableOptions): ResizableResult {
  const [size, setSize] = useState(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && parsed >= minSize && parsed <= maxSize) {
          return parsed;
        }
      }
    }
    return initialSize;
  });

  const [isResizing, setIsResizing] = useState(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
      startSizeRef.current = size;
    },
    [direction, size]
  );

  useEffect(() => {
    if (!isResizing) return;

    const onMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = currentPos - startPosRef.current;
      const newSize = Math.min(maxSize, Math.max(minSize, startSizeRef.current + delta));
      setSize(newSize);
    };

    const onMouseUp = () => {
      setIsResizing(false);
      if (storageKey) {
        localStorage.setItem(storageKey, String(size));
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [isResizing, direction, minSize, maxSize, size, storageKey]);

  return {
    size,
    isResizing,
    resizerProps: {
      onMouseDown,
    },
  };
}
