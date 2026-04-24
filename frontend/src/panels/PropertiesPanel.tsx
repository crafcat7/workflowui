// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * PropertiesPanel - shows editable config for the currently selected node.
 *
 * Rendering is driven by the NODE_SCHEMAS registry (see
 * `nodes/configSchemas.ts`); the giant `node.type === 'X' && ...` chain has
 * been replaced with a generic SchemaRenderer that interprets each node
 * type's declared sections. Node types that declare `vendorSchema: true`
 * (currently only `createNet`) still fetch their field list from the
 * backend via `vendor.getConfigSchema`. Unknown node types fall back to a
 * raw key/value editor so they remain usable even without a registered
 * schema.
 */

import { useState, useEffect } from 'react';
import { useWorkflowStore, type WorkflowNodeData } from '../store/workflowStore';
import { useDebugStore } from '../store/debugStore';
import { wsClient } from '../transport/WsClient';
import {
  NODE_SCHEMAS,
  type ConfigField,
  type ConfigSection as ConfigSectionDef,
} from '../nodes/configSchemas';

// ---------------------------------------------------------------------------
// Vendor schema (backend-provided fields for createNet)
// ---------------------------------------------------------------------------

interface VendorFieldDef {
  key: string;
  label: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'select';
  group: string;
  placeholder?: string;
  default?: string;
  options?: string[];
}

interface VendorSchema {
  vendor: string;
  fields: VendorFieldDef[];
}

let cachedSchema: VendorSchema | null = null;
let schemaPromise: Promise<VendorSchema> | null = null;
// Monotonic token incremented on every cache invalidation. An
// in-flight fetch captures the token at launch and refuses to
// populate the cache (or resolve subscribers with its value) if the
// token has advanced by the time its response lands — otherwise a
// pre-reconnect response race-wins against the post-reconnect one
// and the user ends up staring at a stale schema.
let schemaEpoch = 0;

// Subscribers that need to refetch after the cache is invalidated on
// a WS reconnect. Each mounted `useVendorSchema` hook registers a
// listener here and deregisters on unmount. Plain Set (no React
// context) because the cache itself is module-scoped — any component
// tree that imports this module shares the invalidation.
const schemaSubscribers = new Set<() => void>();

function invalidateVendorSchemaCache() {
  schemaEpoch += 1;
  cachedSchema = null;
  schemaPromise = null;
  // Copy before iterating: a subscriber may unmount (and thus
  // deregister) synchronously in response to the fire, which would
  // mutate the Set mid-iteration on some engines.
  for (const fn of Array.from(schemaSubscribers)) fn();
}

// Wire once at module load. The backend may have been upgraded while
// we were offline (new ncnn version → new fields, renamed groups),
// so on reconnect we must treat any prior schema as stale. Using the
// transport-level reconnect hook is cheaper than polling and doesn't
// require every PropertiesPanel instance to own its own listener.
wsClient.onReconnect(() => {
  invalidateVendorSchemaCache();
});

function fetchVendorSchema(): Promise<VendorSchema> {
  if (cachedSchema) return Promise.resolve(cachedSchema);
  if (schemaPromise) return schemaPromise;
  const launchedAt = schemaEpoch;
  schemaPromise = wsClient
    .call<VendorSchema>('vendor.getConfigSchema')
    .then((s): VendorSchema => {
      // If the cache was invalidated while this call was in flight,
      // the response is stale: a newer fetch is either in progress
      // or has already populated the cache. Resolve to whatever the
      // current cached value is (falling back to the stale result as
      // a last resort so we never reject the promise chain).
      if (launchedAt !== schemaEpoch) {
        return cachedSchema ?? s;
      }
      cachedSchema = s;
      return s;
    })
    .catch((): VendorSchema => {
      const fallback: VendorSchema = { vendor: 'unknown', fields: [] };
      if (launchedAt === schemaEpoch) cachedSchema = fallback;
      return fallback;
    });
  return schemaPromise;
}

function useVendorSchema() {
  const [schema, setSchema] = useState<VendorSchema | null>(cachedSchema);
  useEffect(() => {
    let cancelled = false;
    const refetch = () => {
      // Clear the displayed schema first so the vendor panel falls back
      // to its skeleton while the new fetch is in flight; otherwise the
      // user sees stale fields for a tick after reconnect.
      if (!cancelled) setSchema(null);
      fetchVendorSchema().then((s) => {
        if (!cancelled) setSchema(s);
      });
    };
    schemaSubscribers.add(refetch);

    if (cachedSchema) {
      setSchema(cachedSchema);
    } else {
      fetchVendorSchema().then((s) => {
        if (!cancelled) setSchema(s);
      });
    }

    return () => {
      cancelled = true;
      schemaSubscribers.delete(refetch);
    };
  }, []);
  return schema;
}

// Exposed for tests — lets the suite simulate a reconnect without
// having to spin up a real WsClient. Not part of the public surface.
export const __test_invalidateVendorSchemaCache = invalidateVendorSchemaCache;

// ---------------------------------------------------------------------------
// Root panel
// ---------------------------------------------------------------------------

export function PropertiesPanel() {
  const { selectedNodeId, updateNodeData } = useWorkflowStore();
  const selectedNode = useWorkflowStore((s) =>
    selectedNodeId ? s.nodesById.get(selectedNodeId) : undefined,
  );

  return (
    <div className="properties-panel">
      <div className="props-title">PROPERTIES</div>
      <div className="props-body">
        {!selectedNode ? (
          <div className="props-empty">Select a node to view its properties</div>
        ) : (
          <PropertiesContent node={selectedNode} onUpdate={updateNodeData} />
        )}
      </div>
    </div>
  );
}

type NodeLike = { id: string; type?: string; data: Record<string, unknown> };

function PropertiesContent({
  node,
  onUpdate,
}: {
  node: NodeLike;
  onUpdate: (id: string, data: Partial<WorkflowNodeData>) => void;
}) {
  const data = node.data as unknown as WorkflowNodeData;
  const schema = node.type ? NODE_SCHEMAS[node.type] : undefined;
  const config = data.config ?? {};

  const handleConfigChange = (key: string, value: string) => {
    onUpdate(node.id, { config: { ...config, [key]: value } });
  };

  return (
    <>
      <NodeIdentity data={data} id={node.id} />
      <NodeStatusRow data={data} />
      <div className="props-divider" />

      {schema?.vendorSchema ? (
        <VendorConfigPanel config={config} onChange={handleConfigChange} />
      ) : schema?.sections ? (
        schema.sections.map((section) => (
          <SchemaSection
            key={section.title}
            section={section}
            config={config}
            onChange={handleConfigChange}
          />
        ))
      ) : (
        <GenericConfigEditor config={config} onChange={handleConfigChange} />
      )}

      {/* Output preview for terminal output node (preserves prior behaviour) */}
      {node.type === 'output' && data.output !== undefined && (
        <>
          <div className="props-divider" />
          <ConfigSection title="OUTPUT PREVIEW">
            <OutputBarChart output={data.output} />
          </ConfigSection>
        </>
      )}

      <DebugInputsPanel nodeId={node.id} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Debug inputs inspector (visible only while paused on this node)
// ---------------------------------------------------------------------------

interface PortSummary {
  type: string;
  value?: unknown;
  length?: number;
  preview?: number[];
  width?: number;
  height?: number;
  channels?: number;
  bytes?: number;
}

interface InputEntry {
  handle: string;
  source: string;
  value: PortSummary;
}

function DebugInputsPanel({ nodeId }: { nodeId: string }) {
  const pausedAt = useDebugStore((s) => s.pausedAtNodeId);
  const inspect = useDebugStore((s) => s.inspectData);
  if (pausedAt !== nodeId || !inspect) return null;
  const inputs = (inspect.inputs as InputEntry[] | undefined) ?? [];
  return (
    <>
      <div className="props-divider" />
      <ConfigSection title="DEBUG INPUTS">
        {inputs.length === 0 ? (
          <div className="props-empty" style={{ fontSize: 11 }}>
            No inbound data at this breakpoint.
          </div>
        ) : (
          inputs.map((inp) => (
            <div className="config-field" key={inp.handle}>
              <label>
                {inp.handle} <span style={{ opacity: 0.6 }}>← {inp.source}</span>
              </label>
              <PortSummaryView value={inp.value} />
            </div>
          ))
        )}
      </ConfigSection>
    </>
  );
}

function PortSummaryView({ value }: { value: PortSummary }) {
  switch (value.type) {
    case 'empty':
      return <div className="config-help">empty</div>;
    case 'string':
      return <div className="config-help">string: {String(value.value ?? '')}</div>;
    case 'float':
      return <div className="config-help">float: {String(value.value ?? '')}</div>;
    case 'handle':
      return <div className="config-help">handle #{String(value.value ?? '')}</div>;
    case 'tensor':
      return (
        <div className="config-help">
          tensor[{value.length ?? 0}] {value.preview && value.preview.length > 0 ? (
            <>≈ [{value.preview.map((v) => v.toFixed(3)).join(', ')}{(value.length ?? 0) > (value.preview?.length ?? 0) ? ', …' : ''}]</>
          ) : null}
        </div>
      );
    case 'image':
      return (
        <div className="config-help">
          image {value.width}×{value.height}×{value.channels} ({value.bytes} B)
        </div>
      );
    default:
      return <div className="config-help">{value.type}</div>;
  }
}

// ---------------------------------------------------------------------------
// Schema-driven rendering
// ---------------------------------------------------------------------------

function SchemaSection({
  section,
  config,
  onChange,
}: {
  section: ConfigSectionDef;
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
}) {
  const visibleFields = section.fields.filter((f) => !f.showIf || f.showIf(config));
  if (visibleFields.length === 0) return null;

  return (
    <ConfigSection title={section.title}>
      {section.layout === 'row-3' ? (
        <div className="config-row-3">
          {visibleFields.map((f) => (
            <FieldRenderer key={f.key} field={f} config={config} onChange={onChange} />
          ))}
        </div>
      ) : (
        visibleFields.map((f) => (
          <FieldRenderer key={f.key} field={f} config={config} onChange={onChange} />
        ))
      )}
    </ConfigSection>
  );
}

function FieldRenderer({
  field,
  config,
  onChange,
}: {
  field: ConfigField;
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
}) {
  const raw = config[field.key];
  const value = raw === undefined || raw === null ? field.defaultValue ?? '' : String(raw);

  const help = field.help ? <div className="config-help">{field.help}</div> : null;

  switch (field.kind) {
    case 'select':
      return (
        <div className="config-field">
          <label>{field.label}</label>
          <select
            className="config-select"
            value={value}
            onChange={(e) => onChange(field.key, e.target.value)}
          >
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {help}
        </div>
      );

    case 'checkbox':
      return (
        <div className="config-field">
          <label className="config-checkbox">
            <input
              type="checkbox"
              checked={value === 'true'}
              onChange={(e) => onChange(field.key, e.target.checked ? 'true' : 'false')}
            />
            <span>{field.label}</span>
          </label>
          {help}
        </div>
      );

    case 'textarea':
      return (
        <div className="config-field">
          <label>{field.label}</label>
          <textarea
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(field.key, e.target.value)}
            rows={3}
          />
          {help}
        </div>
      );

    case 'number':
      return (
        <div className="config-field">
          <label>{field.label}</label>
          <input
            type="number"
            value={value}
            placeholder={field.placeholder}
            step={field.step}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {help}
        </div>
      );

    case 'filepath':
    case 'text':
    default:
      // `filepath` is rendered as plain text today; future: add a "browse"
      // button when the desktop shell (Tauri) exposes a file dialog.
      return (
        <div className="config-field">
          <label>{field.label}</label>
          <input
            type="text"
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {help}
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Generic fallback for unknown node types
// ---------------------------------------------------------------------------

function GenericConfigEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
}) {
  const entries = Object.entries(config);
  if (entries.length === 0) {
    return (
      <div className="props-empty" style={{ fontSize: 11 }}>
        No configuration registered for this node type. Extend NODE_SCHEMAS to
        customize this editor.
      </div>
    );
  }
  return (
    <ConfigSection title="CONFIG">
      {entries.map(([k, v]) => (
        <div className="config-field" key={k}>
          <label>{k}</label>
          <input
            type="text"
            value={typeof v === 'string' ? v : JSON.stringify(v)}
            onChange={(e) => onChange(k, e.target.value)}
          />
        </div>
      ))}
    </ConfigSection>
  );
}

// ---------------------------------------------------------------------------
// Identity + status header blocks
// ---------------------------------------------------------------------------

function NodeIdentity({ data, id }: { data: WorkflowNodeData; id: string }) {
  return (
    <div className="props-node-header">
      <div className="props-node-label">{data.label}</div>
      <div className="props-node-id">{id}</div>
    </div>
  );
}

function NodeStatusRow({ data }: { data: WorkflowNodeData }) {
  // `error` is set by WorkflowRunner when a node.status update carries an
  // `error` string (runtime failures, upstream_failed, invalid_config, …)
  // and also by S1's validation_failed handler for graph-level problems.
  // The console log is the primary surface, but a user who dismissed the
  // toast and then clicks the red node deserves to see *why* right here,
  // not to have to scroll back through the console. Missing/undefined
  // means either success or a run before any error fired.
  const errorText = (data as WorkflowNodeData & { error?: string }).error;
  return (
    <>
      <div className="props-status-row">
        <span className="props-status-label">STATUS</span>
        <span className={`props-status-badge ${data.status}`}>{data.status.toUpperCase()}</span>
      </div>
      {errorText && (
        <div className="props-error" role="alert">
          {errorText}
        </div>
      )}
      {data.elapsedMs !== undefined && (
        <div className="props-elapsed">Elapsed: {data.elapsedMs.toFixed(1)}ms</div>
      )}
      {data.avgMs !== undefined && data.runsCount !== undefined && (
        <div className="props-elapsed">
          Avg: {data.avgMs.toFixed(1)}ms over {data.runsCount} runs
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Vendor (createNet) dynamic panel
// ---------------------------------------------------------------------------

function VendorConfigPanel({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
}) {
  const schema = useVendorSchema();

  if (!schema || schema.fields.length === 0) {
    return <FallbackNcnnConfig config={config} onChange={onChange} />;
  }

  // Group by field.group, preserving order of first appearance
  const groups: { name: string; fields: VendorFieldDef[] }[] = [];
  const groupMap = new Map<string, VendorFieldDef[]>();
  for (const f of schema.fields) {
    let arr = groupMap.get(f.group);
    if (!arr) {
      arr = [];
      groupMap.set(f.group, arr);
      groups.push({ name: f.group, fields: arr });
    }
    arr.push(f);
  }

  return (
    <>
      <div className="vendor-badge">
        <span className="vendor-badge-label">VENDOR</span>
        <span className="vendor-badge-name">{schema.vendor.toUpperCase()}</span>
      </div>
      {groups.map((g) => (
        <ConfigSection key={g.name} title={g.name}>
          {g.name === 'INPUT DIMENSIONS' ? (
            <div className="config-row-3">
              {g.fields.map((f) => (
                <VendorField key={f.key} field={f} config={config} onChange={onChange} />
              ))}
            </div>
          ) : (
            g.fields.map((f) => (
              <VendorField key={f.key} field={f} config={config} onChange={onChange} />
            ))
          )}
        </ConfigSection>
      ))}
    </>
  );
}

function VendorField({
  field,
  config,
  onChange,
}: {
  field: VendorFieldDef;
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
}) {
  const value = config[field.key];

  if (field.type === 'bool') {
    return (
      <div className="config-field">
        <label className="config-checkbox">
          <input
            type="checkbox"
            checked={value === 'true' || value === true}
            onChange={(e) => onChange(field.key, e.target.checked ? 'true' : 'false')}
          />
          <span>{field.label}</span>
        </label>
      </div>
    );
  }

  if (field.type === 'select' && field.options) {
    return (
      <div className="config-field">
        <label>{field.label}</label>
        <select
          value={(value as string) || field.default || ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="config-select"
        >
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="config-field">
      <label>{field.label}</label>
      <input
        type={field.type === 'int' || field.type === 'float' ? 'number' : 'text'}
        value={(value as string) || ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        placeholder={field.placeholder}
        step={field.type === 'float' ? '0.01' : undefined}
      />
    </div>
  );
}

function FallbackNcnnConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      <ConfigSection title="MODEL">
        <PlainField label="Param Path (.param)" cfgKey="paramPath" config={config} onChange={onChange} placeholder="model.param" />
        <PlainField label="Model Path (.bin)" cfgKey="modelPath" config={config} onChange={onChange} placeholder="model.bin" />
        <div className="config-field">
          <label className="config-checkbox">
            <input
              type="checkbox"
              checked={config.emptyWeights === 'true' || config.emptyWeights === true}
              onChange={(e) => onChange('emptyWeights', e.target.checked ? 'true' : 'false')}
            />
            <span>Empty Weights (zero-fill)</span>
          </label>
        </div>
      </ConfigSection>
      <ConfigSection title="I/O NAMES">
        <PlainField label="Input Name" cfgKey="inputName" config={config} onChange={onChange} placeholder="data" />
        <PlainField label="Output Name" cfgKey="outputName" config={config} onChange={onChange} placeholder="output" />
      </ConfigSection>
      <ConfigSection title="INPUT DIMENSIONS">
        <div className="config-row-3">
          <PlainField label="W" cfgKey="inputW" config={config} onChange={onChange} placeholder="224" />
          <PlainField label="H" cfgKey="inputH" config={config} onChange={onChange} placeholder="224" />
          <PlainField label="C" cfgKey="inputC" config={config} onChange={onChange} placeholder="3" />
        </div>
      </ConfigSection>
      <ConfigSection title="RUNTIME">
        <PlainField label="Threads" cfgKey="numThreads" config={config} onChange={onChange} placeholder="2" />
      </ConfigSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers reused across renderers
// ---------------------------------------------------------------------------

function ConfigSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="config-section">
      <div className="config-section-title">{title}</div>
      {children}
    </div>
  );
}

function PlainField({
  label,
  cfgKey,
  config,
  onChange,
  placeholder,
}: {
  label: string;
  cfgKey: string;
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="config-field">
      <label>{label}</label>
      <input
        type="text"
        value={(config[cfgKey] as string) || ''}
        onChange={(e) => onChange(cfgKey, e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Output distribution chart
// ---------------------------------------------------------------------------

function OutputBarChart({ output }: { output: unknown }) {
  if (!Array.isArray(output) || output.length === 0) {
    return <div className="props-empty">No numeric data</div>;
  }
  const values = output as number[];
  const numeric = values.every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!numeric) {
    return (
      <pre className="node-output-pre">{JSON.stringify(values.slice(0, 50), null, 2)}</pre>
    );
  }

  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const range = maxVal - minVal || 1;

  const maxBars = 100;
  const step = Math.max(1, Math.floor(values.length / maxBars));
  const sampled: { idx: number; val: number }[] = [];
  for (let i = 0; i < values.length; i += step) {
    sampled.push({ idx: i, val: values[i] });
  }

  const chartWidth = 240;
  const chartHeight = 80;
  const barWidth = Math.max(1, chartWidth / sampled.length - 0.5);

  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => b.v - a.v);
  const top5 = indexed.slice(0, 5);

  return (
    <div className="output-chart">
      <svg width={chartWidth} height={chartHeight} className="output-chart-svg">
        {sampled.map((s, i) => {
          const h = ((s.val - minVal) / range) * (chartHeight - 4);
          const x = (i / sampled.length) * chartWidth;
          return (
            <rect
              key={i}
              x={x}
              y={chartHeight - h - 2}
              width={barWidth}
              height={Math.max(1, h)}
              className="chart-bar"
            />
          );
        })}
      </svg>
      <div className="output-chart-info">
        <div className="chart-stat">Total: {values.length} values</div>
        <div className="chart-stat">
          Range: [{minVal.toFixed(4)}, {maxVal.toFixed(4)}]
        </div>
      </div>
      <div className="output-top-k">
        <div className="top-k-title">TOP 5</div>
        {top5.map((t, i) => (
          <div key={i} className="top-k-row">
            <span className="top-k-idx">[{t.i}]</span>
            <span className="top-k-val">{t.v.toFixed(6)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
