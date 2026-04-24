import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { wsClient } from './transport/WsClient.ts'
import { initWorkflowRunner } from './engine/WorkflowRunner.ts'

// Initialize backend connection
wsClient.connect().catch(() => {
  console.warn('Backend not available, running in offline mode');
});

// Setup notification handlers
initWorkflowRunner();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
