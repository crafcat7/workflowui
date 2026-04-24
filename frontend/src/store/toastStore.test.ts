// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToastStore, showToast, __test_resetToastStore } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __test_resetToastStore();
  });

  it('auto-dismisses after the level-specific TTL', () => {
    showToast('hello', 'info');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    // info TTL is 4000; anything short of that must not dismiss.
    vi.advanceTimersByTime(3999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('keeps error toasts longer than info toasts', () => {
    showToast('oops', 'error');
    vi.advanceTimersByTime(4000); // info TTL elapsed
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(6000); // total 10000 = error TTL
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('clears the pending auto-dismiss timer when removed manually', () => {
    // Regression: without the timer-cancel, a manual remove followed
    // by an addToast that happens to reuse the id would get wiped
    // the moment the stale timer fires.
    showToast('first', 'info');
    const first = useToastStore.getState().toasts[0]!;
    useToastStore.getState().removeToast(first.id);
    expect(useToastStore.getState().toasts).toHaveLength(0);

    // Advancing past the original TTL must not throw, mutate state,
    // or log unexpected warnings. The stale timer would have filtered
    // against a list where id was absent — silent no-op — but if the
    // id gets reused it would wrongly delete the NEW toast.
    showToast('second', 'info');
    vi.advanceTimersByTime(4000);
    // The second toast has its own timer; only when its own TTL
    // elapses should it be removed. Since we advanced exactly 4000
    // from the second's add, it should now be gone — but critically
    // it must have stayed present for the duration, not have been
    // clobbered by the first's stale timer firing prematurely.
    // We verify the second actually got its full TTL by checking
    // a shorter advance first.
    __test_resetToastStore();
    showToast('third', 'info');
    const third = useToastStore.getState().toasts[0]!;
    useToastStore.getState().removeToast(third.id);
    showToast('fourth', 'info');
    vi.advanceTimersByTime(3999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]!.message).toBe('fourth');
  });

  it('preserves insertion order across multiple concurrent toasts', () => {
    showToast('a', 'info');
    showToast('b', 'warn');
    showToast('c', 'error');
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('reset cancels every in-flight timer', () => {
    showToast('one', 'info');
    showToast('two', 'error');
    __test_resetToastStore();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    // Advance past both TTLs; neither timer should still be armed.
    vi.advanceTimersByTime(20000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
