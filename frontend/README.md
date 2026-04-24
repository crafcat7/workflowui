# frontend/

React 19 + Vite 8 + TypeScript 6 graph editor for WorkflowUI.

For project-wide docs — architecture, build, test, node types, debugging,
cross-compile matrix — see the [root README](../README.md)
([中文](../README.zh-CN.md)).

## Scripts

```bash
npm install
npm run dev          # Vite dev server on :5173
npm run build        # tsc -b && vite build
npm run test:unit    # Vitest (jsdom)
npm run test:e2e     # Playwright against mock backend
```
