// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Image preview hook + module constants.
 *
 * Lives separately from `ImagePreview.tsx` so React-Refresh's
 * "only-export-components" rule stays happy: a file that exports a
 * component must not also export non-component values.
 */
import { useEffect, useRef, useState } from 'react';
import { wsClient } from '../transport/WsClient';

// Debounce window applied to filePath edits before issuing an
// `image.preview` RPC. Keeps us from spamming the backend on every
// keystroke while the user is still typing a path.
export const PREVIEW_DEBOUNCE_MS = 300;

export interface ImagePreviewState {
  preview: string | null;
  loading: boolean;
  error: boolean;
}

/**
 * Fetches a base64 PNG preview from the backend whenever `filePath`
 * changes, debounced by `debounceMs`. Empty paths reset state without
 * issuing a request. Setting `enabled:false` short-circuits the fetch
 * (used by SaveImage panels which should only preview after `done`).
 */
export function useImagePreview(
  filePath: string,
  options?: { enabled?: boolean; debounceMs?: number },
): ImagePreviewState {
  const enabled = options?.enabled ?? true;
  const debounceMs = options?.debounceMs ?? PREVIEW_DEBOUNCE_MS;
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = filePath.trim();
    if (!enabled || !trimmed) {
      // Defer the reset to avoid synchronous setState inside the effect
      // body (react-hooks/set-state-in-effect rule).
      const t = setTimeout(() => {
        setPreview(null);
        setError(false);
        setLoading(false);
      }, 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    debounceRef.current = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      setError(false);
      wsClient
        .call<{ dataUrl: string }>('image.preview', { path: trimmed })
        .then((res) => {
          if (cancelled) return;
          setPreview(res.dataUrl);
          setError(false);
        })
        .catch(() => {
          if (cancelled) return;
          setPreview(null);
          setError(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, debounceMs);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [filePath, enabled, debounceMs]);

  return { preview, loading, error };
}
