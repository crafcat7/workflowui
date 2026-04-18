import { useState, useEffect } from 'react';
import { useWorkflowStore, type WorkflowNodeData } from '../store/workflowStore';
import { wsClient } from '../transport/WsClient';

/* ── Vendor config schema types (mirrors backend ConfigFieldSchema) ── */
interface ConfigFieldDef {
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
  fields: ConfigFieldDef[];
}

/* ── Cached schema so we only fetch once per session ── */
let cachedSchema: VendorSchema | null = null;
let schemaPromise: Promise<VendorSchema> | null = null;

function fetchVendorSchema(): Promise<VendorSchema> {
  if (cachedSchema) return Promise.resolve(cachedSchema);
  if (schemaPromise) return schemaPromise;
  schemaPromise = wsClient
    .call<VendorSchema>('vendor.getConfigSchema')
    .then((s) => {
      cachedSchema = s;
      return s;
    })
    .catch(() => {
      // Fallback when backend is offline — show nothing special
      const fallback: VendorSchema = { vendor: 'unknown', fields: [] };
      cachedSchema = fallback;
      return fallback;
    });
  return schemaPromise;
}

/* ── Hook: use vendor schema ── */
function useVendorSchema() {
  const [schema, setSchema] = useState<VendorSchema | null>(cachedSchema);

  useEffect(() => {
    if (cachedSchema) {
      setSchema(cachedSchema);
      return;
    }
    fetchVendorSchema().then(setSchema);
  }, []);

  return schema;
}

/* ── Main Panel ── */
export function PropertiesPanel() {
  const { nodes, selectedNodeId, updateNodeData } = useWorkflowStore();
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

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

function PropertiesContent({ node, onUpdate }: { node: { id: string; type?: string; data: Record<string, unknown> }; onUpdate: (id: string, data: Partial<WorkflowNodeData>) => void }) {
  const data = node.data as unknown as WorkflowNodeData;

  const handleConfigChange = (key: string, value: string) => {
    onUpdate(node.id, {
      config: { ...(data.config || {}), [key]: value },
    });
  };

  return (
    <>
      {/* Node identity */}
      <div className="props-node-header">
        <div className="props-node-label">{data.label}</div>
        <div className="props-node-id">{node.id}</div>
      </div>

      {/* Status */}
      <div className="props-status-row">
        <span className="props-status-label">STATUS</span>
        <span className={`props-status-badge ${data.status}`}>{data.status.toUpperCase()}</span>
      </div>
      {data.elapsedMs !== undefined && (
        <div className="props-elapsed">
          Elapsed: {data.elapsedMs.toFixed(1)}ms
        </div>
      )}

      <div className="props-divider" />

      {/* Input Image */}
      {node.type === 'inputImage' && (
        <ConfigSection title="IMAGE SOURCE">
          <ConfigField label="File Path" configKey="filePath" config={data.config} onChange={handleConfigChange} placeholder="/path/to/image.jpg" />
        </ConfigSection>
      )}

      {/* Input Tensor */}
      {node.type === 'inputTensor' && (
        <ConfigSection title="TENSOR DATA">
          <div className="config-field">
            <label>Mode</label>
            <select
              className="config-select"
              value={(data.config.fillMode as string) || 'manual'}
              onChange={(e) => handleConfigChange('fillMode', e.target.value)}
            >
              <option value="manual">Manual Text</option>
              <option value="auto">Auto Fill (Fixed Value)</option>
            </select>
          </div>

          {(data.config.fillMode === 'auto') ? (
            <>
              <ConfigField label="Shape (e.g. 3, 224, 224)" configKey="shape" config={data.config} onChange={handleConfigChange} placeholder="3, 224, 224" />
              <ConfigField label="Fill Value (e.g. 0.0)" configKey="fillValue" config={data.config} onChange={handleConfigChange} placeholder="0.0" />
            </>
          ) : (
            <ConfigField label="Tensor Text" configKey="tensorText" config={data.config} onChange={handleConfigChange} placeholder="comma-separated values" />
          )}
        </ConfigSection>
      )}

      {/* CreateNet - Dynamic vendor config */}
      {node.type === 'createNet' && (
        <VendorConfigPanel config={data.config} onChange={handleConfigChange} />
      )}

      {/* SaveText */}
      {node.type === 'saveText' && (
        <ConfigSection title="OUTPUT FILE">
          <ConfigField label="File Path" configKey="filePath" config={data.config} onChange={handleConfigChange} placeholder="output.txt" />
        </ConfigSection>
      )}

      {/* Condition */}
      {node.type === 'condition' && (
        <ConfigSection title="CONDITION">
          <ConfigField label="Expression (threshold)" configKey="expression" config={data.config} onChange={handleConfigChange} placeholder="> 0.5" />
        </ConfigSection>
      )}

      {/* Benchmark */}
      {node.type === 'benchmark' && (
        <ConfigSection title="BENCHMARK OPTIONS">
          <ConfigField label="Duration (sec)" configKey="duration" config={data.config} onChange={handleConfigChange} placeholder="10" />
          <div className="props-info-text" style={{ marginTop: '8px', fontSize: '11px', color: '#6080a0' }}>
            Runs inference repeatedly for the specified duration (default 10s).
          </div>
        </ConfigSection>
      )}

      {/* Postprocess */}
      {node.type === 'postprocess' && (
        <ConfigSection title="POSTPROCESS OPTIONS">
          <div className="config-field">
            <label>Operation</label>
            <select
              className="config-select"
              value={(data.config?.op as string) || 'nms'}
              onChange={(e) => handleConfigChange('op', e.target.value)}
            >
              <option value="nms">Non-Maximum Suppression (NMS)</option>
              <option value="topk">Top-K</option>
            </select>
          </div>

          {(data.config?.op === 'nms' || !data.config?.op) && (
            <ConfigField label="IoU Threshold" configKey="iouThreshold" config={data.config || {}} onChange={handleConfigChange} placeholder="0.45" />
          )}
          {data.config?.op === 'topk' && (
            <ConfigField label="K Value" configKey="k" config={data.config || {}} onChange={handleConfigChange} placeholder="1" />
          )}
        </ConfigSection>
      )}

      {/* Output Node - bar chart preview */}
      {node.type === 'output' && data.output !== undefined && (
        <>
          <div className="props-divider" />
          <ConfigSection title="OUTPUT PREVIEW">
            <OutputBarChart output={data.output} />
          </ConfigSection>
        </>
      )}
    </>
  );
}

/* ── Dynamic vendor config for CreateNet ── */
function VendorConfigPanel({ config, onChange }: { config: Record<string, unknown>; onChange: (key: string, value: string) => void }) {
  const schema = useVendorSchema();

  if (!schema || schema.fields.length === 0) {
    // Fallback: show hardcoded NCNN fields when schema unavailable
    return <FallbackNcnnConfig config={config} onChange={onChange} />;
  }

  // Group fields by group name, preserving order
  const groups: { name: string; fields: ConfigFieldDef[] }[] = [];
  const groupMap = new Map<string, ConfigFieldDef[]>();
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
          {/* If all fields in group are dimension-like (W/H/C), render in a row */}
          {g.name === 'INPUT DIMENSIONS' ? (
            <div className="config-row-3">
              {g.fields.map((f) => (
                <DynamicField key={f.key} field={f} config={config} onChange={onChange} />
              ))}
            </div>
          ) : (
            g.fields.map((f) => (
              <DynamicField key={f.key} field={f} config={config} onChange={onChange} />
            ))
          )}
        </ConfigSection>
      ))}
    </>
  );
}

/* ── Renders a single field based on its schema type ── */
function DynamicField({ field, config, onChange }: { field: ConfigFieldDef; config: Record<string, unknown>; onChange: (key: string, value: string) => void }) {
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
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  // string, int, float — all render as text input
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

/* ── Fallback when vendor schema is not available ── */
function FallbackNcnnConfig({ config, onChange }: { config: Record<string, unknown>; onChange: (key: string, value: string) => void }) {
  return (
    <>
      <ConfigSection title="MODEL">
        <ConfigField label="Param Path (.param)" configKey="paramPath" config={config} onChange={onChange} placeholder="model.param" />
        <ConfigField label="Model Path (.bin)" configKey="modelPath" config={config} onChange={onChange} placeholder="model.bin" />
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
        <ConfigField label="Input Name" configKey="inputName" config={config} onChange={onChange} placeholder="data" />
        <ConfigField label="Output Name" configKey="outputName" config={config} onChange={onChange} placeholder="output" />
      </ConfigSection>
      <ConfigSection title="INPUT DIMENSIONS">
        <div className="config-row-3">
          <ConfigField label="W" configKey="inputW" config={config} onChange={onChange} placeholder="224" />
          <ConfigField label="H" configKey="inputH" config={config} onChange={onChange} placeholder="224" />
          <ConfigField label="C" configKey="inputC" config={config} onChange={onChange} placeholder="3" />
        </div>
      </ConfigSection>
      <ConfigSection title="RUNTIME">
        <ConfigField label="Threads" configKey="numThreads" config={config} onChange={onChange} placeholder="2" />
      </ConfigSection>
    </>
  );
}

function ConfigSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="config-section">
      <div className="config-section-title">{title}</div>
      {children}
    </div>
  );
}

function ConfigField({
  label,
  configKey,
  config,
  onChange,
  placeholder,
}: {
  label: string;
  configKey: string;
  config: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="config-field">
      <label>{label}</label>
      <input
        type="text"
        value={(config[configKey] as string) || ''}
        onChange={(e) => onChange(configKey, e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

/** SVG bar chart for output distribution */
function OutputBarChart({ output }: { output: unknown }) {
  if (!Array.isArray(output) || output.length === 0) {
    return <div className="props-empty">No numeric data</div>;
  }

  const values = output as number[];
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const range = maxVal - minVal || 1;

  // For large arrays, downsample to ~100 bars
  const maxBars = 100;
  const step = Math.max(1, Math.floor(values.length / maxBars));
  const sampled: { idx: number; val: number }[] = [];
  for (let i = 0; i < values.length; i += step) {
    sampled.push({ idx: i, val: values[i] });
  }

  const chartWidth = 240;
  const chartHeight = 80;
  const barWidth = Math.max(1, chartWidth / sampled.length - 0.5);

  // Find top-5 values
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
        <div className="chart-stat">Range: [{minVal.toFixed(4)}, {maxVal.toFixed(4)}]</div>
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
