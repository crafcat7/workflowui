import { useEffect } from 'react';
import { useWorkflowStore, generateNodeId } from '../store/workflowStore';

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      const activeEl = document.activeElement;

      // Ignore if user is typing in an input
      if (
        activeEl?.tagName === 'INPUT' ||
        activeEl?.tagName === 'TEXTAREA' ||
        activeEl?.tagName === 'SELECT'
      ) {
        return;
      }

      if (!cmdOrCtrl) return;

      // Undo
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useWorkflowStore.temporal.getState().undo();
      }
      
      // Redo
      if ((e.shiftKey && e.key === 'z') || e.key === 'y') {
        e.preventDefault();
        useWorkflowStore.temporal.getState().redo();
      }

      // Copy
      if (e.key === 'c') {
        const state = useWorkflowStore.getState();
        if (state.selectedNodeId) {
          const node = state.nodes.find((n) => n.id === state.selectedNodeId);
          if (node) {
            navigator.clipboard.writeText(JSON.stringify({ type: 'workflow_node', node }));
          }
        }
      }

      // Paste
      if (e.key === 'v') {
        navigator.clipboard.readText().then((text) => {
          try {
            const data = JSON.parse(text);
            if (data.type === 'workflow_node' && data.node) {
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
              
              // Deselect current node
              if (state.selectedNodeId) {
                state.updateNodeData(state.selectedNodeId, { selected: false });
              }
              
              state.addNode(newNode);
              state.setSelectedNode(newNode.id);
            }
          } catch (err) {
            // Not our JSON, ignore
          }
        }).catch(() => { /* ignore clipboard errors */ });
      }

      // Delete (Backspace / Delete)
      // Note: React Flow handles Backspace/Delete natively by default, but it's good to be safe.
      // Actually React Flow handles it for selected nodes if we use their default shortcuts.
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
