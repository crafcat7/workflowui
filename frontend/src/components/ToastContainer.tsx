// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { useEffect } from 'react';
import { useToastStore } from '../store/toastStore';

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  // Global Escape binding: dismiss the most recent toast. Users
  // frequently have keyboard focus elsewhere (canvas, properties
  // panel) when a toast appears, and we don't want to trap focus
  // just to dismiss a status message. Bail out if the Esc press
  // originates from a text field so we don't steal Esc-to-blur.
  useEffect(() => {
    if (toasts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      const top = toasts[toasts.length - 1];
      if (top) removeToast(top.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toasts, removeToast]);

  if (toasts.length === 0) return null;

  return (
    // Container is a passive live region. Individual toasts choose
    // their own role/politeness — errors escalate to role="alert"
    // + assertive so screen readers interrupt; others use status +
    // polite so they don't clobber whatever the user was hearing.
    <div className="toast-container" role="region" aria-label="Notifications">
      {toasts.map((t) => {
        const isError = t.level === 'error';
        return (
          <div
            key={t.id}
            className={`toast ${t.level}`}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => removeToast(t.id)}
            >
              {/* Unicode multiplication sign avoids loading an icon
                  just for a close button; decorative so hidden from
                  AT — the aria-label on the button carries meaning. */}
              <span aria-hidden="true">×</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
