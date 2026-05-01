// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Single source of truth for every node type.
 *
 * Historically we had four independent registries — `nodeTypeList` for
 * the palette, `NODE_PORTS` for connection validation, `NODE_SCHEMAS`
 * for the Properties panel, and `NODE_CATEGORIES` inside App.tsx for
 * minimap/CSS styling — each of which had to be updated in lockstep
 * when adding or renaming a node. Drift was frequent and silent.
 *
 * This manifest folds all four into one declarative table. The old
 * registries remain available as *derived* exports from their original
 * files so existing imports keep working; they simply project into this
 * manifest instead of duplicating data.
 *
 * Adding a new node type: add one entry here, and register the React
 * component in `nodes/index.ts`. Nothing else.
 */

import type { ReactNode } from 'react';
import type { HandleDataType } from '../components/LabeledHandle';
import type { ConfigSection } from './configSchemas';
import {
  ImageIcon,
  TensorIcon,
  BrainIcon,
  ZapIcon,
  TrendingUpIcon,
  WrenchIcon,
  SaveTextIcon,
  SaveImageIcon,
  BranchIcon,
  OutputIcon,
  InspectIcon,
  HeatmapIcon,
  TagIcon,
  BoxIcon,
  MosaicIcon,
  LayersIcon,
} from './NodeIcons';

export type NodeCategoryKey = 'input' | 'inference' | 'output' | 'control' | 'debug';

export interface NodePortDef {
  id: string;
  direction: 'source' | 'target';
  dataType: HandleDataType;
}

/**
 * Visual category metadata. Kept here (instead of in a lookup table
 * keyed by category name) so the manifest is truly self-contained;
 * `categoryVisuals` below caches the lookup for consumers.
 */
export interface CategoryVisual {
  /** Category display label in the palette, e.g. 'INPUT'. */
  label: string;
  /** Hex color used for the minimap dot and palette indicator. */
  color: string;
  /** CSS class applied to the rendered node, e.g. 'node-input'. */
  cssClass: string;
}

export const CATEGORY_VISUALS: Record<NodeCategoryKey, CategoryVisual> = {
  input: { label: 'INPUT', color: '#2a9d8f', cssClass: 'node-input' },
  inference: { label: 'INFERENCE', color: '#9b59b6', cssClass: 'node-inference' },
  output: { label: 'OUTPUT', color: '#2ecc71', cssClass: 'node-output' },
  control: { label: 'CONTROL', color: '#6080c0', cssClass: 'node-control' },
  debug: { label: 'DEBUG', color: '#e0c080', cssClass: 'node-debug' },
};

export interface NodeManifestEntry {
  /** Unique type id used across React Flow, ports, handlers. */
  type: string;
  /** Human-readable name shown in the palette and node header. */
  label: string;
  /** SVG icon component rendered in the palette card and node header. */
  icon: ReactNode;
  /** Category for styling + palette grouping. */
  category: NodeCategoryKey;
  /** Ports; empty for source-only or sink-only nodes. */
  ports: NodePortDef[];
  /** Config schema sections for the Properties panel. */
  configSections?: ConfigSection[];
  /**
   * If true, the Properties panel fetches `vendor.getConfigSchema`
   * instead of reading `configSections`. Currently only `createNet`.
   */
  vendorSchema?: boolean;
}

export const NODE_MANIFEST: NodeManifestEntry[] = [
  {
    type: 'inputImage',
    label: 'Input Image',
    icon: <ImageIcon />,
    category: 'input',
    ports: [{ id: 'image_data', direction: 'source', dataType: 'image' }],
    configSections: [
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
  {
    type: 'inputTensor',
    label: 'Input Tensor',
    icon: <TensorIcon />,
    category: 'input',
    ports: [{ id: 'tensor_data', direction: 'source', dataType: 'tensor' }],
    configSections: [
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
  {
    type: 'createNet',
    label: 'Create Net',
    icon: <BrainIcon />,
    category: 'inference',
    ports: [{ id: 'net_handle', direction: 'source', dataType: 'net' }],
    vendorSchema: true,
  },
  {
    type: 'inference',
    label: 'Inference',
    icon: <ZapIcon />,
    category: 'inference',
    ports: [
      { id: 'net_handle', direction: 'target', dataType: 'net' },
      { id: 'input_data', direction: 'target', dataType: 'tensor' },
      { id: 'output_data', direction: 'source', dataType: 'tensor' },
    ],
  },
  {
    type: 'benchmark',
    label: 'Benchmark',
    icon: <TrendingUpIcon />,
    category: 'inference',
    ports: [
      { id: 'net_handle', direction: 'target', dataType: 'net' },
      { id: 'input_data', direction: 'target', dataType: 'tensor' },
      { id: 'benchmark_result', direction: 'source', dataType: 'generic' },
    ],
    configSections: [
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
  {
    type: 'postprocess',
    label: 'Postprocess',
    icon: <WrenchIcon />,
    category: 'inference',
    ports: [
      { id: 'input_data', direction: 'target', dataType: 'tensor' },
      { id: 'output_data', direction: 'source', dataType: 'tensor' },
    ],
    configSections: [
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
  {
    type: 'saveText',
    label: 'Save Text',
    icon: <SaveTextIcon />,
    category: 'output',
    ports: [{ id: 'data', direction: 'target', dataType: 'generic' }],
    configSections: [
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
  {
    type: 'saveImage',
    label: 'Save Image',
    icon: <SaveImageIcon />,
    category: 'output',
    ports: [{ id: 'image_data', direction: 'target', dataType: 'image' }],
    configSections: [
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
  {
    type: 'tensorToImage',
    label: 'Tensor To Image',
    icon: <HeatmapIcon />,
    category: 'output',
    ports: [
      { id: 'input_data', direction: 'target', dataType: 'tensor' },
      { id: 'original_image', direction: 'target', dataType: 'image' },
      { id: 'image_data', direction: 'source', dataType: 'image' },
    ],
    configSections: [
      {
        title: 'RENDER SETTINGS',
        fields: [
          {
            key: 'width',
            label: 'Width',
            kind: 'number',
            placeholder: '256',
            step: 1,
            min: 1,
            showIf: (c) => !c.original_image,
          },
          {
            key: 'height',
            label: 'Height',
            kind: 'number',
            placeholder: '64',
            step: 1,
            min: 1,
            showIf: (c) => !c.original_image,
          },
          {
            key: 'colormap',
            label: 'Colormap',
            kind: 'select',
            defaultValue: 'viridis',
            options: [
              { value: 'viridis', label: 'Viridis' },
              { value: 'gray', label: 'Grayscale' },
            ],
          },
          {
            key: 'normalize',
            label: 'Normalize',
            kind: 'select',
            defaultValue: 'auto',
            options: [
              { value: 'auto', label: 'Auto (min/max rescale)' },
              { value: 'none', label: 'None (clamp 0–1)' },
            ],
          },
          {
            key: 'overlayOpacity',
            label: 'Overlay Opacity',
            kind: 'number',
            placeholder: '0.45',
            step: 0.05,
            min: 0,
            max: 1,
            help: 'When an original image is connected, heatmap is composited over it at this opacity (0 = invisible, 1 = opaque). Ignored when no image connected.',
          },
        ],
      },
    ],
  },
  {
    type: 'annotateImage',
    label: 'Annotate Image',
    icon: <TagIcon />,
    category: 'output',
    ports: [
      { id: 'image_data', direction: 'target', dataType: 'image' },
      { id: 'topk_data', direction: 'target', dataType: 'tensor' },
      { id: 'output_data', direction: 'source', dataType: 'image' },
    ],
    configSections: [
      {
        title: 'ANNOTATION',
        fields: [
          {
            key: 'labelsPath',
            label: 'Labels File',
            kind: 'filepath',
            placeholder: 'labels.txt',
            help: 'Path to a text file with one class label per line. When empty, indices are shown instead.',
          },
          {
            key: 'maxLines',
            label: 'Max Lines',
            kind: 'number',
            placeholder: '5',
            step: 1,
            min: 1,
            help: 'Maximum number of top-K lines to render.',
          },
          {
            key: 'fontScale',
            label: 'Font Scale',
            kind: 'number',
            placeholder: '2',
            step: 1,
            min: 1,
            help: 'Multiplier for the 5×7 bitmap font. 1 = smallest, 2 = default.',
          },
        ],
      },
    ],
  },
  {
    type: 'drawBoxes',
    label: 'Draw Boxes',
    icon: <BoxIcon />,
    category: 'output',
    ports: [
      { id: 'image_data', direction: 'target', dataType: 'image' },
      { id: 'boxes_data', direction: 'target', dataType: 'tensor' },
      { id: 'output_data', direction: 'source', dataType: 'image' },
    ],
    configSections: [
      {
        title: 'BOX RENDERING',
        fields: [
          {
            key: 'confidenceThreshold',
            label: 'Confidence Threshold',
            kind: 'number',
            placeholder: '0.25',
            step: 0.05,
            min: 0,
            max: 1,
          },
          {
            key: 'lineWidth',
            label: 'Line Width',
            kind: 'number',
            placeholder: '2',
            step: 1,
            min: 1,
          },
          {
            key: 'fontScale',
            label: 'Font Scale',
            kind: 'number',
            placeholder: '1',
            step: 1,
            min: 1,
          },
          {
            key: 'maxBoxes',
            label: 'Max Boxes',
            kind: 'number',
            placeholder: '100',
            step: 1,
            min: 1,
          },
          {
            key: 'normalizedCoords',
            label: 'Normalized Coords',
            kind: 'select',
            defaultValue: 'false',
            options: [
              { value: 'false', label: 'Pixel coordinates' },
              { value: 'true', label: 'Normalized (0–1)' },
            ],
            help: 'Enable when box coordinates are in [0,1] rather than pixels.',
          },
          {
            key: 'labelsPath',
            label: 'Labels File',
            kind: 'filepath',
            placeholder: 'labels.txt',
            help: 'Optional class labels file (one per line) for per-box class names.',
          },
        ],
      },
    ],
  },
  {
    type: 'segmentationMask',
    label: 'Segmentation Mask',
    icon: <MosaicIcon />,
    category: 'output',
    ports: [
      { id: 'input_data', direction: 'target', dataType: 'tensor' },
      { id: 'mask_data', direction: 'source', dataType: 'image' },
    ],
    configSections: [
      {
        title: 'SEGMENTATION',
        fields: [
          {
            key: 'width',
            label: 'Width',
            kind: 'number',
            placeholder: '224',
            step: 1,
            min: 1,
            help: 'Spatial width of the per-pixel logits tensor.',
          },
          {
            key: 'height',
            label: 'Height',
            kind: 'number',
            placeholder: '224',
            step: 1,
            min: 1,
            help: 'Spatial height of the per-pixel logits tensor.',
          },
        ],
      },
    ],
  },
  {
    type: 'composite',
    label: 'Composite',
    icon: <LayersIcon />,
    category: 'output',
    ports: [
      { id: 'foreground', direction: 'target', dataType: 'image' },
      { id: 'background', direction: 'target', dataType: 'image' },
      { id: 'output_data', direction: 'source', dataType: 'image' },
    ],
    configSections: [
      {
        title: 'BLEND',
        fields: [
          {
            key: 'opacity',
            label: 'Opacity',
            kind: 'number',
            placeholder: '0.5',
            step: 0.05,
            min: 0,
            max: 1,
            help: 'Foreground opacity (0 = only background, 1 = only foreground).',
          },
        ],
      },
    ],
  },
  {
    type: 'condition',
    label: 'Condition',
    icon: <BranchIcon />,
    category: 'control',
    ports: [
      { id: 'input_data', direction: 'target', dataType: 'tensor' },
      { id: 'true_branch', direction: 'source', dataType: 'branch' },
      { id: 'false_branch', direction: 'source', dataType: 'branch' },
    ],
    configSections: [
      {
        title: 'CONDITION',
        fields: [
          {
            key: 'expression',
            label: 'Expression',
            kind: 'text',
            placeholder: 'max > 0.5',
            help: 'Form: <selector> <op> <number>. Selectors: max, min, mean, sum, first, [i]. Ops: > < >= <= == !=. A bare number (e.g. "0.5") is treated as "first > 0.5" for back-compat.',
          },
        ],
      },
    ],
  },
  {
    type: 'output',
    label: 'Output',
    icon: <OutputIcon />,
    category: 'output',
    ports: [{ id: 'data', direction: 'target', dataType: 'generic' }],
  },
  {
    type: 'debug',
    label: 'Inspect',
    icon: <InspectIcon />,
    category: 'debug',
    ports: [
      { id: 'data_in', direction: 'target', dataType: 'generic' },
      { id: 'data_out', direction: 'source', dataType: 'generic' },
    ],
  },
];

/** Index for O(1) lookup by type. */
export const NODE_MANIFEST_BY_TYPE: Record<string, NodeManifestEntry> = Object.fromEntries(
  NODE_MANIFEST.map((e) => [e.type, e]),
);

export function getManifestEntry(type: string | undefined): NodeManifestEntry | undefined {
  return type ? NODE_MANIFEST_BY_TYPE[type] : undefined;
}
