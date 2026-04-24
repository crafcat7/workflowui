// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * ReconnectBanner - top-of-viewport banner displayed whenever the backend
 * WebSocket is not currently connected. Shows reconnect progress (attempt
 * number + countdown to next retry) so users get explicit feedback instead
 * of just a small status dot in the bottom console.
 */

import { useEffect, useState } from 'react';
import { wsClient, type ConnectionState } from '../transport/WsClient';

export function ReconnectBanner() {
  const [state, setState] = useState<ConnectionState>({
    connected: wsClient.connected,
    reconnecting: false,
    attempt: 0,
    nextRetryMs: 0,
  });
  const [countdownMs, setCountdownMs] = useState(0);

  useEffect(() => {
    return wsClient.onConnectionState(setState);
  }, []);

  // Countdown ticker — only active while reconnecting.
  useEffect(() => {
    if (!state.reconnecting || state.connected) {
      setCountdownMs(0);
      return;
    }
    setCountdownMs(state.nextRetryMs);
    const started = Date.now();
    const iv = setInterval(() => {
      const remaining = Math.max(0, state.nextRetryMs - (Date.now() - started));
      setCountdownMs(remaining);
      if (remaining === 0) clearInterval(iv);
    }, 100);
    return () => clearInterval(iv);
  }, [state.reconnecting, state.nextRetryMs, state.connected]);

  if (state.connected) return null;

  const seconds = (countdownMs / 1000).toFixed(1);
  const label = state.reconnecting
    ? `Backend disconnected — reconnecting (attempt ${state.attempt}, retry in ${seconds}s)`
    : 'Backend disconnected';

  return (
    <div className="reconnect-banner" role="status" aria-live="polite">
      <span className="reconnect-dot" />
      <span className="reconnect-label">{label}</span>
    </div>
  );
}
