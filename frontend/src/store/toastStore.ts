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

let toastId = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (message, level = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, message, level }] });
    setTimeout(() => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, 4000);
  },

  removeToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function showToast(message: string, level: ToastLevel = 'info') {
  useToastStore.getState().addToast(message, level);
}
