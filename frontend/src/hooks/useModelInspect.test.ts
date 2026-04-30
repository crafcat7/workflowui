// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useModelInspect, toInspectError } from './useModelInspect';
import { wsClient } from '../transport/WsClient';
import type { ModelGraph } from '../types/modelInspector';

vi.mock('../transport/WsClient', () => ({
  wsClient: {
    call: vi.fn(),
  },
}));

const mockedCall = vi.mocked(wsClient.call);

function fakeGraph(overrides: Partial<ModelGraph> = {}): ModelGraph {
  return {
    vendor: 'ncnn',
    format_version: 'ncnn-7767517',
    layers: [],
    blobs: [],
    param_bytes: 100,
    bin_bytes: 0,
    input_blob_names: ['data'],
    output_blob_names: ['out'],
    editable: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockedCall.mockReset();
});

describe('useModelInspect', () => {
  it('translates camelCase request into snake_case wire shape', async () => {
    mockedCall.mockResolvedValueOnce(fakeGraph());
    const { result } = renderHook(() => useModelInspect());

    await act(async () => {
      await result.current.inspect({
        vendor: 'ncnn',
        paramPath: '/abs/model.param',
        modelPath: '/abs/model.bin',
      });
    });

    expect(mockedCall).toHaveBeenCalledWith('model.inspect', {
      vendor: 'ncnn',
      param_path: '/abs/model.param',
      model_path: '/abs/model.bin',
    });
  });

  it('omits modelPath as empty string when caller does not supply one', async () => {
    mockedCall.mockResolvedValueOnce(fakeGraph());
    const { result } = renderHook(() => useModelInspect());

    await act(async () => {
      await result.current.inspect({ vendor: 'ncnn', paramPath: '/x.param' });
    });

    // The backend treats "" identically to "absent"; the hook chooses
    // "" over leaving the field undefined so the wire payload schema
    // is invariant w.r.t. modelPath presence.
    expect(mockedCall.mock.calls[0]?.[1]).toMatchObject({ model_path: '' });
  });

  it('exposes the resulting graph and clears loading on success', async () => {
    const g = fakeGraph({
      layers: [{ id: 'a', type: 'X', input_blobs: [], output_blobs: ['o'], params: {} }],
    });
    mockedCall.mockResolvedValueOnce(g);
    const { result } = renderHook(() => useModelInspect());

    expect(result.current.loading).toBe(false);
    expect(result.current.graph).toBeNull();

    await act(async () => {
      await result.current.inspect({ vendor: 'ncnn', paramPath: '/x.param' });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.graph).toEqual(g);
  });

  it('captures JSON-RPC errors with their numeric code preserved', async () => {
    mockedCall.mockRejectedValueOnce({ code: -32602, message: 'params.vendor must be a string' });
    const { result } = renderHook(() => useModelInspect());

    await act(async () => {
      await result.current.inspect({ vendor: '', paramPath: '/x.param' });
    });

    expect(result.current.graph).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toEqual({
      code: -32602,
      message: 'params.vendor must be a string',
    });
  });

  it('captures transport-layer Error rejections as code 0', async () => {
    mockedCall.mockRejectedValueOnce(new Error('ws disconnected'));
    const { result } = renderHook(() => useModelInspect());

    await act(async () => {
      await result.current.inspect({ vendor: 'ncnn', paramPath: '/x.param' });
    });

    expect(result.current.error).toEqual({ code: 0, message: 'ws disconnected' });
  });

  it('drops stale results when a newer call lands first', async () => {
    // First call resolves slowly; second call resolves immediately
    // and must win. This is the "user clicks node A then quickly
    // node B" race the seqRef guards against.
    let resolveFirst: ((g: ModelGraph) => void) | null = null;
    mockedCall
      .mockImplementationOnce(
        () =>
          new Promise<ModelGraph>((resolve) => {
            resolveFirst = resolve;
          }) as Promise<unknown>,
      )
      .mockResolvedValueOnce(fakeGraph({ vendor: 'second' }));

    const { result } = renderHook(() => useModelInspect());

    let firstPromise: Promise<void>;
    act(() => {
      firstPromise = result.current.inspect({ vendor: 'ncnn', paramPath: '/a.param' });
    });

    await act(async () => {
      await result.current.inspect({ vendor: 'ncnn', paramPath: '/b.param' });
    });
    // Second call has committed.
    expect(result.current.graph?.vendor).toBe('second');

    // Now let the first call land late — it must NOT overwrite.
    await act(async () => {
      resolveFirst!(fakeGraph({ vendor: 'first' }));
      await firstPromise!;
    });
    expect(result.current.graph?.vendor).toBe('second');
  });

  it('reset clears state and invalidates pending call', async () => {
    let resolveCall: ((g: ModelGraph) => void) | null = null;
    mockedCall.mockImplementationOnce(
      () =>
        new Promise<ModelGraph>((resolve) => {
          resolveCall = resolve;
        }) as Promise<unknown>,
    );
    const { result } = renderHook(() => useModelInspect());

    let p: Promise<void>;
    act(() => {
      p = result.current.inspect({ vendor: 'ncnn', paramPath: '/x.param' });
    });
    expect(result.current.loading).toBe(true);

    act(() => result.current.reset());
    expect(result.current.loading).toBe(false);
    expect(result.current.graph).toBeNull();
    expect(result.current.error).toBeNull();

    // Late resolution must not revive state.
    await act(async () => {
      resolveCall!(fakeGraph({ vendor: 'late' }));
      await p!;
    });
    expect(result.current.graph).toBeNull();
  });

  it('toggles loading flag during the call lifetime', async () => {
    let resolveCall: ((g: ModelGraph) => void) | null = null;
    mockedCall.mockImplementationOnce(
      () =>
        new Promise<ModelGraph>((resolve) => {
          resolveCall = resolve;
        }) as Promise<unknown>,
    );
    const { result } = renderHook(() => useModelInspect());

    let p: Promise<void>;
    act(() => {
      p = result.current.inspect({ vendor: 'ncnn', paramPath: '/x.param' });
    });
    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => {
      resolveCall!(fakeGraph());
      await p!;
    });
    expect(result.current.loading).toBe(false);
  });
});

describe('toInspectError', () => {
  it('preserves JSON-RPC error envelopes', () => {
    expect(toInspectError({ code: -32000, message: 'bad magic' })).toEqual({
      code: -32000,
      message: 'bad magic',
    });
  });

  it('maps Error to code 0 with its message', () => {
    expect(toInspectError(new Error('boom'))).toEqual({ code: 0, message: 'boom' });
  });

  it('stringifies any other rejection value', () => {
    expect(toInspectError('weird')).toEqual({ code: 0, message: 'weird' });
    expect(toInspectError(null)).toEqual({ code: 0, message: 'null' });
  });

  it('rejects partially-shaped envelopes (wrong field types)', () => {
    expect(toInspectError({ code: 'oops', message: 42 })).toEqual({
      code: 0,
      message: '[object Object]',
    });
  });
});
