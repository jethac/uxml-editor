import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createBrowserEditorStore } from './app/createBrowserEditorStore';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element was not found');
}

const store = createBrowserEditorStore();

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
