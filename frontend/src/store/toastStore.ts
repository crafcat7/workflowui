// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { create } from 'zustand';

export type ToastLevel = 'info' | 'warn' | 'error' | 'success';

interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, level?: ToastLevel) => void;
  removeToast: (id: number) => void;
}

/**
 * Per-level auto-dismiss TTLs (ms). Errors stay longer because the user often
 * needs to read a stack trace; successes auto-dismiss quickly.
 */
const TOAST_TTL: Record<ToastLevel, number> = {
  success: 3000,
  info: 4000,
  warn: 6000,
  error: 10000,
};

let toastId = 0;

// Map of toast id → pending auto-dismiss timer. When the user
// manually dismisses (click, Esc, keyboard activate), we clear the
// corresponding timer so it cannot fire later and attempt to remove
// an id that may have since been reused — a subtle double-remove
// that in the worst case could drop a freshly-added toast with the
// recycled id. Keeping the map outside the store avoids making
// timer handles part of the reactive state.
const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();

function clearPending(id: number): void {
  const handle = pendingTimers.get(id);
  if (handle !== undefined) {
    clearTimeout(handle);
    pendingTimers.delete(id);
  }
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (message, level = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, message, level }] });
    const handle = setTimeout(() => {
      pendingTimers.delete(id);
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, TOAST_TTL[level]);
    pendingTimers.set(id, handle);
  },

  removeToast: (id) => {
    clearPending(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function showToast(message: string, level: ToastLevel = 'info') {
  useToastStore.getState().addToast(message, level);
}

// Test-only: reset the id counter + cancel every pending timer.
// Called from vitest setup to keep each case hermetic. Not exported
// from the package barrel.
export function __test_resetToastStore(): void {
  for (const handle of pendingTimers.values()) clearTimeout(handle);
  pendingTimers.clear();
  toastId = 0;
  useToastStore.setState({ toasts: [] });
}
