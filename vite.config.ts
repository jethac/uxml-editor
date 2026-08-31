import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { previewEngineAlias } from './vendor/uxml-preview/alias.ts';

const vendorChunks: readonly (readonly [string, string])[] = [
  ['vendor/uxml-preview/src/', 'preview-engine'],
  ['node_modules/yoga-layout/', 'preview-engine'],
  ['node_modules/@codemirror/', 'code-editor'],
  ['node_modules/@lezer/', 'code-editor'],
  ['node_modules/react-dom/', 'react'],
  ['node_modules/react/', 'react'],
];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: previewEngineAlias() },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll('\\', '/');
          return vendorChunks.find(([prefix]) => normalized.includes(prefix))?.[1];
        },
      },
    },
  },
});
