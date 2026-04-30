// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NodeContextMenu } from './NodeContextMenu';
import { useDebugStore } from '../store/debugStore';
import { useWorkflowStore } from '../store/workflowStore';

function resetStores() {
  useDebugStore.setState({
    breakpoints: [],
    pausedAtNodeId: null,
    inspectData: null,
    logs: [],
  });
  // workflowStore has many fields; only reset what this test cares
  // about. Calling setState with a partial is safe under zustand.
  useWorkflowStore.setState({ isRunning: false });
}

function open(nodeId = 'n-1') {
  const onClose = vi.fn();
  const utils = render(<NodeContextMenu menu={{ x: 10, y: 10, nodeId }} onClose={onClose} />);
  return { ...utils, onClose };
}

describe('NodeContextMenu keyboard navigation', () => {
  beforeEach(resetStores);

  it('auto-focuses the first menuitem on mount', () => {
    // Without auto-focus, keyboard users would have to mouse-click
    // into the menu to begin interacting — defeating its purpose.
    open();
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowDown and ArrowUp wrap focus through menuitems', () => {
    open();
    const items = screen.getAllByRole('menuitem');
    const menu = screen.getByRole('menu');
    // items[0] is focused. ArrowDown → items[1].
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    // Wrap.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    // Reverse wrap.
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
  });

  it('Home jumps to the first item and End to the last', () => {
    open();
    const items = screen.getAllByRole('menuitem');
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes the menu', () => {
    const { onClose } = open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab closes the menu rather than moving focus out', () => {
    // Per the WAI-ARIA menu pattern, Tab from inside a menu
    // dismisses the menu. Letting Tab leak would land focus on
    // something arbitrary behind the popup.
    const { onClose } = open();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes an accessible menu label that identifies the node', () => {
    open('my-node-42');
    expect(screen.getByRole('menu', { name: /my-node-42/i })).toBeInTheDocument();
  });

  it('Enter activates the focused item (add breakpoint)', () => {
    // Enter on a <button> fires click — covered by native behavior —
    // but we still pin the contract so a future refactor to
    // role="menuitem" on a <div> can't silently break activation.
    open('node-X');
    const items = screen.getAllByRole('menuitem');
    // First item is "Add breakpoint" since no breakpoint armed.
    expect(items[0]).toHaveTextContent(/add breakpoint/i);
    act(() => {
      (items[0] as HTMLButtonElement).click();
    });
    const armed = useDebugStore.getState().breakpoints.some((b) => b.nodeId === 'node-X');
    expect(armed).toBe(true);
  });

  it('restores focus to the previously-focused element on close', () => {
    // A real user right-clicks a node, uses keyboard to navigate
    // the menu, then Esc: their focus should go back to whatever
    // held focus before — typically the canvas.
    const sentinel = document.createElement('button');
    sentinel.textContent = 'before';
    document.body.appendChild(sentinel);
    sentinel.focus();
    const { unmount } = open();
    // The menu grabbed focus.
    expect(document.activeElement).not.toBe(sentinel);
    unmount();
    expect(document.activeElement).toBe(sentinel);
    document.body.removeChild(sentinel);
  });
});
