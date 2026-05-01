// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import type { ReactNode } from 'react';
import type { NodeTypes } from '@xyflow/react';
import { InputImageNode } from './InputImageNode';
import { InputTensorNode } from './InputTensorNode';
import { CreateNetNode } from './CreateNetNode';
import { InferenceNode } from './InferenceNode';
import { BenchmarkNode } from './BenchmarkNode';
import { SaveTextNode } from './SaveTextNode';
import { SaveImageNode } from './SaveImageNode';
import { ConditionNode } from './ConditionNode';
import { PostprocessNode } from './PostprocessNode';
import { OutputNode } from './OutputNode';
import { DebugNode } from './DebugNode';
import { TensorToImageNode } from './TensorToImageNode';
import { AnnotateImageNode } from './AnnotateImageNode';
import { DrawBoxesNode } from './DrawBoxesNode';
import { SegmentationMaskNode } from './SegmentationMaskNode';
import { CompositeNode } from './CompositeNode';
import { NODE_MANIFEST, type NodeCategoryKey } from './manifest';

export const nodeTypes: NodeTypes = {
  inputImage: InputImageNode,
  inputTensor: InputTensorNode,
  createNet: CreateNetNode,
  inference: InferenceNode,
  benchmark: BenchmarkNode,
  saveText: SaveTextNode,
  saveImage: SaveImageNode,
  condition: ConditionNode,
  postprocess: PostprocessNode,
  output: OutputNode,
  debug: DebugNode,
  tensorToImage: TensorToImageNode,
  annotateImage: AnnotateImageNode,
  drawBoxes: DrawBoxesNode,
  segmentationMask: SegmentationMaskNode,
  composite: CompositeNode,
};

export interface NodeTypeInfo {
  type: string;
  label: string;
  icon: ReactNode;
  category: NodeCategoryKey;
}

// Derived from the manifest so drift is impossible.
export const nodeTypeList: NodeTypeInfo[] = NODE_MANIFEST.map((e) => ({
  type: e.type,
  label: e.label,
  icon: e.icon,
  category: e.category,
}));
