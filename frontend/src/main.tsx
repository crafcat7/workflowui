// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WorkflowUI contributors
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { wsClient } from './transport/WsClient.ts';
import { initWorkflowRunner } from './engine/WorkflowRunner.ts';
import { logWarn } from './utils/logger.ts';

// Initialize backend connection
wsClient.connect().catch(() => {
  logWarn('Backend not available, running in offline mode');
});

// Setup notification handlers
initWorkflowRunner();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
