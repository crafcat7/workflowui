// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { create } from 'zustand';

export interface Breakpoint {
  nodeId: string;
  enabled: boolean;
}

export interface DebugLogEntry {
  timestamp: number;
  nodeId: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  data?: unknown;
}

/** Upper bound on retained log entries to prevent memory bloat on long runs. */
export const MAX_LOG_ENTRIES = 2000;

interface DebugState {
  breakpoints: Breakpoint[];
  pausedAtNodeId: string | null;
  inspectData: Record<string, unknown> | null;
  logs: DebugLogEntry[];

  addBreakpoint: (nodeId: string) => void;
  removeBreakpoint: (nodeId: string) => void;
  toggleBreakpoint: (nodeId: string) => void;
  setPausedAt: (nodeId: string | null) => void;
  setInspectData: (data: Record<string, unknown> | null) => void;
  addLog: (entry: Omit<DebugLogEntry, 'timestamp'>) => void;
  clearLogs: () => void;
}

export const useDebugStore = create<DebugState>((set, get) => ({
  breakpoints: [],
  pausedAtNodeId: null,
  inspectData: null,
  logs: [],

  addBreakpoint: (nodeId) => {
    if (!get().breakpoints.find((b) => b.nodeId === nodeId)) {
      set({ breakpoints: [...get().breakpoints, { nodeId, enabled: true }] });
    }
  },

  removeBreakpoint: (nodeId) => {
    set({ breakpoints: get().breakpoints.filter((b) => b.nodeId !== nodeId) });
  },

  toggleBreakpoint: (nodeId) => {
    set({
      breakpoints: get().breakpoints.map((b) =>
        b.nodeId === nodeId ? { ...b, enabled: !b.enabled } : b,
      ),
    });
  },

  setPausedAt: (nodeId) => set({ pausedAtNodeId: nodeId }),

  setInspectData: (data) => set({ inspectData: data }),

  addLog: (entry) => {
    const logs = get().logs;
    const next =
      logs.length >= MAX_LOG_ENTRIES
        ? [...logs.slice(logs.length - MAX_LOG_ENTRIES + 1), { ...entry, timestamp: Date.now() }]
        : [...logs, { ...entry, timestamp: Date.now() }];
    set({ logs: next });
  },

  clearLogs: () => set({ logs: [] }),
}));
