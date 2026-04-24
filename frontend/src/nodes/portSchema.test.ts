// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect } from 'vitest';
import {
  areTypesCompatible,
  validateConnection,
  isConnectionValid,
  getPort,
  NODE_PORTS,
} from './portSchema';

describe('areTypesCompatible', () => {
  it('accepts identical types', () => {
    expect(areTypesCompatible('tensor', 'tensor').ok).toBe(true);
    expect(areTypesCompatible('net', 'net').ok).toBe(true);
  });

  it('accepts generic as wildcard in either direction', () => {
    expect(areTypesCompatible('generic', 'tensor').ok).toBe(true);
    expect(areTypesCompatible('net', 'generic').ok).toBe(true);
  });

  it('rejects cross-type connections', () => {
    expect(areTypesCompatible('net', 'tensor').ok).toBe(false);
    expect(areTypesCompatible('tensor', 'net').ok).toBe(false);
  });

  it('allows image→tensor coercion but not the reverse', () => {
    expect(areTypesCompatible('image', 'tensor').ok).toBe(true);
    expect(areTypesCompatible('tensor', 'image').ok).toBe(false);
  });

  it('keeps branch isolated from data types', () => {
    expect(areTypesCompatible('branch', 'branch').ok).toBe(true);
    expect(areTypesCompatible('branch', 'tensor').ok).toBe(false);
    expect(areTypesCompatible('tensor', 'branch').ok).toBe(false);
    // generic must not connect with branch (branch is control-flow)
    expect(areTypesCompatible('branch', 'generic').ok).toBe(false);
    expect(areTypesCompatible('generic', 'branch').ok).toBe(false);
  });

  it('is permissive when a side is unknown (registry gap)', () => {
    expect(areTypesCompatible(undefined, 'tensor').ok).toBe(true);
    expect(areTypesCompatible('tensor', undefined).ok).toBe(true);
  });
});

describe('getPort', () => {
  it('looks up a registered port', () => {
    expect(getPort('inference', 'net_handle')?.dataType).toBe('net');
    expect(getPort('condition', 'true_branch')?.dataType).toBe('branch');
  });

  it('returns null for unknown node type or handle', () => {
    expect(getPort('doesNotExist', 'x')).toBeNull();
    expect(getPort('inference', 'missing')).toBeNull();
    expect(getPort(undefined, 'x')).toBeNull();
  });
});

describe('validateConnection', () => {
  const nodes = [
    { id: 'img1', type: 'inputImage' },
    { id: 'net1', type: 'createNet' },
    { id: 'inf1', type: 'inference' },
    { id: 'cond1', type: 'condition' },
    { id: 'out1', type: 'output' },
  ];

  it('rejects self-loops', () => {
    const r = validateConnection(
      { source: 'inf1', target: 'inf1', sourceHandle: 'output_data', targetHandle: 'input_data' },
      nodes,
    );
    expect(r.ok).toBe(false);
  });

  it('accepts valid image→tensor coercion', () => {
    const r = validateConnection(
      { source: 'img1', target: 'inf1', sourceHandle: 'image_data', targetHandle: 'input_data' },
      nodes,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts net→net', () => {
    const r = validateConnection(
      { source: 'net1', target: 'inf1', sourceHandle: 'net_handle', targetHandle: 'net_handle' },
      nodes,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects net plugged into a tensor input', () => {
    const r = validateConnection(
      { source: 'net1', target: 'inf1', sourceHandle: 'net_handle', targetHandle: 'input_data' },
      nodes,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects branch plugged into a non-branch target', () => {
    const r = validateConnection(
      { source: 'cond1', target: 'out1', sourceHandle: 'true_branch', targetHandle: 'data' },
      nodes,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects source→source (direction violation)', () => {
    const r = validateConnection(
      // inference.output_data is a source; wired as target is wrong
      { source: 'inf1', target: 'net1', sourceHandle: 'output_data', targetHandle: 'net_handle' },
      nodes,
    );
    expect(r.ok).toBe(false);
  });
});

describe('registry coverage', () => {
  it('registers ports for every node type used by nodeTypes', () => {
    const expected = [
      'inputImage',
      'inputTensor',
      'createNet',
      'inference',
      'benchmark',
      'saveText',
      'condition',
      'postprocess',
      'output',
      'debug',
    ];
    for (const t of expected) {
      expect(NODE_PORTS[t], `missing ports for ${t}`).toBeDefined();
    }
  });
});

describe('isConnectionValid convenience wrapper', () => {
  it('returns boolean of validateConnection', () => {
    const nodes = [
      { id: 'a', type: 'inputImage' },
      { id: 'b', type: 'inference' },
    ];
    expect(
      isConnectionValid(
        { source: 'a', target: 'b', sourceHandle: 'image_data', targetHandle: 'input_data' },
        nodes,
      ),
    ).toBe(true);
    expect(
      isConnectionValid(
        { source: 'a', target: 'b', sourceHandle: 'image_data', targetHandle: 'net_handle' },
        nodes,
      ),
    ).toBe(false);
  });
});
