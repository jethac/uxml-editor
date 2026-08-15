import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createProductionTauriRuntime } from './app/createProductionTauriRuntime';
import { createRuntimeEditorStore } from './app/createRuntimeEditorStore';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element was not found');
}

const runtime = createProductionTauriRuntime();
const store = createRuntimeEditorStore({ tauriHost: runtime?.host });

createRoot(root).render(
  <StrictMode>
    <App store={store} desktop={runtime?.desktop} />
  </StrictMode>,
);
