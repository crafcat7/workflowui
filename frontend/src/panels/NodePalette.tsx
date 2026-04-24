// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { useMemo, useState } from 'react';
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

/**
 * Case-insensitive substring match across the two fields a user
 * would plausibly type: the display label and the internal type id.
 * We deliberately do not match against `category` — the category is
 * already surfaced as a group heading, and including it would make
 * e.g. typing "math" return every node in the math category instead
 * of the ones with "math" in their name.
 */
function matchesQuery(nt: NodeTypeInfo, q: string): boolean {
  const needle = q.toLowerCase();
  return nt.label.toLowerCase().includes(needle) || nt.type.toLowerCase().includes(needle);
}

export function NodePalette() {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Filter first, then group. A category with zero matches is
  // omitted entirely (see the `return null` below), which lets the
  // user eyeball relevance at a glance. When the query is blank
  // this short-circuits to the full list without allocating.
  const visible = useMemo<NodeTypeInfo[]>(() => {
    const q = query.trim();
    if (!q) return nodeTypeList;
    return nodeTypeList.filter((nt) => matchesQuery(nt, q));
  }, [query]);

  const grouped = useMemo(() => groupByCategory(visible), [visible]);

  // When a search is active, force every surviving category open.
  // Otherwise a user who collapsed "Math" and then types "add" sees
  // an empty palette and assumes their query didn't match anything.
  // We do NOT mutate `collapsed` here — only override at render
  // time, so collapse state is preserved when the query clears.
  const isSearching = query.trim().length > 0;

  const onDragStart = (e: React.DragEvent, nodeType: string, label: string) => {
    e.dataTransfer.setData('application/reactflow-type', nodeType);
    e.dataTransfer.setData('application/reactflow-label', label);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="node-palette">
      <div className="palette-title">NODES</div>
      <div className="palette-search">
        <input
          type="text"
          className="palette-search-input"
          placeholder="Search nodes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Esc clears the filter — matches the idiom in most IDE
          // command palettes and keeps keyboard flow intact.
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          aria-label="Search nodes"
        />
      </div>
      {isSearching && visible.length === 0 && (
        <div className="palette-empty">No nodes match &ldquo;{query}&rdquo;</div>
      )}
      {categoryOrder.map((key) => {
        const items = grouped[key];
        if (!items || items.length === 0) return null;
        const visual = CATEGORY_VISUALS[key];
        const isCollapsed = !isSearching && (collapsed[key] ?? false);
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
