// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Per-node-type configuration schemas for the Properties panel.
 *
 * Each entry describes how to render the config editor for a node type:
 * which field groups to show, their input kind, validation hints, and
 * when to show/hide them (for conditional fields that only apply in
 * certain modes, e.g. inputTensor fillMode=auto).
 *
 * Adding a new node type typically means:
 *   1. registering its React component in `nodes/index.ts`
 *   2. adding an entry here
 * If no entry exists, the panel falls back to a generic key/value editor.
 */

export type ConfigFieldKind = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'filepath';

export interface ConfigField {
  /** key inside node.data.config */
  key: string;
  label: string;
  kind: ConfigFieldKind;
  placeholder?: string;
  /** default value used on first render if config[key] is undefined */
  defaultValue?: string;
  /** select options (kind === 'select') */
  options?: Array<{ value: string; label: string }>;
  /** show this field only when the predicate matches the current config */
  showIf?: (config: Record<string, unknown>) => boolean;
  /** number input step / min / max */
  step?: number;
  min?: number;
  max?: number;
  /** optional help text shown under the field */
  help?: string;
}

export interface ConfigSection {
  title: string;
  fields: ConfigField[];
  /** render as a 3-column row (for W/H/C dimensions) */
  layout?: 'stack' | 'row-3';
}

export interface NodeTypeSchema {
  /** sections describing this node's config. If absent, panel falls back to
   *  the dynamic vendor schema (createNet) or the generic editor. */
  sections?: ConfigSection[];
  /** node uses the vendor.getConfigSchema RPC result instead of static sections */
  vendorSchema?: boolean;
}

export const NODE_SCHEMAS: Record<string, NodeTypeSchema> = {
  inputImage: {
    sections: [
      {
        title: 'IMAGE SOURCE',
        fields: [
          {
            key: 'filePath',
            label: 'File Path',
            kind: 'filepath',
            placeholder: '/path/to/image.jpg',
            help: 'Absolute path to an image file. Remember the backend reads this, not the browser.',
          },
        ],
      },
    ],
  },

  inputTensor: {
    sections: [
      {
        title: 'TENSOR DATA',
        fields: [
          {
            key: 'fillMode',
            label: 'Mode',
            kind: 'select',
            defaultValue: 'manual',
            options: [
              { value: 'manual', label: 'Manual Text' },
              { value: 'auto', label: 'Auto Fill (Fixed Value)' },
            ],
          },
          {
            key: 'tensorText',
            label: 'Tensor Text',
            kind: 'textarea',
            placeholder: 'comma- or whitespace-separated floats',
            showIf: (c) => (c.fillMode ?? 'manual') === 'manual',
          },
          {
            key: 'shape',
            label: 'Shape',
            kind: 'text',
            placeholder: '3, 224, 224',
            showIf: (c) => c.fillMode === 'auto',
          },
          {
            key: 'fillValue',
            label: 'Fill Value',
            kind: 'number',
            placeholder: '0.0',
            step: 0.01,
            showIf: (c) => c.fillMode === 'auto',
          },
        ],
      },
    ],
  },

  createNet: {
    vendorSchema: true,
  },

  saveText: {
    sections: [
      {
        title: 'OUTPUT FILE',
        fields: [
          {
            key: 'filePath',
            label: 'File Path',
            kind: 'filepath',
            placeholder: 'output.txt',
          },
        ],
      },
    ],
  },

  saveImage: {
    sections: [
      {
        title: 'OUTPUT FILE',
        fields: [
          {
            key: 'filePath',
            label: 'File Path',
            kind: 'filepath',
            placeholder: 'output.png',
          },
        ],
      },
    ],
  },

  condition: {
    sections: [
      {
        title: 'CONDITION',
        fields: [
          {
            key: 'expression',
            label: 'Expression',
            kind: 'text',
            placeholder: '> 0.5',
            help: 'Compared against max(input). Supported: > < >= <= == !=',
          },
        ],
      },
    ],
  },

  benchmark: {
    sections: [
      {
        title: 'BENCHMARK OPTIONS',
        fields: [
          {
            key: 'duration',
            label: 'Duration (seconds)',
            kind: 'number',
            placeholder: '10',
            step: 1,
            min: 1,
            help: 'Runs inference repeatedly for this many seconds (default 10).',
          },
        ],
      },
    ],
  },

  postprocess: {
    sections: [
      {
        title: 'POSTPROCESS OPTIONS',
        fields: [
          {
            key: 'op',
            label: 'Operation',
            kind: 'select',
            defaultValue: 'nms',
            options: [
              { value: 'nms', label: 'Non-Maximum Suppression (NMS)' },
              { value: 'topk', label: 'Top-K' },
            ],
          },
          {
            key: 'iouThreshold',
            label: 'IoU Threshold',
            kind: 'number',
            placeholder: '0.45',
            step: 0.01,
            min: 0,
            max: 1,
            showIf: (c) => (c.op ?? 'nms') === 'nms',
          },
          {
            key: 'k',
            label: 'K Value',
            kind: 'number',
            placeholder: '1',
            step: 1,
            min: 1,
            showIf: (c) => c.op === 'topk',
          },
        ],
      },
    ],
  },
};
