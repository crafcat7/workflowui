// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * NodeContextMenu - floating menu shown on right-click over a node.
 *
 * Rendered imperatively from App.tsx via state {x, y, nodeId}. Dismissed
 * by a click on the document, Escape, or scrolling. All menu items
 * operate through the workflow/debug stores so undo history and backend
 * sync stay consistent.
 *
 * Keyboard model (WAI-ARIA menu pattern):
 *   - Opening focuses the first enabled item.
 *   - ArrowDown / ArrowUp move focus between items, wrapping at the ends.
 *   - Home / End jump to the first / last item.
 *   - Enter / Space activate the focused item.
 *   - Escape closes and returns focus to the previously-focused element.
 *   - Tab also closes (menus aren't part of the tab cycle in this
 *     pattern — the user either activates an item or dismisses).
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
  // Snapshot the element that had focus when the menu opened so we
  // can restore it on close. Matches the native menu behavior of
  // "dismissing returns you to where you came from".
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const addBreakpoint = useDebugStore((s) => s.addBreakpoint);
  const removeBreakpoint = useDebugStore((s) => s.removeBreakpoint);
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode);

  const armed = breakpoints.some((b) => b.nodeId === menu.nodeId && b.enabled);

  // Auto-focus the first menuitem on mount + restore focus on close.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
    return () => {
      // Only restore if the prior focus target is still in the DOM
      // and didn't get blown away by a menu action (e.g. deleting
      // the node the menu was on — there's nothing sensible to
      // focus back to in that case).
      const prior = previouslyFocused.current;
      if (prior && document.body.contains(prior)) {
        prior.focus();
      }
    };
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        onClose();
      }
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

  // Arrow-key navigation within the menu. Scoped to the menu
  // container rather than the document so Escape/Tab (handled above
  // at document level) can still close it.
  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.findIndex((el) => el === document.activeElement);
    // If focus has somehow escaped the menu, re-anchor to the first
    // item rather than silently dropping the keystroke.
    const anchor = currentIndex === -1 ? 0 : currentIndex;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        items[(anchor + 1) % items.length]!.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        items[(anchor - 1 + items.length) % items.length]!.focus();
        break;
      }
      case 'Home': {
        e.preventDefault();
        items[0]!.focus();
        break;
      }
      case 'End': {
        e.preventDefault();
        items[items.length - 1]!.focus();
        break;
      }
      default:
        break;
    }
  };

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
      aria-label={`Actions for node ${menu.nodeId}`}
      onKeyDown={handleMenuKeyDown}
    >
      <button className="ctx-item" onClick={toggleBreakpoint} role="menuitem">
        <span className="ctx-icon" aria-hidden="true">{armed ? '🔴' : '⚪'}</span>
        {armed ? 'Remove breakpoint' : 'Add breakpoint'}
      </button>
      <div className="ctx-separator" role="separator" aria-hidden="true" />
      <button className="ctx-item" onClick={handleDuplicate} role="menuitem">
        <span className="ctx-icon" aria-hidden="true">⎘</span> Duplicate
      </button>
      <button className="ctx-item ctx-danger" onClick={handleDelete} role="menuitem">
        <span className="ctx-icon" aria-hidden="true">✕</span> Delete
      </button>
    </div>
  );
}
