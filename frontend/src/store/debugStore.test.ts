// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDebugStore, MAX_LOG_ENTRIES } from './debugStore';
import { useToastStore, showToast } from './toastStore';

function resetDebug() {
  useDebugStore.setState({
    breakpoints: [],
    pausedAtNodeId: null,
    inspectData: null,
    logs: [],
  });
}

describe('debugStore log cap', () => {
  beforeEach(resetDebug);

  it('caps log length at MAX_LOG_ENTRIES', () => {
    const s = useDebugStore.getState();
    for (let i = 0; i < MAX_LOG_ENTRIES + 50; i++) {
      s.addLog({ nodeId: `n${i}`, level: 'info', message: `m${i}` });
    }
    const logs = useDebugStore.getState().logs;
    expect(logs.length).toBe(MAX_LOG_ENTRIES);
    expect(logs[0].nodeId).toBe(`n${50}`);
    expect(logs[logs.length - 1].nodeId).toBe(`n${MAX_LOG_ENTRIES + 49}`);
  });
});

describe('debugStore breakpoints', () => {
  beforeEach(resetDebug);

  it('addBreakpoint is idempotent by nodeId', () => {
    const s = useDebugStore.getState();
    s.addBreakpoint('node_1');
    s.addBreakpoint('node_1');
    expect(useDebugStore.getState().breakpoints).toHaveLength(1);
  });

  it('toggleBreakpoint flips enabled flag', () => {
    const s = useDebugStore.getState();
    s.addBreakpoint('node_1');
    expect(useDebugStore.getState().breakpoints[0].enabled).toBe(true);
    s.toggleBreakpoint('node_1');
    expect(useDebugStore.getState().breakpoints[0].enabled).toBe(false);
  });
});

describe('toastStore TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('errors persist longer than successes', () => {
    showToast('ok', 'success');
    showToast('boom', 'error');
    expect(useToastStore.getState().toasts).toHaveLength(2);

    // Success TTL is 3s, error TTL is 10s
    vi.advanceTimersByTime(3500);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['boom']);

    vi.advanceTimersByTime(7000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
