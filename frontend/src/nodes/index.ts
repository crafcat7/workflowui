import type { NodeTypes } from '@xyflow/react';
import { InputImageNode } from './InputImageNode';
import { InputTensorNode } from './InputTensorNode';
import { CreateNetNode } from './CreateNetNode';
import { InferenceNode } from './InferenceNode';
import { BenchmarkNode } from './BenchmarkNode';
import { SaveTextNode } from './SaveTextNode';
import { ConditionNode } from './ConditionNode';
import { OutputNode } from './OutputNode';
import { DebugNode } from './DebugNode';

export const nodeTypes: NodeTypes = {
  inputImage: InputImageNode,
  inputTensor: InputTensorNode,
  createNet: CreateNetNode,
  inference: InferenceNode,
  benchmark: BenchmarkNode,
  saveText: SaveTextNode,
  condition: ConditionNode,
  output: OutputNode,
  debug: DebugNode,
};

export interface NodeTypeInfo {
  type: string;
  label: string;
  icon: string;
  category: 'input' | 'inference' | 'output' | 'control' | 'debug';
}

export const nodeTypeList: NodeTypeInfo[] = [
  { type: 'inputImage', label: 'Input Image', icon: '🖼', category: 'input' },
  { type: 'inputTensor', label: 'Input Tensor', icon: '📊', category: 'input' },
  { type: 'createNet', label: 'Create Net', icon: '🧠', category: 'inference' },
  { type: 'inference', label: 'Inference', icon: '⚡', category: 'inference' },
  { type: 'benchmark', label: 'Benchmark', icon: '📈', category: 'inference' },
  { type: 'saveText', label: 'Save Text', icon: '💾', category: 'output' },
  { type: 'condition', label: 'Condition', icon: '🔀', category: 'control' },
  { type: 'output', label: 'Output', icon: '📤', category: 'output' },
  { type: 'debug', label: 'Breakpoint', icon: '🔴', category: 'debug' },
];
