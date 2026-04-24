// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Per-node-type configuration schemas for the Properties panel.
 *
 * Schema *shapes* (ConfigField / ConfigSection / NodeTypeSchema) are
 * declared here so both this file and `manifest.ts` can reference them
 * without a circular runtime import. The actual per-node entries live
 * in `manifest.ts`; `NODE_SCHEMAS` below is a derived projection that
 * existing imports (PropertiesPanel, tests) continue to consume
 * unchanged.
 *
 * Adding a new node type: add one entry to `NODE_MANIFEST` in
 * `manifest.ts`. Nothing else.
 */

import { NODE_MANIFEST } from './manifest';

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

export const NODE_SCHEMAS: Record<string, NodeTypeSchema> = (() => {
  const out: Record<string, NodeTypeSchema> = {};
  for (const e of NODE_MANIFEST) {
    if (e.vendorSchema) {
      out[e.type] = { vendorSchema: true };
    } else if (e.configSections) {
      out[e.type] = { sections: e.configSections };
    }
  }
  return out;
})();
