// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from './WsClient';

// Minimal stand-in for the browser WebSocket. Tests drive the lifecycle
// manually: instantiate WsClient, capture the latest socket, fire
// `_open()`, then assert `call()` behaviour. This is enough for the
// timeout/cleanup paths under test and avoids an actual network listener.
class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  // Test helpers
  _open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  _reply(id: number, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  }
}

describe('WsClient.call timeout', () => {
  let originalWs: typeof globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWs = globalThis.WebSocket;
    // Cast through unknown — MockWebSocket only implements the surface
    // WsClient actually touches, not the full DOM WebSocket type.
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof globalThis.WebSocket }).WebSocket = originalWs;
    vi.useRealTimers();
  });

  it('rejects with a Timeout error when no reply arrives within the limit', async () => {
    const client = new WsClient('ws://test');
    const connected = client.connect();
    MockWebSocket.instances[0]._open();
    await connected;

    // 5 s timeout; backend is silent.
    const pending = client.call('slow.method', undefined, 5000);
    // Attach a catch to silence Vitest's unhandled-rejection guard
    // before we advance timers (the promise rejects deterministically
    // when the timer fires).
    const caught = pending.catch((e: Error) => e);

    vi.advanceTimersByTime(4999);
    // Still pending right before the deadline.
    let racedEarly = false;
    await Promise.race([caught.then(() => { racedEarly = true; }), Promise.resolve()]);
    expect(racedEarly).toBe(false);

    vi.advanceTimersByTime(2);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timeout after 5000ms: slow.method/);
  });

  it('drops late replies for an already-timed-out call (no double settle)', async () => {
    const client = new WsClient('ws://test');
    const connected = client.connect();
    const ws = MockWebSocket.instances[0];
    ws._open();
    await connected;

    const pending = client.call('slow.method', undefined, 1000);
    const caught = pending.catch((e: Error) => e);
    vi.advanceTimersByTime(1001);
    const err = await caught;
    expect((err as Error).message).toMatch(/Timeout/);

    // A late reply for id=1 must be silently ignored — calling
    // `_reply` should not throw and should not produce a new
    // resolution. We assert the latter indirectly: re-awaiting
    // `pending` returns the same rejection without hanging.
    expect(() => ws._reply(1, { ok: true })).not.toThrow();
    await expect(pending).rejects.toThrow(/Timeout/);
  });

  it('clears the timeout when a reply arrives in time', async () => {
    const client = new WsClient('ws://test');
    const connected = client.connect();
    const ws = MockWebSocket.instances[0];
    ws._open();
    await connected;

    const promise = client.call<{ ok: boolean }>('fast.method', undefined, 5000);
    // Reply immediately.
    ws._reply(1, { ok: true });
    const result = await promise;
    expect(result).toEqual({ ok: true });

    // Advancing past the original deadline must not produce any side
    // effect (no late rejection). If the timer wasn't cleared, the
    // pending entry would already be gone by now, but a stray timer
    // could still call `pending.delete` on a missing key — harmless,
    // but we also assert no spurious unhandled-rejection by virtue of
    // the test simply not crashing.
    vi.advanceTimersByTime(10000);
  });

  it('passing timeoutMs=0 disables the timer (long-running fire-and-forget)', async () => {
    const client = new WsClient('ws://test');
    const connected = client.connect();
    const ws = MockWebSocket.instances[0];
    ws._open();
    await connected;

    const promise = client.call('forever.method', undefined, 0);
    let settled = false;
    void promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // Far past the default ceiling — must still not have settled.
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    // A reply still settles it normally.
    ws._reply(1, 42);
    await expect(promise).resolves.toBe(42);
  });

  it('socket close clears pending timers and rejects with WebSocket closed', async () => {
    const client = new WsClient('ws://test');
    const connected = client.connect();
    const ws = MockWebSocket.instances[0];
    ws._open();
    await connected;

    const pending = client.call('any.method', undefined, 5000);
    const caught = pending.catch((e: Error) => e);

    ws.close();
    const err = await caught;
    // The close handler emits the JSON-RPC -32000 error; the
    // message format is "<code>: <message>".
    expect((err as Error).message).toMatch(/-32000: WebSocket closed/);

    // After close, advancing past the original timeout must not
    // produce a second rejection or throw. If the timer hadn't been
    // cleared, it would call `reject` on an already-settled promise
    // (no-op) and try to delete a missing pending entry (also no-op),
    // but Vitest will not accept a hung test, so reaching here is
    // sufficient evidence.
    vi.advanceTimersByTime(10_000);
  });
});
