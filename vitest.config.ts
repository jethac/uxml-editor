import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { previewEngineAlias } from './vendor/uxml-preview/alias.ts';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: previewEngineAlias() },
  test: {
    environment: 'jsdom',
    include: [...configDefaults.include, 'vendor/uxml-preview/tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
    setupFiles: ['./src/test/setup.ts'],
  },
});
