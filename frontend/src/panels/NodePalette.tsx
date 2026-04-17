import { useState } from 'react';
import { nodeTypeList, type NodeTypeInfo } from '../nodes';

const categories = [
  { key: 'input', label: 'INPUT', color: '#2a9d8f' },
  { key: 'inference', label: 'INFERENCE', color: '#9b59b6' },
  { key: 'output', label: 'OUTPUT', color: '#2ecc71' },
  { key: 'control', label: 'CONTROL', color: '#6080c0' },
  { key: 'debug', label: 'DEBUG', color: '#e0c080' },
] as const;

function groupByCategory(list: NodeTypeInfo[]) {
  const groups: Record<string, NodeTypeInfo[]> = {};
  for (const nt of list) {
    (groups[nt.category] ??= []).push(nt);
  }
  return groups;
}

export function NodePalette() {
  const grouped = groupByCategory(nodeTypeList);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const onDragStart = (e: React.DragEvent, nodeType: string, label: string) => {
    e.dataTransfer.setData('application/reactflow-type', nodeType);
    e.dataTransfer.setData('application/reactflow-label', label);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="node-palette">
      <div className="palette-title">NODES</div>
      {categories.map((cat) => {
        const items = grouped[cat.key];
        if (!items) return null;
        const isCollapsed = collapsed[cat.key] ?? false;
        return (
          <div className="palette-category" key={cat.key}>
            <div
              className="palette-category-header"
              onClick={() => setCollapsed((s) => ({ ...s, [cat.key]: !isCollapsed }))}
            >
              <span className="palette-cat-indicator" style={{ background: cat.color }} />
              <span className="palette-cat-label">{cat.label}</span>
              <span className="palette-cat-toggle">{isCollapsed ? '+' : '-'}</span>
            </div>
            {!isCollapsed && (
              <div className="palette-items">
                {items.map((nt) => (
                  <div
                    key={nt.type}
                    className={`palette-node-card cat-${nt.category}`}
                    draggable
                    onDragStart={(e) => onDragStart(e, nt.type, nt.label)}
                    title={`Drag to add ${nt.label}`}
                  >
                    <span className="palette-node-icon">{nt.icon}</span>
                    <span className="palette-node-label">{nt.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
