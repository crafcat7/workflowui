// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { useDebugStore } from '../store/debugStore';

/**
 * Structured logger that writes to the debug store ring buffer in
 * production and additionally forwards to the console in development.
 */

export function logWarn(message: string, data?: unknown): void {
  if (import.meta.env.DEV) {
    console.warn(message, data);
  }
  useDebugStore.getState().addLog({ nodeId: '__system__', message, level: 'warn', data });
}

export function logError(message: string, data?: unknown): void {
  if (import.meta.env.DEV) {
    console.error(message, data);
  }
  useDebugStore.getState().addLog({ nodeId: '__system__', message, level: 'error', data });
}
