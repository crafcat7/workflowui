// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * WebSocket JSON-RPC 2.0 Client
 * Handles communication between frontend and backend wrapper.
 */
import { logError } from '../utils/logger';

type RpcCallback = (result: unknown, error?: RpcError) => void;

interface PendingCall {
  cb: RpcCallback;
  // Timer cleared either when the response arrives (handleMessage) or
  // when the socket closes (onclose). Stored here so timeout-based
  // expiry can also clear itself out of `pending` atomically.
  timer: ReturnType<typeof setTimeout> | null;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcRequest {
  jsonrpc: '2.0';
  method: string;
  id: number;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  result?: unknown;
  params?: unknown;
  error?: RpcError;
}

type NotificationHandler = (method: string, params: unknown) => void;
export interface ConnectionState {
  connected: boolean;
  reconnecting: boolean;
  attempt: number;
  nextRetryMs: number;
}
type ConnectionStateHandler = (state: ConnectionState) => void;
type ConnectionHandler = (connected: boolean) => void;
type ReconnectHandler = () => void;

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 15000;

// Default per-call timeout. All RPCs in this codebase return synchronously
// from the backend dispatcher: long-running work (`workflow.execute`,
// `workflow.benchmark`) replies with an immediate ack and then pushes
// notifications, so 30 s is a generous ceiling for the *reply* path
// alone. Without this guard, a backend that crashed or wedged after
// receiving the request — but before sending the response — would leave
// the call's promise hanging forever, freezing whichever UI flow was
// awaiting it (e.g. the Run button stays in "starting…" state).
//
// The socket's `onclose` handler already rejects all pending requests
// with `WebSocket closed`, so this timer only matters for the
// silent-backend case where the socket is still nominally open but no
// reply will ever arrive.
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

function computeBackoff(attempt: number): number {
  // Exponential backoff with full jitter: delay in [0, min(MAX, base*2^attempt)]
  const capped = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * capped);
}

export class WsClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingCall>();
  private notificationHandlers: NotificationHandler[] = [];
  private connectionHandlers: ConnectionHandler[] = [];
  private connectionStateHandlers: ConnectionStateHandler[] = [];
  private reconnectHandlers: ReconnectHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private _connected = false;
  private _reconnecting = false;
  private _attempt = 0;
  private _nextRetryMs = 0;
  private _stopped = false;
  // False until the very first `onopen`. Any subsequent `onopen` is a
  // reconnect, which is observable to subscribers via `onReconnect` so
  // they can re-seed state the backend may have updated while we were
  // offline (see W1: workflow.state snapshot).
  private _hadFirstOpen = false;

  constructor(url?: string) {
    // Resolution order:
    //   1. explicit constructor arg (tests / advanced embedding)
    //   2. window.__VITE_WS_URL_OVERRIDE__ (E2E init-script injection; must
    //      win over build-time env so a single built bundle can point at a
    //      different backend per Playwright spec)
    //   3. Vite build-time env VITE_WS_URL
    //   4. hard default (matches backend's default listen port)
    const runtimeOverride =
      typeof window !== 'undefined' ? window.__VITE_WS_URL_OVERRIDE__ : undefined;
    this.url = url ?? runtimeOverride ?? import.meta.env.VITE_WS_URL ?? 'ws://localhost:9090';
  }

  connect(): Promise<void> {
    this._stopped = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        this.scheduleReconnect();
        return;
      }

      this.ws.onopen = () => {
        const wasReconnect = this._hadFirstOpen;
        this._hadFirstOpen = true;
        this._connected = true;
        this._reconnecting = false;
        this._attempt = 0;
        this._nextRetryMs = 0;
        this.emitState();
        this.notifyConnection(true);
        // Fire reconnect handlers *after* the standard connection
        // notification so subscribers that need a base `connected`
        // signal don't race with reconcile logic.
        if (wasReconnect) {
          for (const h of this.reconnectHandlers) {
            try {
              h();
            } catch (e) {
              logError('[WsClient] reconnect handler error:', e);
            }
          }
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      this.ws.onerror = (err) => {
        logError('[WsClient] Error:', err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      this.ws.onclose = () => {
        this._connected = false;
        // Reject any pending requests so UI callers can react instead of
        // hanging until GC. Timers must be cleared too — otherwise a
        // late-firing timeout would try to reject a promise that's
        // already been rejected by this close.
        for (const [, p] of this.pending) {
          if (p.timer) clearTimeout(p.timer);
          try {
            p.cb(undefined, { code: -32000, message: 'WebSocket closed' });
          } catch {
            /* ignore */
          }
        }
        this.pending.clear();
        this.notifyConnection(false);
        if (!this._stopped) {
          this.scheduleReconnect();
        }
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this._stopped) return;
    this._reconnecting = true;
    this._attempt += 1;
    this._nextRetryMs = computeBackoff(this._attempt);
    this.emitState();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        /* will reschedule via onclose */
      });
    }, this._nextRetryMs);
  }

  private handleMessage(raw: string) {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(raw);
    } catch {
      logError('[WsClient] Invalid JSON:', raw);
      return;
    }

    // Server notification (no id, has method)
    if (msg.method && msg.id === undefined) {
      for (const handler of this.notificationHandlers) {
        handler(msg.method, msg.params);
      }
      return;
    }

    // Response to a request
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        if (p.timer) clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.cb(msg.result, msg.error ?? undefined);
      }
    }
  }

  /**
   * Issue a JSON-RPC call.
   *
   * `timeoutMs` defaults to {@link DEFAULT_CALL_TIMEOUT_MS}; pass `0`
   * to disable the timer (useful for tests or for explicitly long
   * fire-and-forget paths). When a call times out, its pending entry
   * is removed atomically so a late server reply for the same id is
   * silently dropped rather than resolving an already-rejected
   * promise.
   */
  call<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = ++this.requestId;
      const request: RpcRequest = { jsonrpc: '2.0', method, id, params };

      const cb: RpcCallback = (result, error) => {
        if (error) {
          reject(new Error(`${error.code}: ${error.message}`));
        } else {
          resolve(result as T);
        }
      };

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Remove first so a (very) late server reply for this id is
          // dropped on the floor in handleMessage rather than calling
          // a callback the consumer has long since moved past.
          this.pending.delete(id);
          reject(new Error(`Timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
      }

      this.pending.set(id, { cb, timer });
      this.ws.send(JSON.stringify(request));
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  onConnection(handler: ConnectionHandler) {
    this.connectionHandlers.push(handler);
    // Emit current state immediately so subscribers don't have to race.
    handler(this._connected);
    return () => {
      this.connectionHandlers = this.connectionHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Subscribe to reconnect events. Fires every time the socket
   * re-opens after a prior successful connection (i.e. *not* on the
   * initial connect). Subscribers typically use this to pull a
   * backend state snapshot (e.g. `workflow.state`) and reconcile
   * whatever they missed while offline.
   *
   * Handlers fire after `onConnection(true)` so they see a usable
   * `connected` state if they gate on it.
   */
  onReconnect(handler: ReconnectHandler) {
    this.reconnectHandlers.push(handler);
    return () => {
      this.reconnectHandlers = this.reconnectHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Subscribe to rich connection state (connected + reconnect metadata).
   * Fires immediately with the current state so UI can render without races.
   */
  onConnectionState(handler: ConnectionStateHandler) {
    this.connectionStateHandlers.push(handler);
    handler(this.snapshotState());
    return () => {
      this.connectionStateHandlers = this.connectionStateHandlers.filter((h) => h !== handler);
    };
  }

  private snapshotState(): ConnectionState {
    return {
      connected: this._connected,
      reconnecting: this._reconnecting,
      attempt: this._attempt,
      nextRetryMs: this._nextRetryMs,
    };
  }

  private emitState() {
    const snap = this.snapshotState();
    for (const h of this.connectionStateHandlers) {
      try {
        h(snap);
      } catch (e) {
        logError('[WsClient] state handler error:', e);
      }
    }
  }

  private notifyConnection(connected: boolean) {
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
    this.emitState();
  }

  disconnect() {
    this._stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this._reconnecting = false;
    // Explicit disconnect ends the session; a later connect() is a
    // fresh one, not a reconnect, so don't fire reconcile handlers.
    this._hadFirstOpen = false;
    this.emitState();
  }

  get connected() {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const wsClient = new WsClient();
