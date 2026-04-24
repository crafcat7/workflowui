// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
/**
 * Global keyboard shortcuts.
 *
 * Shortcuts only fire when focus is NOT inside an editable surface
 * (input/textarea/select/contentEditable). Chord shortcuts (Cmd+X) are
 * allowed even in inputs only when we explicitly opt in below (undo/redo
 * stay global so users can undo from within a properties field; save/open
 * also stay global to match typical editor expectations).
 *
 * Shortcut set (implemented):
 *   Undo/Redo   : Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Cmd/Ctrl+Y
 *   Copy/Paste  : Cmd/Ctrl+C, Cmd/Ctrl+V  (legacy JSON clipboard flow)
 *   Save/Open   : Cmd/Ctrl+S, Cmd/Ctrl+O
 *   Select All  : Cmd/Ctrl+A
 *   Duplicate   : Cmd/Ctrl+D
 *   Deselect    : Esc
 *   Fit View    : F
 *   Run/Resume  : R
 *   Breakpoint  : B  (toggle on selected node)
 *   Delete      : Delete / Backspace is already handled natively by React Flow.
 */

import { useEffect } from 'react';
import {
  useWorkflowStore,
  generateNodeId,
} from '../store/workflowStore';
import type { WorkflowActions } from './useWorkflowActions';

export interface KeyboardShortcutDeps {
  actions: WorkflowActions;
  /** React Flow's fitView — if absent (provider not mounted yet) 'F' is a no-op. */
  fitView?: () => void;
}

function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

export function useKeyboardShortcuts(deps: KeyboardShortcutDeps) {
  const { actions, fitView } = deps;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const cmd = isMac ? e.metaKey : e.ctrlKey;
      const editable = isEditableTarget(document.activeElement);

      // ── Chord shortcuts ──────────────────────────────────────────────
      if (cmd) {
        // Undo / Redo (allowed in editable fields too — standard behavior)
        if (e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          useWorkflowStore.temporal.getState().undo();
          return;
        }
        if ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key === 'y') {
          e.preventDefault();
          useWorkflowStore.temporal.getState().redo();
          return;
        }

        // Save / Open (standard editor chords — always fire)
        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          actions.save();
          return;
        }
        if (e.key.toLowerCase() === 'o') {
          e.preventDefault();
          actions.load();
          return;
        }

        // The rest of the chords should be suppressed while typing so the
        // browser's native behavior (text select, copy, paste) still works.
        if (editable) return;

        if (e.key.toLowerCase() === 'a') {
          e.preventDefault();
          actions.selectAll();
          return;
        }
        if (e.key.toLowerCase() === 'd') {
          e.preventDefault();
          actions.duplicateSelected();
          return;
        }
        if (e.key.toLowerCase() === 'c') {
          handleLegacyCopy();
          return;
        }
        if (e.key.toLowerCase() === 'v') {
          handleLegacyPaste();
          return;
        }
        return;
      }

      // ── Single-key shortcuts (suppressed while typing) ───────────────
      if (editable) return;

      if (e.key === 'Escape') {
        actions.deselect();
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        fitView?.();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        void actions.run();
        return;
      }
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        actions.toggleBreakpointOnSelected();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actions, fitView]);
}

// ── Legacy clipboard copy/paste helpers (preserved from previous impl) ──
// These survive mostly for backwards compatibility; duplicateSelected is
// the preferred path and does not depend on clipboard permissions.

function handleLegacyCopy() {
  const state = useWorkflowStore.getState();
  if (!state.selectedNodeId) return;
  const node = state.nodes.find((n) => n.id === state.selectedNodeId);
  if (!node) return;
  void navigator.clipboard
    .writeText(JSON.stringify({ type: 'workflow_node', node }))
    .catch(() => {
      /* clipboard permission denied; silently ignore */
    });
}

function handleLegacyPaste() {
  navigator.clipboard
    .readText()
    .then((text) => {
      try {
        const data = JSON.parse(text);
        if (data.type !== 'workflow_node' || !data.node) return;
        const state = useWorkflowStore.getState();
        const newNode = {
          ...data.node,
          id: generateNodeId(),
          position: {
            x: data.node.position.x + 50,
            y: data.node.position.y + 50,
          },
          selected: true,
        };
        if (state.selectedNodeId) {
          state.updateNodeData(state.selectedNodeId, { selected: false });
        }
        state.addNode(newNode);
        state.setSelectedNode(newNode.id);
      } catch {
        /* not our JSON, ignore */
      }
    })
    .catch(() => {
      /* clipboard permission denied; silently ignore */
    });
}
