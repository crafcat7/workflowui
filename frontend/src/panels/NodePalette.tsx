// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { useState } from 'react';
import { nodeTypeList, type NodeTypeInfo } from '../nodes';
import { CATEGORY_VISUALS, type NodeCategoryKey } from '../nodes/manifest';

// Render categories in the order they appear in CATEGORY_VISUALS
// (which is also the manifest's declared category order).
const categoryOrder = Object.keys(CATEGORY_VISUALS) as NodeCategoryKey[];

function groupByCategory(list: NodeTypeInfo[]) {
  const groups: Partial<Record<NodeCategoryKey, NodeTypeInfo[]>> = {};
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
      {categoryOrder.map((key) => {
        const items = grouped[key];
        if (!items || items.length === 0) return null;
        const visual = CATEGORY_VISUALS[key];
        const isCollapsed = collapsed[key] ?? false;
        return (
          <div className="palette-category" key={key}>
            <div
              className="palette-category-header"
              onClick={() => setCollapsed((s) => ({ ...s, [key]: !isCollapsed }))}
            >
              <span className="palette-cat-indicator" style={{ background: visual.color }} />
              <span className="palette-cat-label">{visual.label}</span>
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
