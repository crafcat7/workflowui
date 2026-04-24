// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// The vendor schema cache lives at module scope in PropertiesPanel.tsx
// and gets populated by a `wsClient.call('vendor.getConfigSchema')`.
// To exercise the reconnect invalidation path we need control over
// both (a) what `call` returns per invocation and (b) the reconnect
// hook, so we mock WsClient and expose handles for the test to fire.
//
// vi.mock is hoisted above any file-level `let`/`const`, so a mock
// factory that closes over module locals is unreachable. `vi.hoisted`
// is the escape hatch: the returned object is created at the same
// hoisted position as the mock, so both sides see the same reference.
const wsMocks = vi.hoisted(() => ({
  reconnect: null as (() => void) | null,
  call: vi.fn(),
}));
vi.mock('../transport/WsClient', () => ({
  wsClient: {
    onNotification: vi.fn(() => () => {}),
    onReconnect: vi.fn((cb: () => void) => {
      wsMocks.reconnect = cb;
      return () => { wsMocks.reconnect = null; };
    }),
    call: (...args: unknown[]) => wsMocks.call(...args),
  },
}));

// Import AFTER the mock so PropertiesPanel's module-level
// `wsClient.onReconnect(...)` registration picks up the mocked client.
import { PropertiesPanel, __test_invalidateVendorSchemaCache } from './PropertiesPanel';
import { useWorkflowStore } from '../store/workflowStore';

function seedCreateNetNode() {
  // `createNet` is the only node type that flips `vendorSchema: true`
  // in NODE_SCHEMAS, so it's the single route into VendorConfigPanel
  // and therefore into the fetch-and-cache path under test.
  const node = {
    id: 'vendor-node',
    type: 'createNet',
    position: { x: 0, y: 0 },
    data: {
      label: 'Create Net',
      type: 'createNet',
      status: 'idle' as const,
      config: {},
    },
  };
  useWorkflowStore.setState({
    nodes: [node as never],
    nodesById: new Map([[node.id, node as never]]),
    selectedNodeId: node.id,
  });
}

describe('PropertiesPanel vendor schema cache', () => {
  beforeEach(() => {
    // Reset the module-scoped cache between tests — otherwise the
    // first test's successful fetch would poison the second test's
    // assertion on a pre-reconnect state.
    __test_invalidateVendorSchemaCache();
    wsMocks.call.mockReset();
    cleanup();
    useWorkflowStore.setState({
      nodes: [],
      nodesById: new Map(),
      selectedNodeId: null,
    });
  });

  it('fetches schema once and reuses the cache on re-mount', async () => {
    // Simulating a user switching between selected nodes: the panel
    // unmounts and re-mounts, but the cache should survive so we
    // don't hammer the backend with identical RPCs. Two renders → one
    // call is the baseline behavior #8 must NOT regress.
    wsMocks.call.mockResolvedValue({ vendor: 'ncnn', fields: [] });
    seedCreateNetNode();
    const { unmount } = render(<PropertiesPanel />);
    await waitFor(() => expect(wsMocks.call).toHaveBeenCalledTimes(1));
    unmount();

    render(<PropertiesPanel />);
    // Tick the microtask queue; no new call should be made.
    await new Promise((r) => setTimeout(r, 10));
    expect(wsMocks.call).toHaveBeenCalledTimes(1);
  });

  it('refetches schema after a WS reconnect', async () => {
    // Scenario: backend v1 shipped 3 fields, user worked for a bit,
    // the connection dropped, backend v2 came back with 5 fields.
    // The panel MUST forget v1's schema and render v2's, otherwise
    // the user silently edits fields that no longer exist (or worse,
    // can't find new ones that do).
    wsMocks.call.mockResolvedValueOnce({
      vendor: 'ncnn',
      fields: [
        { key: 'paramPath', label: 'Param', type: 'string', group: 'MODEL' },
      ],
    });
    seedCreateNetNode();
    render(<PropertiesPanel />);
    await waitFor(() => expect(screen.getByText('Param')).toBeInTheDocument());

    // Arm the second response BEFORE firing reconnect: the refetch
    // kicks off synchronously from the handler.
    wsMocks.call.mockResolvedValueOnce({
      vendor: 'ncnn',
      fields: [
        { key: 'paramPath', label: 'Param', type: 'string', group: 'MODEL' },
        { key: 'newKnob', label: 'New Knob', type: 'string', group: 'MODEL' },
      ],
    });
    expect(wsMocks.reconnect).not.toBeNull();
    wsMocks.reconnect!();

    await waitFor(() => expect(screen.getByText('New Knob')).toBeInTheDocument());
    expect(wsMocks.call).toHaveBeenCalledTimes(2);
  });

  it('survives a reconnect that happens before the first fetch resolves', async () => {
    // Race: user selects the vendor node, fetch goes out, connection
    // drops and reconnects while the response is still in flight. The
    // new fetch must still complete with a valid schema rather than
    // wedging on a cancelled promise or caching the pre-disconnect
    // in-flight result.
    let resolveFirst: (s: unknown) => void = () => {};
    const firstPromise = new Promise((r) => { resolveFirst = r; });
    wsMocks.call.mockReturnValueOnce(firstPromise);
    // Arm the post-reconnect response *before* firing reconnect —
    // the refetch is synchronous and will consume whatever mock is
    // on the queue at that instant.
    wsMocks.call.mockResolvedValueOnce({
      vendor: 'ncnn',
      fields: [
        { key: 'postReconnect', label: 'Post Reconnect', type: 'string', group: 'MODEL' },
      ],
    });

    seedCreateNetNode();
    render(<PropertiesPanel />);
    // Fire reconnect before the first call resolves.
    expect(wsMocks.reconnect).not.toBeNull();
    wsMocks.reconnect!();

    // Now resolve the stale first call; its result must not overwrite
    // the post-reconnect schema on screen.
    resolveFirst({
      vendor: 'ncnn',
      fields: [
        { key: 'stale', label: 'Stale', type: 'string', group: 'MODEL' },
      ],
    });

    await waitFor(() => expect(screen.getByText('Post Reconnect')).toBeInTheDocument());
    // 'Stale' may briefly have been written to cache before the
    // invalidation, but the final on-screen state must be the fresh
    // post-reconnect schema. That's the property the user cares about.
  });
});
