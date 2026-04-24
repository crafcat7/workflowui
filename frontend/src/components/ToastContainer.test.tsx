// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ToastContainer } from './ToastContainer';
import { showToast, useToastStore, __test_resetToastStore } from '../store/toastStore';

describe('ToastContainer', () => {
  beforeEach(() => {
    __test_resetToastStore();
  });

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer />);
    expect(container.firstChild).toBeNull();
  });

  it('gives error toasts role=alert and others role=status', () => {
    // a11y contract: errors interrupt (role=alert, aria-live=assertive)
    // because they gate the user from proceeding; informational
    // toasts use status/polite so they don't clobber whatever the
    // screen reader was announcing.
    render(<ToastContainer />);
    act(() => {
      showToast('heads up', 'info');
      showToast('boom', 'error');
    });
    const alerts = screen.getAllByRole('alert');
    const statuses = screen.getAllByRole('status');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('boom');
    expect(alerts[0]).toHaveAttribute('aria-live', 'assertive');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent('heads up');
    expect(statuses[0]).toHaveAttribute('aria-live', 'polite');
  });

  it('dismisses a toast via the per-item close button', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('hi', 'info');
    });
    const btn = screen.getByRole('button', { name: /dismiss notification/i });
    fireEvent.click(btn);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismisses the most recent toast on Escape key', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('old', 'info');
      showToast('new', 'warn');
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    const remaining = useToastStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.message).toBe('old');
  });

  it('does not intercept Escape when focus is inside a text field', () => {
    // If we stole Esc from the input, users couldn't use it to
    // cancel a pending edit — confusing UX.
    render(
      <>
        <input data-testid="edit" />
        <ToastContainer />
      </>,
    );
    act(() => {
      showToast('persist me', 'info');
    });
    const input = screen.getByTestId('edit');
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('exposes the outer container as a labelled region for screen readers', () => {
    // One landmark per site for notifications makes it discoverable
    // via AT landmark navigation.
    render(<ToastContainer />);
    act(() => {
      showToast('hello', 'info');
    });
    const region = screen.getByRole('region', { name: /notifications/i });
    expect(region).toBeInTheDocument();
  });
});
