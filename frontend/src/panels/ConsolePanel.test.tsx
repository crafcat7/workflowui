// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConsolePanel } from './ConsolePanel';
import { useDebugStore } from '../store/debugStore';
import { useWorkflowStore } from '../store/workflowStore';
import type { WorkflowActions } from '../hooks/useWorkflowActions';

function makeActions(overrides: Partial<WorkflowActions> = {}): WorkflowActions {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    continueExec: vi.fn(),
    stepOver: vi.fn(),
    save: vi.fn(),
    load: vi.fn(),
    duplicateSelected: vi.fn(),
    deleteSelected: vi.fn(),
    deselect: vi.fn(),
    selectAll: vi.fn(),
    toggleBreakpointOnSelected: vi.fn(),
    ...overrides,
  };
}

function resetStores() {
  useDebugStore.setState({
    breakpoints: [],
    pausedAtNodeId: null,
    inspectData: null,
    logs: [],
  });
  useWorkflowStore.setState({ isRunning: false });
}

describe('ConsolePanel a11y', () => {
  beforeEach(resetStores);

  it('exposes each toolbar button with a descriptive aria-label', () => {
    // Icon-only glyphs (▶ ⏵ ⤼ ■) have no accessible name for
    // screen readers; the explicit aria-label is the screen-reader
    // contract.
    render(<ConsolePanel actions={makeActions()} />);
    expect(screen.getByRole('button', { name: /run workflow/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /continue until next breakpoint/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /step over to next node/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop workflow/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save workflow/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load workflow/i })).toBeInTheDocument();
  });

  it('renames RUN to Resume when the workflow is paused', () => {
    // The "R" key double-duty (idle=run, paused=resume) is surfaced
    // in the accessible name so screen-reader users get the same
    // signal the sighted button label carries.
    useDebugStore.setState({ pausedAtNodeId: 'node-5' });
    useWorkflowStore.setState({ isRunning: true });
    render(<ConsolePanel actions={makeActions()} />);
    expect(screen.getByRole('button', { name: /resume workflow/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^run workflow$/i })).toBeNull();
  });

  it('marks the toolbar as a toolbar landmark with a label', () => {
    render(<ConsolePanel actions={makeActions()} />);
    expect(
      screen.getByRole('toolbar', { name: /workflow execution controls/i }),
    ).toBeInTheDocument();
  });

  it('exposes the log area as a role=log live region', () => {
    // Screen-reader users need the log to auto-announce without
    // being an assertive interruption.
    render(<ConsolePanel actions={makeActions()} />);
    const log = screen.getByRole('log', { name: /execution log/i });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-atomic', 'false');
  });

  it('labels the collapse toggle with aria-expanded state', () => {
    render(<ConsolePanel actions={makeActions()} />);
    const toggle = screen.getByRole('button', { name: /collapse console log area/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    const reExpand = screen.getByRole('button', { name: /expand console log area/i });
    expect(reExpand).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ConsolePanel autoscroll', () => {
  beforeEach(resetStores);

  // jsdom doesn't implement layout, so scrollTop/scrollHeight are
  // mutable plain numbers. That's fine for verifying the branching
  // logic, which is all this test cares about.
  function pushLog(msg: string) {
    act(() => {
      useDebugStore.setState((s) => ({
        logs: [...s.logs, { timestamp: Date.now(), nodeId: 'n', level: 'info', message: msg }],
      }));
    });
  }

  it('snaps scrollTop to scrollHeight when a log arrives while anchored', () => {
    render(<ConsolePanel actions={makeActions()} />);
    const log = screen.getByRole('log');
    // Simulate a scrollable area where we are exactly at the bottom.
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    log.scrollTop = 0; // effect will write to this

    pushLog('hello');
    expect(log.scrollTop).toBe(500);
  });

  it('stops autoscrolling once the user scrolls up past the stick threshold', () => {
    render(<ConsolePanel actions={makeActions()} />);
    // Seed a log so the jump-to-latest chip is eligible to appear
    // once autoscroll is frozen — the chip hides itself when the
    // log is empty since there's nothing to jump to.
    pushLog('seed');
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    log.scrollTop = 300;
    fireEvent.scroll(log);

    pushLog('new line');
    expect(log.scrollTop).toBe(300);

    const resume = screen.getByRole('button', { name: /resume autoscroll/i });
    expect(resume).toBeInTheDocument();
  });

  it('re-engages autoscroll when the user scrolls back into the stick zone', () => {
    render(<ConsolePanel actions={makeActions()} />);
    pushLog('seed');
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(screen.getByRole('button', { name: /resume autoscroll/i })).toBeInTheDocument();

    log.scrollTop = 790;
    fireEvent.scroll(log);
    expect(screen.queryByRole('button', { name: /resume autoscroll/i })).toBeNull();
  });

  it('the jump-to-latest button snaps to bottom and re-arms autoscroll', () => {
    render(<ConsolePanel actions={makeActions()} />);
    pushLog('seed');
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    log.scrollTop = 0;
    fireEvent.scroll(log);

    const btn = screen.getByRole('button', { name: /resume autoscroll/i });
    fireEvent.click(btn);
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: /resume autoscroll/i })).toBeNull();
  });
});
