import { existsSync } from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

const port = 4173;
const requestedChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL;
const browserChannel = requestedChannel
  ?? (existsSync(chromium.executablePath()) ? undefined : 'chrome');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  outputDir: 'node_modules/.cache/playwright-test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...(browserChannel === undefined ? {} : { channel: browserChannel }),
    headless: true,
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
