// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { describe, it, expect } from 'vitest';
import { NODE_SCHEMAS } from './configSchemas';

describe('NODE_SCHEMAS', () => {
  it('has an entry for every non-vendor built-in node type', () => {
    for (const t of [
      'inputImage',
      'inputTensor',
      'saveText',
      'condition',
      'benchmark',
      'postprocess',
    ]) {
      expect(NODE_SCHEMAS[t]?.sections, `missing schema for ${t}`).toBeDefined();
    }
  });

  it('marks createNet as vendor-driven', () => {
    expect(NODE_SCHEMAS.createNet.vendorSchema).toBe(true);
    expect(NODE_SCHEMAS.createNet.sections).toBeUndefined();
  });

  it('inputTensor conditional fields gate on fillMode', () => {
    const s = NODE_SCHEMAS.inputTensor.sections![0];
    const textArea = s.fields.find((f) => f.key === 'tensorText')!;
    const shape = s.fields.find((f) => f.key === 'shape')!;
    const fill = s.fields.find((f) => f.key === 'fillValue')!;
    expect(textArea.showIf!({ fillMode: 'manual' })).toBe(true);
    expect(textArea.showIf!({ fillMode: 'auto' })).toBe(false);
    expect(textArea.showIf!({})).toBe(true); // default manual
    expect(shape.showIf!({ fillMode: 'auto' })).toBe(true);
    expect(shape.showIf!({ fillMode: 'manual' })).toBe(false);
    expect(fill.showIf!({ fillMode: 'auto' })).toBe(true);
  });

  it('postprocess conditional fields gate on op', () => {
    const s = NODE_SCHEMAS.postprocess.sections![0];
    const iou = s.fields.find((f) => f.key === 'iouThreshold')!;
    const k = s.fields.find((f) => f.key === 'k')!;
    expect(iou.showIf!({ op: 'nms' })).toBe(true);
    expect(iou.showIf!({})).toBe(true); // default nms
    expect(iou.showIf!({ op: 'topk' })).toBe(false);
    expect(k.showIf!({ op: 'topk' })).toBe(true);
    expect(k.showIf!({ op: 'nms' })).toBe(false);
  });
});
