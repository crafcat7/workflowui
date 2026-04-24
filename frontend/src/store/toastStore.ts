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

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (message, level = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, message, level }] });
    setTimeout(() => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, TOAST_TTL[level]);
  },

  removeToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function showToast(message: string, level: ToastLevel = 'info') {
  useToastStore.getState().addToast(message, level);
}
