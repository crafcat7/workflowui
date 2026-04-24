// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * NodeContextMenu - floating menu shown on right-click over a node.
 *
 * Rendered imperatively from App.tsx via state {x, y, nodeId}. Dismissed
 * by a click on the document, Escape, or scrolling. All menu items
 * operate through the workflow/debug stores so undo history and backend
 * sync stay consistent.
 */

import { useEffect, useRef } from 'react';
import { useDebugStore } from '../store/debugStore';
import { useWorkflowStore } from '../store/workflowStore';
import { wsClient } from '../transport/WsClient';

export interface NodeContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}

interface Props {
  menu: NodeContextMenuState;
  onClose: () => void;
}

export function NodeContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const addBreakpoint = useDebugStore((s) => s.addBreakpoint);
  const removeBreakpoint = useDebugStore((s) => s.removeBreakpoint);
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode);

  const armed = breakpoints.some((b) => b.nodeId === menu.nodeId && b.enabled);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const toggleBreakpoint = () => {
    if (armed) {
      removeBreakpoint(menu.nodeId);
      // If a run is in flight, keep the backend in sync so the next
      // scheduled occurrence of this node no longer pauses.
      if (isRunning) {
        wsClient.call('debug.remove_breakpoint', { node_id: menu.nodeId }).catch(() => {});
      }
    } else {
      addBreakpoint(menu.nodeId);
      if (isRunning) {
        wsClient.call('debug.add_breakpoint', { node_id: menu.nodeId }).catch(() => {});
      }
    }
    onClose();
  };

  const handleDuplicate = () => {
    duplicateNode(menu.nodeId);
    onClose();
  };

  const handleDelete = () => {
    removeNode(menu.nodeId);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="node-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
    >
      <button className="ctx-item" onClick={toggleBreakpoint} role="menuitem">
        <span className="ctx-icon">{armed ? '🔴' : '⚪'}</span>
        {armed ? 'Remove breakpoint' : 'Add breakpoint'}
      </button>
      <div className="ctx-separator" />
      <button className="ctx-item" onClick={handleDuplicate} role="menuitem">
        <span className="ctx-icon">⎘</span> Duplicate
      </button>
      <button className="ctx-item ctx-danger" onClick={handleDelete} role="menuitem">
        <span className="ctx-icon">✕</span> Delete
      </button>
    </div>
  );
}
