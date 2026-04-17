/**
 * WebSocket JSON-RPC 2.0 Client
 * Handles communication between frontend and backend wrapper.
 */

type RpcCallback = (result: unknown, error?: RpcError) => void;

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
type ConnectionHandler = (connected: boolean) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, RpcCallback>();
  private notificationHandlers: NotificationHandler[] = [];
  private connectionHandlers: ConnectionHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private _connected = false;

  constructor(url?: string) {
    this.url = url ?? (import.meta as unknown as Record<string, Record<string, string>>)?.env?.VITE_WS_URL ?? 'ws://localhost:9090';
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('[WsClient] Connected to', this.url);
        this._connected = true;
        this.notifyConnection(true);
        resolve();
      };

      this.ws.onerror = (err) => {
        console.error('[WsClient] Error:', err);
        reject(err);
      };

      this.ws.onclose = () => {
        console.log('[WsClient] Disconnected, reconnecting in 3s...');
        this._connected = false;
        this.notifyConnection(false);
        this.scheduleReconnect();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, 3000);
  }

  private handleMessage(raw: string) {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WsClient] Invalid JSON:', raw);
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
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg.result, msg.error ?? undefined);
      }
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = ++this.requestId;
      const request: RpcRequest = { jsonrpc: '2.0', method, id, params };

      this.pending.set(id, (result, error) => {
        if (error) {
          reject(new Error(`${error.code}: ${error.message}`));
        } else {
          resolve(result as T);
        }
      });

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
    return () => {
      this.connectionHandlers = this.connectionHandlers.filter((h) => h !== handler);
    };
  }

  private notifyConnection(connected: boolean) {
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  get connected() {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const wsClient = new WsClient();
